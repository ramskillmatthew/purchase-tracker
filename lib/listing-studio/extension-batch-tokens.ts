import "server-only";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

/**
 * Milestone 7 (Chrome extension draft queue) — the restricted token issued
 * to the extension after it successfully claims a batch (exchanges a
 * single-use pairing code). Scoped to exactly one batchId, short-lived
 * (expires with the batch itself — see the claim route), HS256-signed with
 * a dedicated server-only secret. Mirrors lib/yahoo/tokens.ts's own
 * EMAIL_ID_SECRET-keyed JWT convention exactly, deliberately reusing the
 * SAME library (jose) rather than introducing a second token approach.
 *
 * This token can only ever be used against the /api/extension/* routes —
 * it is never accepted by any owner-session route, and grants no access
 * beyond that one batch's own payload/photos/result-reporting.
 */

const batchTokenPayloadSchema = z.object({ batchId: z.string().uuid() });
export type BatchTokenPayload = z.infer<typeof batchTokenPayloadSchema>;
const connectionTokenPayloadSchema = z.object({ ownerId: z.string().uuid(), scope: z.literal("listing-assistant") });
export type ConnectionTokenPayload = z.infer<typeof connectionTokenPayloadSchema>;
export const EXTENSION_CONNECTION_EXPIRY_SECONDS = 90 * 24 * 60 * 60;

function key() {
  const value = process.env.EXTENSION_BATCH_SECRET;
  if (!value || value.length < 32) throw new Error("EXTENSION_BATCH_SECRET must contain at least 32 characters.");
  return new TextEncoder().encode(value);
}

/** `expiresInSeconds` should be however long remains until the batch's own expires_at — the token can never outlive the batch it scopes. */
export async function signBatchToken(batchId: string, expiresInSeconds: number): Promise<string> {
  const boundedSeconds = Math.max(1, Math.floor(expiresInSeconds));
  return new SignJWT({ batchId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${boundedSeconds}s`).sign(key());
}

export class BatchTokenError extends Error {
  name = "BatchTokenError";
}

export async function verifyBatchToken(token: string): Promise<BatchTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return batchTokenPayloadSchema.parse(payload);
  } catch {
    // Never surfaces the underlying jose/zod error detail (expired vs
    // malformed vs wrong signature) to the caller — a single generic
    // failure, same "safe generic error message" reasoning as every other
    // auth boundary in this app.
    throw new BatchTokenError("Invalid or expired batch token.");
  }
}

export async function signConnectionToken(ownerId: string): Promise<string> {
  return new SignJWT({ ownerId, scope: "listing-assistant" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${EXTENSION_CONNECTION_EXPIRY_SECONDS}s`).sign(key());
}

export async function verifyConnectionToken(token: string): Promise<ConnectionTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return connectionTokenPayloadSchema.parse(payload);
  } catch {
    throw new BatchTokenError("Invalid or expired extension connection token.");
  }
}

/** Extracts the bearer token from an Authorization header, or null if the header is missing/malformed — never throws. */
export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  return match ? match[1].trim() || null : null;
}
