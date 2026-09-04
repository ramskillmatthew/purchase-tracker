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
import type { EbayFeedBatchBlockingState } from "@/lib/listing-studio/ebay-feed/feed-workflow-status";

export type EbayFeedDraftEligibilityInput = {
  hasEbayPreparation: boolean;
  accountUsable: boolean;
  /** True once listing_marketplace_drafts.ebay_feed_draft_created_at is
   * already set for this listing — a genuine, already-confirmed Seller Hub
   * draft, never merely "an attempt was started". */
  alreadyHasFeedDraft: boolean;
  /** CORRECTIVE PASS (duplicate-submission defect, Phase 6) — whether this
   * listing currently has an in-flight ("active") or unretried-failed
   * ("failed") Seller Hub Feed batch item. Optional and defaults to
   * { kind: "none" } so every pre-existing call site (and every
   * pre-existing test constructing this input) keeps compiling and
   * behaving exactly as before; only a call site that actually resolved
   * real batch-item state needs to pass it. See
   * lib/listing-studio/ebay-feed/feed-workflow-status.ts's own
   * computeEbayFeedBatchBlockingState — the one place this value is ever
   * derived, shared by server and client alike. */
  feedBatchState?: EbayFeedBatchBlockingState;
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

  const feedBatchState = input.feedBatchState ?? { kind: "none" as const };
  // CORRECTIVE PASS (third real-submission audit) — checked BEFORE
  // "active": a stale, inconsistent row must never be reported as if it
  // were still genuinely working.
  if (feedBatchState.kind === "needs_reconciliation") {
    return { eligible: false, reasons: [`Seller Hub Batch #${feedBatchState.displayNumber}'s local record for this listing is inconsistent and needs reconciliation before it can be retried`] };
  }
  if (feedBatchState.kind === "active") {
    return { eligible: false, reasons: [`Already in Seller Hub Batch #${feedBatchState.displayNumber}`] };
  }
  if (feedBatchState.kind === "failed") {
    return { eligible: false, reasons: [`Seller Hub Batch #${feedBatchState.displayNumber} failed for this listing — use Retry Seller Hub draft instead of Create`] };
  }

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
