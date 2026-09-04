import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayFeedBatch, reconcileInconsistentFailedFeedBatchItems } from "@/lib/listing-studio/ebay-feed/feed-batches";
import { SELLER_HUB_DRAFTS_URL } from "@/lib/listing-studio/ebay-feed/feed-workflow-status";
import { enforceRateLimit } from "@/lib/security/activity";

export const runtime = "nodejs";
export const maxDuration = 15;

const RATE_LIMIT_MAX_PER_WINDOW = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

/**
 * PHASE 4/5 (third real-submission audit — historical data repair) —
 * repairs a stale child item still queued/uploaded/awaiting_result under
 * a batch that already failed with no remote task ever recorded. See
 * feed-batches.ts's own reconcileInconsistentFailedFeedBatchItems for the
 * full contract: never touches eBay, never touches the parent row, never
 * touches an item that already reached a real outcome, and refuses a
 * batch that has a recorded remote task ID (that case needs real
 * reconciliation with eBay via the separate Retry action's own
 * getFeedTask-based check, never a blind local status flip).
 *
 * A genuinely SEPARATE action from Retry — this makes no request to
 * eBay at all, ever. The client must call this first when a listing's
 * feedBatchState is "needs_reconciliation"; only after this succeeds
 * does the listing's state become "failed", at which point Retry becomes
 * available as its own, later, explicit action.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
    await enforceRateLimit(user.id, "ebay_feed_batch_reconcile", RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS);

    const existing = await getEbayFeedBatch(user.id, batchId);
    if (!existing) return NextResponse.json({ error: "Batch not found." }, { status: 404 });

    const [result] = await reconcileInconsistentFailedFeedBatchItems(user.id, batchId);
    if (!result) {
      // Owner-scoped and status/ebay_task_id-scoped query matched
      // nothing — either this batch isn't 'failed', already has a
      // recorded remote task, or doesn't belong to this owner. Never
      // leaks which, to avoid confirming another owner's batch id exists.
      return NextResponse.json({ error: "This batch is not eligible for reconciliation — it may not be failed, may already have a recorded eBay task, or may not belong to you." }, { status: 409 });
    }

    const loaded = await getEbayFeedBatch(user.id, batchId);
    if (!loaded) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({
      batchId: loaded.batch.id, status: loaded.batch.status, listingCount: loaded.batch.listingCount, displayNumber: loaded.batch.displayNumber,
      createdAt: loaded.batch.createdAt, completedAt: loaded.batch.completedAt,
      boxDismissedAt: loaded.batch.boxDismissedAt, activityDismissedAt: loaded.batch.activityDismissedAt,
      errorCode: loaded.batch.errorCode, errorMessage: loaded.batch.errorMessage,
      sellerHubDraftsUrl: SELLER_HUB_DRAFTS_URL,
      alreadyConsistent: result.alreadyConsistent,
      reconciledItemIds: result.reconciledItemIds,
      items: loaded.items.map(item => ({
        itemId: item.id, marketplaceDraftId: item.marketplaceDraftId, draftId: item.productDraftId, queuePosition: item.queuePosition,
        status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage,
        startedAt: item.startedAt, completedAt: item.completedAt,
        generatedTitle: item.generatedTitle, sku: item.sku,
      })),
    });
  } catch (error) { return safeApiError(error, "Could not reconcile this eBay draft batch."); }
}
