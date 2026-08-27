import { describe, expect, it } from "vitest";
import { matchAspectValue, isAspectValueFilled } from "@/lib/listing-studio/ebay-aspect-matching";
import type { GroupedAspect } from "@/lib/listing-studio/ebay-aspect-grouping";

const NOW = () => "2026-01-01T00:00:00.000Z";

function aspect(overrides: Partial<GroupedAspect> = {}): GroupedAspect {
  return { name: "Game", usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: null, allowedValues: ["Pokémon TCG", "Yu-Gi-Oh!"], ...overrides };
}

describe("matchAspectValue — SELECTION_ONLY", () => {
  it("REQUIREMENT: an exact match to an allowed value is accepted, keeping the candidate's own confidence", () => {
    const result = matchAspectValue(aspect(), [{ value: "Pokémon TCG", source: "imported_ebay_item_specifics", confidence: "high" }], NOW);
    expect(result).toMatchObject({ value: "Pokémon TCG", confidence: "high", source: "imported_ebay_item_specifics" });
  });

  it("normalises case/whitespace/punctuation before matching (a safe alias match, never a semantic guess)", () => {
    const result = matchAspectValue(aspect(), [{ value: "  pokémon   tcg.", source: "shared_facts", confidence: "medium" }], NOW);
    expect(result.value).toBe("Pokémon TCG");
  });

  it("REGRESSION (safety-critical): rejects a candidate that does not match any allowed value — never stores an unrecognised paraphrase", () => {
    const result = matchAspectValue(aspect(), [{ value: "Pokemon Cards", source: "shared_facts", confidence: "high" }], NOW);
    expect(result).toMatchObject({ value: null, confidence: "unknown" });
  });

  it("tries candidates in priority order, using the first one that actually matches", () => {
    const result = matchAspectValue(aspect(), [
      { value: "not a real value", source: "weak_source", confidence: "medium" },
      { value: "Yu-Gi-Oh!", source: "strong_source", confidence: "high" },
    ], NOW);
    expect(result).toMatchObject({ value: "Yu-Gi-Oh!", source: "strong_source" });
  });

  it("MULTI cardinality: matches every candidate array entry independently, dropping unmatched ones", () => {
    const multi = aspect({ name: "Colour", cardinality: "MULTI", allowedValues: ["Black", "White", "Red"] });
    const result = matchAspectValue(multi, [{ value: ["black", "chartreuse", "White"], source: "vinted_colours", confidence: "medium" }], NOW);
    expect(result.value).toEqual(["Black", "White"]);
  });

  it("MULTI cardinality: unknown when nothing in the candidate array matches", () => {
    const multi = aspect({ name: "Colour", cardinality: "MULTI", allowedValues: ["Black", "White"] });
    const result = matchAspectValue(multi, [{ value: ["chartreuse"], source: "vinted_colours", confidence: "medium" }], NOW);
    expect(result.confidence).toBe("unknown");
  });

  it("returns unknown (never throws) when there are no candidates at all", () => {
    expect(matchAspectValue(aspect(), [], NOW).confidence).toBe("unknown");
  });
});

describe("matchAspectValue — FREE_TEXT", () => {
  it("accepts a free-text candidate verbatim, trimmed", () => {
    const freeText = aspect({ name: "EAN", mode: "FREE_TEXT", allowedValues: [] });
    const result = matchAspectValue(freeText, [{ value: "  5012345678900  ", source: "imported_ebay_item_specifics", confidence: "high" }], NOW);
    expect(result).toMatchObject({ value: "5012345678900", confidence: "high" });
  });

  it("REGRESSION: truncates to the aspect's own maxLength rather than storing an overlong value", () => {
    const freeText = aspect({ name: "Notes", mode: "FREE_TEXT", allowedValues: [], maxLength: 5 });
    const result = matchAspectValue(freeText, [{ value: "abcdefghij", source: "shared_facts", confidence: "medium" }], NOW);
    expect(result.value).toBe("abcde");
  });

  it("skips a blank candidate and falls through to the next one", () => {
    const freeText = aspect({ name: "Notes", mode: "FREE_TEXT", allowedValues: [] });
    const result = matchAspectValue(freeText, [{ value: "   ", source: "empty_source", confidence: "high" }, { value: "real value", source: "real_source", confidence: "medium" }], NOW);
    expect(result).toMatchObject({ value: "real value", source: "real_source" });
  });
});

describe("isAspectValueFilled", () => {
  const base = { value: "Pokémon TCG", source: "x", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" };

  it("high and medium confidence always count as filled", () => {
    expect(isAspectValueFilled({ ...base, confidence: "high" })).toBe(true);
    expect(isAspectValueFilled({ ...base, confidence: "medium" })).toBe(true);
  });

  it("REQUIREMENT: low confidence does NOT count as filled until the owner confirms it", () => {
    expect(isAspectValueFilled({ ...base, confidence: "low", userConfirmed: false })).toBe(false);
    expect(isAspectValueFilled({ ...base, confidence: "low", userConfirmed: true })).toBe(true);
  });

  it("REQUIREMENT: unknown (no value) never counts as filled, even if userConfirmed is somehow true", () => {
    expect(isAspectValueFilled({ ...base, value: null, confidence: "unknown", userConfirmed: true })).toBe(false);
  });
});
