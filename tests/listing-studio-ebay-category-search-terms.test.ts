import { describe, expect, it } from "vitest";
import { buildEbayCategorySearchTerms } from "@/lib/listing-studio/ebay-category-search-terms";

function input(overrides: Partial<Parameters<typeof buildEbayCategorySearchTerms>[0]> = {}) {
  return { brand: null, productType: null, model: null, set: null, configuration: null, title: null, knownCategoryName: null, keyAttributes: [], ...overrides };
}

describe("buildEbayCategorySearchTerms", () => {
  it("REQUIREMENT: reproduces the spec's own Prismatic Evolutions Elite Trainer Box example", () => {
    const terms = buildEbayCategorySearchTerms(input({
      brand: "Pokémon TCG", set: "Prismatic Evolutions", productType: "Elite Trainer Box", keyAttributes: ["sealed"],
    }));
    expect(terms).toBe("Pokémon TCG Prismatic Evolutions Elite Trainer Box sealed");
  });

  it("orders terms brand -> set -> productType -> model -> configuration -> key attributes", () => {
    const terms = buildEbayCategorySearchTerms(input({ brand: "Nike", productType: "Trainers", model: "Pegasus 40" }));
    expect(terms).toBe("Nike Trainers Pegasus 40");
  });

  it("omits any field that is null, never producing double spaces", () => {
    const terms = buildEbayCategorySearchTerms(input({ brand: "Nike", model: "Pegasus" }));
    expect(terms).toBe("Nike Pegasus");
    expect(terms).not.toContain("  ");
  });

  it("REGRESSION: never uses the raw title/known category alongside real structured terms", () => {
    const terms = buildEbayCategorySearchTerms(input({ brand: "Nike", title: "Some unrelated marketing title" }));
    expect(terms).toBe("Nike");
    expect(terms).not.toContain("unrelated");
  });

  it("falls back to the title only when NO structured facts are available at all", () => {
    const terms = buildEbayCategorySearchTerms(input({ title: "Nike Pegasus 40 Trainers" }));
    expect(terms).toBe("Nike Pegasus 40 Trainers");
  });

  it("falls back to the known category name when title is also absent", () => {
    const terms = buildEbayCategorySearchTerms(input({ knownCategoryName: "Trainers" }));
    expect(terms).toBe("Trainers");
  });

  it("returns an empty string (never throws) when nothing at all is known", () => {
    expect(buildEbayCategorySearchTerms(input())).toBe("");
  });

  it("deduplicates the exact same term appearing in two fields, case-insensitively", () => {
    const terms = buildEbayCategorySearchTerms(input({ brand: "Nike", model: "NIKE" }));
    expect(terms).toBe("Nike");
  });

  it("caps the number of terms and the overall query length", () => {
    const manyAttributes = Array.from({ length: 20 }, (_, i) => `attribute${i}`);
    const terms = buildEbayCategorySearchTerms(input({ brand: "Brand", keyAttributes: manyAttributes }));
    expect(terms.split(" ").length).toBeLessThanOrEqual(8);
  });
});
