import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";

export async function GET() {
  try { const r = await supabaseRequest("purchases?select=*&order=order_date.desc,created_at.desc"); return NextResponse.json(await r.json()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const purchase = await request.json();
    const quantity = Math.floor(Number(purchase.quantity));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) {
      return NextResponse.json({ error: "Quantity must be between 1 and 100." }, { status: 400 });
    }

    const purchases = Array.from({ length: quantity }, () => ({ ...purchase, quantity: 1 }));
    await supabaseRequest("purchases", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(purchases),
    });
    return NextResponse.json({ ok: true, created: quantity }, { status: 201 });
  }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 500 }); }
}

export async function PATCH(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Purchase ID is required." }, { status: 400 });
    await supabaseRequest(`purchases?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(await request.json()),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.get("clear") === "all") {
      await supabaseRequest("purchases?id=not.is.null", { method: "DELETE" });
      return NextResponse.json({ ok: true });
    }
    const id = params.get("id");
    if (!id) return NextResponse.json({ error: "Purchase ID is required." }, { status: 400 });
    await supabaseRequest(`purchases?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 500 });
  }
}
