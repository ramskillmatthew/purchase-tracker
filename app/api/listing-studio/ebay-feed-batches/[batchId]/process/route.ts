import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayFeedBatch, runEbayFeedBatchProcessTick } from "@/lib/listing-studio/ebay-feed/feed-batches";
import { isEbayFeedBatchStatusTerminal, SELLER_HUB_DRAFTS_URL } from "@/lib/listing-studio/ebay-feed/feed-workflow-status";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * The Sell Feed API pipeline's own poll-and-advance entry point — mirrors
 * app/api/listing-studio/ebay-draft-batches/[batchId]/process/route.ts
 * exactly in shape, advancing the claimed BATCH by exactly one stage (see
 * lib/listing-studio/ebay-feed/feed-batches.ts's own header for the full
 * stage list) rather than one item, then returning the batch's full
 * current state. The client's poll loop calls this repeatedly while
 * Listings Review is open; reloading the page and resuming that same loop
 * picks up exactly where persisted state left off.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });

    const existing = await getEbayFeedBatch(user.id, batchId);
    if (!existing) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    if (!isEbayFeedBatchStatusTerminal(existing.batch.status)) {
      await runEbayFeedBatchProcessTick(user.id, batchId);
    }

    const loaded = await getEbayFeedBatch(user.id, batchId);
    if (!loaded) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({
      batchId: loaded.batch.id, status: loaded.batch.status, listingCount: loaded.batch.listingCount, displayNumber: loaded.batch.displayNumber,
      createdAt: loaded.batch.createdAt, completedAt: loaded.batch.completedAt,
      boxDismissedAt: loaded.batch.boxDismissedAt, activityDismissedAt: loaded.batch.activityDismissedAt,
      errorCode: loaded.batch.errorCode, errorMessage: loaded.batch.errorMessage,
      sellerHubDraftsUrl: SELLER_HUB_DRAFTS_URL,
      items: loaded.items.map(item => ({
        itemId: item.id, marketplaceDraftId: item.marketplaceDraftId, draftId: item.productDraftId, queuePosition: item.queuePosition,
        status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage,
        startedAt: item.startedAt, completedAt: item.completedAt,
        generatedTitle: item.generatedTitle, sku: item.sku,
      })),
    });
  } catch (error) { return safeApiError(error, "Could not process this eBay draft batch."); }
}
