import { makeCsv, purchaseExportColumns } from "@/lib/exportColumns";
import { supabaseRequest } from "@/lib/supabase";

export async function GET(request: Request) {
  try { const { searchParams } = new URL(request.url); const start = searchParams.get("start"); const end = searchParams.get("end"); if (!start || !end) return new Response("Dates required", { status: 400 });
    const r = await supabaseRequest(`purchases?select=*&order_date=gte.${encodeURIComponent(start)}&order_date=lte.${encodeURIComponent(end)}&order=order_date.asc`);
    return new Response(makeCsv(await r.json(), purchaseExportColumns), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="purchases-${start}-${end}.csv"` } });
  } catch (e) { return new Response(e instanceof Error ? e.message : "Export failed", { status: 500 }); }
}
