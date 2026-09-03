import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayFeedBatch, cancelEbayFeedBatch, dismissEbayFeedBatch } from "@/lib/listing-studio/ebay-feed/feed-batches";
import { SELLER_HUB_DRAFTS_URL } from "@/lib/listing-studio/ebay-feed/feed-workflow-status";

export const runtime = "nodejs";

/** Owner-side polling endpoint, mirrors
 * app/api/listing-studio/ebay-draft-batches/[batchId]/route.ts's own GET
 * exactly in shape/intent. Always includes sellerHubDraftsUrl so the
 * client can offer the "Open Seller Hub Drafts" link the moment a batch
 * reaches a completed status — this app never auto-publishes, so this
 * link is the required next step, not a convenience shortcut. */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });

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
  } catch (error) { return safeApiError(error, "Could not load this eBay draft batch."); }
}

/** Cooperative cancel — see feed-batches.ts's own cancelEbayFeedBatch
 * comment: only a batch still in 'queued' status can be cleanly cancelled
 * locally; anything already sent to eBay runs to its own natural
 * completion. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
    const status = await cancelEbayFeedBatch(user.id, batchId).catch(error => {
      if (error instanceof Error && error.message === "Batch not found.") return null;
      throw error;
    });
    if (status === null) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ batchId, status });
  } catch (error) { return safeApiError(error, "Could not cancel this eBay draft batch."); }
}

const dismissRequestSchema = z.object({ action: z.enum(["dismiss_box", "dismiss_activity"]) }).strict();

/** Soft-dismiss only — never deletes the batch, its items, or any listing/
 * marketplace-draft data. Mirrors the legacy route's own PATCH exactly. */
export async function PATCH(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
    const { action } = dismissRequestSchema.parse(await request.json());

    const loaded = await getEbayFeedBatch(user.id, batchId);
    if (!loaded) return NextResponse.json({ error: "Batch not found." }, { status: 404 });

    await dismissEbayFeedBatch(user.id, batchId, action);
    return NextResponse.json({ batchId, action });
  } catch (error) { return safeApiError(error, "Could not update this eBay draft batch."); }
}
