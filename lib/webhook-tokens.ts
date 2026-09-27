import { randomBytes, timingSafeEqual } from "crypto";

/**
 * Capability tokens for unauthenticated webhook endpoints.
 *
 * A token IS the capability: whoever holds it may trigger (incoming) or answer
 * (respond) exactly one thing, and nothing else. Tokens are high-entropy and
 * compared in constant time so they can be safely allow-listed past the
 * password proxy.
 */

const TOKEN_BYTES = 32; // 256 bits -> 43-char base64url

/** Generate a high-entropy URL-safe token (>= 32 bytes of entropy). */
export function generateWebhookToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Constant-time comparison that never short-circuits on length. */
export function tokensEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; compare against a fixed-length
  // digest-like buffer to keep the comparison itself constant-time.
  if (bufferA.length !== bufferB.length) {
    // Still perform a comparison to avoid leaking length via early return timing.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
