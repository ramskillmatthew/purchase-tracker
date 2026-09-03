/**
 * Returns, Losses & Write-offs — inventory-movement planning + idempotency.
 *
 * Every stock change this feature makes is expressed as a PlannedMovement
 * with a deterministic `idempotencyKey`. The migration's
 * `inventory_movements.idempotency_key` unique index is the hard DB-level
 * guarantee that the same movement is never written twice — a retried or
 * double-submitted completion/loss request produces the identical key, so a
 * duplicate insert fails harmlessly and the caller treats "already exists"
 * as "already applied", never as an error to surface to the owner.
 *
 * Applying a plan is the caller's job (an API route, via supabaseRequest):
 * 1. Insert the inventory_movements row for each planned movement (on a
 *    unique-violation, skip it — already applied).
 * 2. PATCH purchases.stock_status for that purchase_id to the movement's
 *    resulting status.
 * Both steps happen for every purchase_id in the plan; if step 1 succeeds
 * for a purchase but step 2 fails, the movement row alone is enough to
 * safely retry step 2 (it is not re-inserted).
 */

export type MovementDirection = "out_of_stock" | "back_in_stock";
export type MovementReason = "lost" | "unsellable" | "refunded_no_return" | "returned_to_stock" | "loss_reversed" | "return_reversed";

export type PlannedMovement = {
  purchaseId: string;
  direction: MovementDirection;
  reason: MovementReason;
  idempotencyKey: string;
  unitCostPence: number;
  resultingStockStatus: "in_stock" | "no_longer_in_stock";
};

/** `gen` (default 0) namespaces the key per edit generation, so an edit that
 * reverses a unit and later re-applies the SAME unit gets a fresh,
 * non-colliding idempotency key. gen 0 keeps the original wire format. */
export function returnMovementKey(returnId: string, purchaseId: string, action: "restock" | "writeoff" | "restock_reversed" | "writeoff_reversed", gen = 0): string {
  return `return:${returnId}:${action}:${purchaseId}${gen ? `:g${gen}` : ""}`;
}
export function lossMovementKey(lossId: string, purchaseId: string, action: "writeoff" | "writeoff_reversed", gen = 0): string {
  return `loss:${lossId}:${action}:${purchaseId}${gen ? `:g${gen}` : ""}`;
}

const LOSS_TYPE_TO_REASON: Record<string, MovementReason> = {
  lost_inventory: "lost",
  unsellable_purchase: "unsellable",
  refund_without_return: "refunded_no_return",
};

/** On completing a return: 'returned_safely' restocks every affected unit at
 * its original cost; 'buyer_refunded_no_return' writes them off (they were
 * already out_of_stock from the sale — this only records WHY, via the
 * movement row; their stock_status does not need to change). */
export function planReturnCompletion(params: {
  returnId: string;
  outcome: "returned_safely" | "buyer_refunded_no_return";
  purchaseUnitCostsPence: Record<string, number>; // purchaseId -> original cost
  gen?: number;
}): PlannedMovement[] {
  const gen = params.gen ?? 0;
  const ids = Object.keys(params.purchaseUnitCostsPence);
  if (params.outcome === "returned_safely") {
    return ids.map(purchaseId => ({
      purchaseId, direction: "back_in_stock", reason: "returned_to_stock",
      idempotencyKey: returnMovementKey(params.returnId, purchaseId, "restock", gen),
      unitCostPence: params.purchaseUnitCostsPence[purchaseId], resultingStockStatus: "in_stock",
    }));
  }
  return ids.map(purchaseId => ({
    purchaseId, direction: "out_of_stock", reason: "refunded_no_return",
    idempotencyKey: returnMovementKey(params.returnId, purchaseId, "writeoff", gen),
    unitCostPence: params.purchaseUnitCostsPence[purchaseId], resultingStockStatus: "no_longer_in_stock",
  }));
}

/** Reversing a completed return: undo exactly what completion did, using the
 * SAME purchase ids that were snapshotted at completion time
 * (return_records.restock_purchase_ids), never re-derived. `gen` bumps the
 * key so an edit can reverse-then-reapply the same unit without collision. */
export function planReturnReversal(params: {
  returnId: string;
  outcome: "returned_safely" | "buyer_refunded_no_return" | null;
  restockedPurchaseIds: string[];
  purchaseUnitCostsPence: Record<string, number>;
  gen?: number;
}): PlannedMovement[] {
  if (!params.outcome) return []; // never completed -> nothing to reverse
  const gen = params.gen ?? 0;
  if (params.outcome === "returned_safely") {
    return params.restockedPurchaseIds.map(purchaseId => ({
      purchaseId, direction: "out_of_stock", reason: "return_reversed",
      idempotencyKey: returnMovementKey(params.returnId, purchaseId, "restock_reversed", gen),
      unitCostPence: params.purchaseUnitCostsPence[purchaseId] ?? 0, resultingStockStatus: "no_longer_in_stock",
    }));
  }
  return params.restockedPurchaseIds.map(purchaseId => ({
    purchaseId, direction: "back_in_stock", reason: "return_reversed",
    idempotencyKey: returnMovementKey(params.returnId, purchaseId, "writeoff_reversed", gen),
    unitCostPence: params.purchaseUnitCostsPence[purchaseId] ?? 0, resultingStockStatus: "in_stock",
  }));
}

export function planLossApplication(params: {
  lossId: string;
  lossType: "lost_inventory" | "unsellable_purchase" | "refund_without_return" | "other_write_off";
  purchaseUnitCostsPence: Record<string, number>;
  stockRemoved: boolean;
  gen?: number;
}): PlannedMovement[] {
  if (!params.stockRemoved) return [];
  const gen = params.gen ?? 0;
  const reason = LOSS_TYPE_TO_REASON[params.lossType] ?? "unsellable";
  return Object.keys(params.purchaseUnitCostsPence).map(purchaseId => ({
    purchaseId, direction: "out_of_stock", reason,
    idempotencyKey: lossMovementKey(params.lossId, purchaseId, "writeoff", gen),
    unitCostPence: params.purchaseUnitCostsPence[purchaseId], resultingStockStatus: "no_longer_in_stock",
  }));
}

export function planLossReversal(params: { lossId: string; writtenOffPurchaseIds: string[]; purchaseUnitCostsPence: Record<string, number>; gen?: number }): PlannedMovement[] {
  const gen = params.gen ?? 0;
  return params.writtenOffPurchaseIds.map(purchaseId => ({
    purchaseId, direction: "back_in_stock", reason: "loss_reversed",
    idempotencyKey: lossMovementKey(params.lossId, purchaseId, "writeoff_reversed", gen),
    unitCostPence: params.purchaseUnitCostsPence[purchaseId] ?? 0, resultingStockStatus: "in_stock",
  }));
}

/** Serialise a PlannedMovement[] to the jsonb shape rl_apply_movements expects. */
export function movementsToRpcJson(movements: PlannedMovement[], opts: { returnRecordId?: string; lossRecordId?: string }): Record<string, unknown>[] {
  return movements.map(m => ({
    purchase_id: m.purchaseId,
    direction: m.direction,
    reason: m.reason,
    return_record_id: opts.returnRecordId ?? "",
    loss_record_id: opts.lossRecordId ?? "",
    unit_cost: (m.unitCostPence / 100).toFixed(2),
    idempotency_key: m.idempotencyKey,
    resulting_stock_status: m.resultingStockStatus,
  }));
}

/** Serialise a stock-precondition check list for rl_assert_stock. */
export function stockChecksToRpcJson(movements: PlannedMovement[]): Record<string, string>[] {
  return movements.map(m => ({
    purchase_id: m.purchaseId,
    expected: m.direction === "out_of_stock" ? "in_stock" : "no_longer_in_stock",
  }));
}

/**
 * Stock-conflict detection for a reversal: if a unit's CURRENT stock_status
 * no longer matches what the reversal expects to find it in (e.g. it was
 * sold again after being restocked by a return, so it is no longer
 * `in_stock` when a return-cancellation tries to take it back out), the
 * reversal must be blocked rather than silently corrupting stock. The
 * caller surfaces `conflictingPurchaseIds` as a clear, specific error.
 */
export function findStockConflicts(
  planned: PlannedMovement[],
  currentStockStatusByPurchaseId: Record<string, "in_stock" | "no_longer_in_stock">,
): string[] {
  const expectedBefore = (movement: PlannedMovement): "in_stock" | "no_longer_in_stock" =>
    movement.direction === "out_of_stock" ? "in_stock" : "no_longer_in_stock";
  return planned
    .filter(m => currentStockStatusByPurchaseId[m.purchaseId] !== undefined && currentStockStatusByPurchaseId[m.purchaseId] !== expectedBefore(m))
    .map(m => m.purchaseId);
}
