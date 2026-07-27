import { expenseExportColumns, makeCsv } from "@/lib/exportColumns";
import { supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import type { Expense } from "@/lib/types";

export async function GET(request: Request) {
  try { await requireOwner(); const { searchParams } = new URL(request.url); const start = searchParams.get("start"); const end = searchParams.get("end"); if (!start || !end) return new Response("Dates required", { status: 400 });
    // See app/api/export/purchases/route.ts — same PostgREST truncation risk for a wide date range, same fix.
    const rows = await supabaseRequestAll<Expense>(`expenses?select=*&purchase_date=gte.${encodeURIComponent(start)}&purchase_date=lte.${encodeURIComponent(end)}&order=purchase_date.asc`);
    return new Response(makeCsv(rows, expenseExportColumns), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="expenses-${start}-${end}.csv"` } });
  } catch (e) { return new Response(e instanceof Error && e.name === "AuthError" ? "Authentication required." : "Export failed.", { status: e instanceof Error && e.name === "AuthError" ? 401 : 500 }); }
}
