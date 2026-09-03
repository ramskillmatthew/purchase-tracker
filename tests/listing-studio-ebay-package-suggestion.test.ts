import { describe, expect, it } from "vitest";
import { suggestPackageSize } from "@/lib/listing-studio/ebay-package-suggestion";

function input(overrides: Partial<Parameters<typeof suggestPackageSize>[0]> = {}) {
  return { productType: null, brand: null, model: null, material: null, ...overrides };
}

describe("suggestPackageSize — deterministic, keyword-based, never AI", () => {
  it("Problem 5 fix (proven root-cause fix): ordinary footwear (trainers) is a HIGH-confidence default that does NOT require review", () => {
    const result = suggestPackageSize(input({ productType: "Running Trainers", brand: "On Running" }));
    expect(result.size).toBe("medium_parcel");
    expect(result.confidence).toBe("high");
    expect(result.requiresReview).toBe(false);
    expect(result.reason).toMatch(/shoebox/i);
  });

  it.each(["Trainers", "Sneakers", "Shoes", "Sandals", "Slippers"])("REQUIREMENT: '%s' is treated as ordinary footwear — high confidence, no review", productType => {
    const result = suggestPackageSize(input({ productType }));
    expect(result.confidence).toBe("high");
    expect(result.requiresReview).toBe(false);
  });

  it("REQUIREMENT: boots are bulkier than ordinary footwear — stays a reviewable, medium-confidence suggestion", () => {
    const result = suggestPackageSize(input({ productType: "Winter Boots", brand: "Timberland" }));
    expect(result.size).toBe("medium_parcel");
    expect(result.confidence).toBe("medium");
    expect(result.requiresReview).toBe(true);
    expect(result.reason).toMatch(/bulkier/i);
  });

  it("REQUIREMENT: more than one unit in the listing makes even ordinary footwear's combined packaging uncertain — flagged for review", () => {
    const single = suggestPackageSize(input({ productType: "Trainers", quantity: 1 }));
    expect(single.requiresReview).toBe(false);
    const multi = suggestPackageSize(input({ productType: "Trainers", quantity: 3 }));
    expect(multi.requiresReview).toBe(true);
    expect(multi.reason).toMatch(/more than one unit/i);
  });

  it("a missing/null quantity is treated the same as a single unit (never forced into review)", () => {
    const result = suggestPackageSize(input({ productType: "Trainers", quantity: null }));
    expect(result.requiresReview).toBe(false);
  });

  it("a sealed trading-card box (Elite Trainer Box) suggests a small parcel, still reviewable", () => {
    const result = suggestPackageSize(input({ productType: "Elite Trainer Box", brand: "Pokémon TCG", model: "Prismatic Evolutions" }));
    expect(result.size).toBe("small_parcel");
    expect(result.confidence).toBe("medium");
    expect(result.requiresReview).toBe(true);
  });

  it("a beauty/skincare product suggests a small parcel at low confidence, never a fabricated volume claim", () => {
    const result = suggestPackageSize(input({ productType: "Serum", brand: "The Ordinary" }));
    expect(result.size).toBe("small_parcel");
    expect(result.confidence).toBe("low");
    expect(result.requiresReview).toBe(true);
    expect(result.reason).not.toMatch(/\d+\s?ml/i);
  });

  it("REQUIREMENT: no product information at all returns null (never guesses blind), low confidence, requires review, honest reason", () => {
    const result = suggestPackageSize(input());
    expect(result.size).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.requiresReview).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("an unrecognised product type returns null rather than a wrong default, and says so plainly", () => {
    const result = suggestPackageSize(input({ productType: "Ceramic Plant Pot" }));
    expect(result.size).toBeNull();
    expect(result.requiresReview).toBe(true);
    expect(result.reason).toMatch(/manually/i);
  });

  it("REGRESSION: never returns 'custom' — that value only ever means an explicit manual choice, never a suggestion", () => {
    const anyResult = suggestPackageSize(input({ productType: "Running Trainers" }));
    expect(anyResult.size).not.toBe("custom");
  });
});
