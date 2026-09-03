import type { PackageSize } from "@/lib/listing-studio/marketplace-types";

/**
 * Step 5 — intelligent parcel-size suggestion. Deliberately deterministic
 * and keyword-based, mirroring ebay-title-builder.ts's own "no free-form
 * AI prose, only verified facts" philosophy: there is no AI call here at
 * all, so this never adds cost or latency to "Generate listings", and it
 * can never invent a size it has no basis for. Only ever a SUGGESTION —
 * "Manual override always wins" is enforced by the caller (see
 * ebay-aspect-persistence.ts's sibling, the generate route, and
 * EbayCategoryAndAspectsDialog.tsx), never by this module.
 *
 * Problem 5 fix — a high-confidence, ordinary, single-item match (the
 * overwhelmingly common case: one pair of trainers/shoes/sandals in its
 * usual box) is a genuine, reliable default, and must not be flagged
 * uncertain merely because this module has no photo/packaging analysis —
 * see `requiresReview` below, which is what actually drives the UI's
 * "Needs review" badge (never `confidence` directly). Only genuinely
 * uncertain cases keep `requiresReview: true`: no keyword match at all,
 * a bulkier sub-type (boots) whose packaging varies more than an ordinary
 * shoebox, or more than one unit in the same listing (its combined
 * packaging isn't the same as a single item's).
 */
export type PackageSizeSuggestion = {
  size: PackageSize | null;
  confidence: "high" | "medium" | "low";
  /** Drives the "Needs review" badge — deliberately a separate field from
   * `confidence` (a "medium" heuristic match can still be a reliable,
   * non-reviewable default; see this module's own top comment). */
  requiresReview: boolean;
  reason: string;
};

export type PackageSizeSuggestionInput = {
  productType: string | null;
  brand: string | null;
  model: string | null;
  material: string | null;
  /** Number of identical units in this one listing, when known — more
   * than one unit makes the combined packaging genuinely uncertain even
   * for an otherwise-ordinary item, so it's always flagged for review. */
  quantity?: number | null;
};

// "boot" is deliberately its own, bulkier sub-category — genuinely more
// variable packaging (ankle boot vs. tall winter boot) than an ordinary
// shoebox, so it stays a reviewable medium-confidence suggestion rather
// than the high-confidence default the other ordinary footwear keywords get.
const ORDINARY_FOOTWEAR_KEYWORDS = ["trainer", "sneaker", "shoe", "sandal", "slipper"];
const BULKY_FOOTWEAR_KEYWORDS = ["boot"];
const SEALED_BOX_KEYWORDS = ["elite trainer box", "etb", "booster box", "booster bundle", "battle box", "collection box", "bundle box"];
const CARD_PRODUCT_KEYWORDS = ["tcg", "pokemon", "pokémon", "trading card", "booster pack", "card pack"];
const SMALL_FLAT_KEYWORDS = ["sachet", "sample", "single card", "trading card"];
const BEAUTY_KEYWORDS = ["serum", "cream", "moisturiser", "moisturizer", "cosmetic", "skincare", "lotion", "toner", "cleanser"];

function matchesAny(haystack: string, keywords: string[]): boolean {
  return keywords.some(keyword => haystack.includes(keyword));
}

export function suggestPackageSize(input: PackageSizeSuggestionInput): PackageSizeSuggestion {
  const haystack = [input.productType, input.brand, input.model, input.material].filter(Boolean).join(" ").toLowerCase();
  const isMultiQuantity = (input.quantity ?? 1) > 1;

  function withMultiQuantityReview(suggestion: PackageSizeSuggestion): PackageSizeSuggestion {
    if (!isMultiQuantity || suggestion.requiresReview) return suggestion;
    return { ...suggestion, requiresReview: true, reason: `${suggestion.reason} This listing has more than one unit, so the combined packaging needs a manual check.` };
  }

  if (!haystack.trim()) {
    return { size: null, confidence: "low", requiresReview: true, reason: "Not enough product information yet to suggest a parcel size." };
  }

  // Sealed trading-card box packaging (e.g. "Elite Trainer Box") is
  // checked BEFORE the ordinary-footwear keywords below deliberately —
  // "Elite Trainer Box" contains the substring "trainer" and must still
  // resolve as a card product, never as footwear.
  if (matchesAny(haystack, SEALED_BOX_KEYWORDS)) {
    return withMultiQuantityReview({ size: "small_parcel", confidence: "medium", requiresReview: true, reason: "Sealed trading-card box packaging is normally compact enough for a small parcel." });
  }
  if (matchesAny(haystack, SMALL_FLAT_KEYWORDS) && matchesAny(haystack, CARD_PRODUCT_KEYWORDS)) {
    return withMultiQuantityReview({ size: "large_letter", confidence: "medium", requiresReview: true, reason: "A single card or small card pack is thin and light enough to post as a large letter." });
  }
  if (matchesAny(haystack, CARD_PRODUCT_KEYWORDS)) {
    return withMultiQuantityReview({ size: "small_parcel", confidence: "low", requiresReview: true, reason: "Trading card product — likely a small parcel, but confirm the actual packaging before dispatch." });
  }
  if (matchesAny(haystack, BULKY_FOOTWEAR_KEYWORDS)) {
    return withMultiQuantityReview({ size: "medium_parcel", confidence: "medium", requiresReview: true, reason: "Boots can be bulkier than standard trainers — please confirm the parcel size fits before dispatch." });
  }
  if (matchesAny(haystack, ORDINARY_FOOTWEAR_KEYWORDS)) {
    return withMultiQuantityReview({ size: "medium_parcel", confidence: "high", requiresReview: false, reason: "Footwear is usually sent in its original shoebox — a medium parcel is the standard case." });
  }
  if (matchesAny(haystack, BEAUTY_KEYWORDS)) {
    return withMultiQuantityReview({ size: "small_parcel", confidence: "low", requiresReview: true, reason: "Small cosmetic item — likely a small parcel, but confirm bottle size and any outer packaging first." });
  }
  return { size: null, confidence: "low", requiresReview: true, reason: "Product type doesn't match a known packaging pattern — choose a parcel size manually." };
}
