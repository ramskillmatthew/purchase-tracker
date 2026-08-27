import { describe, expect, it } from "vitest";
import { applyAutomationMode } from "@/lib/listing-studio/ebay-aspect-automation";
import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { MarketplaceAspectValue } from "@/lib/listing-studio/marketplace-types";

const aspect: GroupedAspect = { name: "Game", usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: null, allowedValues: ["Pokémon TCG"] };

function value(overrides: Partial<MarketplaceAspectValue> = {}): MarketplaceAspectValue {
  return { value: "Pokémon TCG", confidence: "high", source: "shared_facts", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "", ...overrides };
}

describe("applyAutomationMode", () => {
  it("REQUIREMENT: high confidence is applied automatically in Fast and Balanced", () => {
    expect(applyAutomationMode(aspect, value({ confidence: "high" }), "fast")).toMatchObject({ appliedAutomatically: true, needsReview: false });
    expect(applyAutomationMode(aspect, value({ confidence: "high" }), "balanced")).toMatchObject({ appliedAutomatically: true, needsReview: false });
  });

  it("REQUIREMENT: medium confidence is applied with a review marker in both Fast and Balanced", () => {
    expect(applyAutomationMode(aspect, value({ confidence: "medium" }), "fast")).toMatchObject({ appliedAutomatically: true, needsReview: true });
    expect(applyAutomationMode(aspect, value({ confidence: "medium" }), "balanced")).toMatchObject({ appliedAutomatically: true, needsReview: true });
  });

  it("REQUIREMENT: low confidence is never auto-applied in Fast or Balanced, and always needs review", () => {
    expect(applyAutomationMode(aspect, value({ confidence: "low" }), "fast")).toMatchObject({ appliedAutomatically: false, needsReview: true });
    expect(applyAutomationMode(aspect, value({ confidence: "low" }), "balanced")).toMatchObject({ appliedAutomatically: false, needsReview: true });
  });

  it("REQUIREMENT (Strict mode): even a high-confidence value is never silently treated as approved", () => {
    expect(applyAutomationMode(aspect, value({ confidence: "high" }), "strict")).toMatchObject({ appliedAutomatically: false, needsReview: true });
  });

  it("Strict mode still surfaces the suggested value itself — never withheld, only unapproved", () => {
    const result = applyAutomationMode(aspect, value({ confidence: "high" }), "strict");
    expect(result.value).toBe("Pokémon TCG");
  });

  it("REQUIREMENT: unknown/no value is never applied in any mode", () => {
    const unknown = value({ value: null, confidence: "unknown" });
    for (const mode of ["fast", "balanced", "strict"] as const) {
      expect(applyAutomationMode(aspect, unknown, mode)).toMatchObject({ appliedAutomatically: false });
    }
  });

  it("an unknown REQUIRED aspect is flagged for review (a blocking gap), an unknown OPTIONAL one is not", () => {
    const unknown = value({ value: null, confidence: "unknown" });
    const optional: GroupedAspect = { ...aspect, usage: "OPTIONAL" };
    expect(applyAutomationMode(aspect, unknown, "balanced").needsReview).toBe(true);
    expect(applyAutomationMode(optional, unknown, "balanced").needsReview).toBe(false);
  });

  it("never mutates the value or confidence — only the automation flags", () => {
    const input = value({ confidence: "medium", value: "Pokémon TCG" });
    const result = applyAutomationMode(aspect, input, "fast");
    expect(result.value).toBe(input.value);
    expect(result.confidence).toBe(input.confidence);
  });
});
