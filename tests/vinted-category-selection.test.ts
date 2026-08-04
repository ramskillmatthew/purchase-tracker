import { describe, expect, it } from "vitest";
import {
  validateSelectedVintedCategory, deriveDraftAudience, deriveDraftItemFamily,
  selectAutomaticSelectionBranches, AUTOMATIC_SELECTION_BRANCHES, extractCategorySearchKeywords,
  normaliseFootwearVintedAudience, stripChildrensAudienceWording, normaliseFootwearListingText,
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

describe("normaliseFootwearVintedAudience — business rule: footwear must never be listed under a children's Vinted audience", () => {
  it("Boys + footwear normalises to Women", () => {
    expect(normaliseFootwearVintedAudience("boys", "footwear")).toBe("womens");
  });

  it("Girls + footwear normalises to Women", () => {
    expect(normaliseFootwearVintedAudience("girls", "footwear")).toBe("womens");
  });

  it("Men + footwear remains Men", () => {
    expect(normaliseFootwearVintedAudience("mens", "footwear")).toBe("mens");
  });

  it("Women + footwear remains Women", () => {
    expect(normaliseFootwearVintedAudience("womens", "footwear")).toBe("womens");
  });

  it("Unisex + footwear remains Unisex", () => {
    expect(normaliseFootwearVintedAudience("unisex", "footwear")).toBe("unisex");
  });

  it("Unknown + footwear remains Unknown", () => {
    expect(normaliseFootwearVintedAudience("unknown", "footwear")).toBe("unknown");
  });

  it("null + footwear remains null", () => {
    expect(normaliseFootwearVintedAudience(null, "footwear")).toBeNull();
  });

  it("REGRESSION: Boys/Girls on non-footwear (clothing or uncertain) remain completely unchanged — Vinted's own Kids clothing branches are still a valid destination there", () => {
    expect(normaliseFootwearVintedAudience("boys", "clothing")).toBe("boys");
    expect(normaliseFootwearVintedAudience("girls", "clothing")).toBe("girls");
    expect(normaliseFootwearVintedAudience("boys", "uncertain")).toBe("boys");
    expect(normaliseFootwearVintedAudience("girls", "uncertain")).toBe("girls");
  });

  it("REGRESSION: never a size-based decision — this function has no ukSize/sourceSize parameter at all, only (audience, itemFamily)", () => {
    expect(normaliseFootwearVintedAudience.length).toBe(2);
  });

  it("REGRESSION: no AI call is involved — the function is synchronous (returns a value directly, never a Promise) and this module never imports the Anthropic SDK or any runVinted*/run*Analysis AI-calling function", async () => {
    expect(normaliseFootwearVintedAudience("boys", "footwear")).not.toBeInstanceOf(Promise);
    const source = await import("node:fs").then(fs => fs.readFileSync("lib/listing-studio/vinted-category-selection.ts", "utf8"));
    expect(source).not.toContain("@anthropic-ai/sdk");
    expect(source).not.toMatch(/^import.*Anthropic/m);
    expect(source).not.toMatch(/import\s*"server-only"/);
  });
});

describe("stripChildrensAudienceWording — business rule: Women's footwear text must never carry children's audience wording", () => {
  it("Clifton 9 Youth -> Clifton 9 (the exact production example)", () => {
    expect(stripChildrensAudienceWording("Clifton 9 Youth")).toBe("Clifton 9");
  });

  it("Junior Clifton 9 -> Clifton 9", () => {
    expect(stripChildrensAudienceWording("Junior Clifton 9")).toBe("Clifton 9");
  });

  it("Kids' Running Trainers -> Running Trainers", () => {
    expect(stripChildrensAudienceWording("Kids' Running Trainers")).toBe("Running Trainers");
  });

  it("removes Boys/Girls wording", () => {
    expect(stripChildrensAudienceWording("Boys Running Trainers")).toBe("Running Trainers");
    expect(stripChildrensAudienceWording("Girls Cloud 5")).toBe("Cloud 5");
    expect(stripChildrensAudienceWording("Boy's Trainers")).toBe("Trainers");
    expect(stripChildrensAudienceWording("Girl's Trainers")).toBe("Trainers");
  });

  it("is case-insensitive", () => {
    expect(stripChildrensAudienceWording("YOUTH Cloud 5")).toBe("Cloud 5");
    expect(stripChildrensAudienceWording("boys Cloud 5")).toBe("Cloud 5");
    expect(stripChildrensAudienceWording("KiDs Cloud 5")).toBe("Cloud 5");
  });

  it("removes every children's term named by the business rule (Kid/Kids/Junior/Juniors/Child/Children/Children's too)", () => {
    expect(stripChildrensAudienceWording("Kid Trainers")).toBe("Trainers");
    expect(stripChildrensAudienceWording("Juniors Trainers")).toBe("Trainers");
    expect(stripChildrensAudienceWording("Child Trainers")).toBe("Trainers");
    expect(stripChildrensAudienceWording("Children Trainers")).toBe("Trainers");
    expect(stripChildrensAudienceWording("Children's Trainers")).toBe("Trainers");
  });

  it("removes multiple terms in the same value safely", () => {
    expect(stripChildrensAudienceWording("Youth Kids Boys Trainers")).toBe("Trainers");
  });

  it("REGRESSION: never removes text merely because it contains the same letters inside another legitimate word — only whole, standalone terms are removed", () => {
    expect(stripChildrensAudienceWording("Skidmore")).toBe("Skidmore");
    expect(stripChildrensAudienceWording("Cowboy")).toBe("Cowboy");
    expect(stripChildrensAudienceWording("Tomboys")).toBe("Tomboys");
    expect(stripChildrensAudienceWording("Kanye Boyfriend Jeans")).toBe("Kanye Boyfriend Jeans");
  });

  it("collapses duplicate whitespace and removes awkward leftover punctuation left behind by a removed term", () => {
    expect(stripChildrensAudienceWording("Running Kids' Trainers")).toBe("Running Trainers");
    expect(stripChildrensAudienceWording("On Cloud   5")).toBe("On Cloud 5");
  });

  it("preserves the remaining model/product name exactly, in order, once the term is gone", () => {
    expect(stripChildrensAudienceWording("Hoka Clifton 9 Youth Running Trainers")).toBe("Hoka Clifton 9 Running Trainers");
  });

  it("returns null for null, and null (never an empty string) when nothing but children's wording was present", () => {
    expect(stripChildrensAudienceWording(null)).toBeNull();
    expect(stripChildrensAudienceWording("Youth")).toBeNull();
  });

  it("a value with no children's wording at all is returned completely unchanged", () => {
    expect(stripChildrensAudienceWording("Clifton 9")).toBe("Clifton 9");
  });
});

describe("normaliseFootwearListingText — the gated, business-rule application of stripChildrensAudienceWording", () => {
  it("footwear + womens: children's wording is stripped", () => {
    expect(normaliseFootwearListingText("Clifton 9 Youth", "footwear", "womens")).toBe("Clifton 9");
  });

  it("REGRESSION: footwear + mens is NEVER touched by this rule, even if the text happened to contain a children's term", () => {
    expect(normaliseFootwearListingText("Junior Racer", "footwear", "mens")).toBe("Junior Racer");
  });

  it("REGRESSION: footwear + unisex/unknown are never touched either — this rule is specifically scoped to Women's", () => {
    expect(normaliseFootwearListingText("Junior Racer", "footwear", "unisex")).toBe("Junior Racer");
    expect(normaliseFootwearListingText("Junior Racer", "footwear", "unknown")).toBe("Junior Racer");
    expect(normaliseFootwearListingText("Junior Racer", "footwear", null)).toBe("Junior Racer");
  });

  it("REGRESSION: non-footwear (clothing/uncertain) is never touched, even for Women's — Kids clothing wording is legitimate there", () => {
    expect(normaliseFootwearListingText("Girls Puffer Jacket", "clothing", "womens")).toBe("Girls Puffer Jacket");
    expect(normaliseFootwearListingText("Girls Puffer Jacket", "uncertain", "womens")).toBe("Girls Puffer Jacket");
  });

  it("the title never needs to say Women/Women's — a clean value with no children's wording is returned exactly as-is, not appended to", () => {
    expect(normaliseFootwearListingText("Cloud 5", "footwear", "womens")).toBe("Cloud 5");
  });

  it("null passes through as null regardless of gating", () => {
    expect(normaliseFootwearListingText(null, "footwear", "womens")).toBeNull();
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
