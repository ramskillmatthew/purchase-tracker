import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayDraftBatch, cancelEbayDraftBatch, dismissEbayDraftBatch } from "@/lib/listing-studio/ebay-draft-batches";

export const runtime = "nodejs";

/** Owner-side polling endpoint, mirrors
 * app/api/listing-studio/extension-batches/[batchId]/route.ts's own GET
 * exactly in shape/intent — the client polls this every few seconds while
 * the batch is non-terminal. */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });

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
  } catch (error) { return safeApiError(error, "Could not load this eBay draft batch."); }
}

/** Cooperative cancel — only queued items are cancelled; anything already
 * mid-processing finishes (or itself fails) naturally. Mirrors the Vinted
 * extension-batch DELETE route exactly. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
    const status = await cancelEbayDraftBatch(user.id, batchId).catch(error => {
      if (error instanceof Error && error.message === "Batch not found.") return null;
      throw error;
    });
    if (status === null) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ batchId, status });
  } catch (error) { return safeApiError(error, "Could not cancel this eBay draft batch."); }
}

const dismissRequestSchema = z.object({ action: z.enum(["dismiss_box", "dismiss_activity"]) }).strict();

/** Soft-dismiss only — never deletes the batch, its items, or any listing/
 * marketplace-draft data. Mirrors the Vinted extension-batch PATCH route's
 * own two actions exactly, minus that route's "must be terminal" gate for
 * dismiss_box: an eBay batch has no browser-extension pairing to worry
 * about interrupting, so — per the product spec's own stuck-batch
 * dismissal requirement — a still-non-terminal (stuck) batch may also be
 * dismissed, after the confirmation dialog's explicit warning. */
export async function PATCH(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
    const { action } = dismissRequestSchema.parse(await request.json());

    const loaded = await getEbayDraftBatch(user.id, batchId);
    if (!loaded) return NextResponse.json({ error: "Batch not found." }, { status: 404 });

    await dismissEbayDraftBatch(user.id, batchId, action);
    return NextResponse.json({ batchId, action });
  } catch (error) { return safeApiError(error, "Could not update this eBay draft batch."); }
}
