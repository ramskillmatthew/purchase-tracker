import { describe, expect, it } from "vitest";
import { computeReturnStructuralDiff, computeLossStructuralDiff } from "@/lib/returns/edit-diff";

const COST = { p1: 2260, p2: 3000, p3: 1000 };

describe("computeReturnStructuralDiff — set-diff, generation-namespaced keys", () => {
  it("25. quantity increase 1 → 2 (same outcome): ONLY the added unit gets an apply movement, at the next generation", () => {
    const d = computeReturnStructuralDiff({
      returnId: "r1",
      currentUnits: [{ purchaseId: "p1", outcome: "returned_safely" }],
      desiredUnits: [{ purchaseId: "p1", outcome: "returned_safely" }, { purchaseId: "p2", outcome: "returned_safely" }],
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements).toEqual([]);
    expect(d.applyMovements.map(m => m.purchaseId)).toEqual(["p2"]);
    expect(d.applyMovements[0].idempotencyKey).toBe("return:r1:restock:p2:g1");
    expect(d.nextGen).toBe(1);
  });

  it("25. quantity decrease 2 → 1: ONLY the removed unit is reversed", () => {
    const d = computeReturnStructuralDiff({
      returnId: "r1",
      currentUnits: [{ purchaseId: "p1", outcome: "returned_safely" }, { purchaseId: "p2", outcome: "returned_safely" }],
      desiredUnits: [{ purchaseId: "p1", outcome: "returned_safely" }],
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements.map(m => m.purchaseId)).toEqual(["p2"]);
    expect(d.reverseMovements[0]).toMatchObject({ direction: "out_of_stock", reason: "return_reversed" });
    expect(d.applyMovements).toEqual([]);
  });

  it("26. outcome flip returned_safely → buyer_refunded_no_return (same unit): reverse the restock, apply the write-off", () => {
    const d = computeReturnStructuralDiff({
      returnId: "r1",
      currentUnits: [{ purchaseId: "p1", outcome: "returned_safely" }],
      desiredUnits: [{ purchaseId: "p1", outcome: "buyer_refunded_no_return" }],
      unitCostsPence: COST, currentGen: 2,
    });
    expect(d.reverseMovements[0]).toMatchObject({ purchaseId: "p1", direction: "out_of_stock", reason: "return_reversed" });
    expect(d.reverseMovements[0].idempotencyKey).toBe("return:r1:restock_reversed:p1:g2");
    expect(d.applyMovements[0]).toMatchObject({ purchaseId: "p1", direction: "out_of_stock", reason: "refunded_no_return" });
    expect(d.applyMovements[0].idempotencyKey).toBe("return:r1:writeoff:p1:g3");
  });

  it("a unit that stays effective and unchanged produces NOTHING", () => {
    const d = computeReturnStructuralDiff({
      returnId: "r1",
      currentUnits: [{ purchaseId: "p1", outcome: "returned_safely" }],
      desiredUnits: [{ purchaseId: "p1", outcome: "returned_safely" }],
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements).toEqual([]);
    expect(d.applyMovements).toEqual([]);
  });

  it("swap linked units p1 → p3: reverse p1, apply p3", () => {
    const d = computeReturnStructuralDiff({
      returnId: "r1",
      currentUnits: [{ purchaseId: "p1", outcome: "returned_safely" }],
      desiredUnits: [{ purchaseId: "p3", outcome: "returned_safely" }],
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements.map(m => m.purchaseId)).toEqual(["p1"]);
    expect(d.applyMovements.map(m => m.purchaseId)).toEqual(["p3"]);
    expect(d.effectivePurchaseIds).toEqual(["p3"]);
  });
});

describe("computeLossStructuralDiff", () => {
  it("36. quantity 1 → 2: only the added unit is written off", () => {
    const d = computeLossStructuralDiff({
      lossId: "l1", currentPurchaseIds: ["p1"], currentLossType: "lost_inventory", currentStockRemoved: true,
      desiredPurchaseIds: ["p1", "p2"], desiredLossType: "lost_inventory", desiredStockRemoved: true,
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements).toEqual([]);
    expect(d.applyMovements.map(m => m.purchaseId)).toEqual(["p2"]);
    expect(d.applyMovements[0].reason).toBe("lost");
  });

  it("36. quantity 2 → 1: only the removed unit is restored", () => {
    const d = computeLossStructuralDiff({
      lossId: "l1", currentPurchaseIds: ["p1", "p2"], currentLossType: "unsellable_purchase", currentStockRemoved: true,
      desiredPurchaseIds: ["p1"], desiredLossType: "unsellable_purchase", desiredStockRemoved: true,
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements.map(m => m.purchaseId)).toEqual(["p2"]);
    expect(d.reverseMovements[0].reason).toBe("loss_reversed");
    expect(d.applyMovements).toEqual([]);
  });

  it("lost → unsellable (same units): re-classify — reverse + re-apply with the new reason, NEVER a second removal", () => {
    const d = computeLossStructuralDiff({
      lossId: "l1", currentPurchaseIds: ["p1"], currentLossType: "lost_inventory", currentStockRemoved: true,
      desiredPurchaseIds: ["p1"], desiredLossType: "unsellable_purchase", desiredStockRemoved: true,
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements.map(m => m.purchaseId)).toEqual(["p1"]); // back in stock
    expect(d.applyMovements.map(m => [m.purchaseId, m.reason])).toEqual([["p1", "unsellable"]]); // out again, new reason
    // net stock effect: in then out = out — the unit is removed exactly once overall
    expect(d.reverseMovements[0].resultingStockStatus).toBe("in_stock");
    expect(d.applyMovements[0].resultingStockStatus).toBe("no_longer_in_stock");
  });

  it("37. date/month-only change with no unit change: NO movement at all (caller just moves the recognition month)", () => {
    const d = computeLossStructuralDiff({
      lossId: "l1", currentPurchaseIds: ["p1"], currentLossType: "lost_inventory", currentStockRemoved: true,
      desiredPurchaseIds: ["p1"], desiredLossType: "lost_inventory", desiredStockRemoved: true,
      unitCostsPence: COST, currentGen: 0,
    });
    expect(d.reverseMovements).toEqual([]);
    expect(d.applyMovements).toEqual([]);
  });
});
