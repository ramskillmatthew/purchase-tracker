import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { generatePairingCode, hashPairingCode, pairingCodeMatchesHash } from "@/lib/listing-studio/extension-pairing-code";

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "a".repeat(32);
});

describe("generatePairingCode", () => {
  it("generates an 8-character code from the safe alphabet (no 0/O/1/I/L)", () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
  });

  it("generates different codes across calls (astronomically unlikely to collide)", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePairingCode()));
    expect(codes.size).toBe(50);
  });
});

describe("hashPairingCode / pairingCodeMatchesHash", () => {
  it("REGRESSION: never stores/returns the plaintext — the hash is a 64-char hex digest, never containing the original code as a substring", () => {
    const code = generatePairingCode();
    const hash = hashPairingCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash.toUpperCase()).not.toContain(code.toUpperCase());
  });

  it("the same code always hashes to the same value (deterministic, so a single DB lookup by hash works)", () => {
    const code = generatePairingCode();
    expect(hashPairingCode(code)).toBe(hashPairingCode(code));
  });

  it("normalises case and surrounding whitespace before hashing — a user retyping in lowercase still matches", () => {
    const code = "ABCD2345";
    expect(hashPairingCode(code)).toBe(hashPairingCode("abcd2345"));
    expect(hashPairingCode(code)).toBe(hashPairingCode("  ABCD2345  "));
  });

  it("pairingCodeMatchesHash confirms a correct code and rejects an incorrect one", () => {
    const code = generatePairingCode();
    const hash = hashPairingCode(code);
    expect(pairingCodeMatchesHash(code, hash)).toBe(true);
    expect(pairingCodeMatchesHash(generatePairingCode(), hash)).toBe(false);
  });

  it("throws a clear error if EXTENSION_BATCH_SECRET is missing or too short — never silently hashes with an empty/weak key", () => {
    delete process.env.EXTENSION_BATCH_SECRET;
    expect(() => hashPairingCode("ABCD2345")).toThrow(/EXTENSION_BATCH_SECRET/);
    process.env.EXTENSION_BATCH_SECRET = "short";
    expect(() => hashPairingCode("ABCD2345")).toThrow(/EXTENSION_BATCH_SECRET/);
  });
});
