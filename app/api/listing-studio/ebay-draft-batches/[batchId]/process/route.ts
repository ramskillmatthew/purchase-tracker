import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { retiredInventoryApiRouteResponse } from "@/lib/ebay-account/retired-inventory-route";

export const runtime = "nodejs";

/**
 * PHASE 3 (hard-retire legacy Inventory API writes) — RETIRED. This
 * endpoint used to call lib/listing-studio/ebay-draft-batches.ts's
 * runEbayDraftBatchProcessTick, which advances a legacy batch item and can
 * call the Inventory API's createOrReplaceInventoryItem/createOffer for
 * any item still 'queued'. See
 * app/api/listing-studio/ebay-draft-batches/[batchId]/items/[itemId]/retry/route.ts's
 * own identical corrective-pass comment for the full rationale — this is
 * the same retirement, applied to this route.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    await requireOwner();
    void (await params);
    return retiredInventoryApiRouteResponse();
  } catch (error) { return safeApiError(error, "Could not process this request."); }
}
