import { z } from "zod";
import { makeCsv, purchaseExportColumns } from "@/lib/exportColumns";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";

const idsSchema = z.array(z.string().uuid()).min(1).max(500);

export async function GET(request: Request) {
  try {
    await requireOwner();
    const { searchParams } = new URL(request.url);
    // Exporting a just-approved import batch by explicit id — never mixes
    // in unrelated historical purchases the way a date-range export could
    // (a re-import on the same day, or a backdated order_date, would
    // otherwise pull in rows the user didn't just approve).
    const idsParam = searchParams.get("ids");
    if (idsParam) {
      const parsedIds = idsSchema.safeParse(idsParam.split(",").map(value => value.trim()).filter(Boolean));
      if (!parsedIds.success) return new Response("Invalid ids.", { status: 400 });
      const r = await supabaseRequest(`purchases?select=*&id=in.(${parsedIds.data.join(",")})&order=order_date.asc`);
      return new Response(makeCsv(await r.json(), purchaseExportColumns), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="purchases-import-batch.csv"' } });
    }
    const start = searchParams.get("start"); const end = searchParams.get("end"); if (!start || !end) return new Response("Dates required", { status: 400 });
    const r = await supabaseRequest(`purchases?select=*&order_date=gte.${encodeURIComponent(start)}&order_date=lte.${encodeURIComponent(end)}&order=order_date.asc`);
    return new Response(makeCsv(await r.json(), purchaseExportColumns), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="purchases-${start}-${end}.csv"` } });
  } catch (e) { return new Response(e instanceof Error && e.name === "AuthError" ? "Authentication required." : "Export failed.", { status: e instanceof Error && e.name === "AuthError" ? 401 : 500 }); }
}
