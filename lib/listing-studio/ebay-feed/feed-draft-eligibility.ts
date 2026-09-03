/**
 * The Sell Feed API pipeline's own "is this listing eligible for Create
 * eBay drafts right now" — deliberately SEPARATE from
 * lib/listing-studio/ebay-draft-eligibility.ts's evaluateEbayDraftEligibility
 * (the retired Inventory API pipeline's own eligibility function, left
 * untouched for the legacy batches it still describes), because the real
 * requirements genuinely differ:
 *
 * RESEARCH FINDING (confirmed directly from the real downloaded template —
 * see lib/listing-studio/ebay-feed/template-fixtures/ — whose own #INFO
 * row states plainly: "Action and Category ID are required to create draft
 * listings"): a Seller Hub draft created via this pipeline needs NO
 * business policies (fulfillment/return/payment) and NO merchant location
 * — those are things the SELLER assigns themselves, later, when they
 * manually complete and publish the draft inside Seller Hub. Requiring
 * them here would block a real, valid draft attempt on a requirement eBay
 * itself does not impose at this stage. This is the corrected, verified
 * understanding this pipeline exists specifically to act on — never
 * loosened further, and every other requirement below (price, photo, SKU,
 * quantity, category, condition) still fails closed exactly like the
 * legacy pipeline's own checks.
 */

import { toFeedTemplateConditionId } from "@/lib/listing-studio/ebay-feed/feed-condition";

export type EbayFeedDraftEligibilityInput = {
  hasEbayPreparation: boolean;
  accountUsable: boolean;
  /** True once listing_marketplace_drafts.ebay_feed_draft_created_at is
   * already set for this listing — a genuine, already-confirmed Seller Hub
   * draft, never merely "an attempt was started". */
  alreadyHasFeedDraft: boolean;
  contentReady: boolean;
  hasValidPrice: boolean;
  hasPhoto: boolean;
  hasSku: boolean;
  hasQuantity: boolean;
  hasCategoryId: boolean;
  conditionValue: string | null;
};

export type EbayFeedDraftEligibilityResult = { eligible: boolean; reasons: string[] };

export function evaluateEbayFeedDraftEligibility(input: EbayFeedDraftEligibilityInput): EbayFeedDraftEligibilityResult {
  if (!input.hasEbayPreparation) return { eligible: false, reasons: ["No eBay preparation for this listing"] };
  if (input.alreadyHasFeedDraft) return { eligible: false, reasons: ["A Seller Hub draft already exists for this listing"] };

  const reasons: string[] = [];
  if (!input.accountUsable) reasons.push("eBay account is not connected");
  if (!input.contentReady) reasons.push("eBay content is not yet complete — finish it in Listing Studio");
  if (!input.hasValidPrice) reasons.push("Missing eBay selling price");
  if (!input.hasPhoto) reasons.push("No uploaded photos");
  if (!input.hasSku) reasons.push("Missing SKU");
  if (!input.hasQuantity) reasons.push("Missing quantity");
  if (!input.hasCategoryId) reasons.push("Missing eBay category");
  const condition = toFeedTemplateConditionId(input.conditionValue);
  if (!condition.ok) reasons.push(condition.reason);

  return { eligible: reasons.length === 0, reasons };
}
