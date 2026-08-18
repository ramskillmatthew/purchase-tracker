import { describe, expect, it } from "vitest";
import { computeHomeReport } from "@/lib/home-report";
import type { Purchase } from "@/lib/types";

function purchase(overrides: Partial<Purchase> & { id: string }): Purchase {
  return {
    order_date: "2026-08-14", purchased_from: "Vinted", seller_name: "", sku: "1000",
    item_description: "Item", item_size: "N/A", quantity: 1, item_condition: "Brand new", category: "Other",
    price_purchased: 10, arrived: null, stock_status: "in_stock", created_at: "2026-08-14T10:00:00+00:00",
    ...overrides,
  };
}

describe("computeHomeReport's 'recent' list — the Home dashboard's recent-purchases card", () => {
  it("REQUIREMENT: uses the same authoritative order as everywhere else — order_date desc, then numeric SKU desc, never just insertion order", () => {
    const rows = [
      purchase({ id: "a", sku: "1803" }),
      purchase({ id: "b", sku: "1807" }),
      purchase({ id: "c", sku: "1810" }),
      purchase({ id: "d", sku: "1801" }),
    ];
    const report = computeHomeReport("all-time", rows, []);
    expect(report.recent.map(row => row.sku)).toEqual(["1810", "1807", "1803", "1801"]);
  });

  it("REQUIREMENT: numeric SKU comparison, not text — a purchase with SKU 1000 ranks above one with SKU 999 on the same date", () => {
    const rows = [purchase({ id: "a", sku: "999" }), purchase({ id: "b", sku: "1000" })];
    const report = computeHomeReport("all-time", rows, []);
    expect(report.recent.map(row => row.id)).toEqual(["b", "a"]);
  });

  it("a newer order date still outranks an older one with a higher SKU", () => {
    const rows = [
      purchase({ id: "old", order_date: "2026-08-01", sku: "9999" }),
      purchase({ id: "new", order_date: "2026-08-14", sku: "1" }),
    ];
    const report = computeHomeReport("all-time", rows, []);
    expect(report.recent.map(row => row.id)).toEqual(["new", "old"]);
  });

  it("still caps at 10 rows", () => {
    const rows = Array.from({ length: 15 }, (_, i) => purchase({ id: `id-${i}`, sku: String(i) }));
    const report = computeHomeReport("all-time", rows, []);
    expect(report.recent).toHaveLength(10);
  });
});
