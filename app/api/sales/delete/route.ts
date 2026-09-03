import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { classifySaleRpcError } from "@/lib/sales/rpc-errors";

const deleteCancelledSalesSchema = z.object({
  salesOrderIds: z.array(z.string().uuid()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.salesOrderIds).size !== value.salesOrderIds.length) {
    context.addIssue({ code: "custom", path: ["salesOrderIds"], message: "Sale IDs must be unique." });
  }
});

const RPC_ERROR_MESSAGES: Record<string, string> = {
  empty_selection: "Select at least one sale to delete.",
  too_many_sales: "Select fewer sales — there is a maximum per deletion.",
  sale_not_found: "One of the selected sales could not be found.",
  sale_still_active: "A completed sale must be cancelled before it can be permanently deleted.",
  active_return_blocks_delete: "This sale has an active return in progress. Cancel or reverse the return first, then delete the sale.",
  active_loss_blocks_delete: "This sale has an active loss / write-off recorded against it. Remove or reverse it first, then delete the sale.",
};

/**
 * Permanently removes an ALREADY-CANCELLED, owner-scoped sale together with its
 * safely-inactive return history, atomically, via rpc/rl_purge_deletable_sale
 * (see supabase-returns-losses.sql). One transaction:
 *   - refuses a still-completed sale (cancel it first),
 *   - refuses while a genuinely active return or loss owns the sale,
 *   - otherwise removes the sale's cancelled / soft-deleted returns (and their
 *     net-zero inventory_movements + cascaded audit rows), detaches any
 *     soft-deleted loss (keeping it as history), then deletes the sale
 *     (sale_items cascade).
 * A stale client copy or a lingering historical return record can never block
 * the delete or leave an orphan.
 */
export async function DELETE(request: Request) {
  try {
    const user = await requireOwner();
    const { salesOrderIds } = deleteCancelledSalesSchema.parse(await request.json());
    const idFilter = salesOrderIds.map(encodeURIComponent).join(",");
    const existing = await (await supabaseRequest(
      `sales_orders?owner_id=eq.${user.id}&id=in.(${idFilter})&select=id,status`,
    )).json() as { id: string; status: string }[];
    if (existing.length !== salesOrderIds.length || existing.some(order => order.status === "completed")) {
      return NextResponse.json({ error: "Active sales must complete the cancellation and stock decision before permanent deletion." }, { status: 409 });
    }

    try {
      const rpcResponse = await supabaseRequest("rpc/rl_purge_deletable_sale", {
        method: "POST",
        body: JSON.stringify({ p_owner_id: user.id, p_sales_order_ids: salesOrderIds }),
      });
      const result = await rpcResponse.json() as { deleted_sales: number; deleted_returns: number; detached_losses: number };
      return NextResponse.json({
        deleted: result.deleted_sales,
        deletedReturns: result.deleted_returns,
        detachedLosses: result.detached_losses,
      });
    } catch (error) {
      const reason = classifySaleRpcError(error);
      if (!reason || !(reason in RPC_ERROR_MESSAGES)) throw error;
      return NextResponse.json({ error: RPC_ERROR_MESSAGES[reason], reason }, { status: 409 });
    }
  } catch (error) {
    return safeApiError(error, "Could not permanently delete the cancelled sales.");
  }
}
