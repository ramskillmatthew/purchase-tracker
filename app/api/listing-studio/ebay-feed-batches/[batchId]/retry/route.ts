import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayFeedBatch, retryEbayFeedBatch, driveEbayFeedBatchTicks } from "@/lib/listing-studio/ebay-feed/feed-batches";
import { SELLER_HUB_DRAFTS_URL } from "@/lib/listing-studio/ebay-feed/feed-workflow-status";
import { enforceRateLimit } from "@/lib/security/activity";

export const runtime = "nodejs";
export const maxDuration = 30;

const RATE_LIMIT_MAX_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

/**
 * PHASE 7 — deliberate retry of an already-failed batch, never an
 * unexplained fresh batch. See feed-batches.ts's own retryEbayFeedBatch
 * for the full reconciliation contract (never creates a second remote
 * task for work eBay already accepted). Owner-isolated (getEbayFeedBatch's
 * own owner_id scoping, and retryEbayFeedBatch's own repeated
 * owner_id=eq.${ownerId} WHERE clauses) and concurrency-protected (the
 * underlying PATCH only matches a row still genuinely 'failed' — see that
 * function's own comment).
 *
 * CORRECTIVE PASS (fourth real-submission audit — root cause of "Retry
 * returns to Queued forever") — drives MULTIPLE bounded process ticks
 * (driveEbayFeedBatchTicks, never just one) through every fast local
 * stage immediately after a successful retry, so real progress happens
 * within this same request even if the browser closes right away. Its
 * own failure must never fail the retry request itself, which already
 * succeeded; the client's existing poll loop (now correctly re-including
 * this batch — see ListingsReviewWorkspace.tsx's own fix) continues from
 * persisted state on its own next tick regardless.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
    await enforceRateLimit(user.id, "ebay_feed_batch_retry", RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS);

    const existing = await getEbayFeedBatch(user.id, batchId);
    if (!existing) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    if (existing.batch.status !== "failed") {
      return NextResponse.json({ error: `Only a failed Seller Hub draft batch can be retried (this one is currently "${existing.batch.status}").` }, { status: 409 });
    }

    const outcome = await retryEbayFeedBatch(user.id, batchId).catch(error => {
      if (error instanceof Error && /already retried|no longer failed/.test(error.message)) return null;
      throw error;
    });
    if (outcome === null) {
      return NextResponse.json({ error: "This batch was already retried — reload to see its current status." }, { status: 409 });
    }

    await driveEbayFeedBatchTicks(user.id, batchId).catch(() => {});

    const loaded = await getEbayFeedBatch(user.id, batchId);
    if (!loaded) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({
      batchId: loaded.batch.id, status: loaded.batch.status, listingCount: loaded.batch.listingCount, displayNumber: loaded.batch.displayNumber,
      createdAt: loaded.batch.createdAt, completedAt: loaded.batch.completedAt,
      boxDismissedAt: loaded.batch.boxDismissedAt, activityDismissedAt: loaded.batch.activityDismissedAt,
      errorCode: loaded.batch.errorCode, errorMessage: loaded.batch.errorMessage,
      sellerHubDraftsUrl: SELLER_HUB_DRAFTS_URL,
      resumedFromTaskId: outcome.resumedFromTaskId,
      items: loaded.items.map(item => ({
        itemId: item.id, marketplaceDraftId: item.marketplaceDraftId, draftId: item.productDraftId, queuePosition: item.queuePosition,
        status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage,
        startedAt: item.startedAt, completedAt: item.completedAt,
        generatedTitle: item.generatedTitle, sku: item.sku,
      })),
    });
  } catch (error) { return safeApiError(error, "Could not retry this eBay draft batch."); }
}
