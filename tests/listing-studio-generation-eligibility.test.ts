import { describe, expect, it } from "vitest";
import { isEligibleForGeneration, type EligibilityDraft } from "@/lib/listing-studio/generation-eligibility";

function draft(overrides: Partial<EligibilityDraft> = {}): EligibilityDraft {
  return { id: "d1", title: "On Running Cloud 5", generatedTitle: null, ebayGenerated: false, hasPhoto: true, ...overrides };
}

describe("isEligibleForGeneration — real behavioural test (not source-text matching)", () => {
  it("REGRESSION (the exact reported bug): a product with a Vinted draft already generated, but no eBay draft, IS eligible when eBay UK is the target", () => {
    const alreadyVinted = draft({ generatedTitle: "On Running Cloud 5 Trainers", ebayGenerated: false });
    expect(isEligibleForGeneration(alreadyVinted, ["EBAY_UK"])).toBe(true);
  });

  it("the SAME product is NOT eligible when Vinted alone is the target — Vinted is already done, nothing to generate", () => {
    const alreadyVinted = draft({ generatedTitle: "On Running Cloud 5 Trainers", ebayGenerated: false });
    expect(isEligibleForGeneration(alreadyVinted, ["VINTED"])).toBe(false);
  });

  it("a product with BOTH Vinted and eBay already generated is not eligible for either target", () => {
    const fullyDone = draft({ generatedTitle: "x", ebayGenerated: true });
    expect(isEligibleForGeneration(fullyDone, ["VINTED"])).toBe(false);
    expect(isEligibleForGeneration(fullyDone, ["EBAY_UK"])).toBe(false);
    expect(isEligibleForGeneration(fullyDone, ["VINTED", "EBAY_UK"])).toBe(false);
  });

  it("a brand new product (neither marketplace generated yet) is eligible for Vinted, eBay UK, or Both", () => {
    const fresh = draft({ generatedTitle: null, ebayGenerated: false });
    expect(isEligibleForGeneration(fresh, ["VINTED"])).toBe(true);
    expect(isEligibleForGeneration(fresh, ["EBAY_UK"])).toBe(true);
    expect(isEligibleForGeneration(fresh, ["VINTED", "EBAY_UK"])).toBe(true);
  });

  it("Both target: eligible if EITHER marketplace still needs generating, even if the other is already done", () => {
    const vintedOnlyDone = draft({ generatedTitle: "x", ebayGenerated: false });
    expect(isEligibleForGeneration(vintedOnlyDone, ["VINTED", "EBAY_UK"])).toBe(true);
    const ebayOnlyDone = draft({ generatedTitle: null, ebayGenerated: true });
    expect(isEligibleForGeneration(ebayOnlyDone, ["VINTED", "EBAY_UK"])).toBe(true);
  });

  it("REGRESSION: the Unsorted group is never eligible, regardless of target or generation state", () => {
    expect(isEligibleForGeneration(draft({ title: "Unsorted", generatedTitle: null, ebayGenerated: false }), ["VINTED", "EBAY_UK"])).toBe(false);
  });

  it("REGRESSION: a group with zero photos is never eligible, regardless of target", () => {
    expect(isEligibleForGeneration(draft({ hasPhoto: false }), ["EBAY_UK"])).toBe(false);
  });
});
