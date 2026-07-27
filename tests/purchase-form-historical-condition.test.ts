import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { conditions, isHistoricalCondition, purchaseInputSchema } from "@/lib/validation/purchase";

describe("isHistoricalCondition", () => {
  it("REQUIREMENT 16: recognises every canonical condition as NOT historical", () => {
    for (const condition of conditions) expect(isHistoricalCondition(condition)).toBe(false);
  });

  it("recognises a factual free-text description as historical", () => {
    expect(isHistoricalCondition("Holes in heel")).toBe(true);
    expect(isHistoricalCondition("Scuffs on toe box")).toBe(true);
  });

  it("treats blank/undefined/null as not historical (nothing to preserve)", () => {
    expect(isHistoricalCondition("")).toBe(false);
    expect(isHistoricalCondition(undefined)).toBe(false);
    expect(isHistoricalCondition(null)).toBe(false);
  });
});

describe("REQUIREMENT 11/12/17: purchaseInputSchema itself stays canonical-only — every non-import purchase-creation path is unaffected", () => {
  it("still rejects a historical/free-text condition for ordinary manual purchase creation", () => {
    const candidate = {
      order_date: "2026-07-24", purchased_from: "Vinted", seller_name: null, sku: "1801",
      item_description: "Nike Air Max 95", item_size: "9", quantity: 1,
      item_condition: "Holes in heel", price_purchased: 13.49, arrived: null,
    };
    const result = purchaseInputSchema.safeParse(candidate);
    expect(result.success).toBe(false);
  });

  it("still accepts only the five canonical conditions", () => {
    for (const condition of conditions) {
      const result = purchaseInputSchema.safeParse({
        order_date: "2026-07-24", purchased_from: "Vinted", seller_name: null, sku: "1801",
        item_description: "Nike Air Max 95", item_size: "9", quantity: 1,
        item_condition: condition, price_purchased: 13.49, arrived: null,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("PurchaseForm.tsx structural checks (no React testing harness in this project — mirrors the codebase's existing route-level structural-test convention)", () => {
  const source = readFileSync("components/PurchaseForm.tsx", "utf8");

  it("REQUIREMENT 17: never renders a free-text input for Item Condition — only the canonical/historical <select>, so a new manual purchase can never introduce new free text", () => {
    expect(source).not.toMatch(/name="item_condition"[^>]*<input/);
    expect(source).toContain('name="item_condition"');
    expect(source).toContain("<select");
  });

  it("REQUIREMENT 17: the historical option can only ever appear when editing an existing purchase, never when creating a new one", () => {
    // historicalCondition is derived from `purchase?.item_condition` and purchase is undefined in create mode
    expect(source).toContain("isHistoricalCondition(purchase?.item_condition)");
    expect(source).toContain("{historicalCondition &&");
  });

  it("REQUIREMENT 15: an unchanged historical condition is omitted from the save request rather than re-sent through the canonical-only PATCH schema", () => {
    expect(source).toContain("delete fields.item_condition");
  });
});
