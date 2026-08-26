import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { generateListingTitle, generateListingDescription, type GeneratedListingFields } from "@/lib/listing-studio/listing-template";
import { normaliseFootwearVintedAudience, normaliseFootwearListingText, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";

export const runtime = "nodejs";

type DraftRow = {
  id: string;
  brand: string | null; model: string | null; product_type: string | null;
  colours: string[] | null; material: string | null; uk_size: string | null; sku: string | null;
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
  generated_title: string | null; generated_description: string | null;
};

/**
 * Business-rule follow-up correction (children's wording in customer-facing
 * text) — the deterministic "Refresh listing text" repair action for
 * EXISTING footwear/Women's drafts generated before this rule existed
 * (e.g. a stored model of "Clifton 9 Youth"). Cleans ONLY the customer-
 * facing text: model, productType, and the title/description derived from
 * them. Never re-runs photo analysis, never makes an AI call, never
 * touches SKU, UK size, colours, material, brand, photos, Vinted audience,
 * or Vinted category — those are read here only to feed the deterministic
 * title/description template and to decide whether this draft even
 * qualifies (footwear + an already/effectively Women's audience), never
 * written back. Safe to call on any draft, any number of times: a draft
 * that doesn't qualify, or that's already clean, is always a genuine no-op
 * (no PATCH is issued at all) — this route never runs as a database-wide
 * batch by itself; each draft is refreshed individually, by request.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,brand,model,product_type,colours,material,uk_size,sku,vinted_audience,generated_title,generated_description`,
    );
    const draft = drafts[0];
    if (!draft) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    const itemFamily = deriveDraftItemFamily(draft.product_type);
    // Gating only — this route never writes vinted_audience. Using the
    // EFFECTIVE (normalised) audience means this action correctly cleans
    // text even for a draft whose audience column hasn't itself been
    // corrected yet (e.g. Assign Category hasn't been re-run on it), while
    // still never persisting a changed audience value itself.
    const effectiveAudience = normaliseFootwearVintedAudience(draft.vinted_audience, itemFamily);

    const cleanedModel = normaliseFootwearListingText(draft.model, itemFamily, effectiveAudience);
    const cleanedProductType = normaliseFootwearListingText(draft.product_type, itemFamily, effectiveAudience);

    const structuredFields: GeneratedListingFields = {
      brand: draft.brand, model: cleanedModel, productType: cleanedProductType,
      colours: draft.colours ?? [], material: draft.material, ukSize: draft.uk_size, sku: draft.sku,
    };
    const generatedTitle = generateListingTitle(structuredFields);
    const generatedDescription = generateListingDescription(structuredFields);

    const changed = cleanedModel !== draft.model || cleanedProductType !== draft.product_type
      || generatedTitle !== draft.generated_title || generatedDescription !== draft.generated_description;

    if (!changed) {
      return NextResponse.json({
        changed: false, model: draft.model, productType: draft.product_type,
        generatedTitle: draft.generated_title, generatedDescription: draft.generated_description,
      });
    }

    const nowIso = new Date().toISOString();
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        model: cleanedModel, product_type: cleanedProductType,
        generated_title: generatedTitle, generated_description: generatedDescription,
        updated_at: nowIso,
      }),
    });

    return NextResponse.json({ changed: true, model: cleanedModel, productType: cleanedProductType, generatedTitle, generatedDescription });
  } catch (error) { return safeApiError(error, "Could not refresh this listing's text."); }
}
