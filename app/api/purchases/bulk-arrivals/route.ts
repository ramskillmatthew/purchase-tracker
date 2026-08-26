import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { bulkArrivalsRequestSchema } from "@/lib/validation/bulk-arrivals";
import { MAX_BULK_ARRIVAL_SKUS, resolveBulkArrivals, type ArrivalRecord } from "@/lib/bulk-arrivals";
import { parseSkuLines } from "@/lib/purchases";

/**
 * Bulk mark-arrivals: a pasted list of SKUs is matched against every
 * purchase in one request and the not-yet-arrived matches are set to
 * arrived = true in a single PATCH — never a fetch-everything-to-the-
 * browser flow, never one request per SKU. `action` distinguishes the
 * preview step (no writes) from the confirmed update; both re-derive the
 * match set fresh from the database on every call — a client-supplied
 * preview result is never trusted as the basis for what actually updates,
 * so data that changed between preview and confirmation is still caught.
 * Only ever touches the purchases table — no other record type is read or written here.
 */
export async function POST(request: Request) {
  try {
    await requireOwner();
    const { action, skus } = bulkArrivalsRequestSchema.parse(await request.json());

    // Independently re-parsed/deduplicated here — the client's own count and
    // dedup are never trusted as the basis for matching or updating.
    const uniqueSkus = parseSkuLines(skus.join("\n"));
    if (!uniqueSkus.length) return NextResponse.json({ error: "Enter at least one SKU." }, { status: 400 });
    if (uniqueSkus.length > MAX_BULK_ARRIVAL_SKUS) {
      return NextResponse.json({ error: `Submit at most ${MAX_BULK_ARRIVAL_SKUS} unique SKUs per request.` }, { status: 400 });
    }

    const records = await supabaseRequestAll<ArrivalRecord>("purchases?select=id,sku,arrived&sku=not.is.null&order=created_at.asc");
    const { updateIds, ...summary } = resolveBulkArrivals(uniqueSkus, records);

    if (action === "update" && updateIds.length) {
      await supabaseRequest(`purchases?id=in.(${updateIds.join(",")})`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ arrived: true }),
      });
    }

    return NextResponse.json({ ...summary, updatedIds: action === "update" ? updateIds : [] });
  } catch (error) { return safeApiError(error, "Could not process bulk arrivals."); }
}
