import { describe, expect, it } from "vitest";
import { deletePurchasesInputSchema, MAX_DELETE_PURCHASES } from "@/lib/validation/purchase";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("deletePurchasesInputSchema", () => {
  it("REQUIREMENT: accepts a well-formed request", () => {
    expect(deletePurchasesInputSchema.safeParse({ ids: [uuid(1), uuid(2)] }).success).toBe(true);
  });

  it("REQUIREMENT: rejects an empty list", () => {
    expect(deletePurchasesInputSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it("REQUIREMENT: rejects duplicate ids", () => {
    const result = deletePurchasesInputSchema.safeParse({ ids: [uuid(1), uuid(1)] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path.join(".") === "ids")).toBe(true);
  });

  it("REQUIREMENT: enforces a sensible maximum batch size, shared with the RPC's own ceiling", () => {
    expect(MAX_DELETE_PURCHASES).toBe(500);
    const tooMany = Array.from({ length: MAX_DELETE_PURCHASES + 1 }, (_, i) => uuid(i));
    expect(deletePurchasesInputSchema.safeParse({ ids: tooMany }).success).toBe(false);
  });

  it("accepts exactly the maximum batch size", () => {
    const exactly = Array.from({ length: MAX_DELETE_PURCHASES }, (_, i) => uuid(i));
    expect(deletePurchasesInputSchema.safeParse({ ids: exactly }).success).toBe(true);
  });

  it("rejects a non-UUID id", () => {
    expect(deletePurchasesInputSchema.safeParse({ ids: ["not-a-uuid"] }).success).toBe(false);
  });

  it("rejects unrecognised extra keys (strict schema)", () => {
    expect(deletePurchasesInputSchema.safeParse({ ids: [uuid(1)], force: true }).success).toBe(false);
  });
});
