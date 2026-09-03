import { describe, expect, it } from "vitest";
import { computeEbayCardStatus, EBAY_CARD_STATUS_LABELS, EBAY_CARD_STATUS_TONES, type EbaySummary } from "@/lib/listing-studio/ebay-card-status";

function summary(overrides: Partial<EbaySummary> = {}): EbaySummary {
  return {
    contentState: "generated", title: "Nike Pegasus 40 Mens UK 9 Black Trainers", description: "Genuine Nike Pegasus 40 trainers.",
    categoryId: "183454", conditionValue: "New", pricePence: 2999, quantity: 1,
    readiness: { ready: true, completionPercent: 100, requiredComplete: 9, requiredTotal: 9, recommendedComplete: 0, recommendedTotal: 0 },
    reviewReasonCount: 0, categoryReviewReason: null,
    ...overrides,
  };
}

describe("computeEbayCardStatus — Phase 6/13: marketplace-specific eBay status, never Ready for fallback", () => {
  it("REGRESSION (the exact reported bug): a FALLBACK draft is 'generation_failed', never 'draft_complete'/Ready, regardless of other fields", () => {
    const status = computeEbayCardStatus(summary({ contentState: "fallback", categoryId: null, conditionValue: null, pricePence: null }), false);
    expect(status).toBe("generation_failed");
    expect(EBAY_CARD_STATUS_LABELS[status]).toBe("Generation failed");
    expect(EBAY_CARD_STATUS_TONES[status]).toBe("danger");
  });

  it("a FAILED draft (no usable fallback) is also generation_failed", () => {
    expect(computeEbayCardStatus(summary({ contentState: "failed" }), false)).toBe("generation_failed");
  });

  it("no eBay draft at all is not_generated", () => {
    expect(computeEbayCardStatus(null, false)).toBe("not_generated");
  });

  it("isGenerating always wins, even over a stored failure state", () => {
    expect(computeEbayCardStatus(summary({ contentState: "fallback" }), true)).toBe("generating");
  });

  it("REQUIREMENT: content genuinely generated but category missing is needs_category, never Ready", () => {
    expect(computeEbayCardStatus(summary({ categoryId: null }), false)).toBe("needs_category");
  });

  it("REQUIREMENT: category set, condition missing is needs_condition", () => {
    expect(computeEbayCardStatus(summary({ conditionValue: null }), false)).toBe("needs_condition");
  });

  it("REQUIREMENT: category and condition set, price missing is needs_price", () => {
    expect(computeEbayCardStatus(summary({ pricePence: null }), false)).toBe("needs_price");
  });

  it("REQUIREMENT: everything required present is draft_complete (never bare 'Ready')", () => {
    const status = computeEbayCardStatus(summary(), false);
    expect(status).toBe("draft_complete");
    expect(EBAY_CARD_STATUS_LABELS[status]).toBe("Draft details complete");
    expect(EBAY_CARD_STATUS_TONES[status]).toBe("success");
  });

  it("content generated, all core fields set, but readiness still not ready due to missing required aspects is needs_details", () => {
    const status = computeEbayCardStatus(summary({ readiness: { ready: false, completionPercent: 80, requiredComplete: 8, requiredTotal: 9, recommendedComplete: 0, recommendedTotal: 0 } }), false);
    expect(status).toBe("needs_details");
  });

  // PROVEN ROOT CAUSE FIX (the exact reported "Needs review with zero
  // visible reason" bug): missing/blank RECOMMENDED aspects alone must
  // NEVER produce needs_review — this replaces the old, wrong assumption
  // (readiness.recommendedTotal > readiness.recommendedComplete) that
  // caused the screenshot's "9/16 recommended" to read as "Needs review"
  // with nothing anywhere explaining what supposedly needed review.
  it("REQUIREMENT (PROVEN ROOT CAUSE FIX): required complete but recommended aspects still missing/blank is draft_complete, never needs_review, when there is no genuine review reason", () => {
    const status = computeEbayCardStatus(summary({
      readiness: { ready: true, completionPercent: 56, requiredComplete: 9, requiredTotal: 9, recommendedComplete: 9, recommendedTotal: 16 },
      reviewReasonCount: 0,
    }), false);
    expect(status).toBe("draft_complete");
  });

  it("REQUIREMENT: a genuine review reason (e.g. an unresolved category confirmation) DOES produce needs_review", () => {
    const status = computeEbayCardStatus(summary({ reviewReasonCount: 1, categoryReviewReason: "The suggested eBay category is a medium-confidence match — confirm it or choose a different one." }), false);
    expect(status).toBe("needs_review");
  });

  it("blank optional fields alone (reviewReasonCount 0) never produce needs_review even when many recommended fields are also blank", () => {
    const status = computeEbayCardStatus(summary({
      readiness: { ready: true, completionPercent: 30, requiredComplete: 9, requiredTotal: 9, recommendedComplete: 0, recommendedTotal: 18 },
      reviewReasonCount: 0,
    }), false);
    expect(status).toBe("draft_complete");
  });
});
