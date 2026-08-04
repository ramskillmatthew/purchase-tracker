import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getVintedCategoryById, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";
import { buildListingWarnings, type ReadinessCheckFields } from "@/lib/listing-studio/listing-review";
import { normaliseFootwearVintedAudience, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";

export const runtime = "nodejs";

type DraftRow = {
  id: string;
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; sku: string | null; condition: string | null;
  generated_title: string | null; generated_description: string | null;
  vinted_audience: VintedAudienceValue | null;
  vinted_category_id: number | null; vinted_category_status: string | null;
  confirmed_price_pence: number | null;
};
type ImageRow = { id: string };

/**
 * Milestone 5 (Listings Review) — the one write this milestone adds. Sets
 * `review_marked_ready_at` to now, which lib/listing-studio/listing-review.ts's
 * computeListingReviewStatus() treats as an explicit "I've reviewed this
 * Edited listing and it's fine" acknowledgement: it only ever resolves an
 * Edited listing back to Ready, never a listing that's still missing a
 * required field (that determination is automatic and has no override —
 * see that function's own comment). No body required — this route always
 * marks ready, never anything else.
 *
 * Follow-up correction (closing the Mark Ready readiness gap) — this route
 * used to independently re-check only category and selling price, leaving
 * every other required field (title, description, brand, product type,
 * colours, conditionally-required size, condition, audience, at least one
 * uploaded photo) validated ONLY client-side, which a direct API request
 * could simply skip. It now fetches this draft's full current row plus a
 * fresh photo count and calls buildListingWarnings — the exact SAME
 * function the UI calls to decide what's missing — so the server's
 * definition of "ready" can never drift from the browser's, and a direct
 * request can never mark an incomplete listing ready by bypassing the UI.
 * getVintedCategoryById is still called separately (not merely trusting
 * the stored vinted_category_id) since a category can go inactive between
 * page load and this click — vintedCategoryValid is always a FRESH
 * catalogue lookup, never the client's last-known state.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const existing = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,brand,model,product_type,colours,material,uk_size,sku,condition,generated_title,generated_description,vinted_audience,vinted_category_id,vinted_category_status,confirmed_price_pence`,
    );
    if (!existing.length) return NextResponse.json({ error: "Listing not found." }, { status: 404 });
    const draft = existing[0];

    const [category, images] = await Promise.all([
      draft.vinted_category_id ? getVintedCategoryById(draft.vinted_category_id) : Promise.resolve(null),
      supabaseRequestAll<ImageRow>(`listing_draft_images?draft_id=eq.${draftId}&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id&limit=1`),
    ]);

    const readinessFields: ReadinessCheckFields = {
      brand: draft.brand, model: draft.model, productType: draft.product_type, colours: draft.colours ?? [], material: draft.material,
      ukSize: draft.uk_size, sku: draft.sku,
      generatedTitle: draft.generated_title ?? "", generatedDescription: draft.generated_description ?? "",
      condition: draft.condition,
      // Business-rule follow-up correction: Ready validation sees the
      // normalised value (never Boys/Girls for footwear), even for a
      // legacy draft not yet corrected by Assign Category/reassignment.
      vintedAudience: normaliseFootwearVintedAudience(draft.vinted_audience, deriveDraftItemFamily(draft.product_type)),
      vintedCategoryId: draft.vinted_category_id, vintedCategoryValid: isPublishableVintedCategory(category), vintedCategoryStatus: draft.vinted_category_status,
      hasPhoto: images.length > 0,
      sellingPricePence: draft.confirmed_price_pence,
    };

    const warnings = buildListingWarnings(readinessFields);
    if (warnings.length > 0) {
      return NextResponse.json({ error: `This listing isn't ready yet: ${warnings.join(", ")}.`, warnings }, { status: 400 });
    }

    const reviewMarkedReadyAt = new Date().toISOString();
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ review_marked_ready_at: reviewMarkedReadyAt }),
    });

    return NextResponse.json({ draftId, reviewMarkedReadyAt });
  } catch (error) { return safeApiError(error, "Could not mark this listing ready."); }
}
