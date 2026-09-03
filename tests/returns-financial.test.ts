import { describe, expect, it } from "vitest";
import { computeReturnReversal, computeLossImpact, returnNetProfitImpactPence } from "@/lib/returns/financial";

/**
 * Numeric proofs for the Returns/Losses financial formulas. Every figure is
 * integer pence. See lib/returns/financial.ts's header for the model.
 */

describe("computeReturnReversal — returned_safely (Scenario A / mockup numbers)", () => {
  // Mockup "Complete return": revenue £35.00, previous profit £12.40,
  // cost basis £22.60, return postage £3.49, full refund, 1 of 1 unit.
  const base = {
    saleRevenuePence: 3500, saleFeesPence: 0, saleCostPence: 2260, saleProfitPence: 1240,
    saleQty: 1, returnedQty: 1, refundMode: "full" as const,
    returnPostagePence: 349, unrecoveredCostsPence: 0, outcome: "returned_safely" as const,
  };

  it("4/16/17. reverses revenue and profit, adds return postage, restores stock at ORIGINAL cost", () => {
    const r = computeReturnReversal(base);
    expect(r.revenueReversedPence).toBe(3500);
    expect(r.profitReversedPence).toBe(1240);
    expect(r.extraCostsPence).toBe(349);
    expect(r.inventoryWriteOffPence).toBe(0); // item came back — nothing written off
    expect(r.stockValueRestoredPence).toBe(2260); // original purchase cost, NOT sale price / refund
    // September net-profit impact = -(profit reversed) - extra costs
    expect(r.netProfitImpactPence).toBe(-(1240) - 349); // -1589  (matches mockup "-£15.89")
  });

  it("does not double count cost of goods — Aug (+1240) then Sep (-1240 - 349) nets to just the -349 return cost", () => {
    const r = computeReturnReversal(base);
    const augustProfit = base.saleProfitPence; // +1240 booked in August, untouched
    const combined = augustProfit + r.netProfitImpactPence;
    expect(combined).toBe(-349); // out only the return postage; item owned again at cost via stockValueRestored
  });
});

describe("computeReturnReversal — buyer_refunded_no_return", () => {
  const base = {
    saleRevenuePence: 6971, saleFeesPence: 0, saleCostPence: 4999, saleProfitPence: 1472,
    saleQty: 1, returnedQty: 1, refundMode: "full" as const,
    returnPostagePence: 349, unrecoveredCostsPence: 0, outcome: "buyer_refunded_no_return" as const,
  };

  it("5. does NOT restore stock; writes off the original stock cost once", () => {
    const r = computeReturnReversal(base);
    expect(r.stockValueRestoredPence).toBe(0);
    expect(r.inventoryWriteOffPence).toBe(4999);
    expect(r.netProfitImpactPence).toBe(-(1472) - 349 - 4999);
  });

  it("18. no double count — Aug (+1472) + Sep impact nets to exactly -(cost) - (extra) with cost counted once", () => {
    const r = computeReturnReversal(base);
    const combined = base.saleProfitPence + r.netProfitImpactPence;
    expect(combined).toBe(-4999 - 349);
  });
});

describe("computeReturnReversal — partial quantity and partial refund", () => {
  it("6. partial quantity uses the proportional slice of revenue/profit/cost", () => {
    const r = computeReturnReversal({
      saleRevenuePence: 10000, saleFeesPence: 1000, saleCostPence: 4000, saleProfitPence: 5000,
      saleQty: 4, returnedQty: 1, refundMode: "full", outcome: "returned_safely",
    });
    expect(r.revenueReversedPence).toBe(2500); // 10000 * 1/4
    expect(r.profitReversedPence).toBe(1250); // 5000 * 1/4
    expect(r.stockValueRestoredPence).toBe(1000); // 4000 * 1/4
    expect(r.netProfitImpactPence).toBe(-1250);
  });

  it("partial refund reverses the ACTUAL refunded amount, not a proportional share", () => {
    const r = computeReturnReversal({
      saleRevenuePence: 10000, saleFeesPence: 800, saleCostPence: 4000, saleProfitPence: 5200,
      saleQty: 1, returnedQty: 1, refundMode: "partial", partialRefundPence: 3000,
      returnPostagePence: 0, unrecoveredCostsPence: 0, outcome: "returned_safely",
    });
    expect(r.revenueReversedPence).toBe(3000);
    expect(r.profitReversedPence).toBe(3000 - 800); // refund minus the fee share you also don't recover
    expect(r.netProfitImpactPence).toBe(-(2200));
  });

  it("rejects an out-of-range returned quantity", () => {
    expect(() => computeReturnReversal({
      saleRevenuePence: 100, saleFeesPence: 0, saleCostPence: 50, saleProfitPence: 50,
      saleQty: 1, returnedQty: 2, refundMode: "full", outcome: "returned_safely",
    })).toThrow();
  });
});

describe("computeLossImpact", () => {
  it("11. lost_inventory uses ORIGINAL purchase cost * quantity", () => {
    const r = computeLossImpact({ lossType: "lost_inventory", quantity: 1, unitCostPence: 4700, stockRemoved: true });
    expect(r.stockValueRemovedPence).toBe(4700);
    expect(r.netProfitImpactPence).toBe(-4700);
  });

  it("12. unsellable_purchase uses ORIGINAL purchase cost, reported separately from lost inventory", () => {
    const r = computeLossImpact({ lossType: "unsellable_purchase", quantity: 2, unitCostPence: 3600, stockRemoved: true });
    expect(r.stockValueRemovedPence).toBe(7200);
    expect(r.netProfitImpactPence).toBe(-7200);
  });

  it("lost_inventory with extra unrecovered costs adds them once", () => {
    const r = computeLossImpact({ lossType: "lost_inventory", quantity: 1, unitCostPence: 8450, otherCostsPence: 400, stockRemoved: true });
    expect(r.netProfitImpactPence).toBe(-(8450 + 400)); // matches mockup "£88.50 (£84.50 + £4.00)"
  });

  it("18. refund_without_return keeps customer refund, stock cost and fees as SEPARATE components, summed once", () => {
    const r = computeLossImpact({
      lossType: "refund_without_return", quantity: 1, unitCostPence: 1500,
      customerRefundPence: 2499, otherCostsPence: 0, stockRemoved: true,
    });
    expect(r.customerRefundPence).toBe(2499);
    expect(r.stockCostWriteOffPence).toBe(1500);
    expect(r.otherCostsPence).toBe(0);
    expect(r.netProfitImpactPence).toBe(-(2499 + 1500));
  });

  it("other_write_off with keep-in-stock removes no stock value", () => {
    const r = computeLossImpact({ lossType: "other_write_off", quantity: 1, unitCostPence: 5000, otherCostsPence: 1200, stockRemoved: false });
    expect(r.stockValueRemovedPence).toBe(0);
    expect(r.netProfitImpactPence).toBe(-1200);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => computeLossImpact({ lossType: "lost_inventory", quantity: 0, unitCostPence: 100, stockRemoved: true })).toThrow();
  });
});

describe("19. edit applies only the DIFFERENCE (formula is pure, so a diff is just old vs new)", () => {
  it("changing return postage from £3.49 to £5.00 moves the period impact by exactly -£1.51", () => {
    const before = computeReturnReversal({
      saleRevenuePence: 3500, saleFeesPence: 0, saleCostPence: 2260, saleProfitPence: 1240,
      saleQty: 1, returnedQty: 1, refundMode: "full", returnPostagePence: 349, outcome: "returned_safely",
    });
    const after = computeReturnReversal({
      saleRevenuePence: 3500, saleFeesPence: 0, saleCostPence: 2260, saleProfitPence: 1240,
      saleQty: 1, returnedQty: 1, refundMode: "full", returnPostagePence: 500, outcome: "returned_safely",
    });
    expect(after.netProfitImpactPence - before.netProfitImpactPence).toBe(-151);
  });

  describe("returnNetProfitImpactPence — the ONE active+completed formula", () => {
    it("1/2. base impact of a return is exactly -(reversed profit): £21.73 -> -£21.73, £25 -> -£25", () => {
      expect(returnNetProfitImpactPence({ profitReversedPence: 2173 })).toBe(-2173);
      expect(returnNetProfitImpactPence({ profitReversedPence: 2500 })).toBe(-2500);
    });
    it("4. reversing a loss-making sale's negative profit is a POSITIVE contribution", () => {
      expect(returnNetProfitImpactPence({ profitReversedPence: -500 })).toBe(500);
    });
    it("6. postage / unrecovered / other costs each make it more negative, added exactly once", () => {
      expect(returnNetProfitImpactPence({
        profitReversedPence: 2173, returnPostagePence: 350, unrecoveredCostsPence: 120, otherCostsPence: 80,
      })).toBe(-(2173 + 350 + 120 + 80));
    });
    it("7. restored stock value is NOT an input — it can never lift the impact", () => {
      // no stockValueRestored parameter exists; a returned_safely return with a
      // huge stock cost still only reverses profit + costs.
      expect(returnNetProfitImpactPence({ profitReversedPence: 100 })).toBe(-100);
      // matches computeReturnReversal for a full refund, returned_safely
      const r = computeReturnReversal({
        saleRevenuePence: 2500, saleFeesPence: 0, saleCostPence: 327, saleProfitPence: 2173,
        saleQty: 1, returnedQty: 1, refundMode: "full", outcome: "returned_safely",
      });
      expect(r.netProfitImpactPence).toBe(returnNetProfitImpactPence({ profitReversedPence: r.profitReversedPence }));
      expect(r.stockValueRestoredPence).toBe(327); // recorded, but absent from the impact
    });
    it("buyer_refunded_no_return adds the inventory write-off once (still no stock credit)", () => {
      expect(returnNetProfitImpactPence({ profitReversedPence: 2173, inventoryWriteOffPence: 327 })).toBe(-(2173 + 327));
    });
  });

  it("changing outcome safely-returned -> not-returned adds the stock write-off and removes the restore", () => {
    const common = {
      saleRevenuePence: 6971, saleFeesPence: 0, saleCostPence: 4999, saleProfitPence: 1472,
      saleQty: 1, returnedQty: 1, refundMode: "full" as const, returnPostagePence: 349,
    };
    const safely = computeReturnReversal({ ...common, outcome: "returned_safely" });
    const notReturned = computeReturnReversal({ ...common, outcome: "buyer_refunded_no_return" });
    expect(safely.stockValueRestoredPence).toBe(4999);
    expect(notReturned.stockValueRestoredPence).toBe(0);
    expect(notReturned.inventoryWriteOffPence).toBe(4999);
    expect(notReturned.netProfitImpactPence - safely.netProfitImpactPence).toBe(-4999);
  });
});
