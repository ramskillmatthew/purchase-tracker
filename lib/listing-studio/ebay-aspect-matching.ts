import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { MarketplaceAspectValue, AspectConfidenceLevel } from "@/lib/listing-studio/marketplace-types";

/**
 * Stage 5 — deterministic candidate-to-eBay-value matching, tried BEFORE
 * any AI call (mirroring every other deterministic-first pattern in this
 * codebase). A candidate is a piece of real evidence already known about
 * the product (an imported eBay item specific, a confirmed shared fact, a
 * Vinted-generated field) — never a guess. Matching never invents a value:
 * for a SELECTION_ONLY aspect, only a candidate that normalises to EXACTLY
 * one of eBay's own allowed values is ever accepted; anything else is left
 * unmatched (unknown), never stored as an approximate paraphrase eBay
 * itself would reject.
 */
export type AspectCandidate = {
  value: string | string[];
  source: string;
  // The evidence's own confidence BEFORE matching — matching can only ever
  // keep or lower this (an exact match to an allowed value keeps it; a
  // free-text candidate accepted verbatim keeps it), never raise a weak
  // candidate's confidence just because it happened to match.
  confidence: Exclude<AspectConfidenceLevel, "unknown">;
};

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ").replace(/[.,]/g, "").trim();
}

function findAllowedMatch(candidateValue: string, allowedValues: string[]): string | null {
  const target = normalise(candidateValue);
  return allowedValues.find(allowed => normalise(allowed) === target) ?? null;
}

/**
 * Tries each candidate in priority order (array order = priority, per the
 * product spec's own candidate-source list) and returns the first one that
 * produces a usable value for this aspect. Free text respects aspectMaxLength,
 * truncating never inventing. Returns an "unknown" value (never a guess)
 * when nothing matches.
 */
export function matchAspectValue(aspect: GroupedAspect, candidates: AspectCandidate[], now: () => string = () => new Date().toISOString()): MarketplaceAspectValue {
  for (const candidate of candidates) {
    if (aspect.mode === "FREE_TEXT") {
      const raw = Array.isArray(candidate.value) ? candidate.value.join(", ") : candidate.value;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const value = aspect.maxLength ? trimmed.slice(0, aspect.maxLength) : trimmed;
      return { value, confidence: candidate.confidence, source: candidate.source, appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: now() };
    }

    // SELECTION_ONLY: only an EXACT (case/whitespace/punctuation-normalised)
    // match to one of eBay's own allowed values is ever accepted — a safe
    // alias match, never a semantic/synonym guess. Rejecting anything else
    // is what keeps this aspect's own accuracy rule intact even when the
    // candidate source itself is confident about a paraphrase eBay
    // wouldn't recognise (e.g. "Pokemon" vs eBay's own "Pokémon TCG").
    if (aspect.cardinality === "MULTI" && Array.isArray(candidate.value)) {
      const matched = candidate.value.map(v => findAllowedMatch(v, aspect.allowedValues)).filter((v): v is string => v !== null);
      if (matched.length) return { value: matched, confidence: candidate.confidence, source: candidate.source, appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: now() };
      continue;
    }
    const single = Array.isArray(candidate.value) ? candidate.value[0] : candidate.value;
    if (single === undefined) continue;
    const matched = findAllowedMatch(single, aspect.allowedValues);
    if (matched) return { value: matched, confidence: candidate.confidence, source: candidate.source, appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: now() };
  }

  return { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: now() };
}

/**
 * Whether an aspect's current value counts as genuinely "filled" for
 * readiness purposes (Stage 5's own automation-mode section: "Low: do not
 * apply if required; request confirmation. Unknown: leave blank."). High
 * and medium confidence always count; a low-confidence suggestion only
 * counts once the owner has actually confirmed it — never silently trusted
 * for a required field just because a value string is present.
 */
export function isAspectValueFilled(aspect: MarketplaceAspectValue): boolean {
  if (aspect.value == null) return false;
  if (aspect.confidence === "high" || aspect.confidence === "medium") return true;
  return aspect.userConfirmed;
}
