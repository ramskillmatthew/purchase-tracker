import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { buildFeedDraftPreviewForProduct } from "@/lib/listing-studio/ebay-feed/feed-batches";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_PREVIEW_LISTINGS = 25;
const requestSchema = z.object({ draftIds: z.array(uuidSchema).min(1).max(MAX_PREVIEW_LISTINGS) }).strict();

/**
 * PHASE 4 (Listings Review UI wiring) — the pre-submission preview the
 * confirmation dialog shows before any real batch is created: exactly
 * which fields will transfer to the Seller Hub draft, and which fields
 * this template structurally has no column for (so the user must
 * complete them in Seller Hub themselves) — see
 * lib/listing-studio/ebay-feed/feed-batches.ts's own
 * buildFeedDraftPreviewForProduct. Read-only: never creates a task,
 * never uploads anything, never touches eBay at all.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { draftIds } = requestSchema.parse(await request.json());
    const uniqueDraftIds = [...new Set(draftIds)];

    const previews = await Promise.all(uniqueDraftIds.map(async draftId => {
      const result = await buildFeedDraftPreviewForProduct(user.id, draftId);
      return "error" in result
        ? { draftId, error: result.error }
        : { draftId, fields: result.fields, completeInSellerHub: result.completeInSellerHub };
    }));

    return NextResponse.json({ previews });
  } catch (error) { return safeApiError(error, "Could not build a preview for these listings."); }
}
