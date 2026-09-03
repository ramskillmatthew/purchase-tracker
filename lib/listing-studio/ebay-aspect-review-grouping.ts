import type { GroupedAspect, GroupedAspects } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { MarketplaceAspectValue, MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

/**
 * The single rule for "does the eBay details editor still owe the owner a
 * decision about this item specific" — the aspect-resolution pipeline itself
 * flagged it `needsReview` and the owner has not confirmed it. Reserved
 * `__`-prefixed pseudo-aspects (`__packageSize`, `__productFacts`, …) are
 * never real item specifics and are handled elsewhere.
 *
 * Used by BOTH the dialog's review summary and its "Needs review" aspect
 * group, so the count in the summary can never disagree with the fields the
 * form actually shows.
 */
export function aspectNeedsReview(value: MarketplaceAspectValue | undefined | null): boolean {
  return Boolean(value?.needsReview && !value.userConfirmed);
}

export type ReviewPartitionedAspects = {
  /** Every unresolved-review aspect, in Required → Recommended → Optional
   * order, pulled OUT of its normal group so it can be rendered in one
   * always-visible "Needs review" group — a review-flagged aspect can then
   * never be hidden behind the collapsed "optional" section. */
  needsReview: GroupedAspect[];
  required: GroupedAspect[];
  recommended: GroupedAspect[];
  optional: GroupedAspect[];
};

/**
 * Partitions this category's grouped aspect definitions so that any aspect
 * currently carrying an unresolved review flag is moved into a dedicated
 * `needsReview` list, and removed from its normal Required/Recommended/
 * Optional list. Once the owner resolves it (confirms a value, or a re-run
 * resolves it to a no-review value) it is no longer flagged and flows back
 * to its normal group on the next render — no separate "return it" step.
 */
export function partitionAspectsForReview(groups: GroupedAspects, dynamicData: MarketplaceDynamicData | null | undefined): ReviewPartitionedAspects {
  const data = dynamicData ?? {};
  const needsReview: GroupedAspect[] = [];
  const withoutReviewFlagged = (list: GroupedAspect[]) =>
    list.filter(aspect => {
      if (aspectNeedsReview(data[aspect.name])) { needsReview.push(aspect); return false; }
      return true;
    });
  // Evaluate in Required → Recommended → Optional order so `needsReview`
  // comes out in that same, most-important-first order.
  const required = withoutReviewFlagged(groups.required);
  const recommended = withoutReviewFlagged(groups.recommended);
  const optional = withoutReviewFlagged(groups.optional);
  return { needsReview, required, recommended, optional };
}
