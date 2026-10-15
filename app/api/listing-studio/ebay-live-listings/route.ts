import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { EBAY_LIVE_CONFIRMATION, MAX_EBAY_LIVE_LISTINGS, previewEbayLiveListings, publishOneEbayLiveListing } from "@/lib/listing-studio/ebay-live-listings";

export const runtime = "nodejs";
const idsSchema = z.array(uuidSchema).min(1).max(MAX_EBAY_LIVE_LISTINGS);
const previewSchema = z.object({ productDraftIds: idsSchema }).strict();
const publishSchema = z.object({ productDraftIds: idsSchema, confirmation: z.literal(EBAY_LIVE_CONFIRMATION) }).strict();

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const parsed = previewSchema.parse(await request.json());
    return NextResponse.json({ items: await previewEbayLiveListings(user.id, parsed.productDraftIds), confirmationRequired: EBAY_LIVE_CONFIRMATION });
  } catch (error) { return safeApiError(error, "Could not prepare the eBay listing preview."); }
}

export async function PUT(request: Request) {
  try {
    const user = await requireOwner();
    const { productDraftIds } = publishSchema.parse(await request.json());
    const results: Array<{ productDraftId: string; ok: boolean; listingId?: string; offerId?: string; alreadyLive?: boolean; error?: string }> = [];
    for (let index = 0; index < productDraftIds.length; index += 3) {
      const chunk = productDraftIds.slice(index, index + 3);
      results.push(...await Promise.all(chunk.map(async productDraftId => {
        try { return { productDraftId, ok: true, ...await publishOneEbayLiveListing(user.id, productDraftId) }; }
        catch (error) { return { productDraftId, ok: false, error: error instanceof Error ? error.message : "eBay could not publish this listing." }; }
      })));
    }
    return NextResponse.json({ results, publishedCount: results.filter(r => r.ok).length, failedCount: results.filter(r => !r.ok).length });
  } catch (error) { return safeApiError(error, "Could not publish the selected eBay listings."); }
}
