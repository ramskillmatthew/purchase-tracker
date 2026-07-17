import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";

export async function GET() {
  try {
    const response = await supabaseRequest("expenses?select=*&order=purchase_date.desc,created_at.desc");
    return NextResponse.json(await response.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try { await supabaseRequest("expenses", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(await request.json()) }); return NextResponse.json({ ok: true }, { status: 201 }); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 500 }); }
}

export async function PATCH(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Expense ID is required." }, { status: 400 });
    await supabaseRequest(`expenses?id=eq.${encodeURIComponent(id)}`, {
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
      await supabaseRequest("expenses?id=not.is.null", { method: "DELETE" });
      return NextResponse.json({ ok: true });
    }
    const id = params.get("id");
    if (!id) return NextResponse.json({ error: "Expense ID is required." }, { status: 400 });
    await supabaseRequest(`expenses?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 500 });
  }
}
