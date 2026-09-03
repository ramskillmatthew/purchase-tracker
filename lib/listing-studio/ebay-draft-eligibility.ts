/**
 * Stage 6 (eBay draft batches) — the ONE place "is this listing eligible
 * for Create eBay drafts right now" is decided, mirroring
 * lib/listing-studio/listing-review.ts's buildListingWarnings: used
 * identically by the client (to grey out ineligible selections and explain
 * why) and the server (which never trusts the client's own check — see
 * app/api/listing-studio/ebay-draft-batches/route.ts). Pure, DB-free: every
 * input is already-resolved data the caller looked up.
 *
 * Deliberately separate from lib/listing-studio/marketplace-readiness.ts's
 * computeMarketplaceReadiness (CONTENT readiness — title/description/
 * category/condition/photo/quantity/aspects) — that answers "is this eBay
 * draft's generated content complete", this answers "can a real eBay
 * Inventory item + offer be created for it right now", which additionally
 * needs a valid price and three selected (and still-available) business
 * policies, and confirms one doesn't already exist.
 *
 * CORRECTIVE PASS — merchantLocationKey is deliberately NOT a blocking
 * requirement here. Traced against eBay's own Inventory API documentation
 * (developer.ebay.com/api-docs/sell/static/inventory/publishing-offers.html,
 * "Required fields for publishing an offer"): "a missing merchantLocationKey
 * will not cause issues when first creating an offer (the createOffer is
 * successful), but calling the publishOffer method will fail if the offer
 * does not have the merchantLocationKey." This application's Inventory API
 * allowlist (lib/ebay-account/inventory-allowlist.ts) permanently forbids
 * publishOffer — it only ever calls createOffer, the operation the location
 * is proven NOT required for. Blocking draft creation on it would enforce a
 * publish-time eBay requirement this app never reaches. See
 * eligibilityNotes below for the non-blocking signal surfaced instead.
 *
 * CORRECTIVE PASS (failed first draft) — also now requires the listing's
 * condition to translate to a real eBay ConditionEnum value via
 * lib/listing-studio/ebay-condition.ts's toEbayInventoryCondition, the
 * SAME function the batch processor uses to build the final payload (see
 * that file's own header for the full root-cause story). The UI must
 * never say "Ready" for a listing whose condition eBay will reject.
 */

import { toEbayInventoryCondition } from "@/lib/listing-studio/ebay-condition";

export type EbayDraftEligibilityInput = {
  hasEbayPreparation: boolean;
  accountUsable: boolean;
  alreadyHasOffer: boolean;
  contentReady: boolean;
  hasValidPrice: boolean;
  hasPhoto: boolean;
  hasSku: boolean;
  hasQuantity: boolean;
  conditionValue: string | null;
  fulfillmentPolicyId: string | null;
  fulfillmentPolicyStale: boolean;
  returnPolicyId: string | null;
  returnPolicyStale: boolean;
  paymentPolicyId: string | null;
  paymentPolicyStale: boolean;
  merchantLocationKey: string | null;
};

export type EbayDraftEligibilityResult = {
  eligible: boolean;
  reasons: string[];
  /** Non-blocking notes — true today "would" reasons that don't currently
   * prevent draft creation but are worth surfacing (e.g. no inventory
   * location set yet, which only matters once the user later chooses to
   * publish outside this app). Never included in `reasons`, never affects
   * `eligible`. */
  notes: string[];
};

export function evaluateEbayDraftEligibility(input: EbayDraftEligibilityInput): EbayDraftEligibilityResult {
  const reasons: string[] = [];
  const notes: string[] = [];

  if (!input.hasEbayPreparation) {
    return { eligible: false, reasons: ["No eBay preparation for this listing"], notes: [] };
  }
  if (input.alreadyHasOffer) {
    return { eligible: false, reasons: ["An eBay draft already exists for this listing"], notes: [] };
  }
  if (!input.accountUsable) reasons.push("eBay account is not connected");
  if (!input.contentReady) reasons.push("eBay content is not yet complete — finish it in Listing Studio");
  if (!input.hasValidPrice) reasons.push("Missing eBay selling price");
  if (!input.hasPhoto) reasons.push("No uploaded photos");
  if (!input.hasSku) reasons.push("Missing SKU");
  if (!input.hasQuantity) reasons.push("Missing quantity");
  const condition = toEbayInventoryCondition(input.conditionValue);
  if (!condition.ok) reasons.push(condition.reason);
  if (!input.fulfillmentPolicyId) reasons.push("Missing shipping policy");
  else if (input.fulfillmentPolicyStale) reasons.push("Shipping policy is no longer available — choose another");
  if (!input.returnPolicyId) reasons.push("Missing return policy");
  else if (input.returnPolicyStale) reasons.push("Return policy is no longer available — choose another");
  if (!input.paymentPolicyId) reasons.push("Missing payment policy");
  else if (input.paymentPolicyStale) reasons.push("Payment policy is no longer available — choose another");
  if (!input.merchantLocationKey) notes.push("No inventory location set — optional for a draft, but eBay will require one before you can publish this listing yourself");

  return { eligible: reasons.length === 0, reasons, notes };
}
