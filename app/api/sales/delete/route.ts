import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";

const deleteCancelledSalesSchema = z.object({
  salesOrderIds: z.array(z.string().uuid()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.salesOrderIds).size !== value.salesOrderIds.length) {
    context.addIssue({ code: "custom", path: ["salesOrderIds"], message: "Sale IDs must be unique." });
  }
});

/** Permanently removes only non-active, owner-scoped sales. Active sales must be cancelled first. */
export async function DELETE(request: Request) {
  try {
    const user = await requireOwner();
    const { salesOrderIds } = deleteCancelledSalesSchema.parse(await request.json());
    const idFilter = salesOrderIds.map(encodeURIComponent).join(",");
    const ownerPath = `sales_orders?owner_id=eq.${user.id}&id=in.(${idFilter})`;
    const existing = await (await supabaseRequest(`${ownerPath}&select=id,status`)).json() as { id: string; status: string }[];
    if (existing.length !== salesOrderIds.length || existing.some(order => order.status === "completed")) {
      return NextResponse.json({ error: "Active sales must complete the cancellation and stock decision before permanent deletion." }, { status: 409 });
    }
    const deleted = await (await supabaseRequest(`${ownerPath}&status=neq.completed`, { method: "DELETE", headers: { Prefer: "return=representation" } })).json() as { id: string }[];
    return NextResponse.json({ deleted: deleted.length });
  } catch (error) {
    return safeApiError(error, "Could not permanently delete the cancelled sales.");
  }
}
