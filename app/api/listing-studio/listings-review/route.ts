import { NextResponse } from "next/server";
import { supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";
import { getVintedCategoriesByIds, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";

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
      + `&select=id,created_at,updated_at,brand,model,product_type,colours,material,uk_size,uk_size_source,sku,condition,generated_title,generated_description,ai_result_json,review_marked_ready_at,vinted_category_id,vinted_category_path,vinted_category_source,vinted_category_status,vinted_audience,vinted_audience_source,vinted_audience_evidence`
      + `&order=updated_at.desc`,
    );

    if (!drafts.length) return NextResponse.json({ drafts: [], images: [] });

    const draftIds = drafts.map(draft => draft.id);
    const [images, categoriesById] = await Promise.all([
      supabaseRequestAll<ImageRow>(
        `listing_draft_images?draft_id=in.(${draftIds.join(",")})&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id,draft_id,sort_order&order=sort_order.asc`,
      ),
      // Milestone 7: one fresh, bulk validity check for every distinct
      // category referenced on this page — never trusted from the stored
      // vinted_category_path alone, since a category can go inactive after
      // it was chosen.
      getVintedCategoriesByIds(drafts.map(draft => draft.vinted_category_id).filter((id): id is number => id !== null)),
    ]);

    const draftsWithCategoryValidity = drafts.map(draft => ({
      ...draft,
      vinted_category_valid: draft.vinted_category_id !== null && isPublishableVintedCategory(categoriesById.get(draft.vinted_category_id) ?? null),
    }));

    return NextResponse.json({ drafts: draftsWithCategoryValidity, images });
  } catch (error) { return safeApiError(error, "Could not load your listings."); }
}
