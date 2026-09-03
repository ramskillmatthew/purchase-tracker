import "server-only";
import { getCachedCategoryTreeId } from "@/lib/listing-studio/ebay-taxonomy-cache";
import { getCategorySuggestions, type EbayApiFailure, type EbayCategorySuggestion } from "@/lib/listing-studio/ebay-taxonomy-client";
import { buildEbayCategorySearchTerms, type EbayCategorySearchInput } from "@/lib/listing-studio/ebay-category-search-terms";
import { runEbayCategoryRanking } from "@/lib/listing-studio/ebay-category-ranking-ai";
import { fixtureCategorySuggestions, FIXTURE_CATEGORY_TREE_ID, FIXTURE_CATEGORY_TREE_VERSION } from "@/lib/listing-studio/ebay-taxonomy-fixtures";
import { describeEbayApiFailure, type EbayErrorCode } from "@/lib/listing-studio/ebay-error-codes";
import type { EbayCategoryAlternative } from "@/lib/listing-studio/marketplace-types";

/** The one eBay UK marketplace id this app ever requests a category tree
 * for — see https://developer.ebay.com/api-docs/sell/inventory/types/slr:MarketplaceEnum. */
export const EBAY_GB_MARKETPLACE_ID = "EBAY_GB";

// A confident top pick beats the runner-up by at least this fraction of its
// own relevancy score (e.g. top=300, second<=210 at 0.3) to be trusted
// automatically. Below MEDIUM_GAP_RATIO, the race is close enough to send
// to the bounded AI ranking step instead of guessing from relevancy alone.
// Centralised here — see the product spec's own "not scattered as
// unexplained magic numbers" requirement — and covered by
// tests/listing-studio-ebay-category-service.test.ts.
const HIGH_GAP_RATIO = 0.3;
const MEDIUM_GAP_RATIO = 0.1;
const MIN_SEARCH_TERMS_FOR_HIGH_CONFIDENCE = 2;

export type EbayCategorySuggestionOutcome =
  // Phase 8 fix — "the live localhost UI must state when it is using
  // fixture mode... do not fabricate production-like results using a
  // hidden fixture." `usedFixture` is the one signal that makes that
  // possible: true only when NO real eBay credentials are configured and
  // this isn't a production deployment (see useFixture's own gate below)
  // — never true once real credentials exist, even if they turn out to
  // be invalid (an auth failure is reported honestly instead, never
  // masked by a fixture).
  | { status: "success"; searchTerms: string; selected: EbayCategoryAlternative; alternatives: EbayCategoryAlternative[]; stale: boolean; usedFixture: boolean }
  | { status: "no_results"; searchTerms: string; usedFixture?: boolean }
  | { status: "not_configured" }
  | { status: "upstream_unavailable"; reason: EbayApiFailure["error"] };

function parseRelevancy(value: string | null | undefined): number {
  const parsed = value ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function toAlternative(suggestion: EbayCategorySuggestion, rank: number, confidence: "high" | "medium" | "low", reason: string): EbayCategoryAlternative {
  const ancestors = suggestion.categoryTreeNodeAncestors ?? [];
  const path = [...ancestors.map(a => a.categoryName), suggestion.category.categoryName].join(" > ");
  return { categoryId: suggestion.category.categoryId, categoryName: suggestion.category.categoryName, categoryPath: path, rank, confidence, reason };
}

/**
 * The full Stage 4 pipeline for one product: structured facts -> search
 * terms -> real eBay category suggestions -> a ranking layer that selects
 * the strongest result. The AI (lib/listing-studio/ebay-category-ranking-ai.ts)
 * only ever RANKS candidates eBay itself already returned — it is
 * structurally incapable of inventing a category id (see that module's own
 * schema, which rejects anything outside the supplied candidate list).
 *
 * Deterministic-first: eBay's own relevancy score already separates a
 * clear winner from a close race in most cases, so the bounded AI call
 * only runs when that gap is genuinely too close to trust alone —
 * mirroring lib/listing-studio/vinted-category-assignment.ts's own
 * "deterministic first, AI only for real ambiguity" convention.
 */
export async function suggestEbayCategory(facts: EbayCategorySearchInput): Promise<EbayCategorySuggestionOutcome> {
  const searchTerms = buildEbayCategorySearchTerms(facts);
  if (!searchTerms) return { status: "no_results", searchTerms: "" };

  const hasCredentials = Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
  // Never active in a real production deployment (NODE_ENV is always
  // "production" there) regardless of credential misconfiguration — see
  // ebay-taxonomy-fixtures.ts's own top comment.
  const useFixture = !hasCredentials && process.env.NODE_ENV !== "production";

  let suggestions: EbayCategorySuggestion[];
  let stale = false;
  if (useFixture) {
    suggestions = fixtureCategorySuggestions(searchTerms);
  } else {
    const treeResult = await getCachedCategoryTreeId(EBAY_GB_MARKETPLACE_ID);
    if (!treeResult.ok) return treeResult.error === "not_configured" ? { status: "not_configured" } : { status: "upstream_unavailable", reason: treeResult.error };
    stale = treeResult.data.stale;

    const suggestionsResult = await getCategorySuggestions(treeResult.data.categoryTreeId, searchTerms);
    if (!suggestionsResult.ok) return suggestionsResult.error === "not_configured" ? { status: "not_configured" } : { status: "upstream_unavailable", reason: suggestionsResult.error };
    suggestions = suggestionsResult.data;
  }

  if (suggestions.length === 0) return { status: "no_results", searchTerms, usedFixture: useFixture };

  const termCount = searchTerms.split(/\s+/).filter(Boolean).length;
  const ranked = [...suggestions].sort((a, b) => parseRelevancy(b.relevancy) - parseRelevancy(a.relevancy));

  if (ranked.length === 1) {
    const confidence = termCount >= MIN_SEARCH_TERMS_FOR_HIGH_CONFIDENCE ? "high" : "medium";
    const selected = toAlternative(ranked[0], 1, confidence, "Only matching eBay category for these search terms.");
    return { status: "success", searchTerms, selected, alternatives: [], stale, usedFixture: useFixture };
  }

  const top = parseRelevancy(ranked[0].relevancy);
  const second = parseRelevancy(ranked[1].relevancy);
  const gapRatio = top > 0 ? (top - second) / top : 0;

  if (gapRatio >= HIGH_GAP_RATIO) {
    const selected = toAlternative(ranked[0], 1, "high", "Clearly the strongest match for these search terms.");
    const alternatives = ranked.slice(1, 4).map((s, index) => toAlternative(s, index + 2, "low", "Other possible match."));
    return { status: "success", searchTerms, selected, alternatives, stale, usedFixture: useFixture };
  }
  if (gapRatio >= MEDIUM_GAP_RATIO) {
    const selected = toAlternative(ranked[0], 1, "medium", "Best match for these search terms, worth a quick check.");
    const alternatives = ranked.slice(1, 4).map((s, index) => toAlternative(s, index + 2, "low", "Other possible match."));
    return { status: "success", searchTerms, selected, alternatives, stale, usedFixture: useFixture };
  }

  // Genuinely close race by relevancy alone — ask the bounded AI ranking
  // step to break the tie using the fuller structured facts eBay's own
  // text-relevancy score never saw.
  const candidates = ranked.slice(0, 10).map(s => ({ categoryId: s.category.categoryId, categoryName: s.category.categoryName, categoryPath: [...(s.categoryTreeNodeAncestors ?? []).map(a => a.categoryName), s.category.categoryName].join(" > "), relevancy: s.relevancy ?? null }));
  const aiOutcome = await runEbayCategoryRanking({ brand: facts.brand, productType: facts.productType, model: facts.model, set: facts.set, searchTerms }, candidates);

  const alternatives = ranked.slice(0, 4).map((s, index) => toAlternative(s, index + 1, "low", "Other possible match."));
  if (aiOutcome.status === "success" && aiOutcome.categoryId) {
    const chosen = ranked.find(s => s.category.categoryId === aiOutcome.categoryId);
    if (chosen) {
      const selected = toAlternative(chosen, 1, "medium", aiOutcome.reason || "Selected as the best match among close candidates.");
      return { status: "success", searchTerms, selected, alternatives: alternatives.filter(a => a.categoryId !== chosen.category.categoryId), stale, usedFixture: useFixture };
    }
  }

  // The AI declined, failed, or (defensively) named something invalid —
  // fall back to eBay's own top relevancy result, but honestly marked low
  // confidence so Strict/Balanced automation requires the owner to confirm
  // it rather than silently trusting a genuinely ambiguous pick.
  const selected = toAlternative(ranked[0], 1, "low", "Closest match, but several similar categories were found — please confirm.");
  return { status: "success", searchTerms, selected, alternatives: alternatives.filter(a => a.categoryId !== selected.categoryId), stale, usedFixture: useFixture };
}

// Phase 8 fix — precise, actionable messages (and a safe error CODE the
// client can key UI off of) instead of one generic bucket. See
// ebay-error-codes.ts's own comment for the proven 401 auth-failure
// diagnosis that motivated this.
export function describeEbayCategorySuggestionFailureDetailed(outcome: Extract<EbayCategorySuggestionOutcome, { status: "not_configured" | "upstream_unavailable" | "no_results" }>): { code: EbayErrorCode; message: string } {
  if (outcome.status === "not_configured") return { code: "EBAY_NOT_CONFIGURED", message: "eBay category access is not configured on localhost." };
  if (outcome.status === "no_results") return { code: "EBAY_NO_CATEGORY", message: "No suitable eBay UK category was returned for this product yet." };
  return describeEbayApiFailure(outcome.reason);
}

/** @deprecated Prefer describeEbayCategorySuggestionFailureDetailed, which also carries a safe error code. Kept only for existing callers that only need the message text. */
export function describeEbayCategorySuggestionFailure(outcome: Extract<EbayCategorySuggestionOutcome, { status: "not_configured" | "upstream_unavailable" | "no_results" }>): string {
  return describeEbayCategorySuggestionFailureDetailed(outcome).message;
}

export { FIXTURE_CATEGORY_TREE_ID, FIXTURE_CATEGORY_TREE_VERSION };
