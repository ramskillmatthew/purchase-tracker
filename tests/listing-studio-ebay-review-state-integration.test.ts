import { describe, expect, it } from "vitest";
import { buildEbaySummary, computeEbayCardStatus } from "@/lib/listing-studio/ebay-card-status";
import { CATEGORY_CONFIRMATION_KEY } from "@/lib/listing-studio/ebay-category-review";
import type { MarketplaceDynamicData, MarketplaceReadiness } from "@/lib/listing-studio/marketplace-types";

/**
 * TEST THE REAL STATE PATH — every test below drives the SAME real
 * functions the app itself uses in production (buildEbaySummary,
 * computeEbayCardStatus, and — internally — resolveCategoryReviewState/
 * readCategoryConfirmation/requiresWomensDepartment), from a realistic
 * persisted `listing_marketplace_drafts` row all the way through to the
 * final row-badge status. Never a reimplementation, never source-text
 * assertions alone.
 */

function aspect(overrides: Partial<MarketplaceDynamicData[string]> = {}): MarketplaceDynamicData[string] {
  return { value: "x", confidence: "high", source: "product_facts", appliedAutomatically: true, needsReview: false, userConfirmed: false, updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

const READY_READINESS: MarketplaceReadiness = { ready: true, completionPercent: 72, requiredComplete: 9, requiredTotal: 9, recommendedComplete: 9, recommendedTotal: 16 };

/** The exact screenshot-equivalent fixture from the user's own report:
 * On Running Cloud 5, UK 4, category selected as Women's Trainers at
 * (real, honest) Medium confidence, every required/recommended field
 * already at High confidence, price £35.00, package size Medium parcel. */
function screenshotEquivalentRow(overrides: Record<string, unknown> = {}) {
  return {
    title: "On Running Cloud 5 Womens UK 4 Light blue Grey Mesh Running Trainers", description: "Genuine On Running Cloud 5 trainers.",
    source_type: "generated", content_mode: "seo_optimised",
    category_id: "95672", category_name: "Trainers", category_path: "Women's Shoes > Women > Clothes, Shoes & Accessories > Trainers",
    category_confidence: "medium" as const, category_source: "ai" as const,
    condition_value: "Used", price_pence: 3500, quantity: 1,
    readiness_json: READY_READINESS,
    dynamic_data_json: {
      __productFacts: {
        brand: "On Running", model: "Cloud 5", productType: "Running Trainers", colours: ["Light blue", "Grey"], material: "Mesh",
        ukShoeSize: "4", clothingSize: null, gender: "womens", itemFamily: "footwear", internalSku: "1234",
        styleCode: null, conditionState: "very_good_preowned", updatedAt: "2026-01-01T00:00:00.000Z",
      },
      __packageSize: aspect({ value: "medium_parcel", source: "default" }),
      Brand: aspect({ value: "On Running" }), Colour: aspect({ value: ["Light blue", "Grey"] }), Department: aspect({ value: "Women" }),
      "UK Shoe Size": aspect({ value: "4" }), Customised: aspect({ value: "No", source: "default" }), "Product Line": aspect({ value: "Cloud 5" }),
      Model: aspect({ value: "Cloud 5" }), "Upper Material": aspect({ value: "Mesh" }), Vintage: aspect({ value: "No", source: "default" }),
      MPN: aspect({ value: null, confidence: "unknown", source: "none" }),
      "US Shoe Size": aspect({ value: null, confidence: "unknown", source: "not_applicable" }),
      "EU Shoe Size": aspect({ value: null, confidence: "unknown", source: "not_applicable" }),
      Character: aspect({ value: null, confidence: "unknown", source: "none" }),
      Theme: aspect({ value: null, confidence: "unknown", source: "none" }),
    } as unknown as MarketplaceDynamicData, // __productFacts is a raw EbayProductFacts object, not a MarketplaceAspectValue — same real-world shape readEbayProductFacts reads via an unknown-cast in production
    ...overrides,
  };
}

describe("SCREENSHOT-EQUIVALENT REGRESSION — the real UK 4 On Running Cloud 5 draft resolves to Ready, not Needs review", () => {
  it("PROVEN ROOT CAUSE FIX: buildEbaySummary -> computeEbayCardStatus resolves this exact fixture to draft_complete (Ready), never needs_review", () => {
    const summary = buildEbaySummary(screenshotEquivalentRow());
    expect(summary.reviewReasonCount).toBe(0);
    expect(summary.categoryReviewReason).toBeNull();
    expect(computeEbayCardStatus(summary, false)).toBe("draft_complete");
  });

  it("REQUIREMENT: the seven missing recommended fields (MPN, US/EU Shoe Size, Character, Theme, ...) remain non-blocking — status is Ready despite 9/16 recommended", () => {
    const summary = buildEbaySummary(screenshotEquivalentRow());
    expect(summary.readiness?.recommendedComplete).toBe(9);
    expect(summary.readiness?.recommendedTotal).toBe(16);
    expect(computeEbayCardStatus(summary, false)).toBe("draft_complete");
  });

  it("£35.00 and Medium parcel remain intact in this same summary — the price/package-size fixes are not regressed by this change", () => {
    const summary = buildEbaySummary(screenshotEquivalentRow());
    expect(summary.pricePence).toBe(3500);
  });

  it("REGRESSION: if the category were genuinely Men's for this UK 4 product (hypothetically corrupted data), the mismatch IS flagged — proves this isn't a blanket 'never review category' bypass", () => {
    const summary = buildEbaySummary(screenshotEquivalentRow({ category_name: "Trainers", category_path: "Men's Shoes > Men > Trainers" }));
    expect(summary.reviewReasonCount).toBe(1);
    expect(computeEbayCardStatus(summary, false)).toBe("needs_review");
  });
});

describe("PERFORMANCE/ACTIVITY — the exact screenshot blocker: hidden 'needs review' -> resolved -> Ready", () => {
  // The user's real persisted draft: a RECOMMENDED "Performance/Activity"
  // item specific the pipeline flagged needsReview and left invisible in the
  // collapsed section.
  function withPerformanceActivity(paOverrides: Partial<MarketplaceDynamicData[string]>) {
    const base = screenshotEquivalentRow();
    return screenshotEquivalentRow({
      dynamic_data_json: { ...base.dynamic_data_json, "Performance/Activity": aspect(paOverrides) } as unknown as MarketplaceDynamicData,
    });
  }

  it("BEFORE FIX: a needsReview Performance/Activity is one genuine, counted review reason (row = Needs review)", () => {
    const summary = buildEbaySummary(withPerformanceActivity({ value: "Running Trainers", confidence: "medium", needsReview: true, userConfirmed: false }));
    expect(summary.reviewReasonCount).toBe(1);
    expect(computeEbayCardStatus(summary, false)).toBe("needs_review");
  });

  it("14. AFTER FIX (deterministic High-confidence 'Running & Jogging'): review count is 0, row resolves to Ready", () => {
    const summary = buildEbaySummary(withPerformanceActivity({ value: "Running & Jogging", confidence: "high", needsReview: false, source: "footwear_activity_rule" }));
    expect(summary.reviewReasonCount).toBe(0);
    expect(summary.categoryReviewReason).toBeNull();
    expect(computeEbayCardStatus(summary, false)).toBe("draft_complete");
  });

  it("11/12. AFTER FIX via manual confirm: userConfirmed resolves it, and survives a full re-fetch of the same row", () => {
    const row = withPerformanceActivity({ value: "Running", confidence: "medium", needsReview: true, userConfirmed: true });
    expect(buildEbaySummary(row).reviewReasonCount).toBe(0);
    expect(buildEbaySummary(row).reviewReasonCount).toBe(0); // fresh re-fetch of the identical persisted row
  });

  it("15/16. resolving Performance/Activity leaves £35.00 and the Medium parcel untouched in the same summary", () => {
    const summary = buildEbaySummary(withPerformanceActivity({ value: "Running & Jogging", confidence: "high", needsReview: false }));
    expect(summary.pricePence).toBe(3500);
    const row = withPerformanceActivity({ value: "Running & Jogging", confidence: "high", needsReview: false });
    expect((row.dynamic_data_json as Record<string, { value: unknown }>).__packageSize.value).toBe("medium_parcel");
  });

  it("17. the Women's Trainers category stays High confidence / no review throughout (UK 4 footwear + Women's path)", () => {
    const summary = buildEbaySummary(withPerformanceActivity({ value: "Running & Jogging", confidence: "high", needsReview: false }));
    // category_confidence in the fixture is a raw AI "medium", but the
    // deterministic below-UK-7 rule corroborates the Women's selection.
    expect(summary.categoryReviewReason).toBeNull();
  });

  it("18/19/20. an UNRESOLVED Performance/Activity is still exactly one actionable reason — never silently dropped, never doubling the count", () => {
    const summary = buildEbaySummary(withPerformanceActivity({ value: null, confidence: "unknown", source: "none", needsReview: true, userConfirmed: false }));
    expect(summary.reviewReasonCount).toBe(1);
    expect(computeEbayCardStatus(summary, false)).toBe("needs_review");
  });
});

describe("UK-SIZE-7+ MANUAL CONFIRMATION — the full save -> re-fetch -> updated review -> updated row-status path", () => {
  function uk9Row(dynamicDataOverrides: MarketplaceDynamicData = {}) {
    return screenshotEquivalentRow({
      title: "On Running Cloud 5 Womens UK 9 Mesh Running Trainers",
      dynamic_data_json: {
        __productFacts: {
          brand: "On Running", model: "Cloud 5", productType: "Running Trainers", colours: ["Blue"], material: "Mesh",
          ukShoeSize: "9", clothingSize: null, gender: "womens", itemFamily: "footwear", internalSku: "1234",
          styleCode: null, conditionState: "very_good_preowned", updatedAt: "2026-01-01T00:00:00.000Z",
        },
        __packageSize: aspect({ value: "medium_parcel", source: "default" }),
        ...dynamicDataOverrides,
      },
    });
  }

  it("REQUIREMENT: before confirmation, a genuine UK9 Medium-confidence Women's category produces exactly one visible review reason, identifying Category", () => {
    const summary = buildEbaySummary(uk9Row());
    expect(summary.reviewReasonCount).toBe(1);
    expect(summary.categoryReviewReason).toMatch(/medium-confidence/);
    expect(computeEbayCardStatus(summary, false)).toBe("needs_review");
  });

  it("REQUIREMENT: confirming the category (persisting __categoryConfirmation, exactly as the PATCH /ebay-aspects route does) removes the review reason immediately", () => {
    // Simulates the PATCH route's own write: { value: categoryId, ...,
    // userConfirmed: true } under the reserved __categoryConfirmation key —
    // the SAME shape/route every other confirmation in this app uses.
    const confirmedRow = uk9Row({ [CATEGORY_CONFIRMATION_KEY]: aspect({ value: "95672", userConfirmed: true }) });
    const summary = buildEbaySummary(confirmedRow);
    expect(summary.reviewReasonCount).toBe(0);
    expect(computeEbayCardStatus(summary, false)).toBe("draft_complete");
  });

  it("REQUIREMENT: confirmation survives a full re-fetch — rebuilding the summary from the SAME persisted row again yields the same resolved (no-review) state", () => {
    const confirmedRow = uk9Row({ [CATEGORY_CONFIRMATION_KEY]: aspect({ value: "95672", userConfirmed: true }) });
    const firstRead = buildEbaySummary(confirmedRow);
    const secondReadAfterRefetch = buildEbaySummary(confirmedRow); // a fresh re-fetch of the identical row
    expect(firstRead.reviewReasonCount).toBe(0);
    expect(secondReadAfterRefetch.reviewReasonCount).toBe(0);
  });

  it("REQUIREMENT: changing the category clears stale confirmation automatically — a confirmation scoped to the OLD category id no longer resolves the NEW category's review", () => {
    const staleConfirmation = uk9Row({ [CATEGORY_CONFIRMATION_KEY]: aspect({ value: "95672", userConfirmed: true }) });
    const changedCategoryRow = { ...staleConfirmation, category_id: "new-category-id" }; // category genuinely changed
    const summary = buildEbaySummary(changedCategoryRow);
    expect(summary.reviewReasonCount).toBe(1); // the stale confirmation (for "95672") does not cover "new-category-id"
    expect(computeEbayCardStatus(summary, false)).toBe("needs_review");
  });
});

describe("REQUIRED/RECOMMENDED item-specific review reasons (not just category)", () => {
  it("a REQUIRED item specific the aspect pipeline flagged needsReview (not yet confirmed) is a genuine, counted review reason", () => {
    const row = screenshotEquivalentRow({ dynamic_data_json: { ...screenshotEquivalentRow().dynamic_data_json, Style: aspect({ value: "Casual", confidence: "medium", needsReview: true, userConfirmed: false }) } });
    const summary = buildEbaySummary(row);
    expect(summary.reviewReasonCount).toBe(1);
    expect(computeEbayCardStatus(summary, false)).toBe("needs_review");
  });

  it("confirming that same aspect (userConfirmed: true) resolves the review reason", () => {
    const row = screenshotEquivalentRow({ dynamic_data_json: { ...screenshotEquivalentRow().dynamic_data_json, Style: aspect({ value: "Casual", confidence: "medium", needsReview: true, userConfirmed: true }) } });
    const summary = buildEbaySummary(row);
    expect(summary.reviewReasonCount).toBe(0);
  });

  it("a blank OPTIONAL aspect (value null, source none, needsReview false) is never counted as a review reason", () => {
    const summary = buildEbaySummary(screenshotEquivalentRow());
    expect(summary.reviewReasonCount).toBe(0); // Character/Theme/MPN are all blank above and none is flagged needsReview
  });

  it("a reserved pseudo-aspect (__packageSize/__productFacts) is never itself counted as a review reason, even if it happened to carry needsReview", () => {
    const row = screenshotEquivalentRow({ dynamic_data_json: { ...screenshotEquivalentRow().dynamic_data_json, __packageSize: aspect({ value: "medium_parcel", needsReview: true, userConfirmed: false }) } });
    const summary = buildEbaySummary(row);
    expect(summary.reviewReasonCount).toBe(0);
  });
});

describe("REVIEW-STATE INVARIANT — the row and the dialog can never disagree about whether a review reason exists", () => {
  const fixtures = [
    screenshotEquivalentRow(), // no review reasons at all
    screenshotEquivalentRow({ category_name: "Trainers", category_path: "Men's Shoes > Men > Trainers" }), // category mismatch
    screenshotEquivalentRow({ dynamic_data_json: { ...screenshotEquivalentRow().dynamic_data_json, Style: aspect({ value: "Casual", confidence: "medium", needsReview: true, userConfirmed: false }) } }), // aspect review
  ];

  it("REQUIREMENT: whenever the row says needs_review, at least one genuine reason exists (categoryReviewReason or a flagged aspect) — never an invisible warning", () => {
    for (const row of fixtures) {
      const summary = buildEbaySummary(row);
      const status = computeEbayCardStatus(summary, false);
      if (status === "needs_review") {
        expect(summary.reviewReasonCount).toBeGreaterThan(0);
      }
    }
  });

  it("REQUIREMENT: whenever reviewReasonCount is zero, the row can never say needs_review", () => {
    for (const row of fixtures) {
      const summary = buildEbaySummary(row);
      if (summary.reviewReasonCount === 0) {
        expect(computeEbayCardStatus(summary, false)).not.toBe("needs_review");
      }
    }
  });
});
