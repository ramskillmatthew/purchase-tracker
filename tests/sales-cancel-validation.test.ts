import { describe, expect, it } from "vitest";
import { cancelSalesInputSchema, MAX_CANCEL_SALES } from "@/lib/validation/sales";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("cancelSalesInputSchema", () => {
  it("REQUIREMENT: accepts a well-formed request", () => {
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: [uuid(1), uuid(2)], returnToStock: true });
    expect(result.success).toBe(true);
  });

  it("REQUIREMENT: rejects an empty selection", () => {
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: [], returnToStock: false });
    expect(result.success).toBe(false);
  });

  it("REQUIREMENT: rejects duplicate sale IDs", () => {
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: [uuid(1), uuid(1)], returnToStock: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path.join(".") === "salesOrderIds")).toBe(true);
  });

  it("REQUIREMENT: enforces a sensible maximum batch size", () => {
    const tooMany = Array.from({ length: MAX_CANCEL_SALES + 1 }, (_, i) => uuid(i));
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: tooMany, returnToStock: true });
    expect(result.success).toBe(false);
  });

  it("accepts exactly the maximum batch size", () => {
    const exactly = Array.from({ length: MAX_CANCEL_SALES }, (_, i) => uuid(i));
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: exactly, returnToStock: true });
    expect(result.success).toBe(true);
  });

  it("REQUIREMENT: returnToStock is a required, explicit boolean — no default, so a caller can never omit the stock decision", () => {
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: [uuid(1)] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID sale id", () => {
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: ["not-a-uuid"], returnToStock: true });
    expect(result.success).toBe(false);
  });

  it("rejects unrecognised extra keys (strict schema)", () => {
    const result = cancelSalesInputSchema.safeParse({ salesOrderIds: [uuid(1)], returnToStock: true, ownerId: "sneaky" });
    expect(result.success).toBe(false);
  });
});
