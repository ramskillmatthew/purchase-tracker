import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { expenseInputSchema } from "@/lib/validation/purchase";

export async function GET() {
  try {
    await requireOwner();
    const response = await supabaseRequest("expenses?select=*&order=purchase_date.desc,created_at.desc");
    return NextResponse.json(await response.json());
  } catch (e) { return safeApiError(e); }
}

export async function POST(request: Request) {
  try { await requireOwner(); await supabaseRequest("expenses", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(expenseInputSchema.parse(await request.json())) }); return NextResponse.json({ ok: true }, { status: 201 }); }
  catch (e) { return safeApiError(e, "Could not save expense."); }
}

export async function PATCH(request: Request) {
  try {
    await requireOwner();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Expense ID is required." }, { status: 400 });
    await supabaseRequest(`expenses?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(expenseInputSchema.partial().strict().parse(await request.json())),
    });
    return NextResponse.json({ ok: true });
  } catch (e) { return safeApiError(e, "Could not update expense."); }
}

export async function DELETE(request: Request) {
  try {
    await requireOwner();
    const params = new URL(request.url).searchParams;
    if (params.get("clear") === "all") {
      await supabaseRequest("expenses?id=not.is.null", { method: "DELETE" });
      return NextResponse.json({ ok: true });
    }
    const id = params.get("id");
    if (!id) return NextResponse.json({ error: "Expense ID is required." }, { status: 400 });
    await supabaseRequest(`expenses?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (e) { return safeApiError(e, "Could not delete expense."); }
}
