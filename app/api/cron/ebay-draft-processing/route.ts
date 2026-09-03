import { NextResponse } from "next/server";

export const runtime = "nodejs";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * PHASE 3 (hard-retire legacy Inventory API writes) — RETIRED. This sweep
 * used to call lib/listing-studio/ebay-draft-batches.ts's
 * runEbayDraftBatchProcessTick for every owner with claimable legacy work,
 * which can call the Inventory API's createOrReplaceInventoryItem/
 * createOffer for any batch item still `queued`. Neutralised to a no-op so
 * ANY still-queued legacy batch item (if one exists) is never
 * automatically picked up and processed again — its row is left exactly
 * as it is, never rewritten, never deleted; it simply stops being acted
 * on. Still requires the same CRON_SECRET bearer auth as every other cron
 * route in this app (never a silent 200 to an unauthenticated caller).
 * See vercel.json, where this route's schedule entry has been removed —
 * this file is kept (rather than deleted) only so a stale registration
 * or manual trigger hits a safe, explicit no-op instead of a 404.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ retired: true, message: "This legacy Inventory API processing sweep is retired and performs no work. See app/api/cron/ebay-feed-processing/route.ts for the active Seller Hub draft pipeline's own sweep." });
}
