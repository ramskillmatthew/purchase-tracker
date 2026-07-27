import type { Expense, Purchase } from "@/lib/types";

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
  const recent = [...periodPurchases].sort((a, b) => b.order_date.localeCompare(a.order_date) || b.created_at.localeCompare(a.created_at)).slice(0, 10);
  return { periodPurchases, stockSpend, expenseSpend, sources, recent };
}
