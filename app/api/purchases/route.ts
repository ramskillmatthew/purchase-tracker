import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { purchaseInputSchema } from "@/lib/validation/purchase";
import type { Purchase } from "@/lib/types";

export async function GET() {
  // A single unbounded request here used to be silently capped at
  // PostgREST's configured db-max-rows (1000) — every purchase beyond
  // that was invisible to the Home dashboard and Purchases page alike.
  // supabaseRequestAll pages through the full table instead.
  try { await requireOwner(); const rows = await supabaseRequestAll<Purchase>("purchases?select=*&order=order_date.desc,created_at.desc"); return NextResponse.json(rows); }
  catch (e) { return safeApiError(e); }
}

export async function POST(request: Request) {
  try {
    await requireOwner();
    const purchase = purchaseInputSchema.parse(await request.json());
    const quantity = purchase.quantity;

    const purchases = Array.from({ length: quantity }, () => ({ ...purchase, quantity: 1 }));
    await supabaseRequest("purchases", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(purchases),
    });
    return NextResponse.json({ ok: true, created: quantity }, { status: 201 });
  }
  catch (e) { return safeApiError(e, "Could not save purchase."); }
}

export async function PATCH(request: Request) {
  try {
    await requireOwner();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Purchase ID is required." }, { status: 400 });
    await supabaseRequest(`purchases?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(purchaseInputSchema.omit({ quantity: true }).partial().strict().parse(await request.json())),
    });
    return NextResponse.json({ ok: true });
  } catch (e) { return safeApiError(e, "Could not update purchase."); }
}

export async function DELETE(request: Request) {
  try {
    await requireOwner();
    const params = new URL(request.url).searchParams;
    if (params.get("clear") === "all") {
      await supabaseRequest("purchases?id=not.is.null", { method: "DELETE" });
      return NextResponse.json({ ok: true });
    }
    const id = params.get("id");
    if (!id) return NextResponse.json({ error: "Purchase ID is required." }, { status: 400 });
    await supabaseRequest(`purchases?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (e) { return safeApiError(e, "Could not delete purchase."); }
}
