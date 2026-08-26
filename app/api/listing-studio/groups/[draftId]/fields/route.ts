import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { updateListingFieldsRequestSchema, uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { generateListingTitle, generateListingDescription, LISTING_CONDITION_TEXT, type GeneratedListingFields } from "@/lib/listing-studio/listing-template";
import { getVintedCategoryById, isPublishableVintedCategory } from "@/lib/listing-studio/vinted-categories-data";
import { resolveVintedCategoryAssignment, describeVintedCategoryAssignmentReason } from "@/lib/listing-studio/vinted-category-assignment";
import { normaliseFootwearVintedAudience, normaliseFootwearListingText, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { estimateAnthropicCostUsd } from "@/lib/listing-studio/anthropic-pricing";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";

export const runtime = "nodejs";

type DraftRow = {
  id: string;
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
  vinted_audience_source: "ai" | "manual" | null;
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
};

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
 * call for title/description, ever. This is the one and only way a
 * listing's title/description change after the initial "Generate
 * Listings" call: the structured fields are the sole editable, canonical
 * source of truth (see lib/listing-studio/listing-template.ts's own top
 * comment); there is no route, here or anywhere else, that accepts a
 * directly-typed title or description.
 *
 * Follow-up correction (2026-08-04): also accepts a manual Vinted category
 * pick (unchanged behaviour) AND a manual Vinted Audience correction
 * (new). components/listing-studio/EditListingFieldsDialog.tsx clears its
 * own local category selection the moment the audience dropdown changes
 * (before this route ever sees the save) — so from this route's point of
 * view, "audience changed AND vintedCategoryId is null" is exactly the
 * signal to recompute a category from the new audience, never a separate
 * server-side "is the old category still compatible" heuristic. A
 * manually re-picked category in the SAME save always wins over any
 * audience-driven recompute. This never re-runs photo analysis and never
 * touches brand/model/colours/material/size/SKU.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const body = updateListingFieldsRequestSchema.parse(await request.json());

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,vinted_audience,vinted_audience_source,vinted_category_id,vinted_category_path,vinted_category_source`,
    );
    const draft = drafts[0];
    if (!draft) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    const rawModel = normalize(body.model);
    const rawProductType = normalize(body.productType);
    const draftItemFamily = deriveDraftItemFamily(rawProductType);

    // Business-rule follow-up correction: footwear must never persist a
    // children's Vinted audience — normalised BEFORE the "did the audience
    // change" comparison, so a submitted "boys"/"girls" for a footwear
    // item is compared (and ultimately persisted) as "womens" here, same
    // as everywhere else this rule applies.
    const normalisedVintedAudience = normaliseFootwearVintedAudience(body.vintedAudience, draftItemFamily);
    const audienceChanged = normalisedVintedAudience !== draft.vinted_audience;
    const finalVintedAudience = normalisedVintedAudience;
    const finalVintedAudienceSource: "ai" | "manual" | null = audienceChanged ? "manual" : draft.vinted_audience_source;

    // Business-rule follow-up correction (children's wording in
    // customer-facing text): the structured source fields are cleaned
    // BEFORE title/description regeneration below — see
    // vinted-category-selection.ts's normaliseFootwearListingText for why
    // this must happen to model/productType themselves, not just the
    // rendered title string.
    const structuredFields: GeneratedListingFields = {
      brand: normalize(body.brand),
      model: normaliseFootwearListingText(rawModel, draftItemFamily, finalVintedAudience),
      productType: normaliseFootwearListingText(rawProductType, draftItemFamily, finalVintedAudience),
      // colours/material are already exact Vinted-enum values (or empty/null)
      // once updateListingFieldsRequestSchema has parsed the body — nothing
      // free-text to trim/normalize here, unlike the plain-string fields above.
      colours: body.colours, material: body.material, ukSize: normalize(body.ukSize), sku: normalize(body.sku),
    };
    const generatedTitle = generateListingTitle(structuredFields);
    const generatedDescription = generateListingDescription(structuredFields);

    let categoryId = draft.vinted_category_id;
    let categoryPath: string | null = draft.vinted_category_path;
    let categorySource = draft.vinted_category_source;
    // null = no category and no attempted-but-failed reason to show (an
    // explicit clear, or nothing was ever attempted) — distinct from a
    // real VintedCategoryAssignmentReason string.
    let categoryStatus: string | null = null;
    let recomputed = false;
    let costLogEntry: { model: string | null; inputTokens: number | null; outputTokens: number | null; candidateCount: number; status: "success" | "failed" } | null = null;

    if (!audienceChanged && body.vintedCategoryId !== null && body.vintedCategoryId === draft.vinted_category_id) {
      // Follow-up correction (2026-08-07): the client always echoes back
      // whatever category id was already stored (EditListingFieldsDialog's
      // local state starts from the current draft — see its own top
      // comment), even when the user never touched the category picker at
      // all. Treating every non-null vintedCategoryId as a fresh "manual
      // pick" — the previous behaviour — silently reclassified an
      // untouched AI-assigned category as manual on the very next
      // unrelated save (e.g. just fixing a typo in Brand), permanently
      // freezing it from ever being automatically reassigned/improved
      // again even though the user never chose it themselves. An
      // unchanged id/path/source is simply carried forward as-is.
      categoryId = draft.vinted_category_id;
      categoryPath = draft.vinted_category_path;
      categorySource = draft.vinted_category_source;
      categoryStatus = draft.vinted_category_source ? "category_assigned" : null;
    } else if (body.vintedCategoryId !== null) {
      // Milestone 7: a manual pick must be a real, currently active +
      // selectable + leaf category — re-validated here server-side, never
      // trusted from the request alone. A manual pick always wins, even
      // if the audience also changed in this same save.
      const category = await getVintedCategoryById(body.vintedCategoryId);
      if (!isPublishableVintedCategory(category)) {
        return NextResponse.json({ error: "That category is not currently available. Please search and choose another." }, { status: 400 });
      }
      categoryId = body.vintedCategoryId;
      categoryPath = category.full_path;
      categorySource = "manual";
      categoryStatus = "category_assigned";
    } else if (audienceChanged) {
      // The client already cleared its own category selection for us —
      // recompute deterministically/via the bounded AI step using the new audience.
      recomputed = true;
      const { result, aiCost } = await resolveVintedCategoryAssignment({
        vintedAudience: finalVintedAudience, productType: structuredFields.productType, brand: structuredFields.brand, model: structuredFields.model,
      });
      categoryStatus = result.reason;
      costLogEntry = aiCost;
      if (result.reason === "category_assigned") {
        categoryId = result.categoryId; categoryPath = result.categoryPath; categorySource = "ai";
      } else {
        categoryId = null; categoryPath = null; categorySource = null;
      }
    } else {
      // No manual pick this save, audience unchanged: vintedCategoryId
      // being null here means the picker was explicitly cleared (or
      // already had nothing set) — always honoured.
      categoryId = null; categoryPath = null; categorySource = null;
    }

    const nowIso = new Date().toISOString();
    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        brand: structuredFields.brand, model: structuredFields.model, product_type: structuredFields.productType,
        colours: structuredFields.colours, material: structuredFields.material, uk_size: structuredFields.ukSize,
        uk_size_source: structuredFields.ukSize ? "manual" : null, sku: structuredFields.sku,
        vinted_audience: finalVintedAudience, vinted_audience_source: finalVintedAudienceSource,
        vinted_category_id: categoryId, vinted_category_path: categoryPath, vinted_category_source: categorySource, vinted_category_status: categoryStatus,
        generated_title: generatedTitle, generated_description: generatedDescription,
        updated_at: nowIso,
      }),
    });

    if (recomputed) {
      // A recompute actually ran (audience-change path) — record the same
      // audit trail the other category-assignment call sites do.
      await supabaseRequest("listing_analysis_runs", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, stage: "category_selection", status: categoryStatus === "category_assigned" ? "success" : "failed",
          model: costLogEntry?.model ?? null, prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
          response_json: { reason: categoryStatus, trigger: "audience_change" },
          error_message: categoryStatus === "category_assigned" ? null : describeVintedCategoryAssignmentReason(categoryStatus as Parameters<typeof describeVintedCategoryAssignmentReason>[0]),
          started_at: nowIso, completed_at: new Date().toISOString(),
        }),
      }).catch(() => {});

      if (costLogEntry) {
        await supabaseRequest("vinted_category_selection_ai_calls", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            draft_id: draftId, owner_id: user.id, model: costLogEntry.model,
            input_tokens: costLogEntry.inputTokens, output_tokens: costLogEntry.outputTokens,
            prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
            candidate_count: costLogEntry.candidateCount,
            estimated_cost_usd: estimateAnthropicCostUsd(costLogEntry.model, costLogEntry.inputTokens, costLogEntry.outputTokens),
            status: costLogEntry.status,
          }),
        }).catch(() => {});
      }
    }

    return NextResponse.json({
      draftId,
      brand: structuredFields.brand, model: structuredFields.model, productType: structuredFields.productType,
      colours: structuredFields.colours, material: structuredFields.material, ukSize: structuredFields.ukSize, sku: structuredFields.sku,
      condition: LISTING_CONDITION_TEXT,
      generatedTitle, generatedDescription,
      vintedAudience: finalVintedAudience, vintedAudienceSource: finalVintedAudienceSource,
      vintedCategoryId: categoryId, vintedCategoryPath: categoryPath, vintedCategorySource: categorySource, vintedCategoryStatus: categoryStatus,
    });
  } catch (error) { return safeApiError(error, "Could not save these fields."); }
}
