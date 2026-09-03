import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { getEbayConnection, listEbayPolicies, listEbayInventoryLocations } from "@/lib/ebay-account/client";

export const runtime = "nodejs";

/**
 * Read-only connection + policy status for the Settings page — never
 * triggers a sync itself (that's the explicit "Sync account" action, see
 * ../sync/route.ts), so opening/reloading Settings never makes an eBay
 * API call on its own. Encrypted tokens are never selected by
 * getEbayConnection/listEbayPolicies in the first place, so there is
 * nothing sensitive here to accidentally serialise.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const connection = await getEbayConnection(user.id);
    const policies = connection ? await listEbayPolicies(connection.id) : [];
    // CORRECTIVE PASS — locations reads ebay_inventory_locations, a table
    // that only exists once supabase-ebay-draft-batches.sql has been
    // applied. Degrades gracefully to [] (never breaks the WHOLE
    // connection/policy response — and therefore the entire Settings eBay
    // section, including the already-working "Connected"/policy display
    // — just because the newer table isn't there yet), exactly like the
    // listings-review route's own graceful-degradation fix for the same
    // migration.
    const locations = connection ? await listEbayInventoryLocations(connection.id).catch(() => []) : [];
    return NextResponse.json({ connection, policies, locations }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return safeApiError(error, "Could not load the eBay connection."); }
}
