import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { retryFailedEbayDraftItem, getEbayDraftBatch } from "@/lib/listing-studio/ebay-draft-batches";
import { enforceRateLimit } from "@/lib/security/activity";

export const runtime = "nodejs";
export const maxDuration = 30;

const RATE_LIMIT_MAX_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

/**
 * Corrective pass (failed first eBay draft) — the genuine "Retry failed
 * draft" endpoint. Deliberately separate from POST .../[batchId]/process
 * (which only ever advances an already-queued item): this one exists
 * specifically to bring a `failed` item back to life, and does real
 * reconciliation work (see lib/listing-studio/ebay-draft-batches.ts's own
 * retryFailedEbayDraftItem for the full sequence: fresh eligibility check,
 * then getOffersForSku + the new getInventoryItem BEFORE any local write,
 * then either reconcile an existing remote offer or requeue through the
 * corrected pipeline) rather than a bare status flip.
 *
 * Requires the authenticated owner; confirms the item belongs to a batch
 * this owner actually owns and is genuinely in the `failed` terminal
 * state before doing anything else. The item's own conditional PATCH
 * (`status=eq.failed`) is the real concurrency guard — two concurrent
 * retry requests can both reach this handler, but only one can actually
 * transition the row, so a double-click or two open tabs can never
 * requeue (or reconcile) the same item twice.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string; itemId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId, itemId } = await params;
    if (!uuidSchema.safeParse(batchId).success || !uuidSchema.safeParse(itemId).success) {
      return NextResponse.json({ error: "Invalid batch or item id." }, { status: 400 });
    }
    await enforceRateLimit(user.id, "ebay_draft_item_retry", RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS);

    const result = await retryFailedEbayDraftItem(user.id, batchId, itemId);

    switch (result.outcome) {
      case "not_found":
        return NextResponse.json({ error: "This eBay draft item could not be found." }, { status: 404 });
      case "not_retryable":
        return NextResponse.json({ error: `This item is not in a retryable state (current status: ${result.itemStatus}).` }, { status: 409 });
      case "ineligible":
        return NextResponse.json({ error: "This listing is not currently eligible for an eBay draft.", reasons: result.reasons }, { status: 400 });
      case "already_in_progress":
        return NextResponse.json({ error: "This item is already being retried." }, { status: 409 });
      case "reconciled_existing_offer":
      case "requeued": {
        const loaded = await getEbayDraftBatch(user.id, batchId);
        return NextResponse.json({
          outcome: result.outcome,
          inventoryItemExists: result.inventoryItemExists,
          offerExists: result.offerExists,
          batch: loaded ? {
            batchId: loaded.batch.id, status: loaded.batch.status, listingCount: loaded.batch.listingCount, displayNumber: loaded.batch.displayNumber,
            items: loaded.items.map(item => ({
              itemId: item.id, marketplaceDraftId: item.marketplaceDraftId, draftId: item.productDraftId, queuePosition: item.queuePosition,
              status: item.status, attemptCount: item.attemptCount, errorCode: item.errorCode, errorMessage: item.errorMessage,
              ebayOfferId: item.ebayOfferId, startedAt: item.startedAt, completedAt: item.completedAt,
              generatedTitle: item.generatedTitle, sku: item.sku,
            })),
          } : null,
        });
      }
    }
  } catch (error) { return safeApiError(error, "Could not retry this eBay draft."); }
}
