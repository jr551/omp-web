/**
 * Client-safe types, bounds and pure validation for the `smartwake` tool.
 *
 * A "smartwake" lets a worker (the agent) schedule a future wake of ITS OWN
 * session: after a delay, or when a bash poll command starts passing. When it
 * fires the stored `message` is delivered back into the originating session so
 * the agent resumes with it.
 *
 * This module has no server-only imports (no `fs`, no omp SDK), so both the
 * server store (lib/wake-store.ts) and the tool/tests can import it. The same
 * split lib/routine-types.ts uses for the Routines feature.
 */

// --- Bounds --------------------------------------------------------------

export const MIN_WAKE_DELAY_MS = 1_000; // 1s
export const MAX_WAKE_DELAY_MS = 24 * 60 * 60 * 1000; // 24h

export const MIN_WAKE_INTERVAL_MS = 10_000; // 10s (the scheduler tick is ~30s)
export const MAX_WAKE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_WAKE_INTERVAL_MS = 60_000; // 1m

export const MIN_WAKE_GUARD_TIMEOUT_MS = 1_000; // 1s
export const MAX_WAKE_GUARD_TIMEOUT_MS = 5 * 60 * 1000; // 5m
export const DEFAULT_WAKE_GUARD_TIMEOUT_MS = 30_000; // 30s

export const MIN_WAKE_EXPIRY_MS = 1_000; // 1s
export const MAX_WAKE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_WAKE_EXPIRY_MS = 60 * 60 * 1000; // 1h

export const MAX_WAKE_MESSAGE_LENGTH = 8_000;
/** How long a terminal (fired/expired/…) wake is kept for observability. */
export const WAKE_TERMINAL_RETENTION_MS = 60 * 60 * 1000; // 1h
/** A single session may not accumulate more than this many pending wakes. */
export const MAX_PENDING_WAKES_PER_SESSION = 50;

// --- Types ---------------------------------------------------------------

export type WakeMode = "delayed" | "guarded";

export type WakeStatus = "pending" | "fired" | "expired" | "cancelled" | "failed";

export interface Wake {
  id: string;
  sessionId: string;
  cwd: string;
  /** Absolute .jsonl path, used to resume the session if it is no longer live. */
  sessionFile?: string;
  mode: WakeMode;
  message: string;
  /** delayed mode: epoch ms at/after which the wake fires. */
  fireAt?: number;
  /** guarded mode: bash command polled via `bash -lc`. */
  pollCommand?: string;
  intervalMs?: number;
  guardTimeoutMs?: number;
  expectOutputMatches?: string;
  createdAt: number;
  expiresAt: number;
  lastPollAt?: number;
  /** epoch ms when the wake reached a terminal status. */
  resolvedAt?: number;
  status: WakeStatus;
  statusReason?: string;
}

/** The validated shape produced from tool args; the store adds id/session fields. */
export interface ValidatedWake {
  mode: WakeMode;
  message: string;
  fireAt?: number;
  pollCommand?: string;
  intervalMs?: number;
  guardTimeoutMs?: number;
  expectOutputMatches?: string;
  createdAt: number;
  expiresAt: number;
}

/** Raw fields supplied by the tool caller (untrusted). */
export interface WakeInput {
  message?: unknown;
  delayMs?: unknown;
  /** Absolute wake time: epoch ms number or ISO date string. */
  at?: unknown;
  pollCommand?: unknown;
  intervalMs?: unknown;
  guardTimeoutMs?: unknown;
  expectOutputMatches?: unknown;
  expiresInMs?: unknown;
}

export type WakeValidation =
  | { ok: true; value: ValidatedWake }
  | { ok: false; error: string };

// --- Validation (pure) ---------------------------------------------------

function toFiniteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
}

function parseAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Validate the caller's smartwake args against the bounds. Pure and clock-free:
 * `now` is injected so tests are deterministic. Returns a {@link ValidatedWake}
 * with resolved absolute `fireAt`/`expiresAt`, ready for the store.
 */
export function validateWakeInput(input: WakeInput, now: number): WakeValidation {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) return { ok: false, error: "message is required" };
  if (message.length > MAX_WAKE_MESSAGE_LENGTH) {
    return { ok: false, error: `message is too long (max ${MAX_WAKE_MESSAGE_LENGTH} characters)` };
  }

  // Expiry (both modes).
  let expiresInMs = DEFAULT_WAKE_EXPIRY_MS;
  if (input.expiresInMs !== undefined && input.expiresInMs !== null) {
    const parsed = toFiniteInt(input.expiresInMs);
    if (!Number.isFinite(parsed) || parsed < MIN_WAKE_EXPIRY_MS || parsed > MAX_WAKE_EXPIRY_MS) {
      return { ok: false, error: `expiresInMs must be between ${MIN_WAKE_EXPIRY_MS} and ${MAX_WAKE_EXPIRY_MS}` };
    }
    expiresInMs = parsed;
  }
  const expiresAt = now + expiresInMs;

  const hasPoll = typeof input.pollCommand === "string" && input.pollCommand.trim().length > 0;
  const hasIntervalOrGuardHint = input.pollCommand !== undefined
    || input.intervalMs !== undefined
    || input.expectOutputMatches !== undefined;
  const hasDelayHint = input.delayMs !== undefined || input.at !== undefined;

  if (hasPoll || (hasIntervalOrGuardHint && !hasDelayHint)) {
    // Guarded mode.
    if (!hasPoll) return { ok: false, error: "pollCommand is required for a guarded wake" };
    const pollCommand = (input.pollCommand as string).trim();

    const intervalMs = toFiniteInt(input.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_WAKE_INTERVAL_MS || intervalMs > MAX_WAKE_INTERVAL_MS) {
      return { ok: false, error: `intervalMs must be between ${MIN_WAKE_INTERVAL_MS} and ${MAX_WAKE_INTERVAL_MS}` };
    }

    let guardTimeoutMs = DEFAULT_WAKE_GUARD_TIMEOUT_MS;
    if (input.guardTimeoutMs !== undefined && input.guardTimeoutMs !== null) {
      const parsed = toFiniteInt(input.guardTimeoutMs);
      if (!Number.isFinite(parsed) || parsed < MIN_WAKE_GUARD_TIMEOUT_MS || parsed > MAX_WAKE_GUARD_TIMEOUT_MS) {
        return { ok: false, error: `guardTimeoutMs must be between ${MIN_WAKE_GUARD_TIMEOUT_MS} and ${MAX_WAKE_GUARD_TIMEOUT_MS}` };
      }
      guardTimeoutMs = parsed;
    }

    let expectOutputMatches: string | undefined;
    if (input.expectOutputMatches !== undefined && input.expectOutputMatches !== null && input.expectOutputMatches !== "") {
      if (typeof input.expectOutputMatches !== "string") return { ok: false, error: "expectOutputMatches must be a string" };
      try {
        new RegExp(input.expectOutputMatches);
      } catch (error) {
        return { ok: false, error: `invalid expectOutputMatches regex: ${error instanceof Error ? error.message : String(error)}` };
      }
      expectOutputMatches = input.expectOutputMatches;
    }

    return {
      ok: true,
      value: {
        mode: "guarded",
        message,
        pollCommand,
        intervalMs,
        guardTimeoutMs,
        ...(expectOutputMatches !== undefined ? { expectOutputMatches } : {}),
        createdAt: now,
        expiresAt,
      },
    };
  }

  // Delayed mode.
  if (!hasDelayHint) {
    return {
      ok: false,
      error: "provide delayMs or at (delayed wake), or pollCommand + intervalMs (guarded wake)",
    };
  }

  let fireAt: number;
  if (input.at !== undefined && input.at !== null) {
    const at = parseAt(input.at);
    if (at === null) return { ok: false, error: "at must be an epoch-ms number or an ISO date string" };
    fireAt = at;
  } else {
    const delayMs = toFiniteInt(input.delayMs);
    if (!Number.isFinite(delayMs) || delayMs < MIN_WAKE_DELAY_MS || delayMs > MAX_WAKE_DELAY_MS) {
      return { ok: false, error: `delayMs must be between ${MIN_WAKE_DELAY_MS} and ${MAX_WAKE_DELAY_MS}` };
    }
    fireAt = now + delayMs;
  }

  const delta = fireAt - now;
  if (delta < MIN_WAKE_DELAY_MS) return { ok: false, error: "wake time must be at least 1s in the future" };
  if (delta > MAX_WAKE_DELAY_MS) return { ok: false, error: "wake time is too far in the future (max 24h)" };
  if (fireAt > expiresAt) return { ok: false, error: "wake time is after the expiry; increase expiresInMs" };

  return {
    ok: true,
    value: { mode: "delayed", message, fireAt, createdAt: now, expiresAt },
  };
}

// --- Human summaries (pure) ---------------------------------------------

/** Render a duration in ms as a short human string ("10m", "2h 5m", "45s"). */
export function humanizeDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/** A one-line human summary of a scheduled wake (returned by the tool). */
export function summarizeWake(wake: Pick<Wake, "mode" | "fireAt" | "pollCommand" | "intervalMs" | "expiresAt">, now: number): string {
  const expiresIn = humanizeDuration(wake.expiresAt - now);
  if (wake.mode === "delayed" && typeof wake.fireAt === "number") {
    return `will wake in ${humanizeDuration(wake.fireAt - now)} (at ${new Date(wake.fireAt).toISOString()}), expires in ${expiresIn}`;
  }
  if (wake.mode === "guarded" && wake.pollCommand) {
    const every = wake.intervalMs ? ` (polling every ${humanizeDuration(wake.intervalMs)})` : "";
    return `will wake when \`${wake.pollCommand}\` succeeds${every}, expires in ${expiresIn}`;
  }
  return `scheduled, expires in ${expiresIn}`;
}
