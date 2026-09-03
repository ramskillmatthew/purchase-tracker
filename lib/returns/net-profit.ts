import { computeReturnsLossesKpis, isCountedReturnInRange, isLossInRange, type ResolvedRange } from "@/lib/returns/kpi";
import { poundsToPence } from "@/lib/sales/money";
import type { LossRecordRow, ReturnRecordRow, SoldUnitCohortEntry } from "@/lib/returns/types";

/**
 * Returns, Losses & Write-offs — Home dashboard net-profit integration.
 *
 * The Home "Net profit" card already computes (see lib/home-report.ts, added
 * for the monthly-net-profit fix):
 *   netProfitPence = validSalesProfitPence - operatingExpensePence
 *
 * This module produces the ADDITIONAL SIGNED adjustment for the same period
 * from returns + losses, so:
 *   netProfitPence = validSalesProfitPence
 *                  - operatingExpensePence
 *                  + periodReturnLossAdjustmentPence   (SIGNED — usually <= 0)
 *
 * The adjustment is NOT clamped. It is the algebraic sum of:
 *   returns:  -(signed original profit of the returned units)   <- reverses the
 *             sale's profit contribution: -£21.73 for a +£21.73 sale, but
 *             +£5.00 for a -£5.00 loss-making sale (you are no longer carrying
 *             that £5 loss). Plus -return postage / -unrecovered / -other /
 *             -inventory write-off (all genuine extra costs, always negative).
 *   losses:   -(stock value removed + customer refund + other costs)  <- always
 *             negative; a genuine write-off must keep its full negative effect.
 * So a single loss-making-sale return makes the period +£5 (a -£5 base nets to
 * £0); a genuine £47 lost-inventory loss makes it -£47; mixed cases sum
 * algebraically with no double-count and no inappropriate clamp.
 *
 * `periodReturnLossAdjustmentPence` is the SAME totalNetProfitImpactPence the
 * page's own KPI strip shows, so the card and the table can never disagree.
 * Every component is counted exactly once (see kpi.ts's own comment).
 *
 * DATE BASIS: a non-cancelled, non-deleted return contributes as soon as it
 * is LOGGED — recognised in the month of started_on while active, and in
 * recognition_month once completed (the August-sale / September-return rule),
 * never both. Losses use event_date/event_month. The original sale's own
 * profit row is never touched; the recognition month simply receives this
 * negative adjustment, so the Home Net Profit card nets to the correct
 * current figure the moment a return is logged.
 */
export function periodReturnLossAdjustmentPence(params: {
  returns: ReturnRecordRow[];
  losses: LossRecordRow[];
  range: ResolvedRange;
}): number {
  const kpis = computeReturnsLossesKpis({
    returns: params.returns,
    losses: params.losses,
    soldUnitCohort: [] as SoldUnitCohortEntry[], // return-rate not needed for the adjustment
    range: params.range,
  });
  return kpis.totalNetProfitImpactPence;
}

/**
 * Net profit including returns/losses. `returnLossAdjustmentPence` is the
 * SIGNED value from periodReturnLossAdjustmentPence (kpis.totalNetProfitImpact
 * Pence) and is ADDED as-is — never clamped.
 *
 * Clamping with `Math.min(0, adj)` would be a bug: reversing a loss-making
 * sale's -£5 profit is a legitimate +£5 adjustment (a -£5 base must net to
 * £0), and clamping would silently drop it and leave Home at -£5.
 *
 *   +£21.73 sale, its return active/completed:  adj = -£21.73  ->  base +21.73 nets to £0
 *    -£5.00 sale, its return active/completed:  adj = +£5.00   ->  base  -5.00 nets to £0
 *    zero-profit sale return:                    adj =  £0.00   ->  base unchanged
 *   genuine £47 lost-inventory loss:             adj = -£47.00  ->  full negative effect kept
 *
 * The adjustment can never be a spurious "bonus": every component except the
 * signed profit reversal is a cost (>= 0 by DB constraint), so a positive
 * total can ONLY come from reversing loss-making sales — which is correct.
 */
export function netProfitWithReturnsLossesPence(
  salesProfitPence: number,
  operatingExpensePence: number,
  returnLossAdjustmentPence: number,
): number {
  return salesProfitPence - operatingExpensePence + returnLossAdjustmentPence;
}

function num(v: number | string | null | undefined): number { const n = typeof v === "string" ? Number(v) : v ?? 0; return Number.isFinite(n) ? n : 0; }
function p(v: number | string | null | undefined): number { return poundsToPence(num(v)); }

/**
 * The per-component breakdown of the same adjustment, so the Home dashboard
 * (and Stage 2) can show WHY without recomputing. Every component is counted
 * exactly once and sums to `periodReturnLossAdjustmentPence` (negated). A
 * cancelled or soft-deleted record contributes nothing; every other return
 * (active or completed) contributes in its single recognition period.
 */
export type NetProfitAdjustmentBreakdown = {
  profitReversedPence: number;
  returnPostagePence: number;
  unrecoveredReturnCostsPence: number;
  inventoryWriteOffPence: number;
  lostInventoryPence: number;
  unsellableStockPence: number;
  otherWriteOffPence: number;
  refundWithoutReturnPence: number;
};

export function netProfitAdjustmentBreakdown(params: {
  returns: ReturnRecordRow[];
  losses: LossRecordRow[];
  range: ResolvedRange;
}): NetProfitAdjustmentBreakdown {
  // Active + completed returns, each in its single recognition period.
  const counted = params.returns.filter(r => isCountedReturnInRange(r, params.range));
  const losses = params.losses.filter(l => !l.deleted_at && isLossInRange(l, params.range));
  const sumLoss = (type: LossRecordRow["loss_type"], f: (l: LossRecordRow) => number) =>
    losses.filter(l => l.loss_type === type).reduce((s, l) => s + f(l), 0);

  return {
    profitReversedPence: counted.reduce((s, r) => s + p(r.profit_reversed), 0),
    returnPostagePence: counted.reduce((s, r) => s + p(r.return_postage), 0),
    unrecoveredReturnCostsPence: counted.reduce((s, r) => s + p(r.unrecovered_costs) + p(r.other_costs), 0),
    inventoryWriteOffPence: counted.reduce((s, r) => s + (r.outcome === "buyer_refunded_no_return" ? p(r.original_stock_cost) : 0), 0),
    lostInventoryPence: sumLoss("lost_inventory", l => p(l.stock_value_removed) + p(l.other_costs)),
    unsellableStockPence: sumLoss("unsellable_purchase", l => p(l.stock_value_removed) + p(l.other_costs)),
    otherWriteOffPence: sumLoss("other_write_off", l => p(l.stock_value_removed) + p(l.other_costs)),
    refundWithoutReturnPence: sumLoss("refund_without_return", l => p(l.customer_refund) + p(l.stock_value_removed) + p(l.other_costs)),
  };
}

export function breakdownTotalPence(b: NetProfitAdjustmentBreakdown): number {
  return -(b.profitReversedPence + b.returnPostagePence + b.unrecoveredReturnCostsPence + b.inventoryWriteOffPence
    + b.lostInventoryPence + b.unsellableStockPence + b.otherWriteOffPence + b.refundWithoutReturnPence) || 0;
}
