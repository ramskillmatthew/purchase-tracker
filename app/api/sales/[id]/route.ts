import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import type { SaleItem, SalesOrder } from "@/lib/types";

/** Reads one sale with its full line-item breakdown, owner-scoped. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    const [order] = await (await supabaseRequest(`sales_orders?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}&select=*`)).json() as SalesOrder[];
    if (!order) return NextResponse.json({ error: "Sale not found." }, { status: 404 });
    const items = await supabaseRequestAll<SaleItem>(`sale_items?sales_order_id=eq.${encodeURIComponent(id)}&order=created_at.asc`);
    return NextResponse.json({ order, items });
  } catch (error) { return safeApiError(error, "Could not load the sale."); }
}
