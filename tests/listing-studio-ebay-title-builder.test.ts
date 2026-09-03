import { describe, expect, it } from "vitest";
import {
  buildEbayTitle, validateEbayTitle, verifiedWordsFromFacts, mapVintedAudienceToEbayGender,
  EBAY_TITLE_MAX_LENGTH, type EbayTitleFacts,
} from "@/lib/listing-studio/ebay-title-builder";

function facts(overrides: Partial<EbayTitleFacts> = {}): EbayTitleFacts {
  return {
    brand: null, model: null, gender: null, productType: null, ukShoeSize: null, clothingSize: null,
    primaryColour: null, secondaryColour: null, material: null, styleCode: null, itemFamily: "footwear",
    otherKeywords: [], ...overrides,
  };
}

describe("mapVintedAudienceToEbayGender", () => {
  it("passes real audience values straight through", () => {
    expect(mapVintedAudienceToEbayGender("mens")).toBe("mens");
    expect(mapVintedAudienceToEbayGender("womens")).toBe("womens");
    expect(mapVintedAudienceToEbayGender("boys")).toBe("boys");
    expect(mapVintedAudienceToEbayGender("girls")).toBe("girls");
    expect(mapVintedAudienceToEbayGender("unisex")).toBe("unisex");
  });
  it("REQUIREMENT: a genuinely unknown/undetermined audience contributes no gender segment at all, never a guess", () => {
    expect(mapVintedAudienceToEbayGender("unknown")).toBeNull();
    expect(mapVintedAudienceToEbayGender(null)).toBeNull();
  });
});

describe("buildEbayTitle — footwear ordering (product spec example: New Balance 2002R)", () => {
  it("Brand -> Model -> Gender -> UK Size -> Colour -> Material -> Product type -> Style code", () => {
    const title = buildEbayTitle(facts({
      brand: "New Balance", model: "2002R", gender: "mens", ukShoeSize: "9", primaryColour: "Grey",
      material: "Suede", productType: "Running Trainers", styleCode: "M2002RST",
    }));
    expect(title).toBe("New Balance 2002R Mens UK 9 Grey Suede Running Trainers M2002RST");
  });

  it("mens footwear: gender word is 'Mens', never 'Men's' (no apostrophe in the title)", () => {
    const title = buildEbayTitle(facts({ brand: "Nike", model: "Pegasus 40", gender: "mens", ukShoeSize: "9", productType: "Trainers" }));
    expect(title).toContain("Mens");
    expect(title).not.toContain("Men's");
  });

  it("uses 'UK 4', never 'Size UK 4'", () => {
    const title = buildEbayTitle(facts({ brand: "Nike", ukShoeSize: "4" }));
    expect(title).toContain("UK 4");
    expect(title).not.toContain("Size UK 4");
  });

  it("REQUIREMENT: missing/unestablished product code is simply omitted, never invented as a placeholder", () => {
    const title = buildEbayTitle(facts({ brand: "New Balance", model: "2002R", gender: "mens", ukShoeSize: "9", primaryColour: "Grey", productType: "Trainers", styleCode: null }));
    expect(title).not.toMatch(/null|undefined|unknown/i);
    expect(title).toBe("New Balance 2002R Mens UK 9 Grey Trainers");
  });

  it("REQUIREMENT: unknown gender simply omits the gender segment, never guesses", () => {
    const title = buildEbayTitle(facts({ brand: "New Balance", model: "2002R", gender: null, ukShoeSize: "9", primaryColour: "Grey", productType: "Trainers" }));
    expect(title).toBe("New Balance 2002R UK 9 Grey Trainers");
  });
});

describe("buildEbayTitle — the exact reported over-eager-deduplication bug (brand 'On Running' vs. product type 'Running Trainers')", () => {
  it("PROVEN ROOT CAUSE FIX: reproduces the exact required title — both 'Running's are kept, since Brand and Product type are different, non-adjacent fields", () => {
    const title = buildEbayTitle(facts({
      brand: "On Running", model: "Cloud 5", gender: "womens", ukShoeSize: "4",
      primaryColour: "Blue", secondaryColour: "White", material: "Mesh", productType: "Running Trainers",
    }));
    expect(title).toBe("On Running Cloud 5 Womens UK 4 Blue White Mesh Running Trainers");
    expect(title.toLowerCase().match(/\brunning\b/g)?.length).toBe(2); // both occurrences retained — this is NOT a bug
  });

  it("REQUIREMENT: a genuinely ACCIDENTAL repeat within a single field's own text is still collapsed (e.g. a messy raw fact 'Running Running Trainers')", () => {
    const title = buildEbayTitle(facts({
      brand: "On Running", model: "Cloud 5", gender: "womens", ukShoeSize: "4", primaryColour: "Blue",
      productType: "Running Running Trainers",
    }));
    expect(title).toBe("On Running Cloud 5 Womens UK 4 Blue Running Trainers");
    expect(title.toLowerCase().match(/\brunning\b/g)?.length).toBe(2); // one from brand, one (not two) from product type
  });

  it("REQUIREMENT: a duplicate word IS collapsed when it lands at the boundary between two ADJACENT assembled segments (brand directly followed by a model restating the same word)", () => {
    const title = buildEbayTitle(facts({ brand: "Nike", model: "Nike Air Max", gender: "mens", ukShoeSize: "9", productType: "Trainers" }));
    expect(title).toBe("Nike Air Max Mens UK 9 Trainers");
    expect(title.toLowerCase().match(/\bnike\b/g)?.length).toBe(1);
  });

  it("REQUIREMENT: field ordering stays Brand -> Model -> Gender -> Size -> Colour -> Material/Type -> Product code with fully distinct terms (no dedup interaction at all)", () => {
    const title = buildEbayTitle(facts({
      brand: "Adidas", model: "Samba OG", gender: "mens", ukShoeSize: "10", primaryColour: "White",
      secondaryColour: "Green", material: "Leather", productType: "Trainers", styleCode: "B75806",
    }));
    expect(title).toBe("Adidas Samba OG Mens UK 10 White Green Leather Trainers B75806");
  });

  it("REQUIREMENT: the title stays within the 80-character limit even with both non-adjacent duplicate-word fields kept in full", () => {
    const title = buildEbayTitle(facts({
      brand: "On Running", model: "Cloud 5", gender: "womens", ukShoeSize: "4",
      primaryColour: "Blue", secondaryColour: "White", material: "Mesh", productType: "Running Trainers",
    }));
    expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
  });
});

describe("buildEbayTitle — the exact reported 'Mesh Upper' trailing-keyword regression", () => {
  it("PROVEN ROOT CAUSE FIX: an AI otherKeyword that semantically restates an earlier field (material 'Mesh' vs. keyword 'Mesh Upper') is dropped, not appended", () => {
    const title = buildEbayTitle(facts({
      brand: "On Running", model: "Cloud 5", gender: "womens", ukShoeSize: "4",
      primaryColour: "Blue", secondaryColour: "Grey", material: "Mesh", productType: "Running Trainers",
      otherKeywords: ["Mesh Upper"],
    }));
    expect(title).toBe("On Running Cloud 5 Womens UK 4 Blue Grey Mesh Running Trainers");
    expect(title).not.toMatch(/Mesh Upper/);
    expect(title.toLowerCase().match(/\bmesh\b/g)?.length).toBe(1); // material stated once, never duplicated by a keyword
  });

  it("REQUIREMENT: a genuinely distinct, non-duplicating otherKeyword is still kept", () => {
    const title = buildEbayTitle(facts({
      brand: "On Running", model: "Cloud 5", gender: "womens", ukShoeSize: "4",
      primaryColour: "Blue", secondaryColour: "Grey", material: "Mesh", productType: "Running Trainers",
      otherKeywords: ["Lightweight"],
    }));
    expect(title).toBe("On Running Cloud 5 Womens UK 4 Blue Grey Mesh Running Trainers Lightweight");
  });

  it("REQUIREMENT: a keyword restating the brand/model/colour (not just material) is also dropped, not just material overlaps", () => {
    const title = buildEbayTitle(facts({
      brand: "Nike", model: "Pegasus 40", gender: "mens", ukShoeSize: "9", primaryColour: "Black",
      productType: "Running Trainers", otherKeywords: ["Nike Cushioning", "Black Colourway", "Breathable"],
    }));
    expect(title).toBe("Nike Pegasus 40 Mens UK 9 Black Running Trainers Breathable");
  });
});

describe("buildEbayTitle — clothing ordering (product spec example: Nike Tech Fleece)", () => {
  it("Brand -> Model/Range -> Gender -> Colour -> Material/style -> Garment type -> Size -> Style code", () => {
    const title = buildEbayTitle(facts({
      itemFamily: "clothing", brand: "Nike", model: "Tech Fleece", gender: "mens", primaryColour: "Black",
      material: "Full Zip", productType: "Hoodie Jacket", clothingSize: "Large L",
    }));
    expect(title).toBe("Nike Tech Fleece Mens Black Full Zip Hoodie Jacket Size Large L");
  });

  it("hoodie: no product code known -> omitted cleanly", () => {
    const title = buildEbayTitle(facts({ itemFamily: "clothing", brand: "Adidas", productType: "Hoodie", gender: "womens", primaryColour: "Pink", clothingSize: "Medium" }));
    expect(title).toBe("Adidas Womens Pink Hoodie Size Medium");
  });

  it("jacket with a style code confidently known", () => {
    const title = buildEbayTitle(facts({ itemFamily: "clothing", brand: "The North Face", productType: "Jacket", gender: "mens", primaryColour: "Green", clothingSize: "Large", styleCode: "NF0A3XEZ" }));
    expect(title).toBe("The North Face Mens Green Jacket Size Large NF0A3XEZ");
  });

  it("t-shirt: brand, gender, colour, garment type, size", () => {
    const title = buildEbayTitle(facts({ itemFamily: "clothing", brand: "Ralph Lauren", productType: "T-Shirt", gender: "mens", primaryColour: "White", clothingSize: "Medium" }));
    expect(title).toBe("Ralph Lauren Mens White T-Shirt Size Medium");
  });

  it("trousers: brand, material/style, garment type, size", () => {
    const title = buildEbayTitle(facts({ itemFamily: "clothing", brand: "Carhartt", productType: "Trousers", gender: "mens", primaryColour: "Navy", material: "Cargo", clothingSize: "32" }));
    expect(title).toBe("Carhartt Mens Navy Cargo Trousers Size 32");
  });
});

describe("buildEbayTitle — general behaviour", () => {
  it("never wraps colour in quotation marks", () => {
    const title = buildEbayTitle(facts({ brand: "Nike", productType: "Trainers", primaryColour: "Blue" }));
    expect(title).not.toContain('"');
  });

  it("REQUIREMENT: never includes a condition phrase — condition lives in its own field/description, never the title", () => {
    const title = buildEbayTitle(facts({ brand: "Nike", productType: "Trainers" }));
    expect(title).not.toMatch(/pre-?owned|used|very good condition/i);
  });

  it("omits a missing fact's segment rather than producing a malformed double space", () => {
    const title = buildEbayTitle(facts({ brand: "Nike" }));
    expect(title).toBe("Nike");
    expect(title).not.toContain("  ");
  });

  it("REQUIREMENT: never exceeds 80 characters, and drops lowest-priority segments (style code, then otherKeywords) first rather than truncating mid-word", () => {
    const title = buildEbayTitle(facts({
      brand: "Nike", model: "Air Max 97 Special Edition Collaboration", gender: "mens", ukShoeSize: "9",
      primaryColour: "Multi", secondaryColour: "Colour Rainbow", material: "Leather And Mesh Combination",
      productType: "Running Trainers Shoes", styleCode: "AJ1234-001", otherKeywords: ["Lightweight", "Breathable", "Limited Edition"],
    }));
    expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
    expect(title.endsWith(" ")).toBe(false);
    expect(title.startsWith("Nike")).toBe(true); // brand/model identity preserved even when trimming
  });

  it("REQUIREMENT: an exact 80-character title is accepted as-is, never trimmed further", () => {
    const build = (filler: string | null) => buildEbayTitle(facts({
      brand: "Nike", model: "Pegasus", gender: "mens", ukShoeSize: "9",
      primaryColour: "Blue", material: "Mesh", productType: "Sneakers",
      otherKeywords: filler ? [filler] : [],
    }));
    const base = build(null);
    expect(base.length).toBeLessThan(EBAY_TITLE_MAX_LENGTH);
    const remaining = EBAY_TITLE_MAX_LENGTH - base.length - 1; // -1 for the joining space before the filler
    const filler = "Xk".repeat(Math.ceil(remaining / 2)).slice(0, remaining);
    const padded = build(filler);
    expect(padded.length).toBe(EBAY_TITLE_MAX_LENGTH);
    expect(validateEbayTitle(padded, new Set())).toEqual([]);
  });

  it("returns an empty string, never throws, when every fact is null", () => {
    expect(buildEbayTitle(facts())).toBe("");
  });
});

describe("validateEbayTitle", () => {
  const verified = verifiedWordsFromFacts(facts({ brand: "Nike", model: "Pegasus 40", productType: "Trainers", primaryColour: "Black" }));

  it("accepts a clean, well-formed title", () => {
    expect(validateEbayTitle("Nike Pegasus 40 Trainers UK 9 Black", verified)).toEqual([]);
  });

  it("flags an empty title", () => {
    expect(validateEbayTitle("", verified).map(i => i.code)).toContain("empty");
  });

  it("flags a title over 80 characters", () => {
    expect(validateEbayTitle("A".repeat(81), new Set()).map(i => i.code)).toContain("too_long");
  });

  it("flags emojis", () => {
    expect(validateEbayTitle("Nike Trainers 🔥", verified).map(i => i.code)).toContain("emoji");
  });

  it("flags unnecessary quotation marks", () => {
    expect(validateEbayTitle('Nike Trainers "Black"', verified).map(i => i.code)).toContain("quotation_marks");
  });

  it("flags excessive punctuation", () => {
    expect(validateEbayTitle("Nike Trainers!!!", verified).map(i => i.code)).toContain("excessive_punctuation");
  });

  it("flags ALL CAPS titles", () => {
    expect(validateEbayTitle("NIKE TRAINERS BLACK", new Set(["nike", "trainers", "black"])).map(i => i.code)).toContain("all_caps");
  });

  it("REQUIREMENT: distinguishes an internal SKU from a manufacturer style code — flags SKU/reference leakage in the title", () => {
    expect(validateEbayTitle("Nike Trainers SKU: 1648", verified).map(i => i.code)).toContain("sku_leakage");
  });

  it("a genuine manufacturer style code is NOT flagged as SKU leakage", () => {
    expect(validateEbayTitle("New Balance 2002R M2002RST", verifiedWordsFromFacts(facts({ brand: "New Balance", model: "2002R", styleCode: "M2002RST" }))).map(i => i.code)).not.toContain("sku_leakage");
  });

  it("flags known Vinted-style bundle/promotional phrasing", () => {
    expect(validateEbayTitle("Nike Trainers bundle discount", verified).map(i => i.code)).toContain("promotional_phrase");
  });

  it("flags a condition phrase in the title", () => {
    expect(validateEbayTitle("Nike Trainers Very Good Condition", verified).map(i => i.code)).toContain("condition_in_title");
  });

  it("flags 'Size UK n' wording (should be 'UK n')", () => {
    expect(validateEbayTitle("Nike Trainers Size UK 9", verified).map(i => i.code)).toContain("size_uk_wording");
  });

  it.each(["wow", "must see", "best", "cheap", "bargain", "look"])("flags the forbidden marketing word '%s'", word => {
    expect(validateEbayTitle(`Nike Trainers ${word}`, verified).map(i => i.code)).toContain("marketing_filler");
  });

  it("flags an adjacent repeated word", () => {
    expect(validateEbayTitle("Nike Trainers Trainers Black", verified).map(i => i.code)).toContain("repeated_adjacent_word");
  });

  it("flags a word repeated 3+ times anywhere in the title", () => {
    expect(validateEbayTitle("Trainers Nike Trainers Black Trainers", verified).map(i => i.code)).toContain("excessive_repetition");
  });

  it("REQUIREMENT: does NOT flag a legitimate word appearing exactly twice in different, non-adjacent fields (e.g. 'Running' from brand and product type)", () => {
    const runningVerified = verifiedWordsFromFacts(facts({ brand: "On Running", model: "Cloud 5", productType: "Running Trainers" }));
    const issues = validateEbayTitle("On Running Cloud 5 Womens UK 4 Blue White Mesh Running Trainers", runningVerified);
    expect(issues.map(i => i.code)).not.toContain("excessive_repetition");
    expect(issues.map(i => i.code)).not.toContain("repeated_adjacent_word");
  });

  it("REQUIREMENT (adversarial, no invented fields): flags a brand not present in verified facts", () => {
    const issues = validateEbayTitle("Adidas Trainers", verified);
    expect(issues.map(i => i.code)).toContain("unverified_claim");
  });

  it("REQUIREMENT (adversarial): flags a model claim not present in verified facts", () => {
    const issues = validateEbayTitle("Nike Zoomfly Elite Trainers", verified);
    expect(issues.map(i => i.code)).toContain("unverified_claim");
  });

  it("never flags ordinary structural words (UK, New, Used, Sealed) as unverified", () => {
    const issues = validateEbayTitle("Nike Trainers UK New Sealed", verified);
    expect(issues.map(i => i.code)).not.toContain("unverified_claim");
  });

  it("skips the unverified-claim check entirely when no verified words were supplied (e.g. a pure length/format test)", () => {
    expect(validateEbayTitle("Anything Goes Here", new Set())).toEqual([]);
  });
});
