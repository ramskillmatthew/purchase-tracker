import { describe, expect, it } from "vitest";
import {
  planReturnCompletion, planReturnReversal, planLossApplication, planLossReversal,
  findStockConflicts, returnMovementKey, lossMovementKey,
} from "@/lib/returns/stock-movements";

describe("planReturnCompletion", () => {
  it("4. 'returned_safely' restocks every affected unit at its snapshotted original cost", () => {
    const plan = planReturnCompletion({ returnId: "ret1", outcome: "returned_safely", purchaseUnitCostsPence: { p1: 2260 } });
    expect(plan).toEqual([{
      purchaseId: "p1", direction: "back_in_stock", reason: "returned_to_stock",
      idempotencyKey: "return:ret1:restock:p1", unitCostPence: 2260, resultingStockStatus: "in_stock",
    }]);
  });

  it("5. 'buyer_refunded_no_return' does not restock — it records a write-off movement instead", () => {
    const plan = planReturnCompletion({ returnId: "ret1", outcome: "buyer_refunded_no_return", purchaseUnitCostsPence: { p1: 4999 } });
    expect(plan[0].direction).toBe("out_of_stock");
    expect(plan[0].reason).toBe("refunded_no_return");
    expect(plan[0].resultingStockStatus).toBe("no_longer_in_stock");
  });

  it("23. the idempotency key is deterministic — retrying the same completion produces the SAME key", () => {
    const a = planReturnCompletion({ returnId: "ret1", outcome: "returned_safely", purchaseUnitCostsPence: { p1: 100 } });
    const b = planReturnCompletion({ returnId: "ret1", outcome: "returned_safely", purchaseUnitCostsPence: { p1: 100 } });
    expect(a[0].idempotencyKey).toBe(b[0].idempotencyKey);
  });
});

describe("planReturnReversal (cancel/delete)", () => {
  it("20. reverses exactly the units that were restocked, using the SNAPSHOTTED ids, never re-derived", () => {
    const plan = planReturnReversal({ returnId: "ret1", outcome: "returned_safely", restockedPurchaseIds: ["p1", "p2"], purchaseUnitCostsPence: { p1: 2260, p2: 1000 } });
    expect(plan.map(m => m.purchaseId)).toEqual(["p1", "p2"]);
    expect(plan.every(m => m.direction === "out_of_stock" && m.resultingStockStatus === "no_longer_in_stock")).toBe(true);
  });

  it("reversing a buyer_refunded_no_return completion puts the written-off units BACK in stock", () => {
    const plan = planReturnReversal({ returnId: "ret1", outcome: "buyer_refunded_no_return", restockedPurchaseIds: ["p1"], purchaseUnitCostsPence: { p1: 4999 } });
    expect(plan[0]).toMatchObject({ direction: "back_in_stock", resultingStockStatus: "in_stock" });
  });

  it("a never-completed return has nothing to reverse", () => {
    expect(planReturnReversal({ returnId: "ret1", outcome: null, restockedPurchaseIds: [], purchaseUnitCostsPence: {} })).toEqual([]);
  });
});

describe("planLossApplication / planLossReversal", () => {
  it("9. every affected purchase gets an out-of-stock movement with the correct distinct reason", () => {
    expect(planLossApplication({ lossId: "loss1", lossType: "lost_inventory", purchaseUnitCostsPence: { p1: 4700 }, stockRemoved: true })[0].reason).toBe("lost");
    expect(planLossApplication({ lossId: "loss1", lossType: "unsellable_purchase", purchaseUnitCostsPence: { p1: 100 }, stockRemoved: true })[0].reason).toBe("unsellable");
    expect(planLossApplication({ lossId: "loss1", lossType: "refund_without_return", purchaseUnitCostsPence: { p1: 100 }, stockRemoved: true })[0].reason).toBe("refunded_no_return");
  });

  it("'keep in stock' (other write-off) never plans a movement", () => {
    expect(planLossApplication({ lossId: "loss1", lossType: "other_write_off", purchaseUnitCostsPence: { p1: 100 }, stockRemoved: false })).toEqual([]);
  });

  it("22. reversal restores exactly the written-off units", () => {
    const plan = planLossReversal({ lossId: "loss1", writtenOffPurchaseIds: ["p1", "p2"], purchaseUnitCostsPence: { p1: 100, p2: 200 } });
    expect(plan.every(m => m.direction === "back_in_stock" && m.resultingStockStatus === "in_stock")).toBe(true);
  });
});

describe("findStockConflicts — cancellation safety", () => {
  it("blocks reversal when a unit's real current stock_status no longer matches what the reversal expects", () => {
    // a return restocked p1 (now expected in_stock before reversing it back out) — but it was sold again since.
    const plan = planReturnReversal({ returnId: "ret1", outcome: "returned_safely", restockedPurchaseIds: ["p1"], purchaseUnitCostsPence: { p1: 100 } });
    const conflicts = findStockConflicts(plan, { p1: "no_longer_in_stock" });
    expect(conflicts).toEqual(["p1"]);
  });

  it("no conflict when the unit is exactly in the state the reversal expects", () => {
    const plan = planReturnReversal({ returnId: "ret1", outcome: "returned_safely", restockedPurchaseIds: ["p1"], purchaseUnitCostsPence: { p1: 100 } });
    expect(findStockConflicts(plan, { p1: "in_stock" })).toEqual([]);
  });
});

describe("movement key builders are stable and namespaced", () => {
  it("return and loss keys never collide even with the same id", () => {
    expect(returnMovementKey("x", "p1", "restock")).not.toBe(lossMovementKey("x", "p1", "writeoff"));
  });
});
