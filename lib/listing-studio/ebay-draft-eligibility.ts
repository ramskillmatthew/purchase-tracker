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
 * needs a valid price, three selected (and still-available) business
 * policies, an inventory location, and confirms one doesn't already exist.
 */

export type EbayDraftEligibilityInput = {
  hasEbayPreparation: boolean;
  accountUsable: boolean;
  alreadyHasOffer: boolean;
  contentReady: boolean;
  hasValidPrice: boolean;
  hasPhoto: boolean;
  hasSku: boolean;
  hasQuantity: boolean;
  fulfillmentPolicyId: string | null;
  fulfillmentPolicyStale: boolean;
  returnPolicyId: string | null;
  returnPolicyStale: boolean;
  paymentPolicyId: string | null;
  paymentPolicyStale: boolean;
  merchantLocationKey: string | null;
};

export type EbayDraftEligibilityResult = { eligible: boolean; reasons: string[] };

export function evaluateEbayDraftEligibility(input: EbayDraftEligibilityInput): EbayDraftEligibilityResult {
  const reasons: string[] = [];

  if (!input.hasEbayPreparation) {
    return { eligible: false, reasons: ["No eBay preparation for this listing"] };
  }
  if (input.alreadyHasOffer) {
    return { eligible: false, reasons: ["An eBay draft already exists for this listing"] };
  }
  if (!input.accountUsable) reasons.push("eBay account is not connected");
  if (!input.contentReady) reasons.push("eBay content is not yet complete — finish it in Listing Studio");
  if (!input.hasValidPrice) reasons.push("Missing eBay selling price");
  if (!input.hasPhoto) reasons.push("No uploaded photos");
  if (!input.hasSku) reasons.push("Missing SKU");
  if (!input.hasQuantity) reasons.push("Missing quantity");
  if (!input.fulfillmentPolicyId) reasons.push("Missing shipping policy");
  else if (input.fulfillmentPolicyStale) reasons.push("Shipping policy is no longer available — choose another");
  if (!input.returnPolicyId) reasons.push("Missing return policy");
  else if (input.returnPolicyStale) reasons.push("Return policy is no longer available — choose another");
  if (!input.paymentPolicyId) reasons.push("Missing payment policy");
  else if (input.paymentPolicyStale) reasons.push("Payment policy is no longer available — choose another");
  if (!input.merchantLocationKey) reasons.push("Missing inventory location");

  return { eligible: reasons.length === 0, reasons };
}
