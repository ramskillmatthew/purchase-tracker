import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { listOwnerEbayBatches } from "@/lib/listing-studio/ebay-draft-batches";
import { isMissingSchemaError } from "@/lib/supabase";
import { retiredInventoryApiRouteResponse } from "@/lib/ebay-account/retired-inventory-route";

export const runtime = "nodejs";

/**
 * Stage 6 (eBay draft batches) — GET remains: pure history/read, no eBay
 * call, so a stuck or completed legacy batch stays visible exactly as it
 * always did (see this app's own "preserve historical batch display, do
 * not delete legacy records" rule). POST is retired below.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const { visible, stuck } = await listOwnerEbayBatches(user.id);
    return NextResponse.json({
      available: true,
      batchIds: visible.map(b => ({ batchId: b.batchId, displayNumber: b.displayNumber })),
      stuck: stuck.map(b => ({ batchId: b.batchId, displayNumber: b.displayNumber, status: b.status, listingCount: b.listingCount, createdAt: b.createdAt })),
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ available: false, batchIds: [], stuck: [] });
    }
    return safeApiError(error, "Could not check for active eBay draft batches.");
  }
}

/**
 * PHASE 3 (hard-retire legacy Inventory API writes) — RETIRED. This
 * endpoint used to create a NEW legacy batch and immediately run its
 * first process tick, which calls the Inventory API's
 * createOrReplaceInventoryItem/createOffer — an unpublished, API-only
 * offer never visible in Seller Hub, not the genuine editable draft this
 * application's product spec requires. See
 * app/api/listing-studio/ebay-draft-batches/[batchId]/process/route.ts's
 * own identical corrective-pass comment for the full rationale. Use
 * POST /api/listing-studio/ebay-feed-batches instead.
 */
export async function POST(_request: Request) {
  try {
    await requireOwner();
    return retiredInventoryApiRouteResponse();
  } catch (error) { return safeApiError(error, "Could not process this request."); }
}
