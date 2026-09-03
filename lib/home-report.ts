import type { Expense, Purchase, SalesOrderListItem } from "@/lib/types";
import { comparePurchasesForDisplay } from "@/lib/purchase-order";
import { poundsToPence } from "@/lib/sales/money";

/**
 * Home dashboard period comparison + aggregation — extracted from
 * app/page.tsx so the date-boundary and totals logic is directly
 * unit-testable with a controlled system clock (this project's vitest
 * setup can't import .tsx components directly). Purely presentational
 * concerns (which cards/labels to render) stay in app/page.tsx; this
 * module owns only "which period means which dates" and "given a period
 * and the complete purchase/expense arrays, what are the totals."
 */

export type Period = "month" | "last-month" | "three-months" | "year" | "last-year" | "all-time";

export const periods: { value: Period; label: string }[] = [
  { value: "month", label: "This Month" },
  { value: "last-month", label: "Last Month" },
  { value: "three-months", label: "Last 3 Months" },
  { value: "year", label: "This Year" },
  { value: "last-year", label: "Last Year" },
  { value: "all-time", label: "All Time" },
];

export type DateRange = { start: string; end: string };

/** Local Y/M/D only — never routes through UTC, so this can't shift a date across a timezone boundary. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * `null` explicitly means "no date boundary" (All Time) — never
 * represented with sentinel dates like 1900-01-01/9999-12-31, since those
 * would silently exclude any record outside that arbitrary window (e.g. a
 * genuinely future-dated one) and would need updating if ever chosen
 * naively. Every other period keeps returning a real {start, end}.
 */
export function rangeFor(period: Period): DateRange | null {
  const now = new Date();
  if (period === "all-time") return null;
  if (period === "last-month") return {
    start: dateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    end: dateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
  };
  if (period === "three-months") return {
    start: dateKey(new Date(now.getFullYear(), now.getMonth() - 2, 1)),
    end: dateKey(new Date(now.getFullYear(), now.getMonth() + 1, 1)),
  };
  if (period === "year") return {
    start: dateKey(new Date(now.getFullYear(), 0, 1)),
    end: dateKey(new Date(now.getFullYear() + 1, 0, 1)),
  };
  // The complete previous calendar year — never the trailing 365 days, a
  // year-ago-to-date window, or a financial year. Jan 1 of last year up to
  // (exclusive) Jan 1 of this year, computed and compared as plain
  // YYYY-MM-DD strings the same way every other period is, so there's no
  // timezone conversion that could shift a record into the wrong day.
  if (period === "last-year") return {
    start: dateKey(new Date(now.getFullYear() - 1, 0, 1)),
    end: dateKey(new Date(now.getFullYear(), 0, 1)),
  };
  return {
    start: dateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: dateKey(new Date(now.getFullYear(), now.getMonth() + 1, 1)),
  };
}

export function inRange(value: string, start: string, end: string): boolean {
  return value >= start && value < end;
}

export type HomeReportSource = { source: string; spend: number; purchases: number; percentage: number; average: number };
export type HomeReport = {
  periodPurchases: Purchase[];
  stockSpend: number;
  expenseSpend: number;
  sources: HomeReportSource[];
  recent: Purchase[];
};

/**
 * Recomputed from scratch every call — never carries over a stale total
 * from a previously-selected period. For All Time (`rangeFor` returns
 * `null`), every successfully loaded record is included unconditionally —
 * no `order_date`/`purchase_date` filter is applied at all.
 */
export function computeHomeReport(period: Period, purchases: Purchase[], expenses: Expense[]): HomeReport {
  const range = rangeFor(period);
  const periodPurchases = range ? purchases.filter(row => inRange(row.order_date, range.start, range.end)) : purchases;
  const periodExpenses = range ? expenses.filter(row => inRange(row.purchase_date, range.start, range.end)) : expenses;
  const stockSpend = periodPurchases.reduce((total, row) => total + Number(row.price_purchased || 0), 0);
  const expenseSpend = periodExpenses.reduce((total, row) => total + Number(row.cost || 0), 0);
  const sourceMap = new Map<string, { spend: number; purchases: number }>();
  periodPurchases.forEach(row => {
    const source = row.purchased_from?.trim() || "Other";
    const current = sourceMap.get(source) || { spend: 0, purchases: 0 };
    current.spend += Number(row.price_purchased || 0);
    current.purchases += 1;
    sourceMap.set(source, current);
  });
  const sources = Array.from(sourceMap, ([source, values]) => ({
    source,
    ...values,
    percentage: stockSpend ? (values.spend / stockSpend) * 100 : 0,
    average: values.purchases ? values.spend / values.purchases : 0,
  })).sort((a, b) => b.spend - a.spend);
  // Same authoritative order as everywhere else purchases are displayed
  // (see lib/purchase-order.ts) — order_date desc, then numeric SKU desc,
  // then created_at desc, then id — never just date+created_at, which
  // left same-date Bulk Input rows in whatever order they happened to be
  // inserted.
  const recent = [...periodPurchases].sort(comparePurchasesForDisplay).slice(0, 10);
  return { periodPurchases, stockSpend, expenseSpend, sources, recent };
}

// ============================================================================
// Monthly net profit — the Home dashboard's headline "Net profit" figure.
//
//   Monthly net profit
//     = Σ canonical profit of every VALID sale whose sale_date is in the period
//     − Σ operating expenses whose expense date is in the period
//
// "Valid sale" is decided ONLY by the financial status column
// (sales_orders.status === "completed") — exactly as lib/sales/history.ts's
// computeHistoryKpis decides it. The operational process_status
// (awaiting_dispatch / sent / delivered_awaiting_payout / return_in_process /
// completed) never decides whether a sale contributes: a legitimate sale that
// simply has not finished shipping or paying out still belongs to the month it
// was sold in. Cancelled and refunded sales (status !== "completed") never
// contribute. The relevant date is always the sale's own sale_date, never a
// completion / dispatch / payout / created_at date.
//
// Per-sale profit is taken from the already-computed canonical `profitPence`
// (summed from each sale_item's saved profit — see app/api/sales/route.ts's
// hydrateOrders), so this module never re-derives it and the dashboard can
// never disagree with the sale detail page or the sales report. There is no
// partial-refund concept in the schema, so no adjusted-profit value exists to
// prefer; a return that is merely in progress keeps its full canonical profit
// until the sale is actually cancelled (status flips to "cancelled").
//
// Operating expenses are every row in the `expenses` table — a table entirely
// separate from `purchases`, with no category/status columns. Inventory/stock
// cost is already inside each sale's profit (via purchase_cost_snapshot), and
// nothing copies a stock purchase into `expenses`, so subtracting every
// expense row here cannot double-count cost of goods.
//
// Period boundaries reuse rangeFor + inRange: a half-open interval
// [firstOfMonth, firstOfNextMonth), compared as plain YYYY-MM-DD strings with
// no UTC/local conversion, so a record dated on the first or last day of a
// month — or either side of a year boundary — lands in exactly one month.
// "All Time" (rangeFor === null) applies no date filter at all.
// ============================================================================

export type MonthlyNetProfit = {
  salesProfitPence: number;
  operatingExpensePence: number;
  netProfitPence: number;
};

/** The only sale fields the net-profit calculation reads. */
export type NetProfitSale = Pick<SalesOrderListItem, "sale_date" | "status" | "profitPence">;

/** The final subtraction, in integer pence. Exposed so app/page.tsx and the tests apply the identical one line. */
export function netProfitPence(salesProfitPence: number, operatingExpensePence: number): number {
  return salesProfitPence - operatingExpensePence;
}

/** Σ operating-expense cost (integer pence) across the expense rows whose expense date (`purchase_date`) falls in `period`. */
export function periodOperatingExpensePence(period: Period, expenses: readonly Expense[]): number {
  const range = rangeFor(period);
  const inPeriod = range ? expenses.filter(row => inRange(row.purchase_date, range.start, range.end)) : expenses;
  // Summed in integer pence, never floating-point pounds, so e.g. 0.10 + 0.20
  // can never surface a 0.30000000000000004 artefact in the total.
  return inPeriod.reduce((total, row) => total + poundsToPence(Number(row.cost || 0)), 0);
}

/** Σ canonical profit (integer pence) of every valid sale (financial status "completed", ANY process_status) whose sale_date falls in `period`. */
export function periodValidSalesProfitPence(period: Period, sales: readonly NetProfitSale[]): number {
  const range = rangeFor(period);
  const inPeriod = range ? sales.filter(row => inRange(row.sale_date, range.start, range.end)) : sales;
  return inPeriod
    .filter(row => row.status === "completed")
    .reduce((total, row) => total + row.profitPence, 0);
}

/**
 * The authoritative monthly-net-profit calculation, as one pure function over
 * fully-loaded records — this is what the regression tests drive. app/page.tsx
 * takes the valid-sales-profit total from the sales API's server-side `kpis`
 * instead (it applies the identical `status === "completed"` rule over the
 * complete, un-paginated result set) and calls `netProfitPence` with it plus
 * `periodOperatingExpensePence`; both paths produce the same number by
 * construction.
 */
export function computeMonthlyNetProfit(period: Period, sales: readonly NetProfitSale[], expenses: readonly Expense[]): MonthlyNetProfit {
  const salesProfitPence = periodValidSalesProfitPence(period, sales);
  const operatingExpensePence = periodOperatingExpensePence(period, expenses);
  return { salesProfitPence, operatingExpensePence, netProfitPence: netProfitPence(salesProfitPence, operatingExpensePence) };
}
