import { describe, expect, it } from "vitest";
import { computeReturnsLossesKpis, type ResolvedRange } from "@/lib/returns/kpi";
import type { SoldUnitCohortEntry } from "@/lib/returns/types";
import { returnRow as ret, lossRow as loss } from "./returns-fixtures";
const SEPT: ResolvedRange = { start: "2026-09-01", end: "2026-09-30" };
const AUG: ResolvedRange = { start: "2026-08-01", end: "2026-08-31" };

describe("computeReturnsLossesKpis", () => {
  it("26. totals use the FULL dataset filtered by business date — ACTIVE returns count in their started month, completed ones in recognition_month", () => {
    const returns = [
      ret({ id: "a", recognition_month: "2026-09", quantity: 1, revenue_reversed: 35, profit_reversed: 12.4, return_postage: 3.49 }),
      ret({ id: "b", recognition_month: "2026-09", quantity: 2, revenue_reversed: 100, profit_reversed: 20, return_postage: 5 }),
      ret({ id: "c", recognition_month: "2026-08", quantity: 9, revenue_reversed: 999, profit_reversed: 999 }), // completed, out of range
      // active (started 02/09) — counts NOW, before any completion
      ret({ id: "d", workflow_status: "return_delivered", outcome: null, recognition_month: null, started_on: "2026-09-02",
        quantity: 1, revenue_reversed: 25, profit_reversed: 21.73, return_postage: 0, net_profit_impact: -21.73 }),
      // active but started in August -> out of the September range
      ret({ id: "e", workflow_status: "return_started", outcome: null, recognition_month: null, started_on: "2026-08-20",
        quantity: 4, revenue_reversed: 400, profit_reversed: 400, return_postage: 0 }),
      ret({ id: "f", workflow_status: "return_cancelled", started_on: "2026-09-05", quantity: 3, revenue_reversed: 300, profit_reversed: 300, return_postage: 0 }), // cancelled -> never
    ];
    const k = computeReturnsLossesKpis({ returns, losses: [], soldUnitCohort: [], range: SEPT });
    expect(k.itemsReturned).toBe(1 + 2 + 1); // a + b + d ; c (Aug) / e (Aug) / f (cancelled) excluded
    expect(k.revenueLostFromReturnsPence).toBe(3500 + 10000 + 2500);
    expect(k.profitLostFromReturnsPence).toBe(1240 + 2000 + 2173);
    expect(k.returnPostagePence).toBe(349 + 500 + 0);
    expect(k.totalNetProfitImpactPence).toBe(-(1240 + 2000 + 2173 + 349 + 500));
  });

  it("1/2/3. a just-logged single-unit return reverses exactly -(that unit's original profit): £21.73 profit -> -£21.73", () => {
    const k = computeReturnsLossesKpis({
      returns: [ret({ workflow_status: "return_started", outcome: null, recognition_month: null, started_on: "2026-09-02",
        quantity: 1, revenue_reversed: 25, profit_reversed: 21.73, return_postage: 0, net_profit_impact: -21.73 })],
      losses: [], soldUnitCohort: [{ saleDate: "2026-09-02", saleStatus: "completed" }], range: SEPT,
    });
    expect(k.itemsReturned).toBe(1);
    expect(k.revenueLostFromReturnsPence).toBe(2500);
    expect(k.profitLostFromReturnsPence).toBe(2173);
    expect(k.returnPostagePence).toBe(0);
    expect(k.returnRatePercent).toBe(100);
    expect(k.totalNetProfitImpactPence).toBe(-2173);
  });

  it("4. a loss-making sale reverses with the correct sign — reversing -£5 profit contributes +£5", () => {
    const k = computeReturnsLossesKpis({
      returns: [ret({ workflow_status: "return_started", outcome: null, recognition_month: null, started_on: "2026-09-02",
        quantity: 1, revenue_reversed: 10, profit_reversed: -5, return_postage: 0, net_profit_impact: 5 })],
      losses: [], soldUnitCohort: [], range: SEPT,
    });
    expect(k.profitLostFromReturnsPence).toBe(-500);
    expect(k.totalNetProfitImpactPence).toBe(500); // -(-500) = +500
  });

  it("27. return rate protects against division by zero", () => {
    const k = computeReturnsLossesKpis({ returns: [ret({})], losses: [], soldUnitCohort: [], range: SEPT });
    expect(k.returnRatePercent).toBe(0); // no sold units in cohort -> 0, never NaN/Infinity
  });

  it("return rate = completed returned units / non-cancelled sold units in the same period", () => {
    const cohort: SoldUnitCohortEntry[] = [
      { saleDate: "2026-09-02", saleStatus: "completed" },
      { saleDate: "2026-09-10", saleStatus: "completed" },
      { saleDate: "2026-09-11", saleStatus: "cancelled" }, // excluded
      { saleDate: "2026-08-30", saleStatus: "completed" }, // out of period
    ];
    const k = computeReturnsLossesKpis({ returns: [ret({ quantity: 1 })], losses: [], soldUnitCohort: cohort, range: SEPT });
    expect(k.returnRatePercent).toBe(50); // 1 returned / 2 eligible sold units
  });

  it("losses: lost inventory, unsellable stock and refunds-without-return are reported on SEPARATE lines", () => {
    const losses = [
      loss({ id: "a", loss_type: "lost_inventory", stock_value_removed: 47 }),
      loss({ id: "b", loss_type: "unsellable_purchase", stock_value_removed: 72 }),
      loss({ id: "c", loss_type: "refund_without_return", customer_refund: 24.99, stock_value_removed: 15 }),
    ];
    const k = computeReturnsLossesKpis({ returns: [], losses, soldUnitCohort: [], range: SEPT });
    expect(k.lostInventoryPence).toBe(4700);
    expect(k.unsellableStockPence).toBe(7200);
    expect(k.refundsWithoutReturnPence).toBe(2499); // customer refund only, kept independent of the £15 stock cost
  });

  it("15/period-scoping. a loss/return outside the selected range contributes nothing to that range", () => {
    const k = computeReturnsLossesKpis({
      returns: [ret({ recognition_month: "2026-09" })],
      losses: [loss({ event_month: "2026-09", event_date: "2026-09-05" })],
      soldUnitCohort: [], range: AUG,
    });
    expect(k.itemsReturned).toBe(0);
    expect(k.lostInventoryPence).toBe(0);
    expect(k.totalNetProfitImpactPence).toBe(0);
  });

  it("totalNetProfitImpactPence sums every negative component exactly once", () => {
    const returns = [ret({ recognition_month: "2026-09", profit_reversed: 12.4, return_postage: 3.49, unrecovered_costs: 0, outcome: "returned_safely" })];
    const losses = [loss({ loss_type: "lost_inventory", stock_value_removed: 47 })];
    const k = computeReturnsLossesKpis({ returns, losses, soldUnitCohort: [], range: SEPT });
    expect(k.totalNetProfitImpactPence).toBe(-(1240 + 349 + 4700));
  });

  it("43. reporting keys on the EVENT date, never the logged date", () => {
    // event in August (in range), logged in September (out of range) -> counts for August.
    const augEventSepLogged = loss({ event_month: "2026-08", event_date: "2026-08-25", event_precision: "exact", logged_date: "2026-09-02", stock_value_removed: 60 });
    expect(computeReturnsLossesKpis({ returns: [], losses: [augEventSepLogged], soldUnitCohort: [], range: AUG }).lostInventoryPence).toBe(6000);
    expect(computeReturnsLossesKpis({ returns: [], losses: [augEventSepLogged], soldUnitCohort: [], range: SEPT }).lostInventoryPence).toBe(0);
  });

  it("48. soft-deleted losses and cancelled returns contribute nothing to any KPI", () => {
    const k = computeReturnsLossesKpis({
      returns: [ret({ recognition_month: "2026-09", workflow_status: "return_cancelled", profit_reversed: 99 })],
      losses: [loss({ event_month: "2026-09", event_date: "2026-09-05", deleted_at: "2026-09-10T00:00:00Z", stock_value_removed: 999 })],
      soldUnitCohort: [], range: SEPT,
    });
    expect(k.itemsReturned).toBe(0);
    expect(k.profitLostFromReturnsPence).toBe(0);
    expect(k.lostInventoryPence).toBe(0);
  });
});
