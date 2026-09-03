import { poundsToPence } from "@/lib/sales/money";
import { precisionDateInRange, readPrecisionDate } from "@/lib/returns/date-precision";
import type { LossRecordRow, ReturnRecordRow, SoldUnitCohortEntry } from "@/lib/returns/types";

/**
 * Returns, Losses & Write-offs — the ONE definition of every page KPI.
 * Never recompute these in a component; call computeReturnsLossesKpis with
 * the FULL filtered dataset (not the visible table page). All figures are
 * integer PENCE; format at the edge.
 *
 * A resolved reporting range is inclusive `start`/`end` YYYY-MM-DD, or null
 * on either side for "All Time" (reuse lib/sales/report-date-range.ts's
 * resolveDateFilter to produce it — do not re-implement period maths here).
 *
 * BUSINESS DATE per record type (documented, consistent):
 *   - Returns  -> once a return is LOGGED (workflow_status in return_started /
 *     item_sent / return_delivered / return_completed) and NOT cancelled and
 *     NOT soft-deleted, it contributes to the financial KPIs 1-5 immediately.
 *     Its recognition period is:
 *       * return_completed        -> recognition_month (the user-selected /
 *                                    completion month — the August-sale /
 *                                    September-return rule)
 *       * any active state        -> the month of started_on (started_precision)
 *     A return is EITHER active OR completed, never both, so it is recognised
 *     in exactly one period at a time — advancing/completing/cancelling moves
 *     or removes that single recognition, never double-counts.
 *   - Losses   -> event_date / event_month (never logged_date).
 *
 * Return rate cohort (single documented definition): counted returned units
 * in the period (active or completed), divided by the number of non-cancelled
 * SOLD UNITS whose sale_date falls in the same period. Division-by-zero -> 0%.
 */

export type ResolvedRange = { start: string | null; end: string | null };

export type ReturnsLossesKpis = {
  itemsReturned: number;
  revenueLostFromReturnsPence: number;
  returnRatePercent: number;
  profitLostFromReturnsPence: number;
  returnPostagePence: number;
  refundsWithoutReturnPence: number;
  lostInventoryPence: number;
  unsellableStockPence: number;
  otherWriteOffPence: number;
  /** refundsWithoutReturn (customer refund + written-off stock cost + other
   * costs) + lostInventory + unsellableStock + otherWriteOff — the
   * "Total losses" headline. Does NOT include return reversals. */
  totalLossesPence: number;
  /** Sum of every negative net-profit adjustment recognised in the period —
   * returns + losses combined, with no component double-counted. Feeds the
   * Home dashboard (see net-profit.ts). */
  totalNetProfitImpactPence: number;
};

function num(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  return Number.isFinite(n) ? n : 0;
}
function pence(value: number | string | null | undefined): number {
  return poundsToPence(num(value));
}

/** A return that has reached 'return_completed' and whose recognition month
 * falls inside the range. Cancelled returns never count. */
export function isCompletedReturnInRange(row: ReturnRecordRow, range: ResolvedRange): boolean {
  if (row.workflow_status !== "return_completed" || !row.recognition_month) return false;
  return precisionDateInRange({ precision: "month", month: row.recognition_month }, range.start, range.end);
}

/** The single period a return is recognised in right now: its recognition
 * month once completed, otherwise the month of started_on. Returns null for a
 * cancelled return or one with no usable date. */
export function returnRecognitionDate(row: ReturnRecordRow) {
  if (row.workflow_status === "return_cancelled") return null;
  if (row.workflow_status === "return_completed") {
    return row.recognition_month ? { precision: "month" as const, month: row.recognition_month } : null;
  }
  return readPrecisionDate(row.started_on, row.started_precision);
}

/** Whether a NON-CANCELLED, NON-DELETED return (active OR completed) is
 * recognised inside the range. This is what every financial return KPI and
 * the Home dashboard adjustment key on — an in-progress return counts from
 * `return_started` onward, not only after completion. */
export function isCountedReturnInRange(row: ReturnRecordRow, range: ResolvedRange): boolean {
  if (row.deleted_at || row.workflow_status === "return_cancelled") return false;
  const pd = returnRecognitionDate(row);
  return pd ? precisionDateInRange(pd, range.start, range.end) : false;
}

export function isLossInRange(row: LossRecordRow, range: ResolvedRange): boolean {
  const pd = readPrecisionDate(row.event_date, row.event_precision) ?? { precision: "month" as const, month: row.event_month };
  return precisionDateInRange(pd, range.start, range.end);
}

/** A record that has been soft-deleted (deleted_at set) never contributes to
 * any KPI or the dashboard adjustment — it is fully reversed. */
export function isActiveRecord(row: { deleted_at?: string | null }): boolean {
  return !row.deleted_at;
}

function soldUnitInRange(entry: SoldUnitCohortEntry, range: ResolvedRange): boolean {
  if (entry.saleStatus === "cancelled") return false;
  if (range.start && entry.saleDate < range.start) return false;
  if (range.end && entry.saleDate > range.end) return false;
  return true;
}

export function computeReturnsLossesKpis(params: {
  returns: ReturnRecordRow[];
  losses: LossRecordRow[];
  soldUnitCohort: SoldUnitCohortEntry[];
  range: ResolvedRange;
}): ReturnsLossesKpis {
  const { returns, losses, soldUnitCohort, range } = params;

  // Active (in-progress) AND completed returns both contribute, keyed on the
  // single period each is recognised in (started month / recognition month).
  const countedReturns = returns.filter(r => isCountedReturnInRange(r, range));
  const itemsReturned = countedReturns.reduce((sum, r) => sum + Math.max(0, Math.trunc(r.quantity)), 0);
  const revenueLostFromReturnsPence = countedReturns.reduce((sum, r) => sum + pence(r.revenue_reversed), 0);
  const profitLostFromReturnsPence = countedReturns.reduce((sum, r) => sum + pence(r.profit_reversed), 0);
  const returnPostagePence = countedReturns.reduce((sum, r) => sum + pence(r.return_postage), 0);
  const returnUnrecoveredPence = countedReturns.reduce((sum, r) => sum + pence(r.unrecovered_costs) + pence(r.other_costs), 0);
  const returnWriteOffPence = countedReturns.reduce(
    (sum, r) => sum + (r.outcome === "buyer_refunded_no_return" ? pence(r.original_stock_cost) : 0),
    0,
  );

  const soldUnits = soldUnitCohort.filter(u => soldUnitInRange(u, range)).length;
  const returnRatePercent = soldUnits === 0
    ? 0
    : Number(((itemsReturned / soldUnits) * 100).toFixed(2));

  const lossesInRange = losses.filter(l => isActiveRecord(l) && isLossInRange(l, range));
  const sumLoss = (type: LossRecordRow["loss_type"], field: (l: LossRecordRow) => number) =>
    lossesInRange.filter(l => l.loss_type === type).reduce((sum, l) => sum + field(l), 0);

  const refundsWithoutReturnPence = sumLoss("refund_without_return", l => pence(l.customer_refund));
  const refundStockWriteOffPence = sumLoss("refund_without_return", l => pence(l.stock_value_removed));
  const refundOtherCostsPence = sumLoss("refund_without_return", l => pence(l.other_costs));
  const lostInventoryPence = sumLoss("lost_inventory", l => pence(l.stock_value_removed) + pence(l.other_costs));
  const unsellableStockPence = sumLoss("unsellable_purchase", l => pence(l.stock_value_removed) + pence(l.other_costs));
  const otherWriteOffPence = sumLoss("other_write_off", l => pence(l.stock_value_removed) + pence(l.other_costs));

  // The one combined negative adjustment for the period — each component
  // counted exactly once:
  //   returns:  -profit_reversed - return_postage - unrecovered_costs
  //             - (stock write-off only when the item was NOT returned)
  //   losses:   -stock_value_removed - other_costs  (all four types)
  //             + for refund_without_return also -customer_refund
  const totalNetProfitImpactPence = -(
    profitLostFromReturnsPence + returnPostagePence + returnUnrecoveredPence + returnWriteOffPence
    + lostInventoryPence + unsellableStockPence + otherWriteOffPence
    + refundsWithoutReturnPence + refundStockWriteOffPence + refundOtherCostsPence
  ) || 0; // normalise -0 -> 0

  const totalLossesPence = refundsWithoutReturnPence + refundStockWriteOffPence + refundOtherCostsPence
    + lostInventoryPence + unsellableStockPence + otherWriteOffPence;

  return {
    itemsReturned,
    revenueLostFromReturnsPence,
    returnRatePercent,
    profitLostFromReturnsPence,
    returnPostagePence,
    refundsWithoutReturnPence,
    lostInventoryPence,
    unsellableStockPence,
    otherWriteOffPence,
    totalLossesPence,
    totalNetProfitImpactPence,
  };
}
