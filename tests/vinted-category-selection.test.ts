import { describe, expect, it } from "vitest";
import {
  validateSelectedVintedCategory, deriveDraftAudience, deriveDraftItemFamily,
  selectAutomaticSelectionBranches, AUTOMATIC_SELECTION_BRANCHES, extractCategorySearchKeywords,
} from "@/lib/listing-studio/vinted-category-selection";
import type { VintedCategoryRow } from "@/lib/listing-studio/vinted-categories-data";

function category(overrides: Partial<VintedCategoryRow> = {}): VintedCategoryRow {
  return {
    id: 1906, code: null, label: "Trainers", full_path: "Women > Shoes > Trainers",
    parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true,
    audience: "womens", item_family: null,
    ...overrides,
  };
}

describe("deriveDraftAudience — follow-up correction (2026-08-04): reads ONLY the dedicated vintedAudience field, never sourceSize.gender", () => {
  it("maps mens/womens/boys/girls directly", () => {
    expect(deriveDraftAudience("mens")).toBe("men");
    expect(deriveDraftAudience("womens")).toBe("women");
    expect(deriveDraftAudience("boys")).toBe("boys");
    expect(deriveDraftAudience("girls")).toBe("girls");
  });

  it("unisex is 'unknown' — there is no unisex branch among the 8 verified ones, so it is never guessed", () => {
    expect(deriveDraftAudience("unisex")).toBe("unknown");
  });

  it("'unknown' stays 'unknown'", () => {
    expect(deriveDraftAudience("unknown")).toBe("unknown");
  });

  it("REGRESSION: a null vintedAudience (an older draft generated before this field existed) is treated as 'unknown', never as a crash or a guess", () => {
    expect(deriveDraftAudience(null)).toBe("unknown");
  });

  it("REGRESSION (the exact production bug): a missing/null sourceSize.gender must never influence this function at all — it doesn't even accept that parameter anymore", () => {
    // New Balance 9060 Trainers: sourceSize.gender was null (no gender
    // printed on the size tag), but vintedAudience was independently
    // determined as "mens" from the photos/brand knowledge — audience
    // resolution must succeed regardless of the missing size-tag gender.
    expect(deriveDraftAudience("mens")).toBe("men");
  });
});

describe("deriveDraftItemFamily — deterministic clothing/footwear classification from productType text", () => {
  it("recognises every named footwear example", () => {
    for (const productType of ["Trainers", "Running shoes", "Hiking shoes", "Football boots", "Boots", "Sandals", "Clogs", "Loafers"]) {
      expect(deriveDraftItemFamily(productType)).toBe("footwear");
    }
  });

  it("recognises every named clothing example", () => {
    for (const productType of ["Coats", "Jackets", "Shirts", "Trousers", "Dresses"]) {
      expect(deriveDraftItemFamily(productType)).toBe("clothing");
    }
  });

  it("is case-insensitive", () => {
    expect(deriveDraftItemFamily("RUNNING TRAINERS")).toBe("footwear");
  });

  it("returns 'uncertain' for null or an unrecognised productType — never guessed", () => {
    expect(deriveDraftItemFamily(null)).toBe("uncertain");
    expect(deriveDraftItemFamily("Widget")).toBe("uncertain");
  });
});

describe("extractCategorySearchKeywords — follow-up correction (2026-08-07): the exact production bug fix (category assignment returning no_candidates for every generated draft despite a valid audience and product type)", () => {
  it("REGRESSION (the exact production bug): 'Running Trainers' splits into individual words, NOT the whole phrase — the catalogue's real leaves are 'Trainers' and 'Running shoes', neither of which contains the literal substring 'Running Trainers'", () => {
    expect(extractCategorySearchKeywords("Running Trainers")).toEqual(["running", "trainers"]);
  });

  it("is case-insensitive and returns lowercase words", () => {
    expect(extractCategorySearchKeywords("RUNNING TRAINERS")).toEqual(["running", "trainers"]);
  });

  it("drops words under 3 characters — no narrowing signal", () => {
    expect(extractCategorySearchKeywords("On Cloud 5")).toEqual(["cloud"]);
  });

  it("drops branch-name stopwords ('shoe'/'shoes'/'clothing') — they appear in virtually every leaf's own full_path and provide zero narrowing signal", () => {
    expect(extractCategorySearchKeywords("Walking Shoes")).toEqual(["walking"]);
    expect(extractCategorySearchKeywords("Shoes")).toEqual([]);
    expect(extractCategorySearchKeywords("Women's Clothing")).toEqual(["women"]);
  });

  it("returns [] for null — callers must fall back to the unnarrowed branch scope", () => {
    expect(extractCategorySearchKeywords(null)).toEqual([]);
  });

  it("returns [] when every word is filtered out (all short and/or stopwords) — never a crash, never a bogus single-letter keyword", () => {
    expect(extractCategorySearchKeywords("Shoe")).toEqual([]);
  });

  it("deduplicates repeated words", () => {
    expect(extractCategorySearchKeywords("Running Running Trainers")).toEqual(["running", "trainers"]);
  });

  it("splits on any non-alphanumeric separator, not just spaces", () => {
    expect(extractCategorySearchKeywords("Football-Boots/Cleats")).toEqual(["football", "boots", "cleats"]);
  });
});

describe("selectAutomaticSelectionBranches — the 8-branch automatic-selection scope", () => {
  it("returns no branches for 'unknown' audience regardless of item family", () => {
    expect(selectAutomaticSelectionBranches("unknown", "clothing")).toEqual([]);
    expect(selectAutomaticSelectionBranches("unknown", "uncertain")).toEqual([]);
  });

  it("returns exactly one branch when both audience and item family are known", () => {
    expect(selectAutomaticSelectionBranches("women", "clothing")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 4)]);
    expect(selectAutomaticSelectionBranches("women", "footwear")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 16)]);
    expect(selectAutomaticSelectionBranches("men", "clothing")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 2050)]);
    expect(selectAutomaticSelectionBranches("men", "footwear")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 1231)]);
    expect(selectAutomaticSelectionBranches("girls", "clothing")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 1195)]);
    expect(selectAutomaticSelectionBranches("girls", "footwear")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 1255)]);
    expect(selectAutomaticSelectionBranches("boys", "clothing")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 1194)]);
    expect(selectAutomaticSelectionBranches("boys", "footwear")).toEqual([AUTOMATIC_SELECTION_BRANCHES.find((b) => b.id === 1256)]);
  });

  it("returns both of an audience's branches when item family is uncertain", () => {
    const result = selectAutomaticSelectionBranches("women", "uncertain");
    expect(result.map((b) => b.id).sort((a, b) => a - b)).toEqual([4, 16]);
  });

  it("every branch id is exactly one of the 8 verified ones, with no duplicates", () => {
    const ids = AUTOMATIC_SELECTION_BRANCHES.map((b) => b.id);
    expect(ids.sort((a, b) => a - b)).toEqual([4, 16, 1194, 1195, 1231, 1255, 1256, 2050]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("validateSelectedVintedCategory — the only gate an AI-chosen category id passes through before being persisted", () => {
  it("accepts a null selection unconditionally", () => {
    const result = validateSelectedVintedCategory(null, [{ id: 1906 }], null);
    expect(result).toEqual({ valid: true, categoryId: null });
  });

  it("accepts a valid id that was in the candidate list and is active/selectable/leaf", () => {
    const cat = category();
    const result = validateSelectedVintedCategory(1906, [{ id: 1906 }], cat);
    expect(result.valid).toBe(true);
    if (result.valid && result.categoryId !== null) expect(result.category).toBe(cat);
  });

  it("rejects an id that was NOT in the supplied candidate list (an invented/out-of-set answer)", () => {
    const result = validateSelectedVintedCategory(9999, [{ id: 1906 }], category({ id: 9999 }));
    expect(result.valid).toBe(false);
  });

  it("rejects an id that can no longer be found in the catalogue", () => {
    const result = validateSelectedVintedCategory(1906, [{ id: 1906 }], null);
    expect(result.valid).toBe(false);
  });

  it("rejects an id whose fresh lookup id doesn't match (defensive mismatch guard)", () => {
    const result = validateSelectedVintedCategory(1906, [{ id: 1906 }], category({ id: 1907 }));
    expect(result.valid).toBe(false);
  });

  it("rejects an inactive category even if it was a valid candidate", () => {
    const result = validateSelectedVintedCategory(1906, [{ id: 1906 }], category({ is_active: false }));
    expect(result.valid).toBe(false);
  });

  it("rejects a non-selectable category", () => {
    const result = validateSelectedVintedCategory(1906, [{ id: 1906 }], category({ is_selectable: false }));
    expect(result.valid).toBe(false);
  });

  it("rejects a non-leaf category", () => {
    const result = validateSelectedVintedCategory(1906, [{ id: 1906 }], category({ is_leaf: false }));
    expect(result.valid).toBe(false);
  });
});
