import { NextResponse } from "next/server";
import { supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";
import { getVintedCategoriesByIds, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";
import { normaliseFootwearVintedAudience, normaliseFootwearListingText, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { buildPurchaseMatchIndex, matchSkuToPurchase, buildPurchaseSkuLookupQueries, type PurchaseMatchRecord } from "@/lib/listing-studio/purchase-match";

export const runtime = "nodejs";

const UNSORTED_TITLE = "Unsorted";

type DraftRow = {
  id: string; created_at: string; updated_at: string;
  // Milestone 6: colours/material replace the old free-text colour column.
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; uk_size_source: string | null; sku: string | null; condition: string | null;
  generated_title: string | null; generated_description: string | null;
  ai_result_json: ListingGenerationFields | null;
  review_marked_ready_at: string | null;
  // Milestone 7 (Vinted category catalogue sync).
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
  vinted_category_status: string | null;
  // Follow-up correction (2026-08-04, extended 2026-08-05).
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
  vinted_audience_source: "ai" | "manual" | null;
  vinted_audience_evidence: string[] | null;
  // Milestone 6 (purchase-price lookup and manual Vinted selling price) —
  // see lib/listing-studio/selling-price.ts's own comment on why this
  // reuses the existing (previously unused) confirmed_price_pence column
  // rather than adding a new one.
  confirmed_price_pence: number | null;
};
type ImageRow = { id: string; draft_id: string; sort_order: number };

/**
 * Milestone 5 (Listings Review). Read-only: everything shown here is data
 * Milestone 4's generate/fields routes already persist — this route adds
 * no new writes and reuses those same underlying tables. Deliberately
 * scoped to only drafts that actually HAVE a generated listing (never
 * Unsorted, never a still-being-organised group with no listing yet) —
 * those remain Listing Studio's job; this page is purely for reviewing
 * what's already been generated. Images are fetched scoped to exactly
 * these drafts' ids (not every image the owner has, unlike the Studio
 * workspace route) since a power user's Unsorted/in-progress photos have
 * no bearing on this page at all.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?owner_id=eq.${user.id}&status=neq.archived&title=neq.${encodeURIComponent(UNSORTED_TITLE)}&generated_title=not.is.null&generated_description=not.is.null`
      + `&select=id,created_at,updated_at,brand,model,product_type,colours,material,uk_size,uk_size_source,sku,condition,generated_title,generated_description,ai_result_json,review_marked_ready_at,vinted_category_id,vinted_category_path,vinted_category_source,vinted_category_status,vinted_audience,vinted_audience_source,vinted_audience_evidence,confirmed_price_pence`
      + `&order=updated_at.desc`,
    );

    if (!drafts.length) return NextResponse.json({ drafts: [], images: [] });

    const draftIds = drafts.map(draft => draft.id);
    // Follow-up correction (restricting the purchase lookup to relevant
    // SKUs) — bounded query/queries scoped to only the SKUs actually on
    // this page (see buildPurchaseSkuLookupQueries's own comment), never
    // the whole purchases table. Empty when no listing has a SKU, in
    // which case zero purchase requests are made at all.
    const purchaseQueries = buildPurchaseSkuLookupQueries(drafts.map(draft => draft.sku));
    const [images, categoriesById, purchaseRecordChunks] = await Promise.all([
      supabaseRequestAll<ImageRow>(
        `listing_draft_images?draft_id=in.(${draftIds.join(",")})&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id,draft_id,sort_order&order=sort_order.asc`,
      ),
      // Milestone 7: one fresh, bulk validity check for every distinct
      // category referenced on this page — never trusted from the stored
      // vinted_category_path alone, since a category can go inactive after
      // it was chosen.
      getVintedCategoriesByIds(drafts.map(draft => draft.vinted_category_id).filter((id): id is number => id !== null)),
      // Milestone 6, narrowed by the follow-up correction above: a small,
      // bounded number of queries (never one per listing, never the whole
      // table) covering only this page's own distinct SKUs. Never queries
      // expenses. Only the columns this feature actually needs are
      // selected — no other purchase data (purchased_from, seller_name,
      // item_size, quantity, item_condition, arrived) is ever fetched or
      // exposed here.
      Promise.all(purchaseQueries.map(query => supabaseRequestAll<PurchaseMatchRecord>(query))),
    ]);

    const purchaseIndex = buildPurchaseMatchIndex(purchaseRecordChunks.flat());

    const draftsWithCategoryValidity = drafts.map(draft => {
      const itemFamily = deriveDraftItemFamily(draft.product_type);
      // Business-rule follow-up correction: displayed here already
      // normalised (never Boys/Girls for a footwear listing), even for a
      // legacy draft that hasn't gone through Assign Category /
      // reassignment since this rule was introduced — a read-time-only
      // correction, never written back to the database by this route (see
      // resolveVintedCategoryAssignment*/the Assign Category actions for
      // the actual persisting correction).
      const normalisedAudience = normaliseFootwearVintedAudience(draft.vinted_audience, itemFamily);
      // Business-rule follow-up correction (children's wording in
      // customer-facing text): same read-time-only pattern as the audience
      // correction above — a legacy footwear/Women's draft generated
      // before this rule existed shows clean text immediately, without
      // requiring the "Refresh listing text" repair action to have run
      // yet. Never written back to the database by this route.
      return {
        ...draft,
        vinted_category_valid: draft.vinted_category_id !== null && isPublishableVintedCategory(categoriesById.get(draft.vinted_category_id) ?? null),
        vinted_audience: normalisedAudience,
        model: normaliseFootwearListingText(draft.model, itemFamily, normalisedAudience),
        product_type: normaliseFootwearListingText(draft.product_type, itemFamily, normalisedAudience),
        generated_title: normaliseFootwearListingText(draft.generated_title, itemFamily, normalisedAudience),
        generated_description: normaliseFootwearListingText(draft.generated_description, itemFamily, normalisedAudience),
        // Milestone 6: computed server-side from the shared index above —
        // the browser only ever sees this ONE listing's own match result
        // (and, for a duplicate, the minimal safe fields needed to display
        // it), never any other purchase's data.
        purchase_match: matchSkuToPurchase(draft.sku, purchaseIndex),
      };
    });

    return NextResponse.json({ drafts: draftsWithCategoryValidity, images });
  } catch (error) { return safeApiError(error, "Could not load your listings."); }
}
