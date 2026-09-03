import { describe, expect, it } from "vitest";
import { periodReturnLossAdjustmentPence, netProfitWithReturnsLossesPence } from "@/lib/returns/net-profit";
import { returnRow, lossRow } from "./returns-fixtures";
import type { ReturnRecordRow, LossRecordRow } from "@/lib/returns/types";

const ret = (o: Partial<ReturnRecordRow> = {}) => returnRow({ revenue_reversed: 69.71, profit_reversed: 14.72, original_stock_cost: 49.99, refund_amount: 69.71, stock_value_restored: 49.99, net_profit_impact: -18.21, ...o });
const loss = (o: Partial<LossRecordRow> = {}) => lossRow({ unit_cost: 60, stock_value_removed: 60, net_profit_impact: -60, ...o });

const AUG = { start: "2026-08-01", end: "2026-08-31" };
const SEPT = { start: "2026-09-01", end: "2026-09-30" };

describe("August sale / September return — dashboard net-profit integration", () => {
  it("15/16. an August sale returned in September: AUGUST net profit is UNCHANGED by the return", () => {
    const returns = [ret({ recognition_month: "2026-09", completed_on: "2026-09-03" })];
    // August: sale profit +£14.72 was booked; the return is recognised in September, so August sees nothing.
    expect(periodReturnLossAdjustmentPence({ returns, losses: [], range: AUG })).toBe(0);
    const augNet = netProfitWithReturnsLossesPence(1472, 0, periodReturnLossAdjustmentPence({ returns, losses: [], range: AUG }));
    expect(augNet).toBe(1472); // exactly the original August profit — history preserved
  });

  it("16. SEPTEMBER net profit loses the reversed profit + return postage (returned safely)", () => {
    const returns = [ret({ recognition_month: "2026-09", profit_reversed: 14.72, return_postage: 3.49, outcome: "returned_safely" })];
    const adj = periodReturnLossAdjustmentPence({ returns, losses: [], range: SEPT });
    expect(adj).toBe(-(1472 + 349)); // -£18.21
    // e.g. September otherwise made £5000 profit with £0 expenses:
    expect(netProfitWithReturnsLossesPence(5000, 0, adj)).toBe(5000 - 1821);
  });

  it("17. return postage lands in the SAME period as the recognition month, never the sale month", () => {
    const returns = [ret({ recognition_month: "2026-09", profit_reversed: 0, return_postage: 3.49 })];
    expect(periodReturnLossAdjustmentPence({ returns, losses: [], range: AUG })).toBe(0);
    expect(periodReturnLossAdjustmentPence({ returns, losses: [], range: SEPT })).toBe(-349);
  });

  it("F. moving a £60 loss from August to September removes it from August and adds it to September (once)", () => {
    const augLoss = [loss({ event_month: "2026-08", event_date: "2026-08-20", stock_value_removed: 60 })];
    const septLoss = [loss({ event_month: "2026-09", event_date: "2026-09-20", stock_value_removed: 60 })];
    expect(periodReturnLossAdjustmentPence({ returns: [], losses: augLoss, range: AUG })).toBe(-6000);
    expect(periodReturnLossAdjustmentPence({ returns: [], losses: augLoss, range: SEPT })).toBe(0);
    // after the edit re-assigns the month:
    expect(periodReturnLossAdjustmentPence({ returns: [], losses: septLoss, range: AUG })).toBe(0);
    expect(periodReturnLossAdjustmentPence({ returns: [], losses: septLoss, range: SEPT })).toBe(-6000);
  });

  it("net profit = sales profit - expenses + adjustment, SIGNED and NEVER clamped", () => {
    expect(netProfitWithReturnsLossesPence(10000, 3000, -1821)).toBe(10000 - 3000 - 1821);
    // a POSITIVE adjustment (reversing a loss-making sale's negative profit)
    // is added, not dropped — clamping here was the accounting bug.
    expect(netProfitWithReturnsLossesPence(10000, 3000, 500)).toBe(10000 - 3000 + 500);
    expect(netProfitWithReturnsLossesPence(-500, 0, 500)).toBe(0);   // -£5 base + a +£5 return -> £0
    expect(netProfitWithReturnsLossesPence(2173, 0, -2173)).toBe(0); // +£21.73 base + a -£21.73 return -> £0
    expect(netProfitWithReturnsLossesPence(0, 0, 0)).toBe(0);        // zero-profit sale return -> no change
  });
});

// ===========================================================================
// Signed returns/losses accounting — a return reverses the ORIGINAL SIGNED
// unit profit (positive, zero, or negative), and the combined adjustment is
// never globally clamped. Genuine losses keep their full negative effect.
// ===========================================================================
describe("signed return adjustment through the Home aggregation", () => {
  // helper: build an ACTIVE return of a single unit whose original sale profit
  // is `profitPounds` (signed), started this September, no extra costs.
  const activeReturn = (profitPounds: number, extra: Partial<ReturnRecordRow> = {}) => returnRow({
    workflow_status: "return_delivered", outcome: null, recognition_month: null,
    completed_on: null, completed_precision: null, started_on: "2026-09-02", started_precision: "exact",
    quantity: 1, revenue_reversed: 10, profit_reversed: profitPounds,
    original_sale_revenue: 10, original_sale_profit: profitPounds, original_stock_cost: 3,
    return_postage: 0, unrecovered_costs: 0, other_costs: 0,
    net_profit_impact: -(profitPounds),
    ...extra,
  });

  it("positive-profit sale return: +£21.73 -> adjustment -£21.73 -> £0 from a +£21.73 base", () => {
    const adj = periodReturnLossAdjustmentPence({ returns: [activeReturn(21.73)], losses: [], range: SEPT });
    expect(adj).toBe(-2173);
    expect(netProfitWithReturnsLossesPence(2173, 0, adj)).toBe(0);
  });

  it("zero-profit sale return: adjustment £0 -> Home net profit unchanged", () => {
    const adj = periodReturnLossAdjustmentPence({ returns: [activeReturn(0)], losses: [], range: SEPT });
    expect(adj).toBe(0);
    expect(netProfitWithReturnsLossesPence(4200, 0, adj)).toBe(4200);
  });

  it("NEGATIVE-profit sale return through Home: -£5 -> adjustment +£5 -> £0 from a -£5 base (not -£5)", () => {
    const adj = periodReturnLossAdjustmentPence({ returns: [activeReturn(-5)], losses: [], range: SEPT });
    expect(adj).toBe(500);
    expect(netProfitWithReturnsLossesPence(-500, 0, adj)).toBe(0);
  });

  it("mixed positive + negative return adjustments sum algebraically (no clamp)", () => {
    const returns = [activeReturn(21.73, { id: "a", sale_item_ids: ["si-a"] }), activeReturn(-5, { id: "b", sale_item_ids: ["si-b"] })];
    const adj = periodReturnLossAdjustmentPence({ returns, losses: [], range: SEPT });
    expect(adj).toBe(-2173 + 500); // -£16.73
    // base includes both sales: 21.73 + (-5) = 16.73
    expect(netProfitWithReturnsLossesPence(1673, 0, adj)).toBe(0);
  });

  it("a loss-making return COMBINED with a genuine £47 lost-inventory loss: +£5 and -£47 net to -£42, loss keeps its full effect", () => {
    const returns = [activeReturn(-5, { id: "lm-r", sale_item_ids: ["si-lm"] })];
    const losses = [loss({ id: "lm-l", loss_type: "lost_inventory", event_month: "2026-09", event_date: "2026-09-05", event_precision: "exact", stock_value_removed: 47, other_costs: 0, customer_refund: 0 })];
    const adj = periodReturnLossAdjustmentPence({ returns, losses, range: SEPT });
    expect(adj).toBe(500 - 4700); // -£42: +£5 return reversal, -£47 genuine loss (not clamped to <= 0)
    // Home: the -£5 loss-making sale in the base is reversed to £0 by its return,
    // then the genuine -£47 loss stands:  -500 + (-4200) = -4700
    expect(netProfitWithReturnsLossesPence(-500, 0, adj)).toBe(-4700);
  });

  it("cancelling a NEGATIVE-profit return reverses the +£5 adjustment exactly once (base -£5 returns)", () => {
    const cancelled = activeReturn(-5, { workflow_status: "return_cancelled" });
    const adj = periodReturnLossAdjustmentPence({ returns: [cancelled], losses: [], range: SEPT });
    expect(adj).toBe(0); // the +£5 is gone, not doubled
    expect(netProfitWithReturnsLossesPence(-500, 0, adj)).toBe(-500);
  });

  it("restored stock value never appears as positive profit — a returned_safely completion of a profitable sale stays negative", () => {
    const completed = returnRow({
      workflow_status: "return_completed", outcome: "returned_safely", recognition_month: "2026-09",
      started_on: "2026-09-02", completed_on: "2026-09-08", completed_precision: "exact", quantity: 1,
      revenue_reversed: 25, profit_reversed: 21.73, original_stock_cost: 3.27, stock_value_restored: 3.27,
      return_postage: 0, unrecovered_costs: 0, other_costs: 0, net_profit_impact: -21.73,
    });
    const adj = periodReturnLossAdjustmentPence({ returns: [completed], losses: [], range: SEPT });
    expect(adj).toBe(-2173); // the £3.27 restored stock is NOT added back as profit
    expect(netProfitWithReturnsLossesPence(2173, 0, adj)).toBe(0);
  });

  it("9. the Returns-page KPI strip and the Home adjustment use the identical signed number", () => {
    const returns = [activeReturn(-5, { id: "x", sale_item_ids: ["si-x"] })];
    // periodReturnLossAdjustmentPence IS kpis.totalNetProfitImpactPence
    const adj = periodReturnLossAdjustmentPence({ returns, losses: [], range: SEPT });
    expect(adj).toBe(500);
  });
});
