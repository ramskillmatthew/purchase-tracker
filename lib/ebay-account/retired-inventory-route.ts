import { NextResponse } from "next/server";

/**
 * PHASE 3 (hard-retire legacy Inventory API writes) — the one, shared 410
 * response every retired legacy Inventory-API-writing route returns. The
 * Inventory API's createOrReplaceInventoryItem/createOffer pipeline
 * (lib/listing-studio/ebay-draft-batches.ts, lib/ebay-account/inventory-client.ts)
 * is never deleted and its historical rows are never touched — only the
 * ACTIVE code paths that could create a NEW write are cut off here, at the
 * one boundary every browser/cron trigger must cross: the route handler
 * itself, before it ever calls into the pipeline.
 *
 * 410 Gone (not 404, not 403) is deliberate: the resource genuinely used
 * to work and now permanently doesn't, which is exactly what "retired" is
 * — this is more honest than 404 (which would suggest the URL never
 * existed) or 403 (which would suggest a permission problem the user
 * could fix).
 */
export function retiredInventoryApiRouteResponse(): NextResponse {
  return NextResponse.json({
    error: "This eBay Inventory API pathway is retired and no longer creates or modifies anything. Use 'Create Seller Hub draft' instead, which creates a genuine, editable draft in eBay Seller Hub — this pathway only ever created an unpublished API-only offer that was never visible there.",
    retired: true,
  }, { status: 410 });
}
