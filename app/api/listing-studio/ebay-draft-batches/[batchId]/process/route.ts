import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayDraftBatch, runEbayDraftBatchProcessTick } from "@/lib/listing-studio/ebay-draft-batches";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Corrective pass — the persistent/resumable processing model's own HTTP
 * entry point. Claims and advances at most
 * PROCESS_TICK_ITEM_LIMIT items by exactly one step each (see
 * lib/listing-studio/ebay-draft-batches.ts's own header comment for the
 * full design), then returns the batch's full current state (same shape
 * as GET .../[batchId]) — never processes a whole batch in one request.
 * The client's poll loop calls this repeatedly IN PLACE OF the old
 * read-only GET (this endpoint both advances real work AND reports full
 * status in one round trip) while Listings Review is open; reloading the
 * page and resuming that same loop picks up exactly where persisted state
 * left off, with no reliance on any particular browser tab or server
 * process having stayed alive in between.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });

    const existing = await getEbayDraftBatch(user.id, batchId);
    if (!existing) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    if (existing.batch.status !== "completed" && existing.batch.status !== "cancelled") {
      await runEbayDraftBatchProcessTick(user.id, batchId);
    }

    const loaded = await getEbayDraftBatch(user.id, batchId);
    if (!loaded) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({
      batchId: loaded.batch.id, status: loaded.batch.status, listingCount: loaded.batch.listingCount, displayNumber: loaded.batch.displayNumber,
      createdAt: loaded.batch.createdAt, completedAt: loaded.batch.completedAt,
      boxDismissedAt: loaded.batch.boxDismissedAt, activityDismissedAt: loaded.batch.activityDismissedAt,
      items: loaded.items.map(item => ({
        itemId: item.id, marketplaceDraftId: item.marketplaceDraftId, draftId: item.productDraftId, queuePosition: item.queuePosition,
        status: item.status, attemptCount: item.attemptCount, errorCode: item.errorCode, errorMessage: item.errorMessage,
        ebayOfferId: item.ebayOfferId, startedAt: item.startedAt, completedAt: item.completedAt,
        generatedTitle: item.generatedTitle, sku: item.sku,
      })),
    });
  } catch (error) { return safeApiError(error, "Could not process this eBay draft batch."); }
}
