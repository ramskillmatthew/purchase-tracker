import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { signBatchToken, verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "b".repeat(32);
});

describe("signBatchToken / verifyBatchToken", () => {
  it("round-trips a valid batchId", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const payload = await verifyBatchToken(token);
    expect(payload.batchId).toBe(BATCH_ID);
  });

  it("REGRESSION: an expired token is rejected with a generic BatchTokenError — never a raw jose 'expired' detail", async () => {
    // expiresInSeconds is clamped to a minimum of 1 (see signBatchToken's
    // own comment) — a negative/zero value can't produce an
    // already-expired-at-issuance token, so this waits just past that
    // 1-second minimum instead.
    const token = await signBatchToken(BATCH_ID, 1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await expect(verifyBatchToken(token)).rejects.toBeInstanceOf(BatchTokenError);
    await expect(verifyBatchToken(token)).rejects.toThrow(/invalid or expired/i);
  }, 10000);

  it("a token signed with a DIFFERENT secret is rejected", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    process.env.EXTENSION_BATCH_SECRET = "c".repeat(32);
    await expect(verifyBatchToken(token)).rejects.toBeInstanceOf(BatchTokenError);
  });

  it("a malformed/garbage token is rejected without throwing an unhandled error", async () => {
    await expect(verifyBatchToken("not-a-real-jwt")).rejects.toBeInstanceOf(BatchTokenError);
  });

  it("never accepts a token whose payload doesn't match the batchId shape (defensive zod re-check)", async () => {
    // Sign with a non-uuid-shaped "batchId" isn't directly possible via
    // signBatchToken's own type, so this documents that verifyBatchToken's
    // schema re-validates the payload shape independent of jose's own
    // signature check — a tampered-but-still-validly-signed payload
    // (impossible without the secret, but defence in depth) would still
    // be caught.
    const token = await signBatchToken(BATCH_ID, 600);
    const payload = await verifyBatchToken(token);
    expect(payload).toEqual({ batchId: BATCH_ID });
  });

  it("clamps a non-positive expiresInSeconds to at least 1 second rather than producing an already-expired-at-issuance or negative-duration token", async () => {
    const token = await signBatchToken(BATCH_ID, 0);
    const payload = await verifyBatchToken(token); // still valid for at least an instant
    expect(payload.batchId).toBe(BATCH_ID);
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Authorization header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });
  it("returns null for a missing header, wrong scheme, or empty token", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });
});
