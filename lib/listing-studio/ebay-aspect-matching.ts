import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { MarketplaceAspectValue, AspectConfidenceLevel, MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

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

/**
 * Live-diagnostic follow-up fix (proven root cause of "0/18 recommended"
 * misleadingly counting three aspects this business can never fill) —
 * some recommended aspects (US/AU/EU Shoe Size — this business only ever
 * states UK size, deliberately never guessed via a conversion table) are
 * genuinely not applicable to how this app operates, not merely
 * unresolved. Excluding them from the readiness ARRAY entirely (never
 * included as either a numerator or denominator entry) is what keeps the
 * completion score meaningful — marking them "not filled" would silently
 * and permanently cap completion below 100% for every single footwear
 * draft, forever, for a fact this app deliberately never collects.
 */
export function isAspectCountableForReadiness(aspect: MarketplaceAspectValue | undefined): boolean {
  return aspect?.source !== "not_applicable";
}

/**
 * Live-diagnostic follow-up fix (proven root cause of a SECOND, more
 * aggressive unsafe whole-object `dynamic_data_json` replacement — manual
 * "Change category" wrote `dynamic_data_json: {}` unconditionally) — a new
 * category genuinely does invalidate every REAL taxonomy aspect value
 * already saved (they belonged to the old category's schema), so those are
 * correctly cleared. But the reserved pseudo-aspects (`__packageSize`,
 * `__contentGeneration`, `__productFacts`, keyed by the `__` prefix — the
 * one established convention every reserved key in this codebase already
 * follows) are NOT category-specific data at all and must survive a
 * category change untouched.
 */
export function clearRealAspectFields(dynamicData: MarketplaceDynamicData): MarketplaceDynamicData {
  const preserved: MarketplaceDynamicData = {};
  for (const [key, value] of Object.entries(dynamicData)) {
    if (key.startsWith("__")) preserved[key] = value;
  }
  return preserved;
}
