import { describe, expect, it } from "vitest";
import { resolveCategoryReviewState, readCategoryConfirmation, CATEGORY_CONFIRMATION_KEY } from "@/lib/listing-studio/ebay-category-review";

function baseParams(overrides: Partial<Parameters<typeof resolveCategoryReviewState>[0]> = {}): Parameters<typeof resolveCategoryReviewState>[0] {
  return {
    categoryId: "95672", categoryName: "Trainers", categoryPath: "Women's Shoes > Women > Clothes, Shoes & Accessories > Trainers",
    categoryConfidence: "medium", categorySource: "ai", itemFamily: "footwear", ukShoeSize: "4", confirmedForCategoryId: null,
    ...overrides,
  };
}

describe("resolveCategoryReviewState — the ONE shared source of truth the row badge and the dialog's review summary both read from", () => {
  it("SCREENSHOT REGRESSION: UK size 4, Medium-confidence Women's category — High effective confidence, no review, deterministic-rule provenance", () => {
    const result = resolveCategoryReviewState(baseParams());
    expect(result).toEqual({ effectiveConfidence: "high", needsReview: false, reason: null, provenance: "footwear_size_rule" });
  });

  it("REQUIREMENT: the deterministic rule never mutates the raw confidence into a false 'AI got more confident' claim — this is asserted by the caller persisting categoryConfidence untouched (see ebay-category-automation.test.ts); this function's own effectiveConfidence is what display/readiness use instead", () => {
    const result = resolveCategoryReviewState(baseParams({ categoryConfidence: "low" }));
    expect(result.effectiveConfidence).toBe("high");
    expect(result.needsReview).toBe(false);
  });

  it("SAFETY NET: a footwear size below UK 7 whose selected category is NOT Women's is a genuine, visible review reason — never silently accepted", () => {
    const result = resolveCategoryReviewState(baseParams({ categoryName: "Trainers", categoryPath: "Men's Shoes > Men > Trainers" }));
    expect(result.needsReview).toBe(true);
    expect(result.provenance).toBe("footwear_size_rule_mismatch");
    expect(result.reason).toMatch(/Women's category/);
  });

  it("REQUIREMENT: UK size 7+ does not use the deterministic rule — falls through to ordinary confidence-based review", () => {
    const result = resolveCategoryReviewState(baseParams({ ukShoeSize: "7" }));
    expect(result.needsReview).toBe(true);
    expect(result.provenance).toBe("ai_suggestion");
    expect(result.reason).toMatch(/medium-confidence/);
  });

  it("a High-confidence category (no footwear rule involved) never needs review", () => {
    const result = resolveCategoryReviewState(baseParams({ ukShoeSize: "9", categoryConfidence: "high" }));
    expect(result.needsReview).toBe(false);
  });

  it("REQUIREMENT: a manual category selection is always trusted outright, regardless of size", () => {
    const result = resolveCategoryReviewState(baseParams({ ukShoeSize: "9", categorySource: "manual", categoryConfidence: null }));
    expect(result).toEqual({ effectiveConfidence: "high", needsReview: false, reason: null, provenance: "manual" });
  });

  it("REQUIREMENT: a genuine UK-7+ Medium-confidence category resolves once the user confirms it — Confidence and confirmation stay separate concepts (confidence is NOT mutated to High)", () => {
    const result = resolveCategoryReviewState(baseParams({ ukShoeSize: "9", categoryConfidence: "medium", confirmedForCategoryId: "95672" }));
    expect(result.needsReview).toBe(false);
    expect(result.effectiveConfidence).toBe("medium"); // never silently promoted to high
    expect(result.provenance).toBe("user_confirmed");
  });

  it("REQUIREMENT: a confirmation for a DIFFERENT category id (stale, from before a category change) is ignored", () => {
    const result = resolveCategoryReviewState(baseParams({ ukShoeSize: "9", categoryConfidence: "medium", confirmedForCategoryId: "some-other-category" }));
    expect(result.needsReview).toBe(true);
  });

  it("no category selected at all is not itself a review state (that's needs_category territory, a different precedence tier)", () => {
    expect(resolveCategoryReviewState(baseParams({ categoryId: null })).needsReview).toBe(false);
  });
});

describe("readCategoryConfirmation — reading the __categoryConfirmation reserved pseudo-aspect", () => {
  it("returns the confirmed category id when userConfirmed is true", () => {
    expect(readCategoryConfirmation({ [CATEGORY_CONFIRMATION_KEY]: { value: "95672", confidence: "high", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: true, updatedAt: "x" } })).toBe("95672");
  });
  it("returns null when never confirmed", () => {
    expect(readCategoryConfirmation({})).toBeNull();
    expect(readCategoryConfirmation(null)).toBeNull();
    expect(readCategoryConfirmation(undefined)).toBeNull();
  });
  it("returns null for a malformed/unconfirmed entry, never throws", () => {
    expect(readCategoryConfirmation({ [CATEGORY_CONFIRMATION_KEY]: { value: "95672", confidence: "high", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "x" } })).toBeNull();
  });
});
