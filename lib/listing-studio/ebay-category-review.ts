import { requiresWomensDepartment, categoryTextIndicatesWomens } from "@/lib/listing-studio/footwear-department-rule";
import type { MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

/**
 * Reserved pseudo-aspect (same zero-schema-migration pattern as
 * __packageSize/__productFacts/__contentGeneration) — a genuine UK-size-7+
 * "Confirm category" action is persisted here as `{value: categoryId}`
 * through the SAME PATCH /ebay-aspects route every real item specific
 * already uses, reusing its merge-safety and userConfirmed handling for
 * free. Scoped to a specific category id: comparing the stored id against
 * the draft's CURRENT category id (see readCategoryConfirmation below) is
 * what makes a stale confirmation from a since-changed category
 * automatically invalid — no separate "clear on change" step is ever
 * needed.
 */
export const CATEGORY_CONFIRMATION_KEY = "__categoryConfirmation";

/** Reads the categoryId a previous "Confirm category" action was saved
 * against, or null if never confirmed (or malformed) — never throws. */
export function readCategoryConfirmation(dynamicData: MarketplaceDynamicData | null | undefined): string | null {
  const raw = (dynamicData as Record<string, unknown> | null | undefined)?.[CATEGORY_CONFIRMATION_KEY];
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as { value?: unknown; userConfirmed?: unknown };
  return entry.userConfirmed === true && typeof entry.value === "string" ? entry.value : null;
}

/**
 * Live-diagnostic follow-up fix (proven root cause of an unexplained
 * "Needs review" row with zero visible reason inside the dialog) — the
 * ONE place that decides whether a selected eBay category genuinely needs
 * human review, and why. Previously nothing computed this explicitly: the
 * product-row badge inferred "needs_review" from unrelated recommended-
 * aspect completeness (see ebay-card-status.ts's own history), and the
 * dialog never rendered category confidence as a review reason at all —
 * so a Medium-confidence category could never actually explain a "Needs
 * review" badge, and a genuinely low-confidence one had no visible
 * Confirm/Change action either. This function is now the single source of
 * truth both the row badge (via buildEbaySummary) and the dialog's own
 * review summary read from — they can never disagree about "why".
 */
export type CategoryReviewState = {
  /** The confidence to actually TRUST for review purposes — distinct from
   * the raw AI/taxonomy confidence eBay returned (never silently
   * overwritten in storage; see the caller's own comment on why the raw
   * value is preserved). Only ever raised by the deterministic footwear
   * rule, never lowered. */
  effectiveConfidence: "high" | "medium" | "low";
  needsReview: boolean;
  /** A short, human-readable, honest explanation — null only when
   * needsReview is false. Never invents certainty language when the
   * underlying reason is genuinely a deterministic rule vs. an AI guess —
   * see `provenance` for the machine-readable distinction. */
  reason: string | null;
  provenance: "footwear_size_rule" | "footwear_size_rule_mismatch" | "ai_suggestion" | "manual" | "user_confirmed";
};

export function resolveCategoryReviewState(params: {
  categoryId: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  categoryConfidence: "high" | "medium" | "low" | null;
  categorySource: "ai" | "manual" | null;
  itemFamily: string;
  ukShoeSize: string | null;
  /** The categoryId a previous "Confirm category" action was saved
   * against (from the __categoryConfirmation reserved pseudo-aspect) —
   * null/undefined if never confirmed. Compared against the CURRENT
   * categoryId so a stale confirmation from a since-changed category is
   * automatically ignored, with no separate "clear on change" step ever
   * needed. */
  confirmedForCategoryId: string | null | undefined;
}): CategoryReviewState {
  if (!params.categoryId) return { effectiveConfidence: "low", needsReview: false, reason: null, provenance: "ai_suggestion" };

  // A manual "Change category" selection is the owner's own explicit,
  // deliberate choice — same as everywhere else in this app a manual
  // correction is trusted outright, never re-litigated.
  if (params.categorySource === "manual") {
    return { effectiveConfidence: "high", needsReview: false, reason: null, provenance: "manual" };
  }

  const categoryText = `${params.categoryName ?? ""} ${params.categoryPath ?? ""}`;
  if (requiresWomensDepartment(params.itemFamily, params.ukShoeSize)) {
    if (categoryTextIndicatesWomens(categoryText)) {
      // The deterministic rule corroborates eBay's own selection — trusted
      // outright regardless of eBay's own (possibly Medium/Low) taxonomy
      // confidence. Never displayed as "the AI got more confident" — see
      // provenance.
      return { effectiveConfidence: "high", needsReview: false, reason: null, provenance: "footwear_size_rule" };
    }
    // The selected category does NOT read as Women's, yet this product's
    // UK size mandates it must be — a genuine mismatch the rule itself
    // flags (never silently accepted as "good enough"), distinct from an
    // ordinary AI-confidence review.
    return {
      effectiveConfidence: "low", needsReview: true, provenance: "footwear_size_rule_mismatch",
      reason: "This product's UK shoe size requires a Women's category, but the selected category is not a Women's category. Choose a Women's category.",
    };
  }

  if (params.confirmedForCategoryId && params.confirmedForCategoryId === params.categoryId) {
    // Confirmation resolves the REVIEW requirement — it deliberately never
    // mutates the original AI confidence value itself (kept exactly as
    // eBay reported it); "confidence" and "confirmed" stay separate
    // concepts, as required.
    return { effectiveConfidence: params.categoryConfidence ?? "medium", needsReview: false, reason: null, provenance: "user_confirmed" };
  }

  if (params.categoryConfidence === "high" || params.categoryConfidence == null) {
    return { effectiveConfidence: "high", needsReview: false, reason: null, provenance: "ai_suggestion" };
  }

  return {
    effectiveConfidence: params.categoryConfidence, needsReview: true, provenance: "ai_suggestion",
    reason: `The suggested eBay category is a ${params.categoryConfidence}-confidence match — confirm it or choose a different one.`,
  };
}
