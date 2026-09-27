import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  resolveWebAuthPolicy,
  verifyWebPassword,
  type WebAuthPolicy,
  type WebAuthStoreOptions,
} from "../bin/web-auth-store.js";

export const OMP_WEB_AUTH_USERNAME = "omp";

/** Name of the httpOnly cookie that carries a form-login session. */
export const OMP_WEB_SESSION_COOKIE = "omp_web_session";

const SESSION_TOKEN_VERSION = "1";
/** Sessions last a month; a password change invalidates them earlier (the key is derived from the credential). */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type AuthorizeOptions = WebAuthStoreOptions & { cookie?: string | null };

/**
 * HMAC key for session tokens, derived from the active credential itself, so
 * tokens survive a server restart but are invalidated the moment the password
 * changes (the digest, and therefore the key, changes with it). Returns null
 * when there is no credential to protect (open / unavailable).
 */
function sessionKeyFromPolicy(policy: WebAuthPolicy): Buffer | null {
  if (policy.mode === "environment") {
    return createHash("sha256").update(`omp-web-session:env:${policy.password}`, "utf8").digest();
  }
  if (policy.mode === "stored") {
    const digest = policy.digest;
    return createHash("sha256")
      .update(`omp-web-session:stored:${digest.salt}:${digest.hash}`, "utf8")
      .digest();
  }
  return null;
}

function signSessionToken(key: Buffer, expiresAtMs: number): string {
  const payload = `${SESSION_TOKEN_VERSION}.${expiresAtMs}`;
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verifySessionToken(token: string, policy: WebAuthPolicy): boolean {
  const key = sessionKeyFromPolicy(policy);
  if (!key) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expiresAtStr, mac] = parts;
  if (version !== SESSION_TOKEN_VERSION) return false;
  const expiresAtMs = Number(expiresAtStr);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;
  const expected = createHmac("sha256", key).update(`${version}.${expiresAtStr}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(mac, "base64url");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type WebLoginResult =
  | { status: "ok"; token: string; maxAgeSeconds: number }
  | { status: "invalid" }
  | { status: "open" }
  | { status: "unavailable" };

/**
 * Verify a submitted password and, on success, mint a session token for the
 * form-login cookie. `open` means no password is set (nothing to log into);
 * `unavailable` means the lock is on but its credential cannot be read.
 */
export function loginWithPassword(password: string, options: WebAuthStoreOptions = {}): WebLoginResult {
  const policy = resolveWebAuthPolicy(options);
  if (policy.mode === "open") return { status: "open" };
  if (policy.mode === "unavailable") return { status: "unavailable" };
  if (!verifyWebPassword(password, { ...options, policy })) return { status: "invalid" };
  const key = sessionKeyFromPolicy(policy);
  if (!key) return { status: "unavailable" };
  return {
    status: "ok",
    token: signSessionToken(key, Date.now() + SESSION_TTL_MS),
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/**
 * Outcome of checking one request's credentials.
 *
 * `unavailable` is not a failed login: it means the lock is on but its
 * credential cannot be read, so the request is refused rather than waved
 * through. See `resolveWebAuthPolicy` in `bin/web-auth-store.js`.
 */
export type WebAuthDecision = "allow" | "unauthorized" | "unavailable";

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

export function isWebPasswordEnabled(
  password: string | undefined = process.env.OMP_WEB_PASSWORD,
): password is string {
  return typeof password === "string" && password.length > 0;
}

/** Decode a `Basic` header, rejecting anything that is not exactly one canonical encoding. */
export function parseBasicCredentials(
  authorization: string | null,
): { username: string; password: string } | null {
  if (!authorization) return null;

  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return null;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return null;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return null;

  return {
    username: credentials.slice(0, separator),
    password: credentials.slice(separator + 1),
  };
}

export function isValidBasicAuthorization(
  authorization: string | null,
  password = process.env.OMP_WEB_PASSWORD,
): boolean {
  if (!isWebPasswordEnabled(password)) return false;

  const credentials = parseBasicCredentials(authorization);
  if (!credentials) return false;

  const usernameMatches = secretsEqual(credentials.username, OMP_WEB_AUTH_USERNAME);
  const passwordMatches = secretsEqual(credentials.password, password);
  return usernameMatches && passwordMatches;
}

/**
 * Authorize one request against whichever credential is in force — the
 * `OMP_WEB_PASSWORD` environment variable, or the hashed credential written by
 * the settings panel and `omp-web --authenticated`.
 */
export function authorizeWebRequest(
  authorization: string | null,
  options: AuthorizeOptions = {},
): WebAuthDecision {
  const policy = resolveWebAuthPolicy(options);
  if (policy.mode === "open") return "allow";
  if (policy.mode === "unavailable") return "unavailable";

  // A valid form-login cookie authorizes the request; the Authorization header
  // (Basic) is still accepted so non-browser API clients keep working.
  if (options.cookie && verifySessionToken(options.cookie, policy)) return "allow";

  const credentials = parseBasicCredentials(authorization);
  if (!credentials || !secretsEqual(credentials.username, OMP_WEB_AUTH_USERNAME)) {
    return "unauthorized";
  }
  return verifyWebPassword(credentials.password, { ...options, policy }) ? "allow" : "unauthorized";
}
