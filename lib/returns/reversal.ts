import { planReturnReversal, planLossReversal, findStockConflicts, movementsToRpcJson, stockChecksToRpcJson, type PlannedMovement } from "@/lib/returns/stock-movements";
import type { ReturnRecordRow, LossRecordRow } from "@/lib/returns/types";

/**
 * Shared "reverse everything this record applied" planner — used by return
 * cancel + return delete, and by loss delete. Pure: the caller supplies the
 * record, a purchaseId->costPence map, and the CURRENT stock_status of every
 * affected purchase; this returns the movement + stock-check jsonb for the
 * transactional RPC, plus any blocking conflicts.
 */
export function buildReturnReversal(params: {
  record: Pick<ReturnRecordRow, "id" | "outcome" | "restock_purchase_ids" | "reversed_movement_gen">;
  purchaseCostByUnit: Record<string, number>;
  currentStockById: Record<string, "in_stock" | "no_longer_in_stock">;
  extraGen?: number;
}): { movements: PlannedMovement[]; movementsJson: Record<string, unknown>[]; stockChecksJson: Record<string, string>[]; conflicts: string[]; nextGen: number } {
  const gen = (params.record.reversed_movement_gen ?? 0) + (params.extraGen ?? 0);
  const movements = planReturnReversal({
    returnId: params.record.id,
    outcome: params.record.outcome,
    restockedPurchaseIds: params.record.restock_purchase_ids ?? [],
    purchaseUnitCostsPence: params.purchaseCostByUnit,
    gen,
  });
  const conflicts = findStockConflicts(movements, params.currentStockById);
  return {
    movements,
    movementsJson: movementsToRpcJson(movements, { returnRecordId: params.record.id }),
    stockChecksJson: stockChecksToRpcJson(movements),
    conflicts,
    nextGen: gen + 1,
  };
}

export function buildLossReversal(params: {
  record: Pick<LossRecordRow, "id" | "written_off_purchase_ids" | "reversed_movement_gen">;
  purchaseCostByUnit: Record<string, number>;
  currentStockById: Record<string, "in_stock" | "no_longer_in_stock">;
}): { movements: PlannedMovement[]; movementsJson: Record<string, unknown>[]; stockChecksJson: Record<string, string>[]; conflicts: string[]; nextGen: number } {
  const gen = params.record.reversed_movement_gen ?? 0;
  const movements = planLossReversal({
    lossId: params.record.id,
    writtenOffPurchaseIds: params.record.written_off_purchase_ids ?? [],
    purchaseUnitCostsPence: params.purchaseCostByUnit,
    gen,
  });
  const conflicts = findStockConflicts(movements, params.currentStockById);
  return {
    movements,
    movementsJson: movementsToRpcJson(movements, { lossRecordId: params.record.id }),
    stockChecksJson: stockChecksToRpcJson(movements),
    conflicts,
    nextGen: gen + 1,
  };
}
