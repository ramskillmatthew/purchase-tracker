import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { updateListingFieldsRequestSchema, uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { generateListingTitle, generateListingDescription, LISTING_CONDITION_TEXT, type GeneratedListingFields } from "@/lib/listing-studio/listing-template";

export const runtime = "nodejs";

type DraftRow = { id: string };

// A blank field is the same "not set" state whether it arrives as an empty
// string or wasn't typed at all — normalized here so listing-template.ts
// never has to treat "" and null as different missing-value states.
function normalize(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Saves the "Edit fields" modal's structured product fields and
 * immediately regenerates the derived title/description from them — no AI
 * call, ever. This is the one and only way a listing's title/description
 * change after the initial "Generate Listings" call: the structured fields
 * are the sole editable, canonical source of truth (see
 * lib/listing-studio/listing-template.ts's own top comment); there is no
 * route, here or anywhere else, that accepts a directly-typed title or
 * description.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const body = updateListingFieldsRequestSchema.parse(await request.json());

    const drafts = await supabaseRequestAll<DraftRow>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id`);
    if (!drafts.length) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    const structuredFields: GeneratedListingFields = {
      brand: normalize(body.brand), model: normalize(body.model), productType: normalize(body.productType),
      colour: normalize(body.colour), ukSize: normalize(body.ukSize), sku: normalize(body.sku),
    };
    const generatedTitle = generateListingTitle(structuredFields);
    const generatedDescription = generateListingDescription(structuredFields);

    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        brand: structuredFields.brand, model: structuredFields.model, product_type: structuredFields.productType,
        colour: structuredFields.colour, uk_size: structuredFields.ukSize,
        uk_size_source: structuredFields.ukSize ? "manual" : null, sku: structuredFields.sku,
        generated_title: generatedTitle, generated_description: generatedDescription,
        updated_at: new Date().toISOString(),
      }),
    });

    return NextResponse.json({
      draftId,
      brand: structuredFields.brand, model: structuredFields.model, productType: structuredFields.productType,
      colour: structuredFields.colour, ukSize: structuredFields.ukSize, sku: structuredFields.sku,
      condition: LISTING_CONDITION_TEXT,
      generatedTitle, generatedDescription,
    });
  } catch (error) { return safeApiError(error, "Could not save these fields."); }
}
