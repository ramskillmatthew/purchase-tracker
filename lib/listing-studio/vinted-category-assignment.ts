import "server-only";
import { getVintedCategoryById, searchAutomaticSelectionCandidates, MAX_AUTOMATIC_SELECTION_CANDIDATES } from "./vinted-categories-data";
import { deriveDraftAudience, deriveDraftItemFamily, selectAutomaticSelectionBranches, validateSelectedVintedCategory, normaliseFootwearVintedAudience } from "./vinted-category-selection";
import { runVintedCategorySelection } from "./vinted-category-selection-ai";
import { runVintedAudienceTextReassessment } from "./vinted-audience-reassessment-ai";
import type { VintedAudienceValue } from "./listing-generation-schemas";

/**
 * Follow-up correction (2026-08-04) — the single, shared orchestration for
 * "given this draft's already-known structured fields, resolve its Vinted
 * category." Extracted out of the generate route (which used to inline
 * this) so the exact same logic backs THREE call sites without drifting
 * apart: the main generate route (right after a fresh AI extraction), the
 * single "Assign category" retry action (no image reanalysis, works on
 * pre-existing drafts), and the bulk "Assign missing categories" action in
 * Listings Review.
 *
 * Every outcome is one of a fixed, safe, closed set — see
 * VintedCategoryAssignmentReason — persisted as
 * listing_drafts.vinted_category_status and translated into an actionable
 * UI message by describeVintedCategoryAssignmentReason() below. Nothing
 * here ever exposes a raw database or Anthropic error.
 */

// Bounded on both ends: a genuine bulk operation (one HTTP request covers
// every selected listing — never one request per listing, per this
// milestone's own explicit requirement), and a concurrency cap so N
// listings never fire N simultaneous Anthropic calls at once. Lives here
// (not in the bulk route itself) because a Next.js route file may only
// export recognised route handlers/config — no arbitrary named exports.
export const MAX_BULK_CATEGORY_ASSIGNMENT = 50;

export type VintedCategoryAssignmentReason =
  | "audience_missing"
  | "item_family_uncertain"
  | "no_candidates"
  | "too_many_candidates"
  | "ai_selection_failed"
  | "ai_selection_invalid"
  | "category_assigned";

export type VintedCategoryAssignmentResult =
  | { reason: "category_assigned"; categoryId: number; categoryPath: string; method: "deterministic" | "ai" }
  | { reason: Exclude<VintedCategoryAssignmentReason, "category_assigned">; categoryId: null; categoryPath: null };

export type VintedCategoryAssignmentAiCost = {
  model: string | null; inputTokens: number | null; outputTokens: number | null;
  candidateCount: number; status: "success" | "failed";
};

export type VintedCategoryAssignmentInput = {
  vintedAudience: VintedAudienceValue | null;
  productType: string | null;
  brand: string | null;
  model: string | null;
};

/**
 * Resolves ONE draft's Vinted category from its already-known structured
 * fields — never touches photos, never calls the main generation AI
 * stage. Deterministic-first: an unambiguous single candidate is assigned
 * with no AI call at all; only genuine ambiguity (2-25 candidates) reaches
 * the bounded text-only AI step. Returns a result the caller persists
 * itself (this function does no writes) plus an AI-cost payload whenever
 * the bounded AI call actually ran (null otherwise — a deterministic
 * match or an audience/candidate dead-end never calls, and never costs,
 * anything).
 *
 * Business-rule follow-up correction: this is the single choke point every
 * caller (listing generation, single/bulk Assign Category, Edit Fields'
 * audience-change recompute) already goes through to resolve a category —
 * so it's also the one place normaliseFootwearVintedAudience is applied to
 * turn a boys'/girls' FOOTWEAR audience into Women's before branch
 * selection even runs. The returned `vintedAudience` is this normalised
 * value; every caller persists THIS value, never its own raw input, so the
 * persisted audience and the resolved category (always from the Women's
 * branch in that case) can never disagree with each other.
 */
export async function resolveVintedCategoryAssignment(
  input: VintedCategoryAssignmentInput,
): Promise<{ result: VintedCategoryAssignmentResult; aiCost: VintedCategoryAssignmentAiCost | null; vintedAudience: VintedAudienceValue | null }> {
  const draftItemFamily = deriveDraftItemFamily(input.productType);
  const vintedAudience = normaliseFootwearVintedAudience(input.vintedAudience, draftItemFamily);
  const draftAudience = deriveDraftAudience(vintedAudience);
  if (draftAudience === "unknown") {
    return { result: { reason: "audience_missing", categoryId: null, categoryPath: null }, aiCost: null, vintedAudience };
  }

  const branches = selectAutomaticSelectionBranches(draftAudience, draftItemFamily);
  // branches.length is always > 0 here: a known (non-"unknown") audience
  // always has at least its clothing+footwear branches available, even
  // when item family is "uncertain" — see selectAutomaticSelectionBranches.

  const candidates = await searchAutomaticSelectionCandidates({
    branchFullPaths: branches.map((b) => b.fullPath),
    query: input.productType,
  });

  if (candidates.length === 0) {
    const reason = draftItemFamily === "uncertain" ? "item_family_uncertain" : "no_candidates";
    return { result: { reason, categoryId: null, categoryPath: null }, aiCost: null, vintedAudience };
  }

  if (candidates.length === 1) {
    const onlyCandidate = candidates[0];
    const freshCategory = await getVintedCategoryById(onlyCandidate.id);
    const validation = validateSelectedVintedCategory(onlyCandidate.id, candidates, freshCategory);
    if (validation.valid && validation.categoryId) {
      return { result: { reason: "category_assigned", categoryId: validation.categoryId, categoryPath: validation.category.full_path, method: "deterministic" }, aiCost: null, vintedAudience };
    }
    // The one candidate the active+selectable query itself just returned
    // failed a fresh re-check (e.g. deactivated between the two queries)
    // — genuinely rare, but never silently trusted regardless.
    return { result: { reason: "no_candidates", categoryId: null, categoryPath: null }, aiCost: null, vintedAudience };
  }

  const aiOutcome = await runVintedCategorySelection(
    { brand: input.brand, model: input.model, productType: input.productType, audience: draftAudience, itemFamily: draftItemFamily },
    candidates.map((c) => ({ id: c.id, fullPath: c.fullPath })),
  );

  if (aiOutcome.status !== "success") {
    return {
      result: { reason: "ai_selection_failed", categoryId: null, categoryPath: null },
      aiCost: { model: null, inputTokens: null, outputTokens: null, candidateCount: candidates.length, status: "failed" },
      vintedAudience,
    };
  }

  const aiCost: VintedCategoryAssignmentAiCost = {
    model: aiOutcome.model, inputTokens: aiOutcome.inputTokens, outputTokens: aiOutcome.outputTokens,
    candidateCount: candidates.length, status: "success",
  };
  const freshCategory = aiOutcome.vintedCategoryId ? await getVintedCategoryById(aiOutcome.vintedCategoryId) : null;
  const validation = validateSelectedVintedCategory(aiOutcome.vintedCategoryId, candidates, freshCategory);

  if (validation.valid && validation.categoryId) {
    return { result: { reason: "category_assigned", categoryId: validation.categoryId, categoryPath: validation.category.full_path, method: "ai" }, aiCost, vintedAudience };
  }
  // Either the AI confidently found nothing among real candidates, or its
  // pick failed fresh re-validation — both are "the bounded AI step did
  // not produce a usable category". Hitting exactly the 25-candidate cap
  // without a confident match is called out distinctly (too_many_candidates)
  // since it signals the candidate set may have been truncated, not just
  // genuinely ambiguous.
  const reason = candidates.length === MAX_AUTOMATIC_SELECTION_CANDIDATES ? "too_many_candidates" : "ai_selection_invalid";
  return { result: { reason, categoryId: null, categoryPath: null }, aiCost, vintedAudience };
}

export type VintedAudienceReassessmentAiCost = {
  model: string | null; inputTokens: number | null; outputTokens: number | null; status: "success" | "failed";
};

export type VintedCategoryAssignmentForExistingDraftInput = {
  vintedAudience: VintedAudienceValue | null;
  vintedAudienceSource: "ai" | "manual" | null;
  vintedAudienceEvidence: string[] | null;
  productType: string | null;
  brand: string | null;
  model: string | null;
};

export type VintedCategoryAssignmentForExistingDraftOutcome = {
  result: VintedCategoryAssignmentResult;
  categoryAiCost: VintedCategoryAssignmentAiCost | null;
  // The audience actually used to resolve the category above — may differ
  // from the input's vintedAudience if a text reassessment ran and
  // improved it. The caller persists this (and its evidence) regardless
  // of whether a category was ultimately found — an audience improving
  // from "unknown" to a real value is real progress worth keeping even if
  // category resolution itself then hits a dead end for some other reason.
  vintedAudience: VintedAudienceValue | null;
  vintedAudienceEvidence: string[] | null;
  audienceReassessmentAttempted: boolean;
  audienceAiCost: VintedAudienceReassessmentAiCost | null;
  // True exactly when the category is still unresolved specifically
  // because audience is unresolved (reason === "audience_missing") even
  // after the best-effort text-only reassessment above — signals the
  // caller to offer the separate, explicit, photo-based "Reassess
  // audience" action.
  canReassessWithPhotos: boolean;
};

/**
 * Follow-up correction (2026-08-05) — used by the "Assign category" retry
 * action and the bulk "Assign missing categories" action (never the main
 * generate route, which already gets a fresh, direct audience answer from
 * the photos it just analysed). Before giving up with "audience_missing",
 * tries ONE cheap, text-only audience reassessment
 * (runVintedAudienceTextReassessment) using this draft's already-stored
 * brand/model/productType/prior evidence — no images, no new photo cost.
 * Only attempted when: the audience isn't already protected as a manual
 * pick, AND there's genuinely something to reason from (brand, model, or
 * productType is non-null) — an empty draft gets no wasted AI call.
 */
export async function resolveVintedCategoryAssignmentForExistingDraft(
  input: VintedCategoryAssignmentForExistingDraftInput,
): Promise<VintedCategoryAssignmentForExistingDraftOutcome> {
  let vintedAudience = input.vintedAudience;
  let vintedAudienceEvidence = input.vintedAudienceEvidence;
  let audienceReassessmentAttempted = false;
  let audienceAiCost: VintedAudienceReassessmentAiCost | null = null;

  const isProtected = input.vintedAudienceSource === "manual";
  const hasStoredTextSignal = Boolean(input.brand || input.model || input.productType);

  if (!isProtected && deriveDraftAudience(vintedAudience) === "unknown" && hasStoredTextSignal) {
    audienceReassessmentAttempted = true;
    const outcome = await runVintedAudienceTextReassessment({
      brand: input.brand, model: input.model, productType: input.productType,
      priorVintedAudience: vintedAudience, priorEvidence: vintedAudienceEvidence,
    });
    if (outcome.status === "success") {
      vintedAudience = outcome.vintedAudience;
      vintedAudienceEvidence = outcome.vintedAudienceEvidence;
      audienceAiCost = { model: outcome.model, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, status: "success" };
    } else {
      audienceAiCost = { model: null, inputTokens: null, outputTokens: null, status: "failed" };
    }
  }

  const { result, aiCost, vintedAudience: resolvedVintedAudience } = await resolveVintedCategoryAssignment({
    vintedAudience, productType: input.productType, brand: input.brand, model: input.model,
  });

  return {
    // resolveVintedCategoryAssignment's own returned audience is always
    // the authoritative one — it's already normalised (boys/girls
    // footwear → womens), so this can never disagree with the branch the
    // category above was actually resolved from.
    result, categoryAiCost: aiCost, vintedAudience: resolvedVintedAudience, vintedAudienceEvidence,
    audienceReassessmentAttempted, audienceAiCost,
    canReassessWithPhotos: result.reason === "audience_missing",
  };
}

/** A fixed, safe sentence per outcome — never a raw database/Anthropic error. Mirrors describeListingGenerationFailure/describeVintedCategoryselectionFailure's convention. */
export function describeVintedCategoryAssignmentReason(reason: VintedCategoryAssignmentReason): string {
  switch (reason) {
    case "audience_missing": return "Select whether this item should be listed under Men or Women.";
    case "item_family_uncertain": return "Product type could not be matched to a Vinted category.";
    case "no_candidates": return "No valid active category was found.";
    case "too_many_candidates": return "Too many possible categories were found — please choose one manually.";
    case "ai_selection_failed": return "Category selection failed — retry.";
    case "ai_selection_invalid": return "No confident category match was found.";
    case "category_assigned": return "Category assigned.";
  }
}
