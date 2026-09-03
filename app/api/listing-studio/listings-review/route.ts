import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";
import { getVintedCategoriesByIds, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";
import { normaliseFootwearVintedAudience, normaliseFootwearListingText, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { buildPurchaseMatchIndex, matchSkuToPurchase, buildPurchaseSkuLookupQueries, type PurchaseMatchRecord } from "@/lib/listing-studio/purchase-match";
import { listMarketplaceDraftsForProducts } from "@/lib/listing-studio/marketplace-drafts";

// Stage 6 (eBay draft batches) — the eBay equivalent of
// LatestExtensionStatusRow, from rpc/listing_studio_latest_ebay_draft_status
// (supabase-ebay-draft-batches.sql). Keyed by marketplace_draft_id (never
// product_draft_id directly — a product's eBay marketplace draft id is a
// different, separate uuid), so the client joins it against
// ebayDrafts[].id, not against the product draft's own id.
export type LatestEbayDraftStatusRow = {
  marketplace_draft_id: string; batch_id: string; batch_status: string; item_status: string; queue_position: number;
  error_code: string | null; error_message: string | null; ebay_offer_id: string | null;
  started_at: string | null; completed_at: string | null;
};

// The Sell Feed API pipeline's own equivalent, from
// rpc/listing_studio_latest_ebay_feed_status (supabase-ebay-feed-drafts.sql)
// — wholly independent of LatestEbayDraftStatusRow above, which describes
// the retired Inventory API pipeline's own, different objects.
export type LatestEbayFeedStatusRow = {
  marketplace_draft_id: string; batch_id: string; batch_status: string; item_status: string; queue_position: number;
  ebay_task_id: string | null; error_code: string | null; error_message: string | null;
  started_at: string | null; completed_at: string | null;
};

// Listings Review redesign — one row per draft, the most recent extension
// batch-item status across EVERY batch the owner has ever sent (see
// rpc/listing_studio_latest_extension_status in supabase-listing-studio.sql).
// Never re-derived per row client-side from a client-visible full batch
// history — this IS the full history, already reduced server-side.
export type LatestExtensionStatusRow = {
  draft_id: string; batch_id: string; batch_status: string; item_status: string; queue_position: number;
  error_code: string | null; error_message: string | null; vinted_draft_id: string | null;
  started_at: string | null; completed_at: string | null; current_step: string | null; step_detail: string | null;
};

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
 * Milestone 5 (Listings Review), corrected by the Stage 6 corrective pass —
 * CANONICAL UNIFIED ROW SET. This route used to scope its ENTIRE base
 * query to `generated_title=not.is.null&generated_description=not.is.null`
 * — a Vinted-only condition. Since app/api/listing-studio/groups/[draftId]/generate/route.ts's
 * own `shouldWriteVintedContent = targetSet.has("VINTED")` means an
 * eBay-only generation NEVER writes listing_drafts.generated_title/
 * generated_description, that old filter made every eBay-only product
 * (and its already-generated eBay marketplace draft) completely invisible
 * on this page — unreachable, un-priceable, un-shippable. PROVEN, not
 * assumed: confirmed by reading the generate route's own branch logic.
 *
 * The corrected model: the visible row set is the UNION of "has Vinted
 * content" OR "has an eBay (EBAY_UK) marketplace draft" — never Vinted
 * alone. Computed in two cheap steps (a lightweight candidate prefilter,
 * then the real EBAY_UK product-id set), never a full unfiltered owner
 * scan: step 1 fetches only `id, title, generated_title,
 * generated_description` for every non-archived, non-Unsorted product this
 * owner has (a cheap, narrow-column query); step 2 fetches every EBAY_UK
 * marketplace draft's product_draft_id for this owner; the union of
 * candidate ids matching either condition is what the REAL, full-column
 * query below is scoped to — a genuinely in-progress Listing Studio group
 * with no content on EITHER channel is still correctly excluded ("neither
 * should not normally be returned").
 */
export async function GET() {
  try {
    const user = await requireOwner();

    const [candidateRows, ebayProductIdRows] = await Promise.all([
      supabaseRequestAll<{ id: string; generated_title: string | null; generated_description: string | null }>(
        `listing_drafts?owner_id=eq.${user.id}&status=neq.archived&title=neq.${encodeURIComponent(UNSORTED_TITLE)}`
        + `&select=id,generated_title,generated_description`,
      ),
      supabaseRequestAll<{ product_draft_id: string }>(
        `listing_marketplace_drafts?owner_id=eq.${user.id}&marketplace=eq.EBAY_UK&select=product_draft_id`,
      ),
    ]);
    const ebayProductIds = new Set(ebayProductIdRows.map(r => r.product_draft_id));
    const visibleDraftIds = candidateRows
      .filter(row => (row.generated_title && row.generated_description) || ebayProductIds.has(row.id))
      .map(row => row.id);

    if (!visibleDraftIds.length) return NextResponse.json({ drafts: [], images: [], ebayDrafts: [] });

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=in.(${visibleDraftIds.join(",")})&owner_id=eq.${user.id}`
      + `&select=id,created_at,updated_at,brand,model,product_type,colours,material,uk_size,uk_size_source,sku,condition,generated_title,generated_description,ai_result_json,review_marked_ready_at,vinted_category_id,vinted_category_path,vinted_category_source,vinted_category_status,vinted_audience,vinted_audience_source,vinted_audience_evidence,confirmed_price_pence`
      + `&order=updated_at.desc`,
    );

    if (!drafts.length) return NextResponse.json({ drafts: [], images: [], ebayDrafts: [] });

    const draftIds = drafts.map(draft => draft.id);
    // Follow-up correction (restricting the purchase lookup to relevant
    // SKUs) — bounded query/queries scoped to only the SKUs actually on
    // this page (see buildPurchaseSkuLookupQueries's own comment), never
    // the whole purchases table. Empty when no listing has a SKU, in
    // which case zero purchase requests are made at all.
    const purchaseQueries = buildPurchaseSkuLookupQueries(drafts.map(draft => draft.sku));
    const [images, categoriesById, purchaseRecordChunks, extensionStatusRows, ebayDraftsByProduct, ebayStatusRows, ebayFeedStatusRows] = await Promise.all([
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
      // Listings Review redesign — ONE call, owner-scoped server-side by
      // the RPC itself, returning at most one row per draft (never a
      // second query per listing). Read-only. Degrades gracefully to "no
      // extension status known" (every listing falls back to its
      // readiness status, exactly like before this feature existed)
      // rather than failing the whole page, so this route keeps working
      // immediately after deploy even before the SQL migration adding
      // rpc/listing_studio_latest_extension_status has been run against
      // the database.
      supabaseRequest("rpc/listing_studio_latest_extension_status", {
        method: "POST", body: JSON.stringify({ p_owner_id: user.id }),
      }).then(response => response.json() as Promise<LatestExtensionStatusRow[]>).catch(() => [] as LatestExtensionStatusRow[]),
      // Stage 6 (eBay draft batches) — every product's eBay marketplace
      // draft (independent of, and never overwriting, its Vinted row
      // above). listMarketplaceDraftsForProducts already returns EVERY
      // marketplace a product has ('VINTED' rows never exist yet — see
      // supabase-listing-studio-marketplace.sql's own header comment — but
      // filtering explicitly here is future-proof and self-documenting).
      //
      // CORRECTIVE PASS — no `.catch()` here anymore. The earlier version
      // swallowed EVERY failure from this call into an empty Map, which
      // hid a real bug: listMarketplaceDraftsForProducts used to select
      // ebay_fulfillment_policy_id and friends (columns that only exist
      // once supabase-ebay-draft-batches.sql has been applied) in the same
      // query as core title/description/category/price fields, so on a
      // database without that migration the WHOLE query 400'd and every
      // eBay marketplace draft vanished from this page — including ones,
      // like the real "On Running Cloud 5" test listing, whose title,
      // description, category, price and photos were already fully
      // populated by Stage 2-5 and never needed the missing migration at
      // all. listMarketplaceDraftsForProducts now queries those two column
      // sets separately and degrades ONLY the migration-dependent fields
      // (see lib/listing-studio/marketplace-drafts.ts's own comments), so
      // it never throws for that specific, expected case — it can still
      // throw for a genuine fault (bad auth, network, an unrelated schema
      // problem), which is deliberately left to propagate to this route's
      // own top-level catch (safeApiError, which logs it) rather than
      // being silently hidden here.
      listMarketplaceDraftsForProducts(user.id, draftIds),
      // Same degrade-gracefully pattern as the Vinted extension-status RPC
      // above — a missing migration never fails this whole page.
      supabaseRequest("rpc/listing_studio_latest_ebay_draft_status", {
        method: "POST", body: JSON.stringify({ p_owner_id: user.id }),
      }).then(response => response.json() as Promise<LatestEbayDraftStatusRow[]>).catch(() => [] as LatestEbayDraftStatusRow[]),
      // The Sell Feed API pipeline's own status — same degrade-gracefully
      // pattern (a missing not-yet-applied migration never fails this
      // whole page).
      supabaseRequest("rpc/listing_studio_latest_ebay_feed_status", {
        method: "POST", body: JSON.stringify({ p_owner_id: user.id }),
      }).then(response => response.json() as Promise<LatestEbayFeedStatusRow[]>).catch(() => [] as LatestEbayFeedStatusRow[]),
    ]);

    const purchaseIndex = buildPurchaseMatchIndex(purchaseRecordChunks.flat());
    const extensionStatusByDraftId = new Map(extensionStatusRows.map(row => [row.draft_id, row]));
    const ebayDrafts = draftIds.flatMap(id => (ebayDraftsByProduct.get(id) ?? []).filter(d => d.marketplace === "EBAY_UK"));
    const ebayStatusByMarketplaceDraftId = new Map(ebayStatusRows.map(row => [row.marketplace_draft_id, row]));
    const ebayFeedStatusByMarketplaceDraftId = new Map(ebayFeedStatusRows.map(row => [row.marketplace_draft_id, row]));
    const ebayDraftsWithStatus = ebayDrafts.map(d => ({
      ...d,
      ebayStatus: ebayStatusByMarketplaceDraftId.get(d.id) ?? null,
      ebayFeedStatus: ebayFeedStatusByMarketplaceDraftId.get(d.id) ?? null,
    }));

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
        // Listings Review redesign — null when this draft has never been
        // part of any (non-cancelled) extension batch item.
        extension_status: extensionStatusByDraftId.get(draft.id) ?? null,
      };
    });

    return NextResponse.json({ drafts: draftsWithCategoryValidity, images, ebayDrafts: ebayDraftsWithStatus });
  } catch (error) { return safeApiError(error, "Could not load your listings."); }
}
