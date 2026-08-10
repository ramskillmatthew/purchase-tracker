import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Milestone 7 (Chrome extension draft queue) — the human-typed pairing
 * code that links a freshly-created batch to the extension that claims it.
 * Never stored in plaintext anywhere (matches this app's existing
 * "never store a raw credential" convention — see lib/yahoo/tokens.ts's
 * EMAIL_ID_SECRET-keyed JWT signing, reused here for the restricted batch
 * token issued after a successful claim). Only a keyed HMAC-SHA256 digest
 * of the code is ever persisted (vinted_extension_batches.pairing_code_hash).
 *
 * Alphabet excludes 0/O/1/I/L — the classic "safe to read aloud/type"
 * exclusion set, since a human copies this from one screen to another. 8
 * characters from a 32-symbol alphabet is 32^8 ≈ 1.1 x 10^12 possibilities
 * — combined with single-use + short expiry (see the batch route), brute
 * force within the code's lifetime is not practical.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function secret(): string {
  const value = process.env.EXTENSION_BATCH_SECRET;
  if (!value || value.length < 32) throw new Error("EXTENSION_BATCH_SECRET must contain at least 32 characters.");
  return value;
}

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// Normalises the same way on both sides (uppercase, trimmed) so a user
// typing lowercase or with stray whitespace still matches — the ALPHABET
// itself is already unambiguous, so normalising case never conflates two
// different real codes.
function normalise(code: string): string {
  return code.trim().toUpperCase();
}

export function hashPairingCode(code: string): string {
  return createHmac("sha256", secret()).update(`pairing-code:${normalise(code)}`).digest("hex");
}

/** Constant-time comparison against a stored hash — never a plain `===` on the digest. */
export function pairingCodeMatchesHash(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashPairingCode(code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
