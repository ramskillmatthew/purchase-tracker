import { poundsToPence } from "./money";
import { calculateMarginPercent } from "./profit";
import { daySpan, enumerateDays, enumerateMonths, formatReportDate, formatReportMonth, type DateRangePreset } from "./report-date-range";
import type { SalesPlatform } from "@/lib/types";

/**
 * Pure aggregation for the Sales Reporting dashboard — no database access
 * here (see app/api/sales/reports/route.ts for that), so every calculation
 * is directly, thoroughly unit-testable without a live database.
 *
 * Every money figure is summed from sale_items' own snapshot/allocated
 * fields — never from a live purchases-table join and never from the
 * order's own total_revenue/platform_fees/postage columns — so:
 *   - historical results are immune to a purchase being edited later
 *     (Category, condition, cost — all frozen at sale time);
 *   - every breakdown (category/condition/platform/chart) reconciles to the
 *     overall summary by construction: the overall summary IS the sum over
 *     every item, and each breakdown is the sum over a SUBSET of the exact
 *     same items, so summing the subsets can never disagree with the whole;
 *   - order-level fees/postage are never added on top of the per-item
 *     allocated shares that already sum to those same order totals, which
 *     would double-count them.
 * `profit` is always recomputed here as revenue − stock cost − fees −
 * postage (matching the exact stated formula) rather than trusted from
 * sale_items.profit, so this module's own arithmetic is self-contained and
 * verifiable independent of the write path that produced the stored value
 * (the two are mathematically identical by construction, but this module
 * never relies on that being true).
 */

export type ReportableSaleItem = {
  sales_order_id: string;
  category_snapshot: string;
  condition_group_snapshot: string;
  purchase_cost_snapshot: number | string;
  allocated_revenue: number | string;
  allocated_platform_fee: number | string;
  allocated_postage: number | string;
};

export type ReportableSalesOrder = {
  id: string;
  sale_date: string;
  platform: SalesPlatform;
  custom_platform_name: string | null;
};

export type ReportSummary = {
  revenuePence: number;
  profitPence: number;
  stockCostPence: number;
  feesPence: number;
  postagePence: number;
  orders: number;
  units: number;
  averageOrderValuePence: number | null;
  averageProfitPerUnitPence: number | null;
  marginPercent: number | null;
};

function itemMoney(item: ReportableSaleItem) {
  const revenuePence = poundsToPence(Number(item.allocated_revenue));
  const feePence = poundsToPence(Number(item.allocated_platform_fee));
  const postagePence = poundsToPence(Number(item.allocated_postage));
  const costPence = poundsToPence(Number(item.purchase_cost_snapshot));
  return { revenuePence, feePence, postagePence, costPence };
}

function emptySummary(orders: number): ReportSummary {
  return {
    revenuePence: 0, profitPence: 0, stockCostPence: 0, feesPence: 0, postagePence: 0,
    orders, units: 0, averageOrderValuePence: null, averageProfitPerUnitPence: null, marginPercent: null,
  };
}

/**
 * `orders` here is only ever used for its COUNT (and, elsewhere, to look up
 * each order's own sale_date/platform) — never to add a second copy of any
 * money field. This is what makes it safe to pass the full orders list
 * alongside every one of its items without "joining sales orders to
 * multiple sale items" ever multiplying an order-level total.
 */
export function computeReportSummary(orders: ReportableSalesOrder[], items: ReportableSaleItem[]): ReportSummary {
  if (items.length === 0) return emptySummary(orders.length);

  let revenuePence = 0, feesPence = 0, postagePence = 0, stockCostPence = 0;
  for (const item of items) {
    const money = itemMoney(item);
    revenuePence += money.revenuePence;
    feesPence += money.feePence;
    postagePence += money.postagePence;
    stockCostPence += money.costPence;
  }
  const profitPence = revenuePence - stockCostPence - feesPence - postagePence;
  const units = items.length;
  const orderCount = orders.length;

  return {
    revenuePence, profitPence, stockCostPence, feesPence, postagePence,
    orders: orderCount,
    units,
    averageOrderValuePence: orderCount > 0 ? Math.round(revenuePence / orderCount) : null,
    averageProfitPerUnitPence: units > 0 ? Math.round(profitPence / units) : null,
    marginPercent: calculateMarginPercent(profitPence, revenuePence),
  };
}

// ============================================================================
// Chart — revenue/profit over time, zero-filled, daily or monthly.
// ============================================================================

export type ChartGranularity = "daily" | "monthly";

export type ReportChartPoint = { key: string; label: string; revenuePence: number; profitPence: number };

/** Daily grouping stays legible up to about three months of bars; beyond that only monthly is offered. Matches "Short ranges should group by day. Longer ranges should group by month." */
export const MAX_DAILY_SPAN_DAYS = 92;

export function isDailyGranularitySensible(startIso: string, endIso: string): boolean {
  return daySpan(startIso, endIso) <= MAX_DAILY_SPAN_DAYS;
}

/**
 * Buckets every item into its PARENT ORDER's sale_date (sale_items carry no
 * date of their own — created_at is an insertion timestamp, not the
 * business sale date), then zero-fills every day/month in the requested
 * range so a genuinely quiet day/month still appears as a real £0 point
 * rather than being silently skipped.
 */
export function computeChartSeries(orders: ReportableSalesOrder[], items: ReportableSaleItem[], range: { start: string; end: string }, granularity: ChartGranularity): ReportChartPoint[] {
  const saleDateByOrderId = new Map(orders.map(order => [order.id, order.sale_date]));
  const bucketed = new Map<string, { revenuePence: number; profitPence: number }>();

  for (const item of items) {
    const saleDate = saleDateByOrderId.get(item.sales_order_id);
    if (!saleDate) continue; // defensive: every item's order must be present in `orders` — see the API route, which fetches them together.
    const bucketKey = granularity === "daily" ? saleDate : saleDate.slice(0, 7);
    const money = itemMoney(item);
    const profitPence = money.revenuePence - money.costPence - money.feePence - money.postagePence;
    const current = bucketed.get(bucketKey) ?? { revenuePence: 0, profitPence: 0 };
    current.revenuePence += money.revenuePence;
    current.profitPence += profitPence;
    bucketed.set(bucketKey, current);
  }

  const keys = granularity === "daily" ? enumerateDays(range.start, range.end) : enumerateMonths(range.start, range.end);
  return keys.map(key => {
    const bucket = bucketed.get(key);
    return {
      key,
      label: granularity === "daily" ? formatReportDate(key) : formatReportMonth(key),
      revenuePence: bucket?.revenuePence ?? 0,
      profitPence: bucket?.profitPence ?? 0,
    };
  });
}

// ============================================================================
// Category / condition-group / platform breakdowns.
// ============================================================================

export type CategoryReportRow = {
  category: string;
  revenuePence: number;
  profitPence: number;
  units: number;
  marginPercent: number | null;
  revenueSharePercent: number;
};

/** One row per distinct category_snapshot actually present — never a fixed hardcoded list, so a category retired from purchaseCategories in the future still reports correctly for historical sales that used it. Sorted by revenue descending by default; the page offers Revenue/Profit/Units sort client-side. */
export function computeCategoryBreakdown(items: ReportableSaleItem[]): CategoryReportRow[] {
  const byCategory = new Map<string, { revenuePence: number; profitPence: number; units: number }>();
  let totalRevenuePence = 0;
  for (const item of items) {
    const money = itemMoney(item);
    const profitPence = money.revenuePence - money.costPence - money.feePence - money.postagePence;
    const current = byCategory.get(item.category_snapshot) ?? { revenuePence: 0, profitPence: 0, units: 0 };
    current.revenuePence += money.revenuePence;
    current.profitPence += profitPence;
    current.units += 1;
    byCategory.set(item.category_snapshot, current);
    totalRevenuePence += money.revenuePence;
  }
  const rows: CategoryReportRow[] = Array.from(byCategory, ([category, values]) => ({
    category,
    revenuePence: values.revenuePence,
    profitPence: values.profitPence,
    units: values.units,
    marginPercent: calculateMarginPercent(values.profitPence, values.revenuePence),
    revenueSharePercent: totalRevenuePence > 0 ? Number(((values.revenuePence / totalRevenuePence) * 100).toFixed(2)) : 0,
  }));
  return rows.sort((a, b) => b.revenuePence - a.revenuePence);
}

export type ConditionGroupKey = "new" | "used" | "unknown";

export type ConditionReportRow = {
  conditionGroup: ConditionGroupKey;
  revenuePence: number;
  profitPence: number;
  units: number;
  averageProfitPerUnitPence: number | null;
  marginPercent: number | null;
};

const CONDITION_GROUP_ORDER: ConditionGroupKey[] = ["new", "used", "unknown"];

/** Always returns all three groups (new/used/unknown), even at zero, so totals visibly reconcile and a historical "unknown" condition is never silently dropped from the comparison. */
export function computeConditionGroupBreakdown(items: ReportableSaleItem[]): ConditionReportRow[] {
  const totals = new Map<ConditionGroupKey, { revenuePence: number; profitPence: number; units: number }>(
    CONDITION_GROUP_ORDER.map(group => [group, { revenuePence: 0, profitPence: 0, units: 0 }]),
  );
  for (const item of items) {
    const group: ConditionGroupKey = item.condition_group_snapshot === "new" || item.condition_group_snapshot === "used" ? item.condition_group_snapshot : "unknown";
    const money = itemMoney(item);
    const profitPence = money.revenuePence - money.costPence - money.feePence - money.postagePence;
    const current = totals.get(group)!;
    current.revenuePence += money.revenuePence;
    current.profitPence += profitPence;
    current.units += 1;
  }
  return CONDITION_GROUP_ORDER.map(group => {
    const values = totals.get(group)!;
    return {
      conditionGroup: group,
      revenuePence: values.revenuePence,
      profitPence: values.profitPence,
      units: values.units,
      averageProfitPerUnitPence: values.units > 0 ? Math.round(values.profitPence / values.units) : null,
      marginPercent: calculateMarginPercent(values.profitPence, values.revenuePence),
    };
  });
}

export type PlatformReportRow = {
  key: string;
  label: string;
  orders: number;
  units: number;
  revenuePence: number;
  profitPence: number;
  feesPence: number;
  postagePence: number;
  averageOrderValuePence: number | null;
  marginPercent: number | null;
};

const PLATFORM_LABELS: Record<SalesPlatform, string> = { vinted: "Vinted", ebay: "eBay", depop: "Depop", other: "Other" };

/**
 * One row per platform (vinted/ebay/depop), plus one row per DISTINCT
 * custom platform name used under "Other" (e.g. "Facebook", "Local shop"),
 * PLUS a combined "Other (all)" row summing every custom platform together
 * — so the page can show a clean Vinted-vs-eBay-vs-Depop-vs-Other headline
 * comparison while still making the individual custom names available.
 * Order/unit counts are taken directly from each order (never re-derived
 * from item counts in a way that could drift), and fees/postage are summed
 * from each item's own allocated share — never the order's own
 * platform_fees/postage column, which would double count.
 */
export function computePlatformBreakdown(orders: ReportableSalesOrder[], items: ReportableSaleItem[]): PlatformReportRow[] {
  const orderById = new Map(orders.map(order => [order.id, order]));
  const groups = new Map<string, { label: string; orderIds: Set<string>; revenuePence: number; profitPence: number; feesPence: number; postagePence: number; units: number }>();
  const otherCombinedKey = "other:__all__";

  function groupFor(key: string, label: string) {
    let group = groups.get(key);
    if (!group) { group = { label, orderIds: new Set(), revenuePence: 0, profitPence: 0, feesPence: 0, postagePence: 0, units: 0 }; groups.set(key, group); }
    return group;
  }

  for (const item of items) {
    const order = orderById.get(item.sales_order_id);
    if (!order) continue; // defensive — see computeChartSeries's identical guard.
    const money = itemMoney(item);
    const profitPence = money.revenuePence - money.costPence - money.feePence - money.postagePence;

    const isOther = order.platform === "other";
    const key = isOther ? `other:${(order.custom_platform_name ?? "").trim().toLowerCase() || "unspecified"}` : order.platform;
    const label = isOther ? (order.custom_platform_name?.trim() || "Other (unspecified)") : PLATFORM_LABELS[order.platform];
    const group = groupFor(key, label);
    group.orderIds.add(order.id);
    group.revenuePence += money.revenuePence;
    group.profitPence += profitPence;
    group.feesPence += money.feePence;
    group.postagePence += money.postagePence;
    group.units += 1;

    if (isOther) {
      const combined = groupFor(otherCombinedKey, "Other (all)");
      combined.orderIds.add(order.id);
      combined.revenuePence += money.revenuePence;
      combined.profitPence += profitPence;
      combined.feesPence += money.feePence;
      combined.postagePence += money.postagePence;
      combined.units += 1;
    }
  }

  const rows: PlatformReportRow[] = Array.from(groups, ([key, values]) => ({
    key,
    label: values.label,
    orders: values.orderIds.size,
    units: values.units,
    revenuePence: values.revenuePence,
    profitPence: values.profitPence,
    feesPence: values.feesPence,
    postagePence: values.postagePence,
    averageOrderValuePence: values.orderIds.size > 0 ? Math.round(values.revenuePence / values.orderIds.size) : null,
    marginPercent: calculateMarginPercent(values.profitPence, values.revenuePence),
  }));
  return rows.sort((a, b) => b.revenuePence - a.revenuePence);
}

// ============================================================================
// GET /api/sales/reports response shape — shared by the route (which builds
// it) and the reports page (which consumes it), so the two can never drift.
// ============================================================================

export type SalesReportResponse = {
  preset: DateRangePreset;
  // The CONCRETE resolved range actually used for every figure below —
  // never null, even for "All Time" (resolved to the earliest completed
  // sale's date through today; see app/api/sales/reports/route.ts).
  range: { start: string; end: string; label: string };
  summary: ReportSummary;
  chart: {
    dailyAvailable: boolean;
    // null (not an empty array) when daily grouping isn't offered for this
    // range — distinguishes "not computed" from "computed, no data".
    daily: ReportChartPoint[] | null;
    monthly: ReportChartPoint[];
  };
  categories: CategoryReportRow[];
  conditions: ConditionReportRow[];
  platforms: PlatformReportRow[];
};
