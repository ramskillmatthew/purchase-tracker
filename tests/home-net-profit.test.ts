import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeHomeReport,
  computeMonthlyNetProfit,
  netProfitPence,
  periodOperatingExpensePence,
  periodValidSalesProfitPence,
} from "@/lib/home-report";
import { computeHistoryKpis } from "@/lib/sales/history";
import type { Expense, SalesOrderListItem } from "@/lib/types";

/**
 * Regression coverage for the Home dashboard "Net profit" card.
 *
 * Business definition under test:
 *   monthly net profit
 *     = Σ canonical profit of every VALID sale (financial status "completed",
 *       ANY operational process_status) whose sale_date is in the month
 *     − Σ operating-expense cost whose expense date is in the month
 *
 * These drive the real shared functions (lib/home-report.ts's net-profit
 * helpers, and lib/sales/history.ts's computeHistoryKpis — the exact
 * aggregation the sales API runs server-side), with realistic typed records
 * and the actual canonical statuses. No mocked/hard-coded totals.
 */

function sale(overrides: Partial<SalesOrderListItem> = {}): SalesOrderListItem {
  return {
    id: "s1", owner_id: "owner", sale_date: "2026-08-15", platform: "ebay", custom_platform_name: null,
    revenue_input_mode: "total", revenue_input_value: 100, total_revenue: 100, platform_fees: 0, postage: 0,
    status: "completed", process_status: "completed", cancelled_at: null, cancellation_stock_action: null,
    created_at: "2026-08-15T10:00:00Z", updated_at: "2026-08-15T10:00:00Z",
    itemCount: 1, profitPence: 5000, itemGroups: [{ description: "Item", quantity: 1 }],
    ...overrides,
  };
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "e1", purchase_date: "2026-08-10", purchased_from: "Royal Mail", arrived: null,
    item_description: "Packaging supplies", cost: 10, created_at: "2026-08-10T00:00:00Z", ...overrides,
  };
}

// August 2026 is the "selected month" for the plain-`month` cases below.
describe("Home monthly net profit — selected month is the current month", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 7, 20)); }); // 20 Aug 2026
  afterEach(() => { vi.useRealTimers(); });

  it("1. a Completed sale dated in the month contributes its canonical profit", () => {
    const result = computeMonthlyNetProfit("month", [sale({ profitPence: 5000 })], []);
    expect(result.salesProfitPence).toBe(5000);
    expect(result.netProfitPence).toBe(5000);
  });

  it("2. an Awaiting-dispatch sale contributes exactly like a Completed one with identical financials", () => {
    const awaiting = computeMonthlyNetProfit("month", [sale({ id: "a", process_status: "awaiting_dispatch", profitPence: 5000 })], []);
    const completed = computeMonthlyNetProfit("month", [sale({ id: "b", process_status: "completed", profitPence: 5000 })], []);
    expect(awaiting.netProfitPence).toBe(completed.netProfitPence);
    expect(awaiting.netProfitPence).toBe(5000);
    // and through the real server-side aggregation:
    expect(computeHistoryKpis([sale({ process_status: "awaiting_dispatch" })]).profitPence)
      .toBe(computeHistoryKpis([sale({ process_status: "completed" })]).profitPence);
  });

  it("3. a Sent / Dispatched sale contributes its profit", () => {
    expect(computeMonthlyNetProfit("month", [sale({ process_status: "sent", profitPence: 3200 })], []).netProfitPence).toBe(3200);
  });

  it("4. a Delivered · awaiting-payout sale contributes its profit", () => {
    expect(computeMonthlyNetProfit("month", [sale({ process_status: "delivered_awaiting_payout", profitPence: 4100 })], []).netProfitPence).toBe(4100);
  });

  it("5. moving a sale Awaiting dispatch -> Completed (no financial change) leaves net profit unchanged", () => {
    const before = computeMonthlyNetProfit("month", [sale({ process_status: "awaiting_dispatch", profitPence: 7777 })], [expense({ cost: 12 })]);
    const after = computeMonthlyNetProfit("month", [sale({ process_status: "completed", profitPence: 7777 })], [expense({ cost: 12 })]);
    expect(after.netProfitPence).toBe(before.netProfitPence);
  });

  it("6. a cancelled / voided sale does not contribute profit", () => {
    const result = computeMonthlyNetProfit("month", [sale({ status: "cancelled", process_status: "returned_cancelled", profitPence: 5000 })], []);
    expect(result.salesProfitPence).toBe(0);
    expect(result.netProfitPence).toBe(0);
  });

  it("7. a fully refunded sale does not contribute retained profit", () => {
    // schema: sales_orders.status in ('completed','refunded','cancelled')
    expect(computeMonthlyNetProfit("month", [sale({ status: "refunded", profitPence: 5000 })], []).netProfitPence).toBe(0);
  });

  it("8. a genuine sale with a return merely IN PROGRESS keeps its full canonical profit", () => {
    const result = computeMonthlyNetProfit("month", [sale({ status: "completed", process_status: "return_in_process", profitPence: 5000 })], []);
    expect(result.netProfitPence).toBe(5000);
  });

  it("11. £150 valid sales profit − £30 operating expenses = £120 net profit", () => {
    const sales = [sale({ id: "a", profitPence: 10000 }), sale({ id: "b", profitPence: 5000 })];
    const expenses = [expense({ id: "e1", cost: 20 }), expense({ id: "e2", cost: 10 })];
    const result = computeMonthlyNetProfit("month", sales, expenses);
    expect(result.salesProfitPence).toBe(15000);
    expect(result.operatingExpensePence).toBe(3000);
    expect(result.netProfitPence).toBe(12000);
  });

  it("13. cost of goods (already inside sale profit) is not deducted a second time via a stock-like expense", () => {
    // sale profit is ALREADY net of its £8 cost of goods; the calc only ever
    // sees profitPence + expense rows, never the purchases table, so inventory
    // cost can enter the figure at most once.
    const s = sale({ profitPence: 2000 }); // e.g. £30 revenue − £8 COGS − £2 fees
    const stockLikeExpense = expense({ purchased_from: "Vinted", arrived: true, item_description: "Bundle of tops", cost: 8 });
    const result = computeMonthlyNetProfit("month", [s], [stockLikeExpense]);
    expect(result.netProfitPence).toBe(2000 - 800); // the £8 subtracted exactly once
  });

  it("14. a month with no sales and no expenses is £0", () => {
    expect(computeMonthlyNetProfit("month", [], [])).toEqual({ salesProfitPence: 0, operatingExpensePence: 0, netProfitPence: 0 });
  });

  it("15. a month with no sales and £40 of operating expenses is −£40", () => {
    expect(computeMonthlyNetProfit("month", [], [expense({ cost: 40 })]).netProfitPence).toBe(-4000);
  });

  it("16. a legitimate loss-making sale contributes its negative profit", () => {
    expect(computeMonthlyNetProfit("month", [sale({ profitPence: -1500 })], []).netProfitPence).toBe(-1500);
  });

  it("17. records on the first and last day of the month are counted once; the 1st of next month is excluded", () => {
    const sales = [
      sale({ id: "first", sale_date: "2026-08-01", profitPence: 1000 }),
      sale({ id: "last", sale_date: "2026-08-31", profitPence: 2000 }),
      sale({ id: "next", sale_date: "2026-09-01", profitPence: 9999 }),
    ];
    expect(periodValidSalesProfitPence("month", sales)).toBe(3000);
    const expenses = [
      expense({ id: "first", purchase_date: "2026-08-01", cost: 5 }),
      expense({ id: "last", purchase_date: "2026-08-31", cost: 7 }),
      expense({ id: "next", purchase_date: "2026-09-01", cost: 100 }),
    ];
    expect(periodOperatingExpensePence("month", expenses)).toBe(1200);
  });

  it("20. currency stays in integer pence — no floating-point rounding artefacts", () => {
    expect(periodOperatingExpensePence("month", [expense({ id: "a", cost: 0.1 }), expense({ id: "b", cost: 0.2 })])).toBe(30);
    const result = computeMonthlyNetProfit("month", [sale({ profitPence: 100 })], [expense({ id: "a", cost: 0.1 }), expense({ id: "b", cost: 0.2 })]);
    expect(result.netProfitPence).toBe(70);
  });

  it("19. computeHomeReport (revenue/spend/expense-total cards) is untouched by the net-profit helpers", () => {
    const report = computeHomeReport("month", [], [expense({ cost: 40 })]);
    expect(report.expenseSpend).toBe(40); // still pounds, still the same field the other cards read
    expect(report.stockSpend).toBe(0);
  });
});

describe("Home monthly net profit — sale-date attribution and month boundaries", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("9/10. a 31 Aug sale completed/updated in September counts in August by its sale_date only", () => {
    vi.setSystemTime(new Date(2026, 8, 10)); // 10 Sep 2026 -> "last-month" is August
    const augustSale = sale({
      sale_date: "2026-08-31", profitPence: 4000,
      created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-20T00:00:00Z", // completion/payout activity in Sept
    });
    expect(computeMonthlyNetProfit("last-month", [augustSale], []).netProfitPence).toBe(4000); // August
    expect(computeMonthlyNetProfit("month", [augustSale], []).netProfitPence).toBe(0); // not September
    // a genuinely September-dated sale is the mirror image
    expect(computeMonthlyNetProfit("last-month", [sale({ sale_date: "2026-09-01", profitPence: 4000 })], []).netProfitPence).toBe(0);
  });

  it("12. an expense dated in September does not affect August's net profit", () => {
    vi.setSystemTime(new Date(2026, 8, 10)); // 10 Sep 2026
    expect(periodOperatingExpensePence("last-month", [expense({ purchase_date: "2026-09-05", cost: 50 })])).toBe(0);
    const result = computeMonthlyNetProfit("last-month", [sale({ sale_date: "2026-08-12", profitPence: 6000 })], [expense({ purchase_date: "2026-09-05", cost: 50 })]);
    expect(result.netProfitPence).toBe(6000);
  });

  it("18. December and January calculations never mix records across the year boundary", () => {
    vi.setSystemTime(new Date(2027, 0, 10)); // 10 Jan 2027
    const sales = [
      sale({ id: "dec", sale_date: "2026-12-31", profitPence: 5000 }),
      sale({ id: "jan", sale_date: "2027-01-01", profitPence: 8000 }),
    ];
    expect(periodValidSalesProfitPence("last-month", sales)).toBe(5000); // December only
    expect(periodValidSalesProfitPence("month", sales)).toBe(8000); // January only
  });

  it("boundary: leap-day 29 Feb sales land in February, not March", () => {
    vi.setSystemTime(new Date(2024, 2, 15)); // 15 Mar 2024 -> "last-month" = February 2024 (leap)
    expect(computeMonthlyNetProfit("last-month", [sale({ sale_date: "2024-02-29", profitPence: 2500 })], []).netProfitPence).toBe(2500);
    expect(computeMonthlyNetProfit("month", [sale({ sale_date: "2024-02-29", profitPence: 2500 })], []).netProfitPence).toBe(0);
  });
});

describe("Home monthly net profit — explicit required regressions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 7, 20)); });
  afterEach(() => { vi.useRealTimers(); });

  it("two identical sales, one Awaiting dispatch and one Completed, contribute the same profit amount", () => {
    const awaiting = sale({ id: "await", process_status: "awaiting_dispatch", sale_date: "2026-08-10", profitPence: 4200 });
    const completed = sale({ id: "done", process_status: "completed", sale_date: "2026-08-10", profitPence: 4200 });

    // pure home-report calc
    expect(periodValidSalesProfitPence("month", [awaiting])).toBe(periodValidSalesProfitPence("month", [completed]));
    // real sales-API server aggregation
    expect(computeHistoryKpis([awaiting]).profitPence).toBe(computeHistoryKpis([completed]).profitPence);
    // combined
    expect(computeMonthlyNetProfit("month", [awaiting, completed], []).netProfitPence).toBe(8400);
  });

  it("£150 sale profit − £30 eligible monthly expenses = £120 monthly net profit", () => {
    const sales = [sale({ id: "a", profitPence: 9000 }), sale({ id: "b", profitPence: 6000 })];
    const expenses = [
      expense({ id: "a", cost: 12 }),
      expense({ id: "b", cost: 18 }),
      expense({ id: "sep", purchase_date: "2026-09-02", cost: 999 }), // outside the month — ignored
    ];
    expect(netProfitPence(periodValidSalesProfitPence("month", sales), periodOperatingExpensePence("month", expenses))).toBe(12000);
    expect(computeMonthlyNetProfit("month", sales, expenses).netProfitPence).toBe(12000);
  });
});

describe("app/page.tsx wiring — Net profit card no longer gated on process_status, and deducts expenses + returns/losses", () => {
  it("reads server KPIs from the all-status sales response and subtracts period operating expenses AND the returns/losses adjustment", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("app/page.tsx", "utf8");
    // pulls the process-status-independent server KPIs (the "all" fetch)
    expect(source).toContain("setAllSalesKpis(allBody.kpis)");
    // Net profit value = valid sales profit − operating expenses − returns/losses adjustment, via the shared helper
    expect(source).toContain("netProfitWithReturnsLossesPence(allSalesKpis?.profitPence ?? 0, operatingExpensePence, returnLossAdjustmentPence)");
    expect(source).toContain("periodOperatingExpensePence(period, expenses)");
    // Stage 1: the signed adjustment comes from the dedicated endpoint, folded (added) into the card
    expect(source).toContain("/api/returns-losses/net-profit-adjustment?preset=");
    expect(source).toContain("setReturnLossAdjustmentPence(Number(body?.adjustmentPence) || 0)");
    // The visible audit trail is built from the exact same live inputs as the
    // card, rather than from a hard-coded reconciliation number.
    expect(source).toContain("Net profit calculation");
    expect(source).toContain("Total profit from valid sales");
    expect(source).toContain("Faulty, lost and written-off stock");
    expect(source).toContain("Profit before operating expenses");
    expect(source).toContain("Every figure below is recalculated from the records");
    // and is NOT the old process-status-gated completed-only figure
    expect(source).not.toContain('money.format((kpis?.profitPence ?? 0) / 100), caption: "Profit in period"');
  });
});
