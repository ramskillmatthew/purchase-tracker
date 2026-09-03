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
  /** Stage 6 correction — no longer a REQUIRED check (see coreChecks below):
   * an eBay marketplace draft's content can be genuinely complete (title,
   * description, category, condition, photo, quantity) with no price at
   * all — price is entered later, per-listing, in Listings Review, and is
   * checked separately there (see lib/listing-studio/ebay-draft-eligibility.ts)
   * before a real eBay draft can be created. Kept on this input type (every
   * existing caller already computes and passes it) purely so a future
   * caller can still use it for its own display/completion purposes, but it
   * no longer contributes to `ready` or `completionPercent` here. */
  hasPrice: boolean;
  hasQuantity: boolean;
  hasSufficientSellingSettings: boolean;
  /** Bug fix (Phase 4/5 — "separate content-generation state from draft
   * readiness"): hasTitle/hasDescriptionOrGenerationPath above only ever
   * checked non-empty strings, which a FALLBACK draft's own 3-line
   * deterministic recovery text also satisfies — the proven reason a
   * failed eBay generation could still read as "5/8 complete" instead of
   * genuinely blocked. true only once content generation actually
   * succeeded (EbayContentGenerationState "generated"), or — for a
   * marketplace/source type where AI generation never applies at all
   * (e.g. an imported eBay exact-copy draft) — once that path's own
   * equivalent "this is real content" condition holds. Optional so every
   * OTHER existing caller (Vinted-shaped, or anything predating this
   * field) keeps working unchanged: defaults to true, never a silent new
   * blocker for a marketplace that never had this concept. */
  hasGeneratedContent?: boolean;
  /** One entry per aspect eBay's own metadata marked "required" for the
   * selected category (Stage 5) — empty until a category with aspect
   * definitions has been resolved. */
  requiredAspectsFilled: boolean[];
  /** One entry per "recommended" aspect — affects completionPercent only,
   * never `ready`. */
  recommendedAspectsFilled: boolean[];
};

export function computeMarketplaceReadiness(input: MarketplaceReadinessInput): MarketplaceReadiness {
  // hasPrice deliberately excluded — see this file's own comment on
  // MarketplaceReadinessInput.hasPrice above (Stage 6 correction).
  const coreChecks = [
    input.hasCategory, input.hasCondition, input.hasTitle, input.hasDescriptionOrGenerationPath,
    input.hasPhoto, input.hasQuantity, input.hasSufficientSellingSettings,
    input.hasGeneratedContent ?? true,
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
