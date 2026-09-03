import type { ReturnRecordRow } from "@/lib/returns/types";

/**
 * Returns, Losses & Write-offs — return-quantity eligibility. This app's
 * inventory model is one row per unit, and a sale of N units has N active
 * sale_items rows; a return "consumes" some of those units. A unit cannot be
 * tied to more than one active/completed return at once.
 */

const CONSUMING_STATUSES = new Set(["return_started", "item_sent", "return_delivered", "return_completed"]);

/** Units of a sale already committed to active/completed (non-cancelled) returns. */
export function unitsAlreadyReturning(existingReturns: Pick<ReturnRecordRow, "workflow_status" | "quantity">[]): number {
  return existingReturns
    .filter(r => CONSUMING_STATUSES.has(r.workflow_status))
    .reduce((sum, r) => sum + Math.max(0, Math.trunc(r.quantity)), 0);
}

/** How many more units of this sale can still be put into a new return. */
export function eligibleReturnQuantity(
  soldUnitCount: number,
  existingReturns: Pick<ReturnRecordRow, "workflow_status" | "quantity">[],
): number {
  const sold = Math.max(0, Math.trunc(soldUnitCount));
  return Math.max(0, sold - unitsAlreadyReturning(existingReturns));
}

export type ReturnQuantityValidation = { ok: true; quantity: number } | { ok: false; error: string };

/** Validate a requested return quantity: positive integer, within the
 * eligible remaining amount. `currentReturnId` lets an EDIT exclude the
 * return being edited from the "already returning" total. */
export function validateReturnQuantity(params: {
  requested: number;
  soldUnitCount: number;
  existingReturns: (Pick<ReturnRecordRow, "workflow_status" | "quantity"> & { id?: string })[];
  currentReturnId?: string | null;
}): ReturnQuantityValidation {
  const requested = Number(params.requested);
  if (!Number.isInteger(requested) || requested < 1) {
    return { ok: false, error: "Return quantity must be a whole number of 1 or more." };
  }
  const others = params.existingReturns.filter(r => !params.currentReturnId || r.id !== params.currentReturnId);
  const eligible = eligibleReturnQuantity(params.soldUnitCount, others);
  if (requested > eligible) {
    return { ok: false, error: eligible <= 0
      ? "Every unit from this sale is already tied to an active or completed return."
      : `Only ${eligible} unit${eligible === 1 ? "" : "s"} from this sale can still be returned.` };
  }
  return { ok: true, quantity: requested };
}

/**
 * Precise (id-level, not just count-level) selection of which sale_items a
 * new return covers — the hard guarantee behind "the same sale quantity
 * cannot be returned more than once" once an order spans multiple different
 * items. `allActiveSaleItemIds` must already be ordered (created_at asc, the
 * app's own established sale_items ordering); `alreadyClaimedIds` is every
 * sale_item id any OTHER active/completed return on this sale already holds.
 */
export function selectSaleItemIdsForReturn(params: {
  allActiveSaleItemIds: string[];
  alreadyClaimedIds: string[];
  quantity: number;
}): { ok: true; saleItemIds: string[] } | { ok: false; error: string } {
  const claimed = new Set(params.alreadyClaimedIds);
  const available = params.allActiveSaleItemIds.filter(id => !claimed.has(id));
  if (params.quantity > available.length) {
    return { ok: false, error: available.length === 0
      ? "Every unit from this sale is already tied to an active or completed return."
      : `Only ${available.length} unit${available.length === 1 ? "" : "s"} from this sale can still be returned.` };
  }
  return { ok: true, saleItemIds: available.slice(0, params.quantity) };
}

/**
 * Loss / write-off quantity eligibility against a matched purchase. In this
 * app's one-row-per-unit model, `remainingInStockUnitRows` is the count of
 * purchases rows for that item still `stock_status = 'in_stock'` and not
 * already written off. A unit cannot be written off twice — that is
 * enforced structurally by only ever selecting from currently-in-stock unit
 * rows, plus the inventory_movements idempotency key.
 */
export type LossQuantityValidation = { ok: true; quantity: number } | { ok: false; error: string };

export function validateLossQuantity(params: { requested: number; remainingEligible: number }): LossQuantityValidation {
  const requested = Number(params.requested);
  if (!Number.isInteger(requested) || requested < 1) {
    return { ok: false, error: "Quantity must be a whole number of 1 or more." };
  }
  const eligible = Math.max(0, Math.trunc(params.remainingEligible));
  if (requested > eligible) {
    return { ok: false, error: eligible <= 0
      ? "No eligible in-stock units remain for this purchase."
      : `Only ${eligible} unit${eligible === 1 ? "" : "s"} from this purchase are eligible.` };
  }
  return { ok: true, quantity: requested };
}
