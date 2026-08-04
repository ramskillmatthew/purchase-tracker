import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import {
  resolveVintedCategoryAssignmentForExistingDraft, describeVintedCategoryAssignmentReason, MAX_BULK_CATEGORY_ASSIGNMENT,
  type VintedCategoryAssignmentReason,
} from "@/lib/listing-studio/vinted-category-assignment";
import { estimateAnthropicCostUsd } from "@/lib/listing-studio/anthropic-pricing";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";

export const runtime = "nodejs";
export const maxDuration = 60;

const BULK_CONCURRENCY = 5;

const assignCategoriesRequestSchema = z.object({
  draftIds: z.array(uuidSchema).min(1).max(MAX_BULK_CATEGORY_ASSIGNMENT),
}).strict();

type DraftRow = {
  id: string; brand: string | null; model: string | null; product_type: string | null;
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
  vinted_audience_source: "ai" | "manual" | null;
  vinted_audience_evidence: string[] | null;
  vinted_category_source: "ai" | "manual" | null;
};

async function runWithConcurrencyLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    let next: T | undefined;
    while ((next = queue.shift())) await task(next);
  });
  await Promise.all(workers);
}

/**
 * Follow-up correction (2026-08-04) — "Assign missing categories" bulk
 * action. ONE HTTP request for every selected listing (never one request
 * per listing), server-side concurrency-bounded. Each listing uses only
 * its own already-stored structured fields — no photo reanalysis, no
 * title/description regeneration. A manually-chosen category is always
 * skipped, never overwritten.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { draftIds } = assignCategoriesRequestSchema.parse(await request.json());

    const drafts = await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=in.(${draftIds.join(",")})&owner_id=eq.${user.id}&select=id,brand,model,product_type,vinted_audience,vinted_audience_source,vinted_audience_evidence,vinted_category_source`,
    );
    const draftsById = new Map(drafts.map((d) => [d.id, d]));

    type ItemResult = { draftId: string; skipped: boolean; reason: VintedCategoryAssignmentReason | null; method: "deterministic" | "ai" | null; costUsd: number | null };
    const results: ItemResult[] = [];

    await runWithConcurrencyLimit(draftIds, BULK_CONCURRENCY, async (draftId) => {
      const draft = draftsById.get(draftId);
      if (!draft) { results.push({ draftId, skipped: true, reason: null, method: null, costUsd: null }); return; }
      if (draft.vinted_category_source === "manual") { results.push({ draftId, skipped: true, reason: null, method: null, costUsd: null }); return; }

      const outcome = await resolveVintedCategoryAssignmentForExistingDraft({
        vintedAudience: draft.vinted_audience, vintedAudienceSource: draft.vinted_audience_source, vintedAudienceEvidence: draft.vinted_audience_evidence,
        productType: draft.product_type, brand: draft.brand, model: draft.model,
      });
      const { result } = outcome;

      const categoryId = result.reason === "category_assigned" ? result.categoryId : null;
      const categoryPath = result.reason === "category_assigned" ? result.categoryPath : null;
      const categorySource: "ai" | null = result.reason === "category_assigned" ? "ai" : null;
      const finalAudience = draft.vinted_audience_source === "manual" ? draft.vinted_audience : outcome.vintedAudience;
      const finalAudienceEvidence = draft.vinted_audience_source === "manual" ? draft.vinted_audience_evidence : outcome.vintedAudienceEvidence;
      const nowIso = new Date().toISOString();

      await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${user.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          vinted_audience: finalAudience, vinted_audience_evidence: finalAudienceEvidence,
          vinted_category_id: categoryId, vinted_category_path: categoryPath, vinted_category_source: categorySource,
          vinted_category_status: result.reason, updated_at: nowIso,
        }),
      }).catch(() => {});

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

      let costUsd: number | null = null;
      if (outcome.categoryAiCost) {
        costUsd = estimateAnthropicCostUsd(outcome.categoryAiCost.model, outcome.categoryAiCost.inputTokens, outcome.categoryAiCost.outputTokens);
        await supabaseRequest("vinted_category_selection_ai_calls", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            draft_id: draftId, owner_id: user.id, call_type: "category_selection", model: outcome.categoryAiCost.model,
            input_tokens: outcome.categoryAiCost.inputTokens, output_tokens: outcome.categoryAiCost.outputTokens,
            prompt_version: LISTING_PROMPT_VERSIONS.category_selection, schema_version: LISTING_SCHEMA_VERSIONS.category_selection,
            candidate_count: outcome.categoryAiCost.candidateCount, estimated_cost_usd: costUsd, status: outcome.categoryAiCost.status,
          }),
        }).catch(() => {});
      }
      let audienceCostUsd: number | null = null;
      if (outcome.audienceAiCost) {
        audienceCostUsd = estimateAnthropicCostUsd(outcome.audienceAiCost.model, outcome.audienceAiCost.inputTokens, outcome.audienceAiCost.outputTokens);
        await supabaseRequest("vinted_category_selection_ai_calls", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            draft_id: draftId, owner_id: user.id, call_type: "audience_reassessment_text", model: outcome.audienceAiCost.model,
            input_tokens: outcome.audienceAiCost.inputTokens, output_tokens: outcome.audienceAiCost.outputTokens,
            prompt_version: LISTING_PROMPT_VERSIONS.audience_reassessment, schema_version: LISTING_SCHEMA_VERSIONS.audience_reassessment,
            candidate_count: null, estimated_cost_usd: audienceCostUsd, status: outcome.audienceAiCost.status,
          }),
        }).catch(() => {});
      }

      const totalCostUsd = costUsd !== null || audienceCostUsd !== null ? (costUsd ?? 0) + (audienceCostUsd ?? 0) : null;
      results.push({ draftId, skipped: false, reason: result.reason, method: result.reason === "category_assigned" ? result.method : null, costUsd: totalCostUsd });
    });

    const noMatchReasons: VintedCategoryAssignmentReason[] = ["item_family_uncertain", "no_candidates", "too_many_candidates", "ai_selection_invalid"];
    const costs = results.map((r) => r.costUsd).filter((c): c is number => c !== null);
    const summary = {
      deterministicCount: results.filter((r) => r.reason === "category_assigned" && r.method === "deterministic").length,
      aiAssignedCount: results.filter((r) => r.reason === "category_assigned" && r.method === "ai").length,
      audienceRequiredCount: results.filter((r) => r.reason === "audience_missing").length,
      noMatchCount: results.filter((r) => r.reason && noMatchReasons.includes(r.reason)).length,
      failedCount: results.filter((r) => r.reason === "ai_selection_failed").length,
      skippedCount: results.filter((r) => r.skipped).length,
      estimatedCostUsd: costs.length ? costs.reduce((sum, c) => sum + c, 0) : null,
    };

    return NextResponse.json({ results, summary });
  } catch (error) { return safeApiError(error, "Could not assign categories to these listings."); }
}
