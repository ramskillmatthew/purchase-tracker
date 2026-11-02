import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema, updateSellingPriceRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { parseSellingPricePounds } from "@/lib/listing-studio/selling-price";
import { buildPurchaseMatchIndex, buildPurchaseSkuLookupQueries, describePurchaseMatch, matchSkuToPurchase, type PurchaseMatchRecord } from "@/lib/listing-studio/purchase-match";

export const runtime = "nodejs";

type DraftRow = { id: string; sku?: string | null };

/** Lightweight editor context for the eBay price step. Uses the exact
 * same SKU matching and wording as Listings Review, so “You paid” can
 * never disagree between the two screens. */
export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const rows = await supabaseRequestAll<DraftRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,sku`);
    const draft = rows[0];
    if (!draft) return NextResponse.json({ error: "Listing not found." }, { status: 404 });
    const purchaseQueries = buildPurchaseSkuLookupQueries([draft.sku ?? null]);
    const chunks = await Promise.all(purchaseQueries.map(query => supabaseRequestAll<PurchaseMatchRecord>(query)));
    const purchaseMatch = matchSkuToPurchase(draft.sku ?? null, buildPurchaseMatchIndex(chunks.flat()));
    return NextResponse.json({ purchaseMatch, purchasePriceText: describePurchaseMatch(purchaseMatch) });
  } catch (error) { return safeApiError(error, "Could not load this item's purchase price."); }
}

/**
 * Milestone 6 (purchase-price lookup and manual Vinted selling price) — the
 * Listings Review details panel's own dedicated save action for
 * confirmed_price_pence. Deliberately a separate, narrow route rather than
 * folding this into the big "Edit fields" PATCH (app/api/listing-studio/
 * groups/[draftId]/fields/route.ts): that route regenerates the derived
 * title/description and touches many unrelated fields every save, while
 * this control needs its own tight Saving/Saved/Save-failed lifecycle
 * scoped to just one field. This route's PATCH body touches ONLY
 * confirmed_price_pence and updated_at — never brand, model, SKU,
 * generated_title, generated_description, category, audience, colours,
 * material, or photos, and never the purchases table at all.
 *
 * The client sends the raw pounds string exactly as typed — never a
 * pre-computed pence value — and parseSellingPricePounds (the same pure
 * function the UI uses for instant client-side feedback) is the sole
 * authoritative parser here too, so a listing can never be persisted with
 * a value that function itself wouldn't accept. No AI call, no analysis
 * run, no AI cost-log row — plain database/application logic only.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const body = updateSellingPriceRequestSchema.parse(await request.json());

    const existing = await supabaseRequestAll<DraftRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id`);
    if (!existing.length) return NextResponse.json({ error: "Listing not found." }, { status: 404 });

    const parsed = parseSellingPricePounds(body.sellingPrice);
    if (!parsed.valid) return NextResponse.json({ error: parsed.error }, { status: 400 });

    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ confirmed_price_pence: parsed.pence, updated_at: new Date().toISOString() }),
    });

    return NextResponse.json({ draftId, sellingPricePence: parsed.pence });
  } catch (error) { return safeApiError(error, "Could not save this listing's selling price."); }
}
