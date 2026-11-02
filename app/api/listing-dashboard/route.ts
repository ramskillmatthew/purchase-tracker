import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { listMarketplaceDraftsForProducts } from "@/lib/listing-studio/marketplace-drafts";
import { buildPurchaseMatchIndex, buildPurchaseSkuLookupQueries, computeCostPence, matchSkuToPurchase, type PurchaseMatchRecord } from "@/lib/listing-studio/purchase-match";
import { savedHiddenListingIds } from "@/lib/listing-dashboard/hidden-listings";

export const runtime = "nodejs";

type DraftRow = { id:string; title:string|null; status:string; created_at:string; updated_at:string; brand:string|null; model:string|null; product_type:string|null; colours:string[]|null; uk_size:string|null; sku:string|null; generated_title:string|null; confirmed_price_pence:number|null; source_type:string|null; source_url:string|null; source_item_id:string|null; ai_result_json:Record<string,unknown>|null };
type ImageRow = { id:string; draft_id:string; sort_order:number };
type ExtensionRow = { draft_id:string; item_status:string; vinted_draft_id:string|null; error_message:string|null };

function titleFor(d: DraftRow) { return d.generated_title?.trim() || [d.brand,d.model,d.product_type].filter(Boolean).join(" ").trim() || d.title?.trim() || "Untitled listing"; }
function liveEbayId(dynamicData: Record<string, { value?: unknown }> | null | undefined) {
  const value = dynamicData?.__ebayLiveListing?.value;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}
function vintedProfileMeta(value: Record<string,unknown>|null|undefined) {
  if (value?.source !== "vinted_profile") return null;
  const raw = value.vintedProfileListing;
  return raw && typeof raw === "object" ? raw as Record<string,unknown> : null;
}

export async function GET() {
  try {
    const user = await requireOwner();
    const hiddenIds = new Set(savedHiddenListingIds(user.user_metadata));
    const allDrafts = await supabaseRequestAll<DraftRow>(`listing_drafts?owner_id=eq.${user.id}&status=neq.archived&title=neq.Unsorted&select=id,title,status,created_at,updated_at,brand,model,product_type,colours,uk_size,sku,generated_title,confirmed_price_pence,source_type,source_url,source_item_id,ai_result_json&order=updated_at.desc`);
    const drafts = allDrafts.filter(draft => !hiddenIds.has(draft.id));
    if (!drafts.length) return NextResponse.json({ listings:[], refreshedAt:new Date().toISOString() });
    const ids = drafts.map(d => d.id);
    const purchaseQueries = buildPurchaseSkuLookupQueries(drafts.map(d => d.sku));
    const [images, marketplaceByProduct, purchaseChunks, extensionRows] = await Promise.all([
      supabaseRequestAll<ImageRow>(`listing_draft_images?owner_id=eq.${user.id}&draft_id=in.(${ids.join(",")})&upload_state=eq.uploaded&select=id,draft_id,sort_order&order=sort_order.asc`),
      listMarketplaceDraftsForProducts(user.id, ids),
      Promise.all(purchaseQueries.map(q => supabaseRequestAll<PurchaseMatchRecord>(q))),
      supabaseRequest("rpc/listing_studio_latest_extension_status", { method:"POST", body:JSON.stringify({ p_owner_id:user.id }) }).then(r => r.json() as Promise<ExtensionRow[]>).catch(() => [] as ExtensionRow[]),
    ]);
    const photoByDraft = new Map<string,string>();
    for (const image of images) if (!photoByDraft.has(image.draft_id)) photoByDraft.set(image.draft_id,image.id);
    const extensionByDraft = new Map(extensionRows.map(row => [row.draft_id,row]));
    const purchaseIndex = buildPurchaseMatchIndex(purchaseChunks.flat());
    const listings = drafts.map(draft => {
      const marketplace = marketplaceByProduct.get(draft.id) ?? [];
      const ebayDraft = marketplace.find(item => item.marketplace === "EBAY_UK" && item.status !== "archived") ?? null;
      const extension = extensionByDraft.get(draft.id) ?? null;
      const vintedProfile = vintedProfileMeta(draft.ai_result_json);
      const importedVinted = Boolean(vintedProfile);
      const importedEbay = draft.source_type === "ebay_uk" || Boolean(ebayDraft?.sourceEbayItemId);
      const ebayListingId = liveEbayId(ebayDraft?.dynamicData) || (importedEbay ? draft.source_item_id || ebayDraft?.sourceEbayItemId || null : null);
      const hasEbay = Boolean(ebayDraft || importedEbay);
      const hasVinted = Boolean(importedVinted || extension || (!importedEbay && draft.source_type !== "ebay_uk"));
      const vintedPrice = hasVinted ? draft.confirmed_price_pence : null;
      const ebayPrice = ebayDraft?.pricePence ?? null;
      const askingPrice = vintedPrice ?? ebayPrice;
      const purchase = matchSkuToPurchase(draft.sku,purchaseIndex);
      const cost = computeCostPence(purchase);
      const photoId = photoByDraft.get(draft.id) ?? null;
      const externalPhoto = importedVinted && typeof vintedProfile?.photoUrl === "string" ? vintedProfile.photoUrl : null;
      const vintedActive = importedVinted ? vintedProfile?.active !== false : Boolean(extension?.vinted_draft_id);
      const needsReview = !(photoId || externalPhoto) || !askingPrice || askingPrice <= 0 || Boolean(extension?.error_message) || Boolean(ebayDraft?.validationMessages.some(message => message.severity === "blocking"));
      const live = Boolean(ebayListingId || vintedActive);
      const ready = ebayDraft?.status === "ready" || extension?.item_status === "completed";
      return {
        id:draft.id, title:titleFor(draft), sku:draft.sku, ukSize:draft.uk_size,
        imageUrl:photoId ? `/api/listing-studio/images/${photoId}/view` : externalPhoto,
        askingPricePence:askingPrice, costPence:cost, profitPence:askingPrice !== null && cost !== null ? askingPrice-cost : null,
        status:importedVinted && !vintedActive ? "needs_review" : needsReview ? "needs_review" : live ? "listed" : ready ? "ready" : "draft",
        statusDetail:importedVinted && !vintedActive ? "No longer found on this Vinted account." : extension?.error_message ?? null,
        vintedAccountNumber:importedVinted && Number.isInteger(Number(vintedProfile?.accountNumber)) && Number(vintedProfile?.accountNumber) > 0 ? Number(vintedProfile?.accountNumber) : null,
        vintedAccountSlot:importedVinted && [1,2,3].includes(Number(vintedProfile?.accountSlot)) ? Number(vintedProfile?.accountSlot) : null,
        vintedProfileId:importedVinted && typeof vintedProfile?.profileId === "string" ? vintedProfile.profileId : null,
        favouriteCount:importedVinted && Number.isFinite(Number(vintedProfile?.favouriteCount)) ? Number(vintedProfile?.favouriteCount) : null,
        platforms:[
          ...(hasVinted ? [{ marketplace:"vinted" as const, live:vintedActive, pricePence:vintedPrice, itemId:importedVinted ? draft.source_item_id : null, url:importedVinted ? draft.source_url : null }] : []),
          ...(hasEbay ? [{ marketplace:"ebay" as const, live:Boolean(ebayListingId), pricePence:ebayPrice, itemId:ebayListingId }] : []),
        ],
        sourceUrl:draft.source_url, updatedAt:draft.updated_at,
      };
    });
    return NextResponse.json({ listings, refreshedAt:new Date().toISOString() });
  } catch (error) { return safeApiError(error,"Could not load the listing dashboard."); }
}
