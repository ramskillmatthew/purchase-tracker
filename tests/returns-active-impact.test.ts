import { describe, expect, it } from "vitest";
import { returnNetProfitImpactPence } from "@/lib/returns/financial";
import { computeReturnsLossesKpis, isCountedReturnInRange } from "@/lib/returns/kpi";
import { netProfitAdjustmentBreakdown, breakdownTotalPence, netProfitWithReturnsLossesPence } from "@/lib/returns/net-profit";
import { returnRow as ret } from "./returns-fixtures";

/**
 * The exact live-test example the corrective pass must satisfy end-to-end:
 *   completed Vinted sale — revenue £25.00, original profit £21.73, qty 1,
 *   sale date 02/09/2026. A return is logged and advanced (return_started ->
 *   return_delivered) but NOT completed.
 *
 * Required:
 *   Active row impact          -£21.73
 *   Items returned              1
 *   Revenue reversed            £25.00
 *   Profit reversed             £21.73
 *   Return postage              £0.00
 *   Current aggregate net profit £0.00   (counted EXACTLY once)
 * and cancelling the return restores £21.73 to net profit exactly once.
 *
 * Figures are treated as evidence, not hardcoded into production code.
 */
const SEPT = { start: "2026-09-01", end: "2026-09-30" };
const AUG = { start: "2026-08-01", end: "2026-08-31" };

// A just-logged, still-active return of that sale.
const activeReturn = ret({
  id: "vans-return", workflow_status: "return_delivered", outcome: null, recognition_month: null,
  completed_on: null, completed_precision: null,
  started_on: "2026-09-02", started_precision: "exact", quantity: 1,
  revenue_reversed: 25, profit_reversed: 21.73,
  original_sale_revenue: 25, original_sale_profit: 21.73, original_stock_cost: 3.27,
  return_postage: 0, unrecovered_costs: 0, other_costs: 0, net_profit_impact: -21.73,
});

describe("live-test example — active return of the £25 / £21.73 vans knu sale", () => {
  it("stored row net-profit impact is -£21.73 (not £0, not -£25 revenue)", () => {
    // the value the create route stores and the row displays
    expect(returnNetProfitImpactPence({ profitReversedPence: 2173 })).toBe(-2173);
    expect(Math.round(Number(activeReturn.net_profit_impact) * 100)).toBe(-2173);
  });

  it("Returns Overview: 1 item, £25.00 reversed, £21.73 profit reversed, £0.00 postage, 100% rate", () => {
    const k = computeReturnsLossesKpis({
      returns: [activeReturn], losses: [],
      soldUnitCohort: [{ saleDate: "2026-09-02", saleStatus: "completed" }], range: SEPT,
    });
    expect(k.itemsReturned).toBe(1);
    expect(k.revenueLostFromReturnsPence).toBe(2500);
    expect(k.profitLostFromReturnsPence).toBe(2173);
    expect(k.returnPostagePence).toBe(0);
    expect(k.returnRatePercent).toBe(100);
  });

  it("recognised in the return_started month; not before completion, not in another month", () => {
    expect(isCountedReturnInRange(activeReturn, SEPT)).toBe(true);
    expect(isCountedReturnInRange(activeReturn, AUG)).toBe(false);
  });

  it("Home Net Profit nets to £0.00 — the sale's £21.73 stays in the base, the adjustment removes it ONCE", () => {
    const adj = breakdownTotalPence(netProfitAdjustmentBreakdown({ returns: [activeReturn], losses: [], range: SEPT }));
    expect(adj).toBe(-2173);
    // base sales profit still includes the (status 'completed') sale at £21.73
    const baseSalesProfitPence = 2173;
    expect(netProfitWithReturnsLossesPence(baseSalesProfitPence, 0, adj)).toBe(0);
  });

  it("cancelling the return: contributes nothing, and £21.73 returns to net profit exactly once", () => {
    const cancelled = { ...activeReturn, workflow_status: "return_cancelled" as const };
    const k = computeReturnsLossesKpis({ returns: [cancelled], losses: [], soldUnitCohort: [], range: SEPT });
    expect(k.itemsReturned).toBe(0);
    expect(k.profitLostFromReturnsPence).toBe(0);
    expect(k.totalNetProfitImpactPence).toBe(0);
    const adj = breakdownTotalPence(netProfitAdjustmentBreakdown({ returns: [cancelled], losses: [], range: SEPT }));
    expect(adj).toBe(0);
    expect(netProfitWithReturnsLossesPence(2173, 0, adj)).toBe(2173); // once, not twice
    expect(isCountedReturnInRange(cancelled, SEPT)).toBe(false);
  });

  it("soft-deleting the return also contributes nothing", () => {
    const deleted = { ...activeReturn, deleted_at: "2026-09-10T00:00:00Z" };
    expect(isCountedReturnInRange(deleted, SEPT)).toBe(false);
    const adj = breakdownTotalPence(netProfitAdjustmentBreakdown({ returns: [deleted], losses: [], range: SEPT }));
    expect(adj).toBe(0);
  });

  it("restored stock value is never a profit credit — a returned_safely completion still only reverses profit + costs", () => {
    const completed = ret({
      workflow_status: "return_completed", outcome: "returned_safely", recognition_month: "2026-09",
      started_on: "2026-09-02", completed_on: "2026-09-08", completed_precision: "exact", quantity: 1,
      revenue_reversed: 25, profit_reversed: 21.73, original_stock_cost: 3.27, stock_value_restored: 3.27,
      return_postage: 0, unrecovered_costs: 0, other_costs: 0, net_profit_impact: -21.73,
    });
    const k = computeReturnsLossesKpis({ returns: [completed], losses: [], soldUnitCohort: [], range: SEPT });
    // impact is still exactly -(profit reversed) — the £3.27 restored stock never lifts it
    expect(k.totalNetProfitImpactPence).toBe(-2173);
  });

  it("months never double-count: a completed return recognised in Sept counts for Sept only, not its Aug started month", () => {
    const completedNextMonth = ret({
      workflow_status: "return_completed", outcome: "returned_safely", recognition_month: "2026-09",
      started_on: "2026-08-28", started_precision: "exact", completed_on: "2026-09-03", completed_precision: "exact",
      quantity: 1, revenue_reversed: 25, profit_reversed: 21.73, return_postage: 0, net_profit_impact: -21.73,
    });
    expect(isCountedReturnInRange(completedNextMonth, AUG)).toBe(false);
    expect(isCountedReturnInRange(completedNextMonth, SEPT)).toBe(true);
  });
});
