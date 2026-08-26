import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { bulkPurchaseUpdateSchema } from "@/lib/validation/purchases-bulk-update";

export async function PATCH(request: Request) {
  try {
    await requireOwner();
    const input = bulkPurchaseUpdateSchema.parse(await request.json());
    const idFilter = input.ids.join(",");
    const existing = await (await supabaseRequest(`purchases?id=in.(${idFilter})&select=id`)).json() as { id: string }[];
    const existingIds = new Set(existing.map(row => row.id));
    const missingIds = input.ids.filter(id => !existingIds.has(id));
    if (missingIds.length) return NextResponse.json({ error: "One or more selected purchases no longer exist.", missingIds }, { status: 404 });

    const changes: { stock_status?: "in_stock" | "no_longer_in_stock"; arrived?: boolean } = {};
    if (input.stockStatus !== undefined) changes.stock_status = input.stockStatus;
    if (input.arrived !== undefined) changes.arrived = input.arrived;
    const updated = await (await supabaseRequest(`purchases?id=in.(${idFilter})&select=id`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(changes),
    })).json() as { id: string }[];
    if (updated.length !== input.ids.length) throw new Error("The complete purchase selection could not be updated.");
    return NextResponse.json({ ok: true, updatedCount: updated.length, updatedIds: updated.map(row => row.id) });
  } catch (error) { return safeApiError(error, "Could not update the selected purchases."); }
}
