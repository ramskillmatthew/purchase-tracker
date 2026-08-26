import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { updateSalesProcessStatusSchema } from "@/lib/validation/sales";
import type { SalesOrder } from "@/lib/types";

/**
 * Updates operational fulfilment state only. Financial completion,
 * cancellation, inventory and all saved money fields are deliberately absent
 * from the patch body. The terminal returned/cancelled state can only be
 * applied after the existing atomic cancellation workflow has completed.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    const { processStatus } = updateSalesProcessStatusSchema.parse(await request.json());
    const path = `sales_orders?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}`;
    const [order] = await (await supabaseRequest(`${path}&select=*`)).json() as SalesOrder[];
    if (!order) return NextResponse.json({ error: "Sale not found." }, { status: 404 });

    if (order.status === "completed" && (processStatus === "cancelled" || processStatus === "returned_cancelled")) {
      return NextResponse.json({ error: "Cancel the sale and confirm its stock outcome before applying a cancelled process status." }, { status: 409 });
    }
    if (order.status !== "completed" && processStatus !== "cancelled" && processStatus !== "returned_cancelled") {
      return NextResponse.json({ error: "A cancelled or refunded sale cannot be moved back into an active fulfilment state." }, { status: 409 });
    }

    await supabaseRequest(path, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ process_status: processStatus, updated_at: new Date().toISOString() }),
    });
    return NextResponse.json({ processStatus });
  } catch (error) {
    return safeApiError(error, "Could not update the sales process status. Install supabase-sales-v4-process-status.sql if it has not been applied.");
  }
}
