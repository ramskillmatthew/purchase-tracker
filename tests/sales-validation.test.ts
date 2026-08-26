import { describe, expect, it } from "vitest";
import { createSaleInputSchema, MAX_SALE_ITEMS, revenueInputModes, salesPlatforms } from "@/lib/validation/sales";

// Zod's z.string().uuid() enforces the RFC4122 version/variant nibbles
// (version 1-5, variant 8/9/a/b) — not just the general 8-4-4-4-12 hex
// shape — so test fixtures must use a genuinely valid UUID form.
const validId1 = "11111111-1111-4111-8111-111111111111";
const validId2 = "22222222-2222-4222-8222-222222222222";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    purchaseIds: [validId1], saleDate: "2026-08-17", platform: "vinted",
    revenueInputMode: "total", revenueInputValue: 25.5, platformFees: 1.5, postage: 3.5,
    ...overrides,
  };
}

describe("createSaleInputSchema — platform validation", () => {
  it("REQUIREMENT: accepts every canonical platform (Vinted, eBay, Depop)", () => {
    for (const platform of ["vinted", "ebay", "depop"] as const) {
      expect(createSaleInputSchema.safeParse(baseInput({ platform })).success).toBe(true);
    }
  });

  it("REQUIREMENT: Other requires a custom platform name", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ platform: "other" })).success).toBe(false);
    expect(createSaleInputSchema.safeParse(baseInput({ platform: "other", customPlatformName: "" })).success).toBe(false);
    expect(createSaleInputSchema.safeParse(baseInput({ platform: "other", customPlatformName: "  " })).success).toBe(false);
  });

  it("REQUIREMENT: Other with a valid custom name is accepted", () => {
    const result = createSaleInputSchema.safeParse(baseInput({ platform: "other", customPlatformName: "Facebook Marketplace" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.customPlatformName).toBe("Facebook Marketplace");
  });

  it("REQUIREMENT: rejects a custom platform name for a non-Other platform (contradictory payload)", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ platform: "vinted", customPlatformName: "Depop" })).success).toBe(false);
  });

  it("rejects an unrecognised platform", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ platform: "facebook" })).success).toBe(false);
  });

  it("exposes the exact canonical platform list", () => {
    expect(salesPlatforms).toEqual(["vinted", "ebay", "depop", "other"]);
  });
});

describe("createSaleInputSchema — purchase IDs", () => {
  it("REQUIREMENT: at least one purchase ID is required", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ purchaseIds: [] })).success).toBe(false);
  });

  it("REQUIREMENT: rejects duplicate purchase IDs explicitly rather than silently deduplicating", () => {
    const result = createSaleInputSchema.safeParse(baseInput({ purchaseIds: [validId1, validId1] }));
    expect(result.success).toBe(false);
  });

  it("multiple distinct purchase IDs (e.g. purchases sharing a displayed SKU) are accepted together", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ purchaseIds: [validId1, validId2] })).success).toBe(true);
  });

  it("rejects a malformed (non-UUID) purchase id", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ purchaseIds: ["not-a-uuid"] })).success).toBe(false);
  });

  it("REQUIREMENT: enforces a sensible maximum purchase-id count", () => {
    const tooMany = Array.from({ length: MAX_SALE_ITEMS + 1 }, (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
    expect(createSaleInputSchema.safeParse(baseInput({ purchaseIds: tooMany })).success).toBe(false);
    const atCap = tooMany.slice(0, MAX_SALE_ITEMS);
    expect(createSaleInputSchema.safeParse(baseInput({ purchaseIds: atCap })).success).toBe(true);
  });
});

describe("createSaleInputSchema — revenue mode and amounts", () => {
  it("REQUIREMENT: the canonical revenue mode list includes Stage 4's itemised mode alongside the original total/average", () => {
    expect(revenueInputModes).toEqual(["total", "average", "itemised"]);
  });

  it("REQUIREMENT: accepts total and average revenue input modes with no line-revenue data", () => {
    for (const revenueInputMode of ["total", "average"] as const) {
      expect(createSaleInputSchema.safeParse(baseInput({ revenueInputMode })).success).toBe(true);
    }
  });

  it("rejects an unrecognised revenue input mode", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ revenueInputMode: "per_unit" })).success).toBe(false);
  });

  it("REQUIREMENT: rejects negative revenue, fees, and postage", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ revenueInputValue: -1 })).success).toBe(false);
    expect(createSaleInputSchema.safeParse(baseInput({ platformFees: -1 })).success).toBe(false);
    expect(createSaleInputSchema.safeParse(baseInput({ postage: -1 })).success).toBe(false);
  });

  it("zero revenue, fees, and postage are all valid (handled safely, never rejected as falsy)", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ revenueInputValue: 0, platformFees: 0, postage: 0 })).success).toBe(true);
  });

  it("platformFees and postage default to 0 when omitted", () => {
    const { platformFees: _fees, postage: _postage, ...withoutFeesPostage } = baseInput();
    const result = createSaleInputSchema.safeParse(withoutFeesPostage);
    expect(result.success).toBe(true);
    if (result.success) { expect(result.data.platformFees).toBe(0); expect(result.data.postage).toBe(0); }
  });
});

describe("createSaleInputSchema — sale date and no order-reference field", () => {
  it("requires a valid ISO date", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ saleDate: "17/08/2026" })).success).toBe(false);
    expect(createSaleInputSchema.safeParse(baseInput({ saleDate: "2026-08-17" })).success).toBe(true);
  });

  it("REQUIREMENT: no order-reference field is accepted — an unknown field is rejected by the strict schema", () => {
    expect(createSaleInputSchema.safeParse(baseInput({ orderReference: "REF-123" })).success).toBe(false);
  });

  it("REQUIREMENT: does not accept purchase cost, description, category, SKU, or supplier from the client — an unrecognised field is rejected", () => {
    for (const field of ["cost", "purchaseCost", "description", "category", "sku", "supplier", "purchasedFrom"]) {
      expect(createSaleInputSchema.safeParse(baseInput({ [field]: "should not be accepted" })).success).toBe(false);
    }
  });
});

describe("createSaleInputSchema — Stage 4 itemised mode (mixed baskets)", () => {
  function itemisedInput(overrides: Record<string, unknown> = {}) {
    return baseInput({
      purchaseIds: [validId1, validId2],
      revenueInputMode: "itemised",
      revenueInputValue: 30,
      lineRevenues: [{ purchaseId: validId1, revenue: 20 }, { purchaseId: validId2, revenue: 10 }],
      ...overrides,
    });
  }

  it("REQUIREMENT: accepts a valid itemised payload whose lines reconcile exactly to the declared total", () => {
    expect(createSaleInputSchema.safeParse(itemisedInput()).success).toBe(true);
  });

  it("REQUIREMENT: itemised mode requires at least one line-revenue entry", () => {
    expect(createSaleInputSchema.safeParse(itemisedInput({ lineRevenues: undefined })).success).toBe(false);
    expect(createSaleInputSchema.safeParse(itemisedInput({ lineRevenues: [] })).success).toBe(false);
  });

  it("REQUIREMENT: total/average modes reject line-revenue data being present at all (a contradictory payload)", () => {
    const result = createSaleInputSchema.safeParse(baseInput({
      revenueInputMode: "total", lineRevenues: [{ purchaseId: validId1, revenue: 20 }],
    }));
    expect(result.success).toBe(false);
  });

  it("REQUIREMENT: rejects the same purchase appearing twice in the line-revenue list", () => {
    const result = createSaleInputSchema.safeParse(itemisedInput({
      lineRevenues: [{ purchaseId: validId1, revenue: 15 }, { purchaseId: validId1, revenue: 15 }],
    }));
    expect(result.success).toBe(false);
  });

  it("REQUIREMENT: rejects line revenues that don't cover exactly the selected purchases (missing one)", () => {
    const result = createSaleInputSchema.safeParse(itemisedInput({
      lineRevenues: [{ purchaseId: validId1, revenue: 30 }],
    }));
    expect(result.success).toBe(false);
  });

  it("REQUIREMENT: rejects a line revenue for a purchase that isn't in purchaseIds at all", () => {
    const stray = "33333333-3333-4333-8333-333333333333";
    const result = createSaleInputSchema.safeParse(itemisedInput({
      lineRevenues: [{ purchaseId: validId1, revenue: 20 }, { purchaseId: stray, revenue: 10 }],
    }));
    expect(result.success).toBe(false);
  });

  it("REQUIREMENT: rejects itemised lines that don't add up to the declared order total — nothing is silently rebalanced", () => {
    const result = createSaleInputSchema.safeParse(itemisedInput({
      revenueInputValue: 999, lineRevenues: [{ purchaseId: validId1, revenue: 20 }, { purchaseId: validId2, revenue: 10 }],
    }));
    expect(result.success).toBe(false);
  });

  it("REQUIREMENT: rejects a negative individual line revenue even when the overall total happens to still be non-negative", () => {
    const result = createSaleInputSchema.safeParse(itemisedInput({
      revenueInputValue: 10, lineRevenues: [{ purchaseId: validId1, revenue: 20 }, { purchaseId: validId2, revenue: -10 }],
    }));
    expect(result.success).toBe(false);
  });

  it("reconciliation is exact in pence — a fractional-penny mismatch is rejected, not rounded away", () => {
    const result = createSaleInputSchema.safeParse(itemisedInput({
      revenueInputValue: 30.01, lineRevenues: [{ purchaseId: validId1, revenue: 20 }, { purchaseId: validId2, revenue: 10 }],
    }));
    expect(result.success).toBe(false);
  });

  it("many identical units (Quick-Sale-shaped) can still use itemised mode if desired, each with its own explicit revenue", () => {
    const idA = "44444444-4444-4444-8444-444444444444";
    const idB = "55555555-5555-4555-8555-555555555555";
    const idC = "66666666-6666-4666-8666-666666666666";
    const result = createSaleInputSchema.safeParse(baseInput({
      purchaseIds: [idA, idB, idC], revenueInputMode: "itemised", revenueInputValue: 30,
      lineRevenues: [{ purchaseId: idA, revenue: 10 }, { purchaseId: idB, revenue: 10 }, { purchaseId: idC, revenue: 10 }],
    }));
    expect(result.success).toBe(true);
  });
});
