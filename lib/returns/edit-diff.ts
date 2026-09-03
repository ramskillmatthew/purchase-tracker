import {
  planReturnCompletion, planReturnReversal, planLossApplication, planLossReversal,
  type PlannedMovement,
} from "@/lib/returns/stock-movements";
import type { ReturnOutcome } from "@/lib/returns/financial";
import type { LossType } from "@/lib/returns/types";

/**
 * Returns, Losses & Write-offs — DIFFERENCE-BASED edit planning.
 *
 * An edit never "replays completion". It computes only the delta between the
 * effects currently applied and the effects the new state implies:
 *
 *   - money-only change (postage, fees, other costs, notes, dates,
 *     recognition month): NO inventory movement at all — the caller just
 *     writes the recomputed money fields.
 *   - structural change (quantity, selected units, outcome, linked sale):
 *     a set-diff over the affected purchase units —
 *       * a unit no longer effective (removed, or its outcome/reason flipped)
 *         gets ONE reversal movement, keyed at the CURRENT generation;
 *       * a unit newly effective (added, or flipped) gets ONE apply movement,
 *         keyed at the NEXT generation so it can never collide with a prior
 *         application of the same unit.
 *
 * A unit that stays effective and unchanged produces NOTHING — its stock is
 * left exactly as it is.
 */

export type EffectiveReturnUnit = { purchaseId: string; outcome: ReturnOutcome };

export type ReturnStructuralDiff = {
  reverseMovements: PlannedMovement[];
  applyMovements: PlannedMovement[];
  nextGen: number;
  /** The purchase ids that will be effective after the edit (new restock/write-off snapshot). */
  effectivePurchaseIds: string[];
};

export function computeReturnStructuralDiff(params: {
  returnId: string;
  currentUnits: EffectiveReturnUnit[];
  desiredUnits: EffectiveReturnUnit[];
  unitCostsPence: Record<string, number>;
  currentGen: number;
}): ReturnStructuralDiff {
  const { returnId, unitCostsPence } = params;
  const currentGen = params.currentGen;
  const nextGen = currentGen + 1;
  const currentByPurchase = new Map(params.currentUnits.map(u => [u.purchaseId, u]));
  const desiredByPurchase = new Map(params.desiredUnits.map(u => [u.purchaseId, u]));

  const toReverse: EffectiveReturnUnit[] = [];
  const toApply: EffectiveReturnUnit[] = [];

  for (const cur of params.currentUnits) {
    const want = desiredByPurchase.get(cur.purchaseId);
    if (!want || want.outcome !== cur.outcome) toReverse.push(cur);
  }
  for (const want of params.desiredUnits) {
    const cur = currentByPurchase.get(want.purchaseId);
    if (!cur || cur.outcome !== want.outcome) toApply.push(want);
  }

  const reverseMovements = groupByOutcome(toReverse).flatMap(({ outcome, ids }) =>
    planReturnReversal({ returnId, outcome, restockedPurchaseIds: ids, purchaseUnitCostsPence: pick(unitCostsPence, ids), gen: currentGen }));
  const applyMovements = groupByOutcome(toApply).flatMap(({ outcome, ids }) =>
    planReturnCompletion({ returnId, outcome, purchaseUnitCostsPence: pick(unitCostsPence, ids), gen: nextGen }));

  return { reverseMovements, applyMovements, nextGen, effectivePurchaseIds: params.desiredUnits.map(u => u.purchaseId) };
}

export type LossStructuralDiff = {
  reverseMovements: PlannedMovement[];
  applyMovements: PlannedMovement[];
  nextGen: number;
  effectivePurchaseIds: string[];
};

export function computeLossStructuralDiff(params: {
  lossId: string;
  currentPurchaseIds: string[];
  currentLossType: LossType;
  currentStockRemoved: boolean;
  desiredPurchaseIds: string[];
  desiredLossType: LossType;
  desiredStockRemoved: boolean;
  unitCostsPence: Record<string, number>;
  currentGen: number;
}): LossStructuralDiff {
  const { lossId, unitCostsPence } = params;
  const nextGen = params.currentGen + 1;
  const currentSet = new Set(params.currentStockRemoved ? params.currentPurchaseIds : []);
  const desiredSet = new Set(params.desiredStockRemoved ? params.desiredPurchaseIds : []);
  const typeChanged = params.currentLossType !== params.desiredLossType;

  // A loss_type change re-classifies the movement reason, so every currently
  // effective unit is reversed and re-applied with the new reason.
  const reverseIds = params.currentStockRemoved
    ? params.currentPurchaseIds.filter(id => !desiredSet.has(id) || typeChanged)
    : [];
  const applyIds = params.desiredStockRemoved
    ? params.desiredPurchaseIds.filter(id => !currentSet.has(id) || typeChanged)
    : [];

  const reverseMovements = planLossReversal({ lossId, writtenOffPurchaseIds: reverseIds, purchaseUnitCostsPence: pick(unitCostsPence, reverseIds), gen: params.currentGen });
  const applyMovements = planLossApplication({ lossId, lossType: params.desiredLossType, purchaseUnitCostsPence: pick(unitCostsPence, applyIds), stockRemoved: params.desiredStockRemoved, gen: nextGen });

  return { reverseMovements, applyMovements, nextGen, effectivePurchaseIds: params.desiredStockRemoved ? params.desiredPurchaseIds : [] };
}

function groupByOutcome(units: EffectiveReturnUnit[]): { outcome: ReturnOutcome; ids: string[] }[] {
  const safely = units.filter(u => u.outcome === "returned_safely").map(u => u.purchaseId);
  const notReturned = units.filter(u => u.outcome === "buyer_refunded_no_return").map(u => u.purchaseId);
  const out: { outcome: ReturnOutcome; ids: string[] }[] = [];
  if (safely.length) out.push({ outcome: "returned_safely", ids: safely });
  if (notReturned.length) out.push({ outcome: "buyer_refunded_no_return", ids: notReturned });
  return out;
}

function pick(source: Record<string, number>, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = source[id] ?? 0;
  return out;
}
