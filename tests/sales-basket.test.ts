import { describe, expect, it } from "vitest";
import { basketGroupKey, buildItemisedLineRevenuesPence, groupBasketItems, totalStockCostPence } from "@/lib/sales/basket";
import type { Purchase } from "@/lib/types";

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: "p1", order_date: "2026-01-01", purchased_from: "Vinted", seller_name: "Seller", sku: "SKU1",
    item_description: "Pokemon box", item_size: "N/A", quantity: 1, item_condition: "Brand new", category: "Pokémon",
    price_purchased: 19.99, arrived: null, stock_status: "in_stock", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("basketGroupKey / groupBasketItems", () => {
  it("REQUIREMENT: groups purchases sharing description/category/condition together, case/whitespace-insensitively on description", () => {
    const items = [
      purchase({ id: "a", item_description: "Pokemon Box", purchased_from: "John Lewis" }),
      purchase({ id: "b", item_description: "  pokemon box  ", purchased_from: "Hamleys" }),
    ];
    const groups = groupBasketItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(i => i.id)).toEqual(["a", "b"]);
  });

  it("REQUIREMENT: never merges the underlying exact UUIDs — every original purchase is still present within its group", () => {
    const items = [purchase({ id: "a" }), purchase({ id: "b" }), purchase({ id: "c" })];
    const groups = groupBasketItems(items);
    expect(groups[0].items).toHaveLength(3);
    expect(new Set(groups[0].items.map(i => i.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("keeps different products as separate groups even if some fields match", () => {
    const items = [
      purchase({ id: "a", item_description: "Pokemon box" }),
      purchase({ id: "b", item_description: "Trainers", category: "Footwear" }),
    ];
    expect(groupBasketItems(items)).toHaveLength(2);
  });

  it("a different condition on an otherwise-identical product forms its own group", () => {
    const items = [
      purchase({ id: "a", item_condition: "Brand new" }),
      purchase({ id: "b", item_condition: "Good condition from photos" }),
    ];
    expect(groupBasketItems(items)).toHaveLength(2);
  });

  it("an empty basket produces no groups", () => {
    expect(groupBasketItems([])).toEqual([]);
  });

  it("preserves first-seen group order", () => {
    const items = [purchase({ id: "a", item_description: "B item" }), purchase({ id: "b", item_description: "A item" })];
    expect(groupBasketItems(items).map(g => g.description)).toEqual(["B item", "A item"]);
  });
});

describe("totalStockCostPence", () => {
  it("sums every item's own purchase cost in pence", () => {
    expect(totalStockCostPence([purchase({ price_purchased: 19.99 }), purchase({ price_purchased: 5.01 })])).toBe(2500);
  });

  it("an empty basket costs zero", () => {
    expect(totalStockCostPence([])).toBe(0);
  });
});

describe("buildItemisedLineRevenuesPence — group unit price × quantity, split per exact UUID", () => {
  it("REQUIREMENT: group quantity × unit sale price produces that group's total, split across its member UUIDs", () => {
    const items = [purchase({ id: "b" }), purchase({ id: "a" }), purchase({ id: "c" })];
    const groups = groupBasketItems(items);
    const lines = buildItemisedLineRevenuesPence(groups, { [groups[0].key]: 1000 });
    expect(lines.reduce((sum, l) => sum + l.revenuePence, 0)).toBe(3000);
    expect(lines).toHaveLength(3);
  });

  it("REQUIREMENT: the sum of all group lines equals the sum of every group's own total — this becomes the order revenue", () => {
    const items = [
      purchase({ id: "a", item_description: "Pokemon box" }),
      purchase({ id: "b", item_description: "Trainers", category: "Footwear" }),
    ];
    const groups = groupBasketItems(items);
    const lines = buildItemisedLineRevenuesPence(groups, { [groups[0].key]: 2000, [groups[1].key]: 3500 });
    expect(lines.reduce((sum, l) => sum + l.revenuePence, 0)).toBe(5500);
  });

  it("a group with no price entered yet contributes zero, never NaN/undefined", () => {
    const groups = groupBasketItems([purchase({ id: "a" })]);
    const lines = buildItemisedLineRevenuesPence(groups, {});
    expect(lines[0].revenuePence).toBe(0);
  });

  it("REQUIREMENT: an odd group total splits deterministically (no lost/invented pennies) across its member UUIDs", () => {
    const items = [purchase({ id: "a" }), purchase({ id: "b" }), purchase({ id: "c" })];
    const groups = groupBasketItems(items);
    const lines = buildItemisedLineRevenuesPence(groups, { [groups[0].key]: 333 }); // 999 pence / 3
    expect(lines.reduce((sum, l) => sum + l.revenuePence, 0)).toBe(999);
  });

  it("every purchaseId in the basket appears exactly once in the output", () => {
    const items = [purchase({ id: "a" }), purchase({ id: "b", item_description: "Trainers", category: "Footwear" })];
    const groups = groupBasketItems(items);
    const lines = buildItemisedLineRevenuesPence(groups, { [groups[0].key]: 100, [groups[1].key]: 200 });
    expect(lines.map(l => l.purchaseId).sort()).toEqual(["a", "b"]);
  });
});
