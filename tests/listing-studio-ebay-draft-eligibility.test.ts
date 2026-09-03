import { describe, expect, it } from "vitest";
import { evaluateEbayDraftEligibility, type EbayDraftEligibilityInput } from "@/lib/listing-studio/ebay-draft-eligibility";

function fullyEligibleInput(overrides: Partial<EbayDraftEligibilityInput> = {}): EbayDraftEligibilityInput {
  return {
    hasEbayPreparation: true, accountUsable: true, alreadyHasOffer: false, contentReady: true, hasValidPrice: true,
    hasPhoto: true, hasSku: true, hasQuantity: true,
    fulfillmentPolicyId: "FUL-1", fulfillmentPolicyStale: false,
    returnPolicyId: "RET-1", returnPolicyStale: false,
    paymentPolicyId: "PAY-1", paymentPolicyStale: false,
    merchantLocationKey: "LOC-1",
    ...overrides,
  };
}

describe("evaluateEbayDraftEligibility", () => {
  it("eligible once every requirement is satisfied", () => {
    const result = evaluateEbayDraftEligibility(fullyEligibleInput());
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("no eBay preparation at all — a single specific reason, nothing else evaluated", () => {
    const result = evaluateEbayDraftEligibility(fullyEligibleInput({ hasEbayPreparation: false, hasValidPrice: false }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["No eBay preparation for this listing"]);
  });

  it("an existing offer excludes the listing outright — never re-drafted accidentally", () => {
    const result = evaluateEbayDraftEligibility(fullyEligibleInput({ alreadyHasOffer: true }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["An eBay draft already exists for this listing"]);
  });

  it("Stage 6: eBay content can be Ready without a price, but Create eBay drafts still requires one", () => {
    const result = evaluateEbayDraftEligibility(fullyEligibleInput({ hasValidPrice: false }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["Missing eBay selling price"]);
  });

  it("missing shipping policy is reported distinctly from a stale one", () => {
    expect(evaluateEbayDraftEligibility(fullyEligibleInput({ fulfillmentPolicyId: null })).reasons).toContain("Missing shipping policy");
    expect(evaluateEbayDraftEligibility(fullyEligibleInput({ fulfillmentPolicyStale: true })).reasons).toContain("Shipping policy is no longer available — choose another");
  });

  it("a stale return/payment policy each blocks independently", () => {
    expect(evaluateEbayDraftEligibility(fullyEligibleInput({ returnPolicyStale: true })).eligible).toBe(false);
    expect(evaluateEbayDraftEligibility(fullyEligibleInput({ paymentPolicyStale: true })).eligible).toBe(false);
  });

  it("missing inventory location blocks eligibility with a specific reason", () => {
    const result = evaluateEbayDraftEligibility(fullyEligibleInput({ merchantLocationKey: null }));
    expect(result.reasons).toContain("Missing inventory location");
  });

  it("collects every distinct missing requirement at once, not just the first", () => {
    const result = evaluateEbayDraftEligibility(fullyEligibleInput({ hasValidPrice: false, hasPhoto: false, fulfillmentPolicyId: null }));
    expect(result.reasons).toEqual(expect.arrayContaining(["Missing eBay selling price", "No uploaded photos", "Missing shipping policy"]));
    expect(result.reasons.length).toBe(3);
  });

  it("an unconnected/needs-reconnect account blocks eligibility", () => {
    const result = evaluateEbayDraftEligibility(fullyEligibleInput({ accountUsable: false }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("eBay account is not connected");
  });
});
