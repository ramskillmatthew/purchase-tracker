import type { MarketplaceReadiness } from "@/lib/listing-studio/marketplace-types";

/**
 * The one place an eBay marketplace draft's readiness is computed (Stage 2/
 * Stage 5) — recomputed from current data on every read, never trusted as
 * stale stored state, matching lib/listing-studio/listing-review.ts's own
 * "computed, not cached as truth" convention. Persisted into
 * listing_marketplace_drafts.readiness_json purely so Listings Review can
 * filter/sort without recomputing every row from scratch — that column is
 * a cache of this function's own output, never an independent source of
 * truth.
 *
 * A draft is "ready" (in this milestone's sense — "draft details complete",
 * never "ready to publish") only once every REQUIRED item is present.
 * Recommended items missing never block readiness — they only lower
 * completionPercent and produce review warnings elsewhere (see
 * lib/listing-studio/marketplace-validation.ts).
 */
export type MarketplaceReadinessInput = {
  hasCategory: boolean;
  hasCondition: boolean;
  hasTitle: boolean;
  hasDescriptionOrGenerationPath: boolean;
  hasPhoto: boolean;
  hasPrice: boolean;
  hasQuantity: boolean;
  hasSufficientSellingSettings: boolean;
  /** One entry per aspect eBay's own metadata marked "required" for the
   * selected category (Stage 5) — empty until a category with aspect
   * definitions has been resolved. */
  requiredAspectsFilled: boolean[];
  /** One entry per "recommended" aspect — affects completionPercent only,
   * never `ready`. */
  recommendedAspectsFilled: boolean[];
};

export function computeMarketplaceReadiness(input: MarketplaceReadinessInput): MarketplaceReadiness {
  const coreChecks = [
    input.hasCategory, input.hasCondition, input.hasTitle, input.hasDescriptionOrGenerationPath,
    input.hasPhoto, input.hasPrice, input.hasQuantity, input.hasSufficientSellingSettings,
  ];
  const requiredComplete = coreChecks.filter(Boolean).length + input.requiredAspectsFilled.filter(Boolean).length;
  const requiredTotal = coreChecks.length + input.requiredAspectsFilled.length;
  const recommendedComplete = input.recommendedAspectsFilled.filter(Boolean).length;
  const recommendedTotal = input.recommendedAspectsFilled.length;

  const ready = requiredComplete === requiredTotal;
  const totalWeighted = requiredTotal + recommendedTotal;
  const completeWeighted = requiredComplete + recommendedComplete;
  const completionPercent = totalWeighted === 0 ? 0 : Math.round((completeWeighted / totalWeighted) * 100);

  return { ready, completionPercent, requiredComplete, requiredTotal, recommendedComplete, recommendedTotal };
}
