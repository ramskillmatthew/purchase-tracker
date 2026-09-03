import { describe, expect, it } from "vitest";
import { partitionAspectsForReview, aspectNeedsReview } from "@/lib/listing-studio/ebay-aspect-review-grouping";
import type { GroupedAspect, GroupedAspects } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { MarketplaceAspectValue, MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

function aspect(name: string, usage: GroupedAspect["usage"]): GroupedAspect {
  return { name, usage, mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: null, allowedValues: ["A", "B"] };
}
function value(overrides: Partial<MarketplaceAspectValue>): MarketplaceAspectValue {
  return { value: "A", confidence: "medium", source: "product_facts_heuristic", appliedAutomatically: true, needsReview: false, userConfirmed: false, updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

const groups: GroupedAspects = {
  required: [aspect("Brand", "REQUIRED"), aspect("Department", "REQUIRED")],
  recommended: [aspect("Performance/Activity", "RECOMMENDED"), aspect("Upper Material", "RECOMMENDED")],
  optional: [aspect("Pattern", "OPTIONAL"), aspect("Season", "OPTIONAL")],
};

describe("aspectNeedsReview", () => {
  it("true only when needsReview and not yet userConfirmed", () => {
    expect(aspectNeedsReview(value({ needsReview: true, userConfirmed: false }))).toBe(true);
    expect(aspectNeedsReview(value({ needsReview: true, userConfirmed: true }))).toBe(false);
    expect(aspectNeedsReview(value({ needsReview: false }))).toBe(false);
    expect(aspectNeedsReview(undefined)).toBe(false);
  });
});

describe("partitionAspectsForReview", () => {
  it("1/2/20. a review-flagged OPTIONAL aspect is pulled into `needsReview` and removed from `optional` (never hidden behind the collapse)", () => {
    const dynamicData: MarketplaceDynamicData = { Pattern: value({ needsReview: true }) };
    const partition = partitionAspectsForReview(groups, dynamicData);
    expect(partition.needsReview.map(a => a.name)).toEqual(["Pattern"]);
    expect(partition.optional.map(a => a.name)).toEqual(["Season"]); // Pattern removed
  });

  it("2/20. the exact screenshot case — a review-flagged RECOMMENDED Performance/Activity moves into `needsReview`", () => {
    const dynamicData: MarketplaceDynamicData = { "Performance/Activity": value({ value: "Running", needsReview: true }) };
    const partition = partitionAspectsForReview(groups, dynamicData);
    expect(partition.needsReview.map(a => a.name)).toEqual(["Performance/Activity"]);
    expect(partition.recommended.map(a => a.name)).toEqual(["Upper Material"]);
  });

  it("orders `needsReview` Required → Recommended → Optional (most important first)", () => {
    const dynamicData: MarketplaceDynamicData = {
      Season: value({ needsReview: true }), Department: value({ needsReview: true }), "Performance/Activity": value({ needsReview: true }),
    };
    expect(partitionAspectsForReview(groups, dynamicData).needsReview.map(a => a.name)).toEqual(["Department", "Performance/Activity", "Season"]);
  });

  it("8. a resolved (userConfirmed) aspect is NOT in `needsReview` — it stays in its normal group", () => {
    const dynamicData: MarketplaceDynamicData = { "Performance/Activity": value({ value: "Running", needsReview: true, userConfirmed: true }) };
    const partition = partitionAspectsForReview(groups, dynamicData);
    expect(partition.needsReview).toEqual([]);
    expect(partition.recommended.map(a => a.name)).toEqual(["Performance/Activity", "Upper Material"]);
  });

  it("8. a high-confidence no-review value is NOT in `needsReview`", () => {
    const dynamicData: MarketplaceDynamicData = { "Performance/Activity": value({ value: "Running & Jogging", confidence: "high", needsReview: false }) };
    expect(partitionAspectsForReview(groups, dynamicData).needsReview).toEqual([]);
  });

  it("18. nothing flagged → every group unchanged, `needsReview` empty (missing optionals stay non-blocking, not 'review')", () => {
    const partition = partitionAspectsForReview(groups, {});
    expect(partition.needsReview).toEqual([]);
    expect(partition.required.map(a => a.name)).toEqual(["Brand", "Department"]);
    expect(partition.recommended.map(a => a.name)).toEqual(["Performance/Activity", "Upper Material"]);
    expect(partition.optional.map(a => a.name)).toEqual(["Pattern", "Season"]);
  });

  it("null dynamicData is safe", () => {
    expect(partitionAspectsForReview(groups, null).needsReview).toEqual([]);
  });
});
