import type { ReturnRecordRow, LossRecordRow } from "@/lib/returns/types";

/**
 * Duplicate economic-event protection.
 *
 * One "buyer refunded, item not returned" incident must never be recorded
 * BOTH as a completed return with outcome `buyer_refunded_no_return` AND as a
 * standalone `refund_without_return` loss for the same sale units — that
 * would double-count the profit reversal, the refund and the inventory
 * write-off.
 *
 * These pure predicates run in both the preview and the final mutation
 * (revalidated on write, so previewing can't bypass the guard).
 */

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return b.some(id => set.has(id));
}

export type DuplicateConflict = { conflictingRecordType: "return" | "loss"; conflictingReference: string; reason: string } | null;

/** Called when COMPLETING a return as `buyer_refunded_no_return`. Blocks if
 * an active `refund_without_return` loss already covers this sale (and, when
 * both carry sale_item_ids, the same units). */
export function findRefundNoReturnConflictForReturn(params: {
  salesOrderId: string;
  saleItemIds: readonly string[];
  losses: LossRecordRow[];
}): DuplicateConflict {
  for (const loss of params.losses) {
    if (loss.deleted_at) continue;
    if (loss.loss_type !== "refund_without_return") continue;
    if (loss.sales_order_id !== params.salesOrderId) continue;
    const lossUnits = loss.sale_item_ids ?? [];
    const sameUnits = lossUnits.length === 0 || params.saleItemIds.length === 0 || overlaps(lossUnits, params.saleItemIds);
    if (sameUnits) {
      return {
        conflictingRecordType: "loss", conflictingReference: loss.reference,
        reason: `A "refund without return" loss (${loss.reference}) already records this refund for the same sale. Edit or delete that loss instead of also completing this return as "buyer refunded".`,
      };
    }
  }
  return null;
}

/** Called when CREATING a `refund_without_return` loss against a sale.
 * Blocks if a completed return with outcome `buyer_refunded_no_return`
 * already covers this sale / units. */
export function findRefundNoReturnConflictForLoss(params: {
  salesOrderId: string | null;
  saleItemIds: readonly string[];
  returns: ReturnRecordRow[];
}): DuplicateConflict {
  if (!params.salesOrderId) return null;
  for (const ret of params.returns) {
    if (ret.deleted_at) continue;
    if (ret.workflow_status !== "return_completed" || ret.outcome !== "buyer_refunded_no_return") continue;
    if (ret.sales_order_id !== params.salesOrderId) continue;
    const sameUnits = params.saleItemIds.length === 0 || overlaps(ret.sale_item_ids ?? [], params.saleItemIds);
    if (sameUnits) {
      return {
        conflictingRecordType: "return", conflictingReference: ret.reference,
        reason: `Return ${ret.reference} is already completed as "buyer refunded — item not returned" for this sale. That return already records the refund, profit reversal and stock write-off — do not also log a separate loss.`,
      };
    }
  }
  return null;
}
