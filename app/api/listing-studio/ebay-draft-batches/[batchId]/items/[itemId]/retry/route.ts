import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { retiredInventoryApiRouteResponse } from "@/lib/ebay-account/retired-inventory-route";

export const runtime = "nodejs";

/**
 * PHASE 3 (hard-retire legacy Inventory API writes) — RETIRED. This
 * endpoint used to call lib/listing-studio/ebay-draft-batches.ts's
 * retryFailedEbayDraftItem, which can call the Inventory API's
 * createOrReplaceInventoryItem/createOffer to bring a failed legacy item
 * back to life. That mechanism only ever produced an unpublished,
 * not-Seller-Hub-visible API offer — never the genuine, editable Seller
 * Hub draft this application's product spec requires — so it must never
 * be triggered again. Still requires the authenticated owner (never a
 * public 410 for an unauthenticated caller) before revealing even that
 * much, matching this app's own "auth first, always" convention; returns
 * 410 Gone rather than silently 404ing or continuing to work.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string; itemId: string }> }) {
  try {
    await requireOwner();
    void (await params);
    return retiredInventoryApiRouteResponse();
  } catch (error) { return safeApiError(error, "Could not process this request."); }
}
