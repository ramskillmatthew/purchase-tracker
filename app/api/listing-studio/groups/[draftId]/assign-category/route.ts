import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { resolveVintedCategoryAssignmentForExistingDraft, describeVintedCategoryAssignmentReason } from "@/lib/listing-studio/vinted-category-assignment";
import { normaliseFootwearVintedAudience, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { estimateAnthropicCostUsd } from "@/lib/listing-studio/anthropic-pricing";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";

export const runtime = "nodejs";
export const maxDuration = 30;

type DraftRow = {
  id: string; brand: string | null; model: string | null; product_type: string | null;
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
  vinted_audience_source: "ai" | "manual" | null;
  vinted_audience_evidence: string[] | null;
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
};

/**
 * Follow-up correction (2026-08-04, extended 2026-08-05) — the "Assign
 * category" retry action. Uses ONLY this draft's already-stored
 * structured fields — never re-runs the main photo-analysis AI call,
 * never regenerates title/description, never touches size/SKU/colours/
 * material. Exists specifically so a listing generated before a prompt
 * fix (or one whose automatic assignment failed) can get a category
 * without a full regenerate. A manually-chosen category, or a manually
 * corrected audience, is never touched — this route respects both as
 * protected.
 *
 * 2026-08-05: before giving up with "audience_missing", now also tries
 * ONE cheap, text-only audience reassessment using this draft's stored
 * brand/model/productType (see resolveVintedCategoryAssignmentForExistingDraft)
 * — no photos, no new photo cost. If even that can't resolve it, the
 * response's `canReassessWithPhotos` flag tells the UI to offer the
 * separate, explicit, cost-warned "Reassess audience" action instead.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}&select=id,brand,model,product_type,vinted_audience,vinted_audience_source,vinted_audience_evidence,vinted_category_id,vinted_category_path,vinted_category_source`,
    );
    const draft = drafts[0];
    if (!draft) return NextResponse.json({ error: "Group not found." }, { status: 404 });

    // Business-rule follow-up correction: footwear must never persist a
    // children's Vinted audience, even one that was manually chosen
    // before this rule existed — a manually-protected CATEGORY does not
    // override that, since it may itself be the incompatible Kids
    // category that needs clearing. This is the one exception to "a
    // manually-chosen category is never touched" below.
    const needsFootwearAudienceCorrection = (draft.vinted_audience === "boys" || draft.vinted_audience === "girls")
      && deriveDraftItemFamily(draft.product_type) === "footwear";

    if (draft.vinted_category_source === "manual" && !needsFootwearAudienceCorrection) {
      return NextResponse.json({
        attempted: false, vintedCategoryId: draft.vinted_category_id, vintedCategoryPath: draft.vinted_category_path,
        vintedCategorySource: draft.vinted_category_source, vintedCategoryStatus: null, canReassessWithPhotos: false,
        message: "This listing already has a manually chosen category.",
      });
    }

    const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
      vintedAudience: draft.vinted_audience, vintedAudienceSource: draft.vinted_audience_source, vintedAudienceEvidence: draft.vinted_audience_evidence,
      productType: draft.product_type, brand: draft.brand, model: draft.model,
    });
    const { result } = outcome;

    const categoryId = result.reason === "category_assigned" ? result.categoryId : null;
    const categoryPath = result.reason === "category_assigned" ? result.categoryPath : null;
    const categorySource: "ai" | null = result.reason === "category_assigned" ? "ai" : null;
    // A manually-protected audience is never touched here regardless of
    // what resolveVintedCategoryAssignmentForExistingDraft computed with
    // it — EXCEPT the footwear boys/girls -> womens business-rule
    // normalisation, which applies even to a manual pick made before that
    // rule existed (see normaliseFootwearVintedAudience's own comment).
    const finalAudience = draft.vinted_audience_source === "manual"
      ? normaliseFootwearVintedAudience(draft.vinted_audience, deriveDraftItemFamily(draft.product_type))
      : outcome.vintedAudience;
    const finalAudienceEvidence = draft.vinted_audience_source === "manual" ? draft.vinted_audience_evidence : outcome.vintedAudienceEvidence;
    const nowIso = new Date().toISOString();

    await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        vinted_audience: finalAudience, vinted_audience_evidence: finalAudienceEvidence,
        vinted_category_id: categoryId, vinted_category_path: categoryPath, vinted_category_source: categorySource,
        vinted_category_status: result.reason, updated_at: nowIso,
      }),
    });

    await supabaseRequest("listing_analysis_runs", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        draft_id: draftId, owner_id: user.id, stage: "category_selection", status: result.reason === "category_assigned" ? "success" : "failed",
        model: outcome.categoryAiCost?.model ?? null, prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
        response_json: { reason: result.reason },
        error_message: result.reason === "category_assigned" ? null : describeVintedCategoryAssignmentReason(result.reason),
        started_at: nowIso, completed_at: new Date().toISOString(),
      }),
    }).catch(() => {});

    if (outcome.categoryAiCost) {
      await supabaseRequest("vinted_category_selection_ai_calls", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, call_type: "category_selection", model: outcome.categoryAiCost.model,
          input_tokens: outcome.categoryAiCost.inputTokens, output_tokens: outcome.categoryAiCost.outputTokens,
          prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
          candidate_count: outcome.categoryAiCost.candidateCount, estimated_cost_usd: estimateAnthropicCostUsd(outcome.categoryAiCost.model, outcome.categoryAiCost.inputTokens, outcome.categoryAiCost.outputTokens),
          status: outcome.categoryAiCost.status,
        }),
      }).catch(() => {});
    }
    if (outcome.audienceAiCost) {
      await supabaseRequest("listing_analysis_runs", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, stage: "audience_reassessment", status: outcome.audienceAiCost.status,
          model: outcome.audienceAiCost.model, prompt_version: LISTING_PROMPT_VERSIONS.audience_reassessment, schema_version: LISTING_SCHEMA_VERSIONS.audience_reassessment,
          response_json: outcome.audienceAiCost.status === "success" ? { vintedAudience: outcome.vintedAudience, method: "text" } : null,
          error_message: outcome.audienceAiCost.status === "failed" ? "Text-only audience reassessment failed." : null,
          started_at: nowIso, completed_at: new Date().toISOString(),
        }),
      }).catch(() => {});
      await supabaseRequest("vinted_category_selection_ai_calls", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: draftId, owner_id: user.id, call_type: "audience_reassessment_text", model: outcome.audienceAiCost.model,
          input_tokens: outcome.audienceAiCost.inputTokens, output_tokens: outcome.audienceAiCost.outputTokens,
          prompt_version: LISTING_PROMPT_VERSIONS.audience_reassessment, schema_version: LISTING_SCHEMA_VERSIONS.audience_reassessment,
          candidate_count: null, estimated_cost_usd: estimateAnthropicCostUsd(outcome.audienceAiCost.model, outcome.audienceAiCost.inputTokens, outcome.audienceAiCost.outputTokens),
          status: outcome.audienceAiCost.status,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      attempted: true, vintedCategoryId: categoryId, vintedCategoryPath: categoryPath,
      vintedCategorySource: categorySource, vintedCategoryStatus: result.reason,
      vintedAudience: finalAudience, vintedAudienceEvidence: finalAudienceEvidence,
      canReassessWithPhotos: outcome.canReassessWithPhotos,
      message: describeVintedCategoryAssignmentReason(result.reason),
    });
  } catch (error) { return safeApiError(error, "Could not assign a Vinted category to this listing."); }
}
