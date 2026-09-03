import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { createEbayFeedBatch, listOwnerEbayFeedBatches, runEbayFeedBatchProcessTick, resolveEbayFeedDraftEligibilityForProducts } from "@/lib/listing-studio/ebay-feed/feed-batches";
import { enforceRateLimit } from "@/lib/security/activity";
import { isMissingSchemaError } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_EBAY_FEED_BATCH_LISTINGS = 25;
const RATE_LIMIT_MAX_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

/**
 * The Sell Feed API pipeline's own equivalent of
 * app/api/listing-studio/ebay-draft-batches/route.ts — creates a genuine,
 * editable Seller Hub draft via lib/listing-studio/ebay-feed/feed-batches.ts,
 * never an Inventory API offer. See that file's own header for why this
 * is a wholly separate route/table/pipeline from the legacy one, which is
 * left untouched.
 *
 * POST is "skip and report", not all-or-nothing, mirroring the legacy
 * route's own convention exactly — eligibility is re-verified fresh here,
 * never trusting the client's own precomputed count.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const { visible, stuck } = await listOwnerEbayFeedBatches(user.id);
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

const createRequestSchema = z.object({ draftIds: z.array(uuidSchema).min(1).max(MAX_EBAY_FEED_BATCH_LISTINGS) }).strict();

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { draftIds } = createRequestSchema.parse(await request.json());
    await enforceRateLimit(user.id, "ebay_feed_batch_create", RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS);

    const uniqueDraftIds = [...new Set(draftIds)];
    const eligibility = await resolveEbayFeedDraftEligibilityForProducts(user.id, uniqueDraftIds);

    const eligibleProductIds: string[] = [];
    const eligibleMarketplaceDraftIds: string[] = [];
    const eligibleSkus: string[] = [];
    const skipped: Array<{ draftId: string; reasons: string[] }> = [];
    for (const draftId of uniqueDraftIds) {
      const entry = eligibility.get(draftId);
      if (entry?.eligible && entry.marketplaceDraftId && entry.sku) {
        eligibleProductIds.push(draftId);
        eligibleMarketplaceDraftIds.push(entry.marketplaceDraftId);
        eligibleSkus.push(entry.sku);
      } else {
        skipped.push({ draftId, reasons: entry?.reasons ?? ["Not eligible"] });
      }
    }

    if (eligibleProductIds.length === 0) {
      return NextResponse.json({ error: "None of the selected listings are eligible for an eBay draft right now.", eligibleCount: 0, skipped }, { status: 400 });
    }

    const { batchId, displayNumber } = await createEbayFeedBatch(user.id, eligibleMarketplaceDraftIds, eligibleProductIds, eligibleSkus);
    // ONE bounded, awaited tick — never a loop to completion. Its own
    // failure must never fail batch CREATION, which already succeeded;
    // the client's poll loop continues from persisted state on the next
    // tick regardless.
    await runEbayFeedBatchProcessTick(user.id, batchId).catch(() => {});

    return NextResponse.json({ batchId, displayNumber, eligibleCount: eligibleProductIds.length, skippedCount: skipped.length, skipped });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ error: "Creating eBay Seller Hub drafts isn't enabled on this database yet — the required migration hasn't been applied.", available: false }, { status: 409 });
    }
    return safeApiError(error, "Could not create an eBay draft batch.");
  }
}
