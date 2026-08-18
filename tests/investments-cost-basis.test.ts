import { describe, expect, it } from "vitest";
import {
  applyAdjustment, applyBuy, applySell, computeRealizedSale, OversellError, reduceLedger, ZERO_COST_BASIS,
} from "@/lib/investments/cost-basis";
import { d, roundGbp } from "@/lib/investments/decimal";

describe("cost-basis — weighted average", () => {
  it("SPEC EXAMPLE: buy 10 @ £50 then 5 @ £70 gives quantity 15, cost basis £850, average £56.6666...", () => {
    let state = ZERO_COST_BASIS;
    state = applyBuy(state, 10, 500);
    state = applyBuy(state, 5, 350);
    expect(state.quantity.toString()).toBe("15");
    expect(state.costBasisGbp.toString()).toBe("850");
    const average = state.costBasisGbp.div(state.quantity);
    expect(average.toDecimalPlaces(10).toString()).toBe("56.6666666667");
  });

  it("SPEC EXAMPLE: selling 5 of those 15 removes 5 × average cost, leaving quantity 10 and cost basis ~£566.67", () => {
    let state = ZERO_COST_BASIS;
    state = applyBuy(state, 10, 500);
    state = applyBuy(state, 5, 350);
    const result = applySell(state, 5);
    expect(result.state.quantity.toString()).toBe("10");
    expect(roundGbp(result.state.costBasisGbp).toString()).toBe("566.67");
    // Average cost stays ~£56.67 after the partial sale (weighted average
    // is recomputed from the SAME per-unit cost, not reset).
    const newAverage = result.state.costBasisGbp.div(result.state.quantity);
    expect(roundGbp(newAverage).toString()).toBe("56.67");
  });

  it("multiple buys at different prices produce a correctly weighted average, not a simple mean of prices", () => {
    let state = ZERO_COST_BASIS;
    state = applyBuy(state, 100, 1000); // £10/unit
    state = applyBuy(state, 10, 500); // £50/unit
    // Weighted: (1000+500)/110 = 13.636..., NOT (10+50)/2 = 30.
    const average = state.costBasisGbp.div(state.quantity);
    expect(average.toDecimalPlaces(4).toString()).toBe("13.6364");
  });

  it("fractional quantities are handled at full precision", () => {
    let state = ZERO_COST_BASIS;
    state = applyBuy(state, "0.125", 100);
    expect(state.quantity.toString()).toBe("0.125");
    const sellResult = applySell(state, "0.05");
    expect(sellResult.state.quantity.toString()).toBe("0.075");
  });

  it("a full sale zeroes remaining quantity AND cost basis exactly — never a floating-point remainder", () => {
    let state = ZERO_COST_BASIS;
    state = applyBuy(state, 3, 100);
    const result = applySell(state, 3);
    expect(result.state.quantity.toString()).toBe("0");
    expect(result.state.costBasisGbp.toString()).toBe("0");
  });

  it("cannot oversell — throws OversellError and never mutates state", () => {
    let state = ZERO_COST_BASIS;
    state = applyBuy(state, 5, 100);
    expect(() => applySell(state, 6)).toThrow(OversellError);
    // Original state (captured before the throwing call) is untouched —
    // applySell never mutates its input, only returns a new state.
    expect(state.quantity.toString()).toBe("5");
  });

  it("cannot sell from an empty (never-bought) position", () => {
    expect(() => applySell(ZERO_COST_BASIS, 1)).toThrow(OversellError);
  });

  it("rejects a non-positive buy/sell quantity", () => {
    expect(() => applyBuy(ZERO_COST_BASIS, 0, 100)).toThrow();
    expect(() => applyBuy(ZERO_COST_BASIS, -1, 100)).toThrow();
    const bought = applyBuy(ZERO_COST_BASIS, 5, 100);
    expect(() => applySell(bought, 0)).toThrow();
    expect(() => applySell(bought, -1)).toThrow();
  });
});

describe("cost-basis — realised sales (proceeds, fees, P/L)", () => {
  it("computes realised P/L as proceeds minus cost-basis-removed minus fees", () => {
    let state = ZERO_COST_BASIS;
    state = applyBuy(state, 10, 500); // avg £50
    const { realized } = computeRealizedSale(state, 4, 260, 5); // sold 4 for £260, £5 fee
    expect(realized.costBasisRemoved.toString()).toBe("200"); // 4 × £50
    expect(realized.proceedsGbp.toString()).toBe("260");
    expect(realized.feesGbp.toString()).toBe("5");
    expect(realized.realizedPnlGbp.toString()).toBe("55"); // 260 - 200 - 5
  });

  it("defaults fees to zero when not supplied", () => {
    const state = applyBuy(ZERO_COST_BASIS, 10, 100);
    const { realized } = computeRealizedSale(state, 5, 60);
    expect(realized.feesGbp.toString()).toBe("0");
    expect(realized.realizedPnlGbp.toString()).toBe("10"); // 60 - 50 - 0
  });

  it("a realised loss produces a negative realizedPnlGbp", () => {
    const state = applyBuy(ZERO_COST_BASIS, 10, 1000); // avg £100
    const { realized } = computeRealizedSale(state, 2, 150);
    expect(realized.realizedPnlGbp.toString()).toBe("-50"); // 150 - 200
  });
});

describe("cost-basis — adjustments (stock splits)", () => {
  it("preserves total cost basis through an adjustment, recomputing average cost per unit", () => {
    const state = applyBuy(ZERO_COST_BASIS, 10, 1000); // avg £100
    // A 2:1 split — 10 units become 20, cost basis stays £1000, average halves.
    const adjusted = applyAdjustment(state, 20);
    expect(adjusted.quantity.toString()).toBe("20");
    expect(adjusted.costBasisGbp.toString()).toBe("1000");
    expect(adjusted.costBasisGbp.div(adjusted.quantity).toString()).toBe("50");
  });

  it("an adjustment down to zero also zeroes cost basis", () => {
    const state = applyBuy(ZERO_COST_BASIS, 10, 1000);
    const adjusted = applyAdjustment(state, 0);
    expect(adjusted.costBasisGbp.toString()).toBe("0");
  });

  it("rejects a negative adjusted quantity", () => {
    const state = applyBuy(ZERO_COST_BASIS, 10, 1000);
    expect(() => applyAdjustment(state, -1)).toThrow();
  });
});

describe("cost-basis — reduceLedger (chronological transaction ledger)", () => {
  it("re-sorts an out-of-order ledger by tradeAt before applying it", () => {
    const result = reduceLedger([
      { id: "2", type: "sell", tradeAt: "2026-02-01", quantity: 5, gbpTotal: 300 },
      { id: "1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 500 },
    ]);
    expect(result.state.quantity.toString()).toBe("5");
    expect(result.realizedSales).toHaveLength(1);
    expect(result.realizedSales[0].transactionId).toBe("2");
  });

  it("full SPEC EXAMPLE end-to-end: two buys then a sell of 5, matching every stated figure", () => {
    const result = reduceLedger([
      { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 500 },
      { id: "b2", type: "buy", tradeAt: "2026-01-02", quantity: 5, gbpTotal: 350 },
      { id: "s1", type: "sell", tradeAt: "2026-01-03", quantity: 5, gbpTotal: 400 },
    ]);
    expect(result.state.quantity.toString()).toBe("10");
    expect(roundGbp(result.state.costBasisGbp).toString()).toBe("566.67");
    expect(result.realizedSales).toHaveLength(1);
    expect(roundGbp(result.realizedSales[0].costBasisRemoved).toString()).toBe("283.33"); // 5 × 56.6666...
  });

  it("throws (never silently clamps) if the ledger tries to oversell", () => {
    expect(() => reduceLedger([
      { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 5, gbpTotal: 100 },
      { id: "s1", type: "sell", tradeAt: "2026-01-02", quantity: 6, gbpTotal: 100 },
    ])).toThrow(OversellError);
  });

  it("a fully-sold-then-rebought asset correctly resets and re-accumulates cost basis", () => {
    const result = reduceLedger([
      { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: 10, gbpTotal: 1000 },
      { id: "s1", type: "sell", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 1500 },
      { id: "b2", type: "buy", tradeAt: "2026-03-01", quantity: 4, gbpTotal: 800 },
    ]);
    expect(result.state.quantity.toString()).toBe("4");
    expect(result.state.costBasisGbp.toString()).toBe("800");
    expect(result.realizedSales).toHaveLength(1);
    expect(result.realizedSales[0].realizedPnlGbp.toString()).toBe("500");
  });

  it("an empty ledger produces a zero state and no realised sales", () => {
    const result = reduceLedger([]);
    expect(result.state.quantity.toString()).toBe("0");
    expect(result.state.costBasisGbp.toString()).toBe("0");
    expect(result.realizedSales).toEqual([]);
  });

  it("fractional quantities round-trip through buy/sell/adjustment without precision loss", () => {
    const result = reduceLedger([
      { id: "b1", type: "buy", tradeAt: "2026-01-01", quantity: "3.333333", gbpTotal: 100 },
      { id: "adj1", type: "adjustment", tradeAt: "2026-01-05", quantity: "6.666666" },
      { id: "s1", type: "sell", tradeAt: "2026-01-10", quantity: "1.666666", gbpTotal: 50 },
    ]);
    expect(d(result.state.quantity).toDecimalPlaces(4).toString()).toBe("5");
  });
});
