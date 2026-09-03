import { describe, expect, it } from "vitest";
import { calculateInStockValue } from "@/lib/purchases";
import { planLossApplication, planLossReversal, planReturnCompletion, planReturnReversal } from "@/lib/returns/stock-movements";
import type { Purchase } from "@/lib/types";

/**
 * Inventory-status + stock-value integrity. The real stock-value query
 * (lib/purchases.ts calculateInStockValue) sums price_purchased over rows
 * whose stock_status === "in_stock". The Returns/Losses movement planners
 * decide the resulting stock_status for every affected unit; applying those
 * (via rl_apply_movements) is what moves the real column. These tests prove
 * the planned end-state and its stock-value consequence, using the ACTUAL
 * stock-value function.
 */

function p(id: string, cost: number, status: Purchase["stock_status"] = "in_stock"): Pick<Purchase, "stock_status" | "price_purchased"> & { id: string } {
  return { id, price_purchased: cost, stock_status: status };
}
/** Apply a plan's resultingStockStatus to a purchase list (what rl_apply_movements does to purchases.stock_status). */
function apply(list: (Pick<Purchase, "stock_status" | "price_purchased"> & { id: string })[], plan: { purchaseId: string; resultingStockStatus: Purchase["stock_status"] }[]) {
  return list.map(row => {
    const m = plan.find(x => x.purchaseId === row.id);
    return m ? { ...row, stock_status: m.resultingStockStatus } : row;
  });
}

describe("stock value excludes lost / unsellable / refund-without-return units, at ORIGINAL cost", () => {
  const stock = [p("a", 4700), p("b", 3600), p("c", 2000)];

  it("10/32/33/35. a lost_inventory loss removes 'a' from stock value (−£47.00, the original cost)", () => {
    const plan = planLossApplication({ lossId: "L1", lossType: "lost_inventory", purchaseUnitCostsPence: { a: 4700 }, stockRemoved: true });
    const after = apply(stock, plan);
    expect(calculateInStockValue(stock)).toBe(4700 + 3600 + 2000);
    expect(calculateInStockValue(after)).toBe(3600 + 2000);
  });

  it("an unsellable_purchase loss removes its unit the same way, distinct reason", () => {
    const plan = planLossApplication({ lossId: "L1", lossType: "unsellable_purchase", purchaseUnitCostsPence: { b: 3600 }, stockRemoved: true });
    expect(plan[0].reason).toBe("unsellable");
    expect(calculateInStockValue(apply(stock, plan))).toBe(4700 + 2000);
  });

  it("38. deleting the loss (reversal) restores the unit to stock value at its ORIGINAL cost, once", () => {
    const applyPlan = planLossApplication({ lossId: "L1", lossType: "lost_inventory", purchaseUnitCostsPence: { a: 4700 }, stockRemoved: true });
    const afterLoss = apply(stock, applyPlan);
    const reversePlan = planLossReversal({ lossId: "L1", writtenOffPurchaseIds: ["a"], purchaseUnitCostsPence: { a: 4700 } });
    expect(reversePlan[0]).toMatchObject({ resultingStockStatus: "in_stock", unitCostPence: 4700 });
    expect(calculateInStockValue(apply(afterLoss, reversePlan))).toBe(4700 + 3600 + 2000);
  });
});

describe("returned-safely restores a unit; buyer-refunded does not", () => {
  it("11/12. returned_safely puts the unit BACK in stock at the ORIGINAL purchase cost snapshot", () => {
    const soldOut = [p("x", 4999, "no_longer_in_stock"), p("y", 1000)];
    const plan = planReturnCompletion({ returnId: "R1", outcome: "returned_safely", purchaseUnitCostsPence: { x: 4999 } });
    expect(plan[0].unitCostPence).toBe(4999); // never the sale price
    const after = apply(soldOut, plan);
    expect(calculateInStockValue(soldOut)).toBe(1000);
    expect(calculateInStockValue(after)).toBe(4999 + 1000);
  });

  it("14. buyer_refunded_no_return leaves the unit out of stock (no restore)", () => {
    const soldOut = [p("x", 4999, "no_longer_in_stock"), p("y", 1000)];
    const plan = planReturnCompletion({ returnId: "R1", outcome: "buyer_refunded_no_return", purchaseUnitCostsPence: { x: 4999 } });
    expect(calculateInStockValue(apply(soldOut, plan))).toBe(1000);
  });

  it("20. cancelling a returned_safely return takes the restored unit back out of stock value, once", () => {
    const restored = [p("x", 4999), p("y", 1000)];
    const reverse = planReturnReversal({ returnId: "R1", outcome: "returned_safely", restockedPurchaseIds: ["x"], purchaseUnitCostsPence: { x: 4999 } });
    expect(calculateInStockValue(apply(restored, reverse))).toBe(1000);
  });
});
