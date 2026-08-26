import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { cancelSalesInputSchema } from "@/lib/validation/sales";
import { classifySaleRpcError } from "@/lib/sales/rpc-errors";
import type { CancelSalesResult } from "@/lib/types";

const RPC_ERROR_MESSAGES: Record<string, string> = {
  empty_selection: "Select at least one sale to cancel.",
  too_many_sales: "Select fewer sales — there is a maximum per cancellation.",
  duplicate_sale_ids: "The same sale was selected more than once.",
  sale_not_found: "One of the selected sales could not be found.",
  sale_not_completed: "One of the selected sales is already cancelled or refunded. Refresh and try again.",
};

/**
 * Bulk-cancels completed sales, atomically, via rpc/cancel_completed_sales
 * (see supabase-sales-v3.sql) — a single database transaction that
 * validates every selected sale (exists, owned by this user, currently
 * completed), locks it and every purchase it touches, flips it to
 * 'cancelled', deactivates its sale_items, and — only when explicitly
 * requested — restores the exact linked purchase UUIDs to 'in_stock'.
 *
 * This is a POST, not a DELETE: a completed sale is never hard-deleted here
 * (or anywhere) — its sales_orders/sale_items rows, snapshots, and money
 * fields are permanently retained for audit history. Using DELETE would
 * falsely suggest the financial record itself is being removed.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = cancelSalesInputSchema.parse(await request.json());
    try {
      const rpcResponse = await supabaseRequest("rpc/cancel_completed_sales", {
        method: "POST",
        body: JSON.stringify({
          p_owner_id: user.id,
          p_sales_order_ids: input.salesOrderIds,
          p_return_to_stock: input.returnToStock,
        }),
      });
      const [row] = await rpcResponse.json() as { orders_cancelled: number; units_affected: number }[];
      const result: CancelSalesResult = { ordersCancelled: row.orders_cancelled, unitsAffected: row.units_affected };
      return NextResponse.json(result);
    } catch (error) {
      // Only a recognized RPC-raised conflict is ever reported as a clear,
      // specific reason — anything else (missing migration/function,
      // database outage, permission problem) must propagate to safeApiError
      // below rather than being silently absorbed.
      const reason = classifySaleRpcError(error);
      if (!reason) throw error;
      return NextResponse.json({ error: RPC_ERROR_MESSAGES[reason] ?? "Could not cancel the selected sales.", reason }, { status: 409 });
    }
  } catch (error) { return safeApiError(error, "Could not cancel the selected sales."); }
}
