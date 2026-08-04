import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getVintedCategoryById, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";

export const runtime = "nodejs";

type DraftRow = { id: string; vinted_category_id: number | null };

/**
 * Milestone 5 (Listings Review) — the one write this milestone adds. Sets
 * `review_marked_ready_at` to now, which lib/listing-studio/listing-review.ts's
 * computeListingReviewStatus() treats as an explicit "I've reviewed this
 * Edited listing and it's fine" acknowledgement: it only ever resolves an
 * Edited listing back to Ready, never a listing that's still missing a
 * required field (that determination is automatic and has no override —
 * see that function's own comment). No body required — this route always
 * marks ready, never anything else.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const existing = await supabaseRequestAll<DraftRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,vinted_category_id`);
    if (!existing.length) return NextResponse.json({ error: "Listing not found." }, { status: 404 });

    // Milestone 7 (Vinted category catalogue sync): revalidated fresh
    // against the live catalogue table here — never trusted from whatever
    // status the client last computed, since a category can go inactive
    // between page load and this click.
    const draft = existing[0];
    const category = draft.vinted_category_id ? await getVintedCategoryById(draft.vinted_category_id) : null;
    if (!isPublishableVintedCategory(category)) {
      return NextResponse.json({ error: "This listing needs a valid Vinted category before it can be marked ready." }, { status: 400 });
    }

    const reviewMarkedReadyAt = new Date().toISOString();
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ review_marked_ready_at: reviewMarkedReadyAt }),
    });

    return NextResponse.json({ draftId, reviewMarkedReadyAt });
  } catch (error) { return safeApiError(error, "Could not mark this listing ready."); }
}
