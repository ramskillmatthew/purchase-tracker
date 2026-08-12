import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHomeReport, inRange, periods, rangeFor, type Period } from "@/lib/home-report";
import type { Expense, Purchase } from "@/lib/types";

/** Every period tested here is statically known to return a real range — this just removes the null-check noise from each test. */
function rangeForNonNull(period: Period) {
  const range = rangeFor(period);
  if (!range) throw new Error(`Expected a real range for period "${period}", got null.`);
  return range;
}

function purchase(overrides: Partial<Purchase>): Purchase {
  return {
    id: "p1", order_date: "2026-01-01", purchased_from: "Vinted", seller_name: "", sku: "SKU1",
    item_description: "Item", item_size: "M", quantity: 1, item_condition: "Brand new",
    price_purchased: 10, arrived: null, stock_status: "in_stock", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
function expense(overrides: Partial<Expense>): Expense {
  return { id: "e1", purchase_date: "2026-01-01", purchased_from: "Royal Mail", arrived: null, item_description: "Postage", cost: 5, created_at: "2026-01-01T00:00:00Z", ...overrides };
}

describe("rangeFor('last-year') date boundaries (system date controlled explicitly)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("1/2. during 2026, Last Year starts 2025-01-01 and ends (exclusive) 2026-01-01, i.e. covers through 2025-12-31", () => {
    vi.setSystemTime(new Date(2026, 6, 27));
    const { start, end } = rangeForNonNull("last-year");
    expect(start).toBe("2025-01-01");
    expect(end).toBe("2026-01-01");
  });

  it("3/6. 2024-12-31 and 2026-01-01 are both excluded", () => {
    vi.setSystemTime(new Date(2026, 6, 27));
    const { start, end } = rangeForNonNull("last-year");
    expect(inRange("2024-12-31", start, end)).toBe(false);
    expect(inRange("2026-01-01", start, end)).toBe(false);
  });

  it("4/5. 2025-01-01 and 2025-12-31 are both included", () => {
    vi.setSystemTime(new Date(2026, 6, 27));
    const { start, end } = rangeForNonNull("last-year");
    expect(inRange("2025-01-01", start, end)).toBe(true);
    expect(inRange("2025-12-31", start, end)).toBe(true);
  });

  it("does not mean the previous 365 days, year-to-date one year ago, a financial year, or the last 12 months", () => {
    vi.setSystemTime(new Date(2026, 6, 27)); // 27 July 2026
    const { start, end } = rangeForNonNull("last-year");
    // the previous-365-days start would be ~28 July 2025, not 1 Jan 2025
    expect(start).not.toBe("2025-07-28");
    // year-to-date-one-year-ago would end ~27 July 2025, not include Dec 2025
    expect(inRange("2025-12-15", start, end)).toBe(true);
    // a rolling last-12-months window wouldn't include January 2025
    expect(inRange("2025-01-15", start, end)).toBe(true);
  });

  it("7. leap-year boundaries behave correctly (2024 was a leap year; 2025 is not)", () => {
    vi.setSystemTime(new Date(2025, 5, 1)); // during 2025 → Last Year = complete 2024
    const { start, end } = rangeForNonNull("last-year");
    expect(start).toBe("2024-01-01");
    expect(end).toBe("2025-01-01");
    expect(inRange("2024-02-29", start, end)).toBe(true); // leap day included
    expect(inRange("2025-02-29", start, end)).toBe(false); // would not be a real date the following (non-leap) year
  });

  it("Last Year is placed after This Year (All Time coverage lives in tests/home-report-all-time.test.ts)", () => {
    expect(periods.map(p => p.value).indexOf("year")).toBeLessThan(periods.map(p => p.value).indexOf("last-year"));
  });
});

describe("computeHomeReport for Last Year — dashboard totals include only last-year records", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); });
  afterEach(() => { vi.useRealTimers(); });

  const purchases: Purchase[] = [
    purchase({ id: "a", order_date: "2024-12-31", price_purchased: 100, purchased_from: "Depop" }), // excluded (too early)
    purchase({ id: "b", order_date: "2025-01-01", price_purchased: 20, purchased_from: "Vinted" }), // included (boundary)
    purchase({ id: "c", order_date: "2025-06-15", price_purchased: 30, purchased_from: "Vinted" }), // included
    purchase({ id: "d", order_date: "2025-12-31", price_purchased: 50, purchased_from: "eBay" }), // included (boundary)
    purchase({ id: "e", order_date: "2026-01-01", price_purchased: 999, purchased_from: "eBay" }), // excluded (too late)
    purchase({ id: "f", order_date: "2026-07-01", price_purchased: 999, purchased_from: "eBay" }), // excluded (this year, not last year)
  ];
  const expenses: Expense[] = [
    expense({ id: "x", purchase_date: "2024-12-31", cost: 40 }), // excluded
    expense({ id: "y", purchase_date: "2025-03-01", cost: 15 }), // included
    expense({ id: "z", purchase_date: "2026-07-01", cost: 999 }), // excluded
  ];

  it("8. Purchases count includes only last-year purchases", () => {
    const report = computeHomeReport("last-year", purchases, expenses);
    expect(report.periodPurchases.map(p => p.id).sort()).toEqual(["b", "c", "d"]);
  });

  it("9. Stock Spend includes only last-year purchases (20 + 30 + 50)", () => {
    const report = computeHomeReport("last-year", purchases, expenses);
    expect(report.stockSpend).toBe(100);
  });

  it("10. Business Expenses includes only last-year expenses (15)", () => {
    const report = computeHomeReport("last-year", purchases, expenses);
    expect(report.expenseSpend).toBe(15);
  });

  it("11. Total Spend (stockSpend + expenseSpend) equals last-year stock spend plus last-year business expenses", () => {
    const report = computeHomeReport("last-year", purchases, expenses);
    expect(report.stockSpend + report.expenseSpend).toBe(115);
  });

  it("12. source totals and averages use only last-year purchases", () => {
    const report = computeHomeReport("last-year", purchases, expenses);
    const vinted = report.sources.find(s => s.source === "Vinted");
    const ebay = report.sources.find(s => s.source === "eBay");
    const depop = report.sources.find(s => s.source === "Depop");
    expect(vinted).toMatchObject({ spend: 50, purchases: 2, average: 25 });
    expect(ebay).toMatchObject({ spend: 50, purchases: 1, average: 50 });
    expect(depop).toBeUndefined(); // its only purchase (id "a") is outside last year
  });

  it("13. empty Last Year data produces zero/empty states, not errors or stale figures", () => {
    const report = computeHomeReport("last-year", [], []);
    expect(report.periodPurchases).toEqual([]);
    expect(report.stockSpend).toBe(0);
    expect(report.expenseSpend).toBe(0);
    expect(report.sources).toEqual([]);
    expect(report.recent).toEqual([]);
  });

  it("14. switching periods never retains a stale total from the previously-selected period", () => {
    const thisYear = computeHomeReport("year", purchases, expenses);
    const lastYear = computeHomeReport("last-year", purchases, expenses);
    expect(thisYear.stockSpend).not.toBe(lastYear.stockSpend);
    expect(thisYear.periodPurchases.map(p => p.id)).not.toEqual(lastYear.periodPurchases.map(p => p.id));
  });
});

describe("REGRESSION: existing periods are unaffected by adding Last Year", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 6, 27)); }); // 27 July 2026
  afterEach(() => { vi.useRealTimers(); });

  it("This Month covers 2026-07-01 to before 2026-08-01", () => {
    const { start, end } = rangeForNonNull("month");
    expect(start).toBe("2026-07-01");
    expect(end).toBe("2026-08-01");
  });

  it("Last Month covers 2026-06-01 to before 2026-07-01", () => {
    const { start, end } = rangeForNonNull("last-month");
    expect(start).toBe("2026-06-01");
    expect(end).toBe("2026-07-01");
  });

  it("Last 3 Months covers 2026-05-01 to before 2026-08-01", () => {
    const { start, end } = rangeForNonNull("three-months");
    expect(start).toBe("2026-05-01");
    expect(end).toBe("2026-08-01");
  });

  it("This Year covers 2026-01-01 to before 2027-01-01", () => {
    const { start, end } = rangeForNonNull("year");
    expect(start).toBe("2026-01-01");
    expect(end).toBe("2027-01-01");
  });
});
