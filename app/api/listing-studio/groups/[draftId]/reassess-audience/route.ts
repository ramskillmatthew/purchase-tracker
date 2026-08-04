import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { MAX_GENERATION_IMAGES_PER_GROUP } from "@/lib/listing-studio/upload-limits";
import { prepareListingGenerationImageInputs } from "@/lib/listing-studio/listing-generation-image-input";
import { runVintedAudiencePhotoReassessment, describeVintedAudienceReassessmentFailure } from "@/lib/listing-studio/vinted-audience-reassessment-ai";
import { resolveVintedCategoryAssignment, describeVintedCategoryAssignmentReason } from "@/lib/listing-studio/vinted-category-assignment";
import { normaliseFootwearVintedAudience, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { estimateAnthropicCostUsd } from "@/lib/listing-studio/anthropic-pricing";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";
import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";

export const runtime = "nodejs";
export const maxDuration = 60;

type DraftRow = {
  id: string; brand: string | null; model: string | null; product_type: string | null;
  vinted_audience: VintedAudienceValue | null;
  vinted_audience_source: "ai" | "manual" | null;
  vinted_audience_evidence: string[] | null;
  vinted_category_id: number | null; vinted_category_path: string | null;
  vinted_category_source: "ai" | "manual" | null; vinted_category_status: string | null;
};
type ImageRow = { id: string; storage_path: string; mime_type: string };

/**
 * Follow-up correction (2026-08-05) — the explicit, cost-warned "Reassess
 * audience" action. Unlike the automatic text-only reassessment tried by
 * "Assign category" (resolveVintedCategoryAssignmentForExistingDraft), this
 * re-sends the draft's actual stored photos to Claude specifically to look
 * for audience evidence — a real, non-trivial AI cost, so it is NEVER
 * triggered automatically; only ever this dedicated, user-initiated route.
 * The client is expected to show the cost warning before calling this.
 *
 * A manually-corrected audience (Edit Fields) is protected exactly as
 * everywhere else — this route no-ops immediately rather than spending any
 * AI cost overwriting a deliberate manual choice.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,brand,model,product_type,vinted_audience,vinted_audience_source,vinted_audience_evidence,vinted_category_id,vinted_category_path,vinted_category_source,vinted_category_status`,
    );
    const draft = drafts[0];
    if (!draft) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    if (draft.vinted_audience_source === "manual") {
      return NextResponse.json({
        attempted: false, vintedAudience: draft.vinted_audience, vintedAudienceEvidence: draft.vinted_audience_evidence,
        message: "This listing already has a manually chosen audience.",
      });
    }

    const images = await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=eq.${draftId}&owner_id=eq.${user.id}&upload_state=eq.uploaded&select=id,storage_path,mime_type&order=sort_order.asc`,
    );
    if (!images.length) return NextResponse.json({ error: "This group has no photos to reassess audience from." }, { status: 400 });
    const eligibleImages = images.slice(0, MAX_GENERATION_IMAGES_PER_GROUP);

    const { blocks } = await prepareListingGenerationImageInputs(
      eligibleImages.map(image => ({ id: image.id, storagePath: image.storage_path, mimeType: image.mime_type })),
      LISTING_STUDIO_BUCKET,
    );
    if (!blocks.length) return NextResponse.json({ error: "Could not prepare any of this group's photos for analysis." }, { status: 502 });

    const startedAt = new Date().toISOString();
    const outcome = await runVintedAudiencePhotoReassessment(
      blocks,
      { brand: draft.brand, model: draft.model, productType: draft.product_type, priorVintedAudience: draft.vinted_audience, priorEvidence: draft.vinted_audience_evidence },
    );
    const completedAt = new Date().toISOString();

    await supabaseRequest("listing_analysis_runs", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        draft_id: draftId, owner_id: user.id, stage: "audience_reassessment",
        status: outcome.status === "success" ? "success" : "failed",
        model: outcome.status === "success" ? outcome.model : null,
        prompt_version: LISTING_PROMPT_VERSIONS.audience_reassessment, schema_version: LISTING_SCHEMA_VERSIONS.audience_reassessment,
        response_json: outcome.status === "success" ? { vintedAudience: outcome.vintedAudience, method: "photo" } : null,
        error_message: outcome.status === "success" ? null : describeVintedAudienceReassessmentFailure(outcome.status),
        started_at: startedAt, completed_at: completedAt,
      }),
    }).catch(() => {});

    await supabaseRequest("vinted_category_selection_ai_calls", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        draft_id: draftId, owner_id: user.id, call_type: "audience_reassessment_photo",
        model: outcome.status === "success" ? outcome.model : null,
        input_tokens: outcome.status === "success" ? outcome.inputTokens : null,
        output_tokens: outcome.status === "success" ? outcome.outputTokens : null,
        prompt_version: LISTING_PROMPT_VERSIONS.audience_reassessment, schema_version: LISTING_SCHEMA_VERSIONS.audience_reassessment,
        candidate_count: null,
        estimated_cost_usd: outcome.status === "success" ? estimateAnthropicCostUsd(outcome.model, outcome.inputTokens, outcome.outputTokens) : null,
        status: outcome.status === "success" ? "success" : "failed",
      }),
    }).catch(() => {});

    if (outcome.status !== "success") {
      return NextResponse.json({ error: describeVintedAudienceReassessmentFailure(outcome.status) }, { status: 502 });
    }

    // Business-rule follow-up correction: applied unconditionally, right
    // here — never only inside the "category was audience_missing" branch
    // below, since that branch doesn't always run (e.g. the category was
    // already stuck for some OTHER reason), and this route is the one
    // place that persists vinted_audience straight from a fresh AI photo
    // result without necessarily going through resolveVintedCategoryAssignment.
    const finalVintedAudience = normaliseFootwearVintedAudience(outcome.vintedAudience, deriveDraftItemFamily(draft.product_type));
    const finalVintedAudienceEvidence = outcome.vintedAudienceEvidence;

    // The audience just improved (that is the whole point of this route) —
    // if this draft's category was previously stuck specifically on
    // "audience_missing", retry it now with the fresh audience. Never
    // touches an already-manual category.
    let categoryId = draft.vinted_category_id;
    let categoryPath = draft.vinted_category_path;
    let categorySource = draft.vinted_category_source;
    let categoryStatus = draft.vinted_category_status;
    if (draft.vinted_category_source !== "manual" && draft.vinted_category_status === "audience_missing") {
      const { result, aiCost } = await resolveVintedCategoryAssignment({
        vintedAudience: finalVintedAudience, productType: draft.product_type, brand: draft.brand, model: draft.model,
      });
      categoryStatus = result.reason;
      if (result.reason === "category_assigned") {
        categoryId = result.categoryId;
        categoryPath = result.categoryPath;
        categorySource = "ai";
      }
      await supabaseRequest("listing_analysis_runs", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, stage: "category_selection", status: result.reason === "category_assigned" ? "success" : "failed",
          model: aiCost?.model ?? null, prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
          response_json: { reason: result.reason },
          error_message: result.reason === "category_assigned" ? null : describeVintedCategoryAssignmentReason(result.reason),
          started_at: completedAt, completed_at: new Date().toISOString(),
        }),
      }).catch(() => {});
      if (aiCost) {
        await supabaseRequest("vinted_category_selection_ai_calls", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            draft_id: draftId, owner_id: user.id, call_type: "category_selection", model: aiCost.model,
            input_tokens: aiCost.inputTokens, output_tokens: aiCost.outputTokens,
            prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
            candidate_count: aiCost.candidateCount, estimated_cost_usd: estimateAnthropicCostUsd(aiCost.model, aiCost.inputTokens, aiCost.outputTokens),
            status: aiCost.status,
          }),
        }).catch(() => {});
      }
    }

    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        vinted_audience: finalVintedAudience, vinted_audience_source: "ai", vinted_audience_evidence: finalVintedAudienceEvidence,
        vinted_category_id: categoryId, vinted_category_path: categoryPath, vinted_category_source: categorySource, vinted_category_status: categoryStatus,
        updated_at: new Date().toISOString(),
      }),
    });

    return NextResponse.json({
      attempted: true, vintedAudience: finalVintedAudience, vintedAudienceEvidence: finalVintedAudienceEvidence,
      vintedCategoryId: categoryId, vintedCategoryPath: categoryPath, vintedCategorySource: categorySource, vintedCategoryStatus: categoryStatus,
      message: "Audience reassessed from photos.",
    });
  } catch (error) { return safeApiError(error, "Could not reassess this listing's audience."); }
}
