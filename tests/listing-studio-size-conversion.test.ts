import { describe, expect, it } from "vitest";
import {
  convertSourceSizeToUk, deriveUkSizeFromSource,
  SUPPORTED_SIZE_CONVERSION_BRANDS, EXCLUDED_BRANDS_NO_OFFICIAL_DATA,
} from "@/lib/listing-studio/size-conversion";
import { generateListingTitle, generateListingDescription } from "@/lib/listing-studio/listing-template";

describe("SUPPORTED_SIZE_CONVERSION_BRANDS — brands with a verified, sourced brand-specific table", () => {
  it("exposes exactly the brands whose official size chart could be verified", () => {
    expect(SUPPORTED_SIZE_CONVERSION_BRANDS.sort()).toEqual(
      ["adidas", "asics", "salomon", "birkenstock", "nike", "new balance", "timberland", "dr martens", "crocs", "merrell", "clarks"].sort(),
    );
  });

  it("EXCLUDED_BRANDS_NO_OFFICIAL_DATA lists exactly the brands where two research passes found no accessible official chart", () => {
    expect([...EXCLUDED_BRANDS_NO_OFFICIAL_DATA].sort()).toEqual(["on", "hoka", "ugg"].sort());
    // None of these appear in the supported list either.
    for (const brand of EXCLUDED_BRANDS_NO_OFFICIAL_DATA) expect(SUPPORTED_SIZE_CONVERSION_BRANDS).not.toContain(brand);
  });
});

describe("deriveUkSizeFromSource — a directly observed UK size always wins, never converted", () => {
  it("UK visible, no brand needed at all → used directly, provenance 'observed'", () => {
    expect(deriveUkSizeFromSource({ brand: null, sourceSizeSystem: "UK", sourceSizeValue: "9", sourceSizeGender: null }))
      .toEqual({ ukSize: "9", provenance: "observed" });
  });

  it("UK visible with a brand present too → still used directly, no conversion attempted", () => {
    expect(deriveUkSizeFromSource({ brand: "Nike", sourceSizeSystem: "UK", sourceSizeValue: "8.5", sourceSizeGender: null }))
      .toEqual({ ukSize: "8.5", provenance: "observed" });
  });

  it("REGRESSION (manual UK size protection is enforced at the route layer, not here): this function never sees or overwrites a manually-entered value — it only ever computes what generation WOULD derive; the generate route's own precedence (draft.uk_size ?? derived.ukSize) is what actually protects a manual entry, covered in the api-routes test suite", () => {
    // Sanity: even with a brand/system/value that WOULD convert, this function has no notion of "existing" state to protect — that's the caller's job.
    const derived = deriveUkSizeFromSource({ brand: "Nike", sourceSizeSystem: "EU", sourceSizeValue: "38", sourceSizeGender: "mens" });
    expect(derived).toEqual({ ukSize: "5", provenance: "brand_converted" });
  });

  it("REGRESSION: a partial/inconsistent source-size pair (one of system/value present without the other) leaves ukSize blank rather than guessing", () => {
    expect(deriveUkSizeFromSource({ brand: "Nike", sourceSizeSystem: "EU", sourceSizeValue: null, sourceSizeGender: null })).toEqual({ ukSize: null, provenance: null });
    expect(deriveUkSizeFromSource({ brand: "Nike", sourceSizeSystem: null, sourceSizeValue: "44", sourceSizeGender: null })).toEqual({ ukSize: null, provenance: null });
    expect(deriveUkSizeFromSource({ brand: "Nike", sourceSizeSystem: null, sourceSizeValue: null, sourceSizeGender: null })).toEqual({ ukSize: null, provenance: null });
  });
});

describe("Brand-specific conversions — verified against each brand's own official site", () => {
  it("Birkenstock: EU (gender-invariant 'unisex' chart, joined via an explicit shared key — matching foot-length-mm bins across official UK/EU pages, confirmed by Birkenstock's own product-variation API which pairs UK;EU directly)", () => {
    expect(convertSourceSizeToUk({ brand: "Birkenstock", system: "EU", value: "42", category: "unisex" }))
      .toEqual({ ukSize: "8", provenance: "brand_converted" });
  });

  it("Birkenstock: US differs by gender for the same physical shoe (published as a half-size range per row) — mens and womens US tables convert independently", () => {
    expect(convertSourceSizeToUk({ brand: "Birkenstock", system: "US", value: "9", category: "mens" }))
      .toEqual({ ukSize: "8", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Birkenstock", system: "US", value: "9", category: "womens" }))
      .toEqual({ ukSize: "7", provenance: "brand_converted" });
  });

  it("Salomon: verified brand-specific EU conversion (Men's/Women's standalone tables, not the internally-inconsistent combined 'unisex' table)", () => {
    expect(convertSourceSizeToUk({ brand: "Salomon", system: "EU", value: "42", category: "mens" }))
      .toEqual({ ukSize: "8", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Salomon", system: "EU", value: "38", category: "womens" }))
      .toEqual({ ukSize: "5", provenance: "brand_converted" });
  });

  it("Salomon: EU sizes are printed as thirds on the label (e.g. \"42 2/3\") — kept exactly as published, matched exactly, not rounded", () => {
    expect(convertSourceSizeToUk({ brand: "Salomon", system: "EU", value: "42 2/3", category: "mens" }))
      .toEqual({ ukSize: "8.5", provenance: "brand_converted" });
  });

  it("Adidas: EU is gender-invariant ('unisex') — resolves without needing a category at all", () => {
    expect(convertSourceSizeToUk({ brand: "Adidas", system: "EU", value: "42", category: null }))
      .toEqual({ ukSize: "8", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Adidas", system: "EU", value: "42 2/3", category: "mens" }))
      .toEqual({ ukSize: "8.5", provenance: "brand_converted" });
  });

  it("Adidas: the US label differs by gender for the same physical shoe (Men's vs Women's convention) — genuinely ambiguous without gender stated", () => {
    expect(convertSourceSizeToUk({ brand: "Adidas", system: "US", value: "9", category: "mens" }))
      .toEqual({ ukSize: "8.5", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Adidas", system: "US", value: "9", category: "womens" }))
      .toEqual({ ukSize: "7.5", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Adidas", system: "US", value: "9", category: null }))
      .toEqual({ ukSize: null, provenance: null });
  });

  it("ASICS: verified brand-specific conversion, separate mens/womens (ASICS' own combined cross-reference columns disagree with each table's own direct data, so only each table's own column is used)", () => {
    expect(convertSourceSizeToUk({ brand: "ASICS", system: "EU", value: "42", category: "mens" }))
      .toEqual({ ukSize: "7.5", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "ASICS", system: "EU", value: "42", category: "womens" }))
      .toEqual({ ukSize: "8", provenance: "brand_converted" });
  });

  it("Timberland: EU-only conversion uses the verified brand-specific table", () => {
    expect(convertSourceSizeToUk({ brand: "Timberland", system: "EU", value: "41", category: "mens" }))
      .toEqual({ ukSize: "7", provenance: "brand_converted" });
  });

  it("Timberland: US-only conversion uses the verified brand-specific table", () => {
    expect(convertSourceSizeToUk({ brand: "Timberland", system: "US", value: "7.5", category: "mens" }))
      .toEqual({ ukSize: "7", provenance: "brand_converted" });
  });

  it("Dr Martens: verified brand-specific conversion", () => {
    expect(convertSourceSizeToUk({ brand: "Dr Martens", system: "EU", value: "39", category: "womens" }))
      .toEqual({ ukSize: "6", provenance: "brand_converted" });
  });

  it("Crocs: verified brand-specific conversion for an EU value the strict no-collision rule keeps (36-37 range never collides with a neighbour)", () => {
    expect(convertSourceSizeToUk({ brand: "Crocs", system: "EU", value: "41", category: "mens" }))
      .toEqual({ ukSize: "7", provenance: "brand_converted" });
  });

  it("Merrell: verified brand-specific conversion, including its childrens table — the one brand whose Little/Big kids charts were confirmed genuinely non-overlapping", () => {
    expect(convertSourceSizeToUk({ brand: "Merrell", system: "EU", value: "41", category: "mens" }))
      .toEqual({ ukSize: "7", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Merrell", system: "EU", value: "30", category: "childrens" }))
      .toEqual({ ukSize: "11", provenance: "brand_converted" });
  });

  it("Clarks: verified brand-specific EU conversion; no US table at all (a confirmed gap on Clarks' own official size guide, not an omission here) — a US request falls through to the generic fallback instead of being unsupported", () => {
    expect(convertSourceSizeToUk({ brand: "Clarks", system: "EU", value: "42", category: "mens" }))
      .toEqual({ ukSize: "8", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Clarks", system: "US", value: "9", category: "mens" }))
      .toEqual({ ukSize: "8.5", provenance: "fallback_converted" });
  });

  it("On, Hoka, UGG: no official data was obtainable — an EU/US size still resolves via the generic fallback rather than being flatly unsupported", () => {
    expect(convertSourceSizeToUk({ brand: "On", system: "US", value: "9", category: "mens" }))
      .toEqual({ ukSize: "8.5", provenance: "fallback_converted" });
    expect(convertSourceSizeToUk({ brand: "Hoka", system: "US", value: "9", category: "womens" }))
      .toEqual({ ukSize: "7", provenance: "fallback_converted" });
    expect(convertSourceSizeToUk({ brand: "UGG", system: "US", value: "9", category: "mens" }))
      .toEqual({ ukSize: "8.5", provenance: "fallback_converted" });
  });

  it("REGRESSION: a brand whose mens/womens numbers genuinely diverge, with no category stated, leaves ukSize blank rather than guessing", () => {
    // Nike mens EU38 = UK5, womens EU38 = UK4.5 — a real, meaningful difference.
    expect(convertSourceSizeToUk({ brand: "Nike", system: "EU", value: "38", category: null })).toEqual({ ukSize: null, provenance: null });
  });

  it("...but resolves correctly once category is explicitly stated", () => {
    expect(convertSourceSizeToUk({ brand: "Nike", system: "EU", value: "38", category: "mens" })).toEqual({ ukSize: "5", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "Nike", system: "EU", value: "38", category: "womens" })).toEqual({ ukSize: "4.5", provenance: "brand_converted" });
  });

  it("brand matching is case/whitespace-insensitive", () => {
    expect(convertSourceSizeToUk({ brand: "  NIKE  ", system: "EU", value: "38", category: "mens" })).toEqual({ ukSize: "5", provenance: "brand_converted" });
    expect(convertSourceSizeToUk({ brand: "new balance", system: "US", value: "10", category: "mens" })).toEqual({ ukSize: "9.5", provenance: "brand_converted" });
  });
});

describe("NO ARBITRARY COLLISION RESOLUTION — a same-source-value collision is ambiguous and blank, never resolved by picking higher/lower", () => {
  it("REGRESSION: the generic mens/unisex EU fallback used to resolve whole-UK-size collisions by picking the higher UK size (e.g. EU41 used to return UK7.5) — that heuristic is gone; EU41 now has 3 genuine UK claimants (7, 7.5, 8) and must be blank", () => {
    expect(convertSourceSizeToUk({ brand: null, system: "EU", value: "41", category: "unisex" })).toEqual({ ukSize: null, provenance: null });
  });

  it("REGRESSION: the generic womens EU fallback likewise no longer resolves its range collisions — EU40 (claimed by UK7, UK7.5, and UK8) is blank, not the previously-picked higher value", () => {
    expect(convertSourceSizeToUk({ brand: null, system: "EU", value: "40", category: "womens" })).toEqual({ ukSize: null, provenance: null });
  });

  it("REGRESSION: Crocs' EU37 used to resolve to UK4 under the higher-wins rule — EU37 is genuinely claimed by both UK3 and UK4 on Crocs' own published ranges and must now be blank", () => {
    expect(convertSourceSizeToUk({ brand: "Crocs", system: "EU", value: "37", category: "mens" })).toEqual({ ukSize: null, provenance: null });
  });

  it("the ONLY generic mens/unisex EU value that survives is the one entirely free of collision (EU38, the very first row, with no lower neighbour to collide with)", () => {
    expect(convertSourceSizeToUk({ brand: null, system: "EU", value: "38", category: "unisex" })).toEqual({ ukSize: "5", provenance: "fallback_converted" });
  });

  it("the ONLY generic womens EU value that survives is EU45 (the very last row, with no higher neighbour to collide with)", () => {
    expect(convertSourceSizeToUk({ brand: null, system: "EU", value: "45", category: "womens" })).toEqual({ ukSize: "12", provenance: "fallback_converted" });
  });

  it("the generic fallback's US columns have no ranges at all and remain fully populated — ambiguity only ever arises from a brand/source publishing a range", () => {
    expect(convertSourceSizeToUk({ brand: null, system: "US", value: "9", category: "mens" })).toEqual({ ukSize: "8.5", provenance: "fallback_converted" });
    expect(convertSourceSizeToUk({ brand: null, system: "US", value: "9", category: "womens" })).toEqual({ ukSize: "7", provenance: "fallback_converted" });
  });
});

describe("Generic fallback table — separated by category, never one universal chart across footwear categories", () => {
  it("unknown brand, mens/unisex category, exact unambiguous value → resolves via the mens/unisex fallback table", () => {
    expect(convertSourceSizeToUk({ brand: "SomeRandomBrand", system: "US", value: "9", category: "mens" }))
      .toEqual({ ukSize: "8.5", provenance: "fallback_converted" });
    expect(convertSourceSizeToUk({ brand: null, system: "US", value: "9", category: "unisex" }))
      .toEqual({ ukSize: "8.5", provenance: "fallback_converted" });
  });

  it("unknown brand, womens category, exact unambiguous value → resolves via the distinct womens fallback table, not the mens/unisex one", () => {
    expect(convertSourceSizeToUk({ brand: "SomeRandomBrand", system: "US", value: "9", category: "womens" }))
      .toEqual({ ukSize: "7", provenance: "fallback_converted" });
  });

  it("unknown brand, childrens category, exact unambiguous value → resolves via the distinct childrens fallback table", () => {
    expect(convertSourceSizeToUk({ brand: "SomeRandomBrand", system: "EU", value: "24", category: "childrens" }))
      .toEqual({ ukSize: "7", provenance: "fallback_converted" });
  });

  it("REGRESSION: unknown brand, no category stated at all → genuinely ambiguous (mens/unisex vs womens is a real fork with nothing to narrow it), blank rather than guessed", () => {
    expect(convertSourceSizeToUk({ brand: "SomeRandomBrand", system: "US", value: "9", category: null }))
      .toEqual({ ukSize: null, provenance: null });
  });

  it("unknown brand, ambiguous fallback collision (a source value with more than one UK claimant) → blank even though category IS known", () => {
    // EU41 mens/unisex has 3 real claimants under the fallback's own source data — ambiguous regardless of category being stated.
    expect(convertSourceSizeToUk({ brand: "SomeRandomBrand", system: "EU", value: "41", category: "mens" }))
      .toEqual({ ukSize: null, provenance: null });
  });

  it("the same raw US value converts to a genuinely different UK size depending on category — proves this isn't one universal chart", () => {
    const mens = convertSourceSizeToUk({ brand: null, system: "US", value: "9", category: "mens" });
    const womens = convertSourceSizeToUk({ brand: null, system: "US", value: "9", category: "womens" });
    expect(mens.ukSize).toBe("8.5");
    expect(womens.ukSize).toBe("7");
    expect(mens.ukSize).not.toBe(womens.ukSize);
  });

  it("brand-specific lookup failing for ANY reason (brand unlisted, or brand known but this system/category/value simply isn't covered) falls through to the fallback, never leaves a supported fallback size blank", () => {
    // Nike has no childrens table at all — falls through rather than being unsupported.
    expect(convertSourceSizeToUk({ brand: "Nike", system: "EU", value: "24", category: "childrens" }))
      .toEqual({ ukSize: "7", provenance: "fallback_converted" });
  });
});

describe("Never interpolates — exact match only, at either tier", () => {
  it("an unsupported exact size (present in no table, brand or fallback) leaves ukSize blank", () => {
    expect(convertSourceSizeToUk({ brand: "Nike", system: "EU", value: "99", category: "mens" }))
      .toEqual({ ukSize: null, provenance: null });
  });

  it("never rounds/interpolates a value between two real, adjacent table entries", () => {
    // Nike mens EU44 = UK9 and EU44.5 = UK9.5 are both real entries; EU44.25 is not.
    expect(convertSourceSizeToUk({ brand: "Nike", system: "EU", value: "44.25", category: "mens" }))
      .toEqual({ ukSize: null, provenance: null });
  });
});

describe("A converted UK size flows into title/description exactly the same way an observed one does", () => {
  it("a brand-converted UK size produces an identical title/description shape to a directly observed one", () => {
    const converted = deriveUkSizeFromSource({ brand: "Merrell", sourceSizeSystem: "EU", sourceSizeValue: "41", sourceSizeGender: "mens" });
    const observedFields = { brand: "Merrell", model: "Moab 3", productType: "Trainers", colour: "Black & Grey", ukSize: "7", sku: "1648" };
    const convertedFields = { ...observedFields, ukSize: converted.ukSize };

    expect(converted).toEqual({ ukSize: "7", provenance: "brand_converted" });
    expect(generateListingTitle(convertedFields)).toBe(generateListingTitle(observedFields));
    expect(generateListingDescription(convertedFields)).toBe(generateListingDescription(observedFields));
    expect(generateListingTitle(convertedFields)).toContain("Size UK 7");
  });

  it("a blank (unsupported/ambiguous) conversion degrades the title/description exactly the same way a directly-unread UK size already does", () => {
    const blank = deriveUkSizeFromSource({ brand: "SomeRandomBrand", sourceSizeSystem: "US", sourceSizeValue: "9", sourceSizeGender: null });
    const fieldsWithBlank = { brand: "SomeRandomBrand", model: "Whatever", productType: "Trainers", colour: "Black", ukSize: blank.ukSize, sku: "1648" };
    const fieldsWithDirectlyUnreadUkSize = { ...fieldsWithBlank, ukSize: null };

    expect(blank).toEqual({ ukSize: null, provenance: null });
    expect(generateListingTitle(fieldsWithBlank)).toBe(generateListingTitle(fieldsWithDirectlyUnreadUkSize));
    expect(generateListingTitle(fieldsWithBlank)).not.toContain("Size UK");
  });
});
