import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { purchaseInputSchema } from "@/lib/validation/purchase";

export async function GET() {
  try { await requireOwner(); const r = await supabaseRequest("purchases?select=*&order=order_date.desc,created_at.desc"); return NextResponse.json(await r.json()); }
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
