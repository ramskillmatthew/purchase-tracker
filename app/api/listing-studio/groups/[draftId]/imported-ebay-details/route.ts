import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getValidEbayAccessToken } from "@/lib/ebay-account/client";
import { fetchEbayTradingItem } from "@/lib/ebay-account/trading-item-client";
import { mapEbayListingFields } from "@/lib/listing-studio/ebay-field-mapping";
import { upsertImportedEbayMarketplaceDraft } from "@/lib/listing-studio/imported-ebay-draft";
import { autoLinkImportedListing } from "@/lib/listing-studio/inventory-link";

type DraftRow = { id: string; source_type: string | null; source_url: string | null; source_item_id: string | null; sku: string | null };

/** Repairs imports created before direct eBay-detail persistence existed.
 * Opening eBay details invokes this only when the marketplace draft is
 * missing, then immediately reloads the normal editor. */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid listing id." }, { status: 400 });
    const rows = await supabaseRequestAll<DraftRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,source_type,source_url,source_item_id,sku`);
    const draft = rows[0];
    if (!draft || draft.source_type !== "ebay_uk" || !draft.source_url) return NextResponse.json({ error: "This is not an imported eBay listing." }, { status: 404 });
    const listing = await fetchEbayTradingItem((await getValidEbayAccessToken(user.id)).accessToken, draft.source_url);
    const fields = mapEbayListingFields(listing);
    const photos = await supabaseRequestAll<{ id: string }>(`listing_draft_images?draft_id=eq.${draftId}&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id`);
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        title: listing.title, description: listing.description, generated_title: listing.title, generated_description: listing.description,
        brand: fields.brand, model: fields.model, product_type: fields.productType, uk_size: fields.size,
        colours: fields.colours, material: fields.material, suggested_price_pence: listing.pricePence,
        confirmed_price_pence: listing.pricePence, ai_result_json: {
          source: "ebay_uk", sourceUrl: listing.url, sourceItemId: listing.itemId,
          importedAt: new Date().toISOString(), currency: listing.currency, quantity: listing.quantity,
          itemSpecifics: listing.itemSpecifics, categoryId: listing.categoryId, category: listing.category,
        }, updated_at: new Date().toISOString(),
      }),
    });
    await upsertImportedEbayMarketplaceDraft({ ownerId: user.id, draftId, listing, hasPhoto: photos.length > 0 });
    if (!draft.sku) await autoLinkImportedListing(draftId, user.id, `${listing.title} ${Object.values(listing.itemSpecifics).join(" ")}`).catch(() => null);
    return NextResponse.json({ ok: true });
  } catch (error) { return safeApiError(error, "Could not load the original eBay details."); }
}
