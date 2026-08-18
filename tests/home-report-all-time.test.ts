import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHomeReport, periods, rangeFor } from "@/lib/home-report";
import type { Expense, Purchase } from "@/lib/types";

function purchase(overrides: Partial<Purchase>): Purchase {
  return {
    id: "p1", order_date: "2026-01-01", purchased_from: "Vinted", seller_name: "", sku: "SKU1",
    item_description: "Item", item_size: "M", quantity: 1, item_condition: "Brand new", category: "Other",
    price_purchased: 10, arrived: null, stock_status: "in_stock", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
function expense(overrides: Partial<Expense>): Expense {
  return { id: "e1", purchase_date: "2026-01-01", purchased_from: "Royal Mail", arrived: null, item_description: "Postage", cost: 5, created_at: "2026-01-01T00:00:00Z", ...overrides };
}

describe("All Time period definition", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); });
  afterEach(() => { vi.useRealTimers(); });

  it("1. appears after Last Year in the period list", () => {
    const values = periods.map(p => p.value);
    expect(values.indexOf("last-year")).toBeLessThan(values.indexOf("all-time"));
    expect(periods[periods.length - 1]).toEqual({ value: "all-time", label: "All Time" });
  });

  it("2/3. has no start date and no end date — represented explicitly as null, never a sentinel date", () => {
    const range = rangeFor("all-time");
    expect(range).toBeNull();
  });

  it("28. all six period options render", () => {
    expect(periods).toHaveLength(6);
    expect(periods.map(p => p.value)).toEqual(["month", "last-month", "three-months", "year", "last-year", "all-time"]);
    expect(periods.map(p => p.label)).toEqual(["This Month", "Last Month", "Last 3 Months", "This Year", "Last Year", "All Time"]);
  });
});

describe("computeHomeReport('all-time') includes every record regardless of date", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); });
  afterEach(() => { vi.useRealTimers(); });

  const purchases: Purchase[] = [
    purchase({ id: "old", order_date: "2019-03-01", price_purchased: 100, purchased_from: "Depop" }), // 6. before current year
    purchase({ id: "mid", order_date: "2023-11-05", price_purchased: 40, purchased_from: "Vinted" }),
    purchase({ id: "now", order_date: "2026-07-01", price_purchased: 30, purchased_from: "Vinted" }), // 7. current year
    purchase({ id: "future", order_date: "2030-01-01", price_purchased: 999, purchased_from: "eBay" }), // 8. future-dated
  ];
  const expenses: Expense[] = [
    expense({ id: "old-e", purchase_date: "2018-01-01", cost: 12 }),
    expense({ id: "now-e", purchase_date: "2026-07-01", cost: 8 }),
    expense({ id: "future-e", purchase_date: "2031-06-01", cost: 500 }), // future-dated
  ];

  it("4/5/6/7/8. purchases and expenses from every year — past, present, and future — are all included", () => {
    const report = computeHomeReport("all-time", purchases, expenses);
    expect(report.periodPurchases.map(p => p.id).sort()).toEqual(["future", "mid", "now", "old"]);
    expect(report.periodPurchases).toHaveLength(purchases.length);
  });

  it("9. Purchases count uses the complete dataset", () => {
    const report = computeHomeReport("all-time", purchases, expenses);
    expect(report.periodPurchases.length).toBe(4);
  });

  it("10. Stock Spend uses every purchase (100 + 40 + 30 + 999)", () => {
    const report = computeHomeReport("all-time", purchases, expenses);
    expect(report.stockSpend).toBe(1169);
  });

  it("11. Business Expenses uses every expense (12 + 8 + 500)", () => {
    const report = computeHomeReport("all-time", purchases, expenses);
    expect(report.expenseSpend).toBe(520);
  });

  it("12. Total Spend equals complete stock spend plus complete business expenses", () => {
    const report = computeHomeReport("all-time", purchases, expenses);
    expect(report.stockSpend + report.expenseSpend).toBe(1689);
  });

  it("13/14/15/16. Where My Money Went / Top Spending Sources include every source, with correct counts and averages", () => {
    const report = computeHomeReport("all-time", purchases, expenses);
    const sourceNames = report.sources.map(s => s.source).sort();
    expect(sourceNames).toEqual(["Depop", "Vinted", "eBay"].sort());
    const vinted = report.sources.find(s => s.source === "Vinted");
    expect(vinted).toMatchObject({ spend: 70, purchases: 2, average: 35 });
    const depop = report.sources.find(s => s.source === "Depop");
    expect(depop).toMatchObject({ spend: 100, purchases: 1, average: 100 });
  });

  it("17. an empty dataset returns correct zero/empty states", () => {
    const report = computeHomeReport("all-time", [], []);
    expect(report.periodPurchases).toEqual([]);
    expect(report.stockSpend).toBe(0);
    expect(report.expenseSpend).toBe(0);
    expect(report.sources).toEqual([]);
    expect(report.recent).toEqual([]);
  });

  it("18. purchases-only data (no expenses) works correctly and independently", () => {
    const report = computeHomeReport("all-time", purchases, []);
    expect(report.periodPurchases).toHaveLength(4);
    expect(report.stockSpend).toBe(1169);
    expect(report.expenseSpend).toBe(0);
  });

  it("19. expenses-only data (no purchases) works correctly and independently", () => {
    const report = computeHomeReport("all-time", [], expenses);
    expect(report.periodPurchases).toEqual([]);
    expect(report.stockSpend).toBe(0);
    expect(report.expenseSpend).toBe(520);
  });

  it("20. switching from Last Year to All Time does not retain the previous period's filtering", () => {
    const lastYear = computeHomeReport("last-year", purchases, expenses);
    const allTime = computeHomeReport("all-time", purchases, expenses);
    expect(allTime.periodPurchases.length).toBeGreaterThan(lastYear.periodPurchases.length);
    expect(allTime.stockSpend).not.toBe(lastYear.stockSpend);
  });

  it("21. switching from All Time back to another period restores that period's own filtering", () => {
    const allTime = computeHomeReport("all-time", purchases, expenses);
    const thisYear = computeHomeReport("year", purchases, expenses);
    expect(thisYear.periodPurchases.map(p => p.id)).toEqual(["now"]);
    expect(thisYear.periodPurchases.length).toBeLessThan(allTime.periodPurchases.length);
  });

  it("27. records beyond the old 1,000-row limit affect All Time totals (a large dataset is not truncated client-side)", () => {
    const many = Array.from({ length: 1798 }, (_, index) => purchase({ id: `bulk-${index}`, order_date: "2020-01-01", price_purchased: 1, purchased_from: "Vinted" }));
    const report = computeHomeReport("all-time", many, []);
    expect(report.periodPurchases).toHaveLength(1798);
    expect(report.stockSpend).toBe(1798);
  });
});

describe("REGRESSION: existing periods still work correctly alongside All Time (22-26)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); });
  afterEach(() => { vi.useRealTimers(); });

  const purchases: Purchase[] = [
    purchase({ id: "a", order_date: "2026-07-15", price_purchased: 10 }), // this month
    purchase({ id: "b", order_date: "2026-06-15", price_purchased: 20 }), // last month
    purchase({ id: "c", order_date: "2026-05-15", price_purchased: 30 }), // last 3 months
    purchase({ id: "d", order_date: "2026-01-15", price_purchased: 40 }), // this year, not recent
    purchase({ id: "e", order_date: "2025-06-15", price_purchased: 50 }), // last year
  ];

  it("22. This Month is unchanged", () => {
    expect(computeHomeReport("month", purchases, []).periodPurchases.map(p => p.id)).toEqual(["a"]);
  });
  it("23. Last Month is unchanged", () => {
    expect(computeHomeReport("last-month", purchases, []).periodPurchases.map(p => p.id)).toEqual(["b"]);
  });
  it("24. Last 3 Months is unchanged", () => {
    expect(computeHomeReport("three-months", purchases, []).periodPurchases.map(p => p.id).sort()).toEqual(["a", "b", "c"]);
  });
  it("25. This Year is unchanged", () => {
    expect(computeHomeReport("year", purchases, []).periodPurchases.map(p => p.id).sort()).toEqual(["a", "b", "c", "d"]);
  });
  it("26. Last Year is unchanged", () => {
    expect(computeHomeReport("last-year", purchases, []).periodPurchases.map(p => p.id)).toEqual(["e"]);
  });
});

describe("29. responsive control renders structurally with six options (app/page.tsx source check)", () => {
  it("app/page.tsx maps over the full periods array without slicing or omitting any option", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("app/page.tsx", "utf8");
    expect(source).toContain("periods.map(option =>");
    expect(source).not.toMatch(/periods\.slice/);
    expect(source).not.toMatch(/periods\.filter/);
  });
});
