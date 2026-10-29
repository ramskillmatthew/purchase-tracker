import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner } from "@/lib/auth/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { bulkSaleExpectedDateSchema } from "@/lib/validation/finance";

export async function PATCH(request: Request) {
  try {
    const user = await requireOwner();
    const input = bulkSaleExpectedDateSchema.parse(await request.json());
    const ids = input.salesOrderIds.join(",");
    const owned = await supabaseRequestAll<{id:string}>(`sales_orders?owner_id=eq.${user.id}&id=in.(${ids})&select=id&order=id.asc`);
    if (owned.length !== input.salesOrderIds.length) return NextResponse.json({ error: "One or more selected sales could not be found." }, { status: 404 });

    await supabaseRequest("finance_sale_payment_details?on_conflict=owner_id,sales_order_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(input.salesOrderIds.map(salesOrderId => ({
        owner_id: user.id,
        sales_order_id: salesOrderId,
        date_kind: input.dateKind,
        expected_date: input.dateKind === "exact" ? input.expectedDate : null,
        range_start: input.dateKind === "range" ? input.rangeStart : null,
        range_end: input.dateKind === "range" ? input.rangeEnd : null,
        updated_at: new Date().toISOString(),
      }))),
    });
    return NextResponse.json({ ok: true, updated: input.salesOrderIds.length });
  } catch (error) { return safeApiError(error, "Could not update the expected payment date."); }
}
