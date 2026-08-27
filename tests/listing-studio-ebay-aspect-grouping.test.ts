import { describe, expect, it } from "vitest";
import { groupEbayAspects } from "@/lib/listing-studio/ebay-aspect-grouping";
import type { EbayAspect } from "@/lib/listing-studio/ebay-taxonomy-client";

function aspect(overrides: Partial<EbayAspect> = {}): EbayAspect {
  return { localizedAspectName: "Game", ...overrides };
}

describe("groupEbayAspects", () => {
  it("REQUIREMENT: separates aspects into required/recommended/optional using eBay's own aspectUsage", () => {
    const grouped = groupEbayAspects([
      aspect({ localizedAspectName: "Game", aspectConstraint: { aspectUsage: "REQUIRED" } }),
      aspect({ localizedAspectName: "Manufacturer", aspectConstraint: { aspectUsage: "RECOMMENDED" } }),
      aspect({ localizedAspectName: "Year Manufactured", aspectConstraint: { aspectUsage: "OPTIONAL" } }),
    ]);
    expect(grouped.required.map(a => a.name)).toEqual(["Game"]);
    expect(grouped.recommended.map(a => a.name)).toEqual(["Manufacturer"]);
    expect(grouped.optional.map(a => a.name)).toEqual(["Year Manufactured"]);
  });

  it("falls back to aspectRequired boolean when aspectUsage is absent", () => {
    const grouped = groupEbayAspects([aspect({ aspectConstraint: { aspectRequired: true } })]);
    expect(grouped.required).toHaveLength(1);
  });

  it("defaults to optional when neither aspectUsage nor aspectRequired is present", () => {
    const grouped = groupEbayAspects([aspect({ aspectConstraint: undefined })]);
    expect(grouped.optional).toHaveLength(1);
  });

  it("REQUIREMENT: renders a free-text aspect as free text, never forcing it into a dropdown", () => {
    const grouped = groupEbayAspects([aspect({ localizedAspectName: "EAN", aspectConstraint: { aspectMode: "FREE_TEXT" }, aspectValues: undefined })]);
    expect(grouped.optional[0].mode).toBe("FREE_TEXT");
    expect(grouped.optional[0].allowedValues).toEqual([]);
  });

  it("REQUIREMENT: a selection-only aspect carries its exact allowed values, never assumed", () => {
    const grouped = groupEbayAspects([aspect({ aspectConstraint: { aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Pokémon TCG" }, { localizedValue: "Yu-Gi-Oh!" }] })]);
    expect(grouped.required[0]?.allowedValues ?? grouped.recommended[0]?.allowedValues ?? grouped.optional[0].allowedValues).toEqual(["Pokémon TCG", "Yu-Gi-Oh!"]);
  });

  it("infers SELECTION_ONLY from a present allowed-value list even when aspectMode itself is missing", () => {
    const grouped = groupEbayAspects([aspect({ aspectConstraint: undefined, aspectValues: [{ localizedValue: "A" }] })]);
    expect(grouped.optional[0].mode).toBe("SELECTION_ONLY");
  });

  it("captures multi-value cardinality and max length", () => {
    const grouped = groupEbayAspects([aspect({ localizedAspectName: "Features", aspectConstraint: { itemToAspectCardinality: "MULTI", aspectMaxLength: 65 } })]);
    expect(grouped.optional[0].cardinality).toBe("MULTI");
    expect(grouped.optional[0].maxLength).toBe(65);
  });

  it("defaults cardinality to SINGLE and maxLength to null when absent", () => {
    const grouped = groupEbayAspects([aspect({ aspectConstraint: {} })]);
    expect(grouped.optional[0].cardinality).toBe("SINGLE");
    expect(grouped.optional[0].maxLength).toBeNull();
  });

  it("handles an empty aspect list without crashing", () => {
    expect(groupEbayAspects([])).toEqual({ required: [], recommended: [], optional: [] });
  });
});
