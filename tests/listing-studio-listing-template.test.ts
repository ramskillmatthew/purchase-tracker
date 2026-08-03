import { describe, expect, it } from "vitest";
import { generateListingTitle, generateListingDescription, LISTING_CONDITION_TEXT, type GeneratedListingFields } from "@/lib/listing-studio/listing-template";

function fields(overrides: Partial<GeneratedListingFields> = {}): GeneratedListingFields {
  return { brand: null, model: null, productType: null, colour: null, ukSize: null, sku: null, ...overrides };
}

describe("generateListingTitle — exact template: Brand Model Product Type - \"Colour\" - Very Good Condition - Size UK X", () => {
  it("reproduces the exact given example: On Cloudmonster Running Trainers", () => {
    const title = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colour: "White & Blue", ukSize: "10.5" }));
    expect(title).toBe('On Cloudmonster Running Trainers - "White & Blue" - Very Good Condition - Size UK 10.5');
  });

  it("reproduces the exact given example: Nike Pegasus Trail 5 Trainers", () => {
    const title = generateListingTitle(fields({ brand: "Nike", model: "Pegasus Trail 5", productType: "Trainers", colour: "Black & White", ukSize: "6" }));
    expect(title).toBe('Nike Pegasus Trail 5 Trainers - "Black & White" - Very Good Condition - Size UK 6');
  });

  it("reproduces the exact given example: Nike React Vision DSMX Trainers", () => {
    const title = generateListingTitle(fields({ brand: "Nike", model: "React Vision DSMX", productType: "Trainers", colour: "White Yellow Black", ukSize: "10" }));
    expect(title).toBe('Nike React Vision DSMX Trainers - "White Yellow Black" - Very Good Condition - Size UK 10');
  });

  it("always includes the exact, unvarying condition text", () => {
    const title = generateListingTitle(fields({ brand: "Adidas", model: "Samba", productType: "Trainers", colour: "Black", ukSize: "9" }));
    expect(title).toContain(LISTING_CONDITION_TEXT);
    expect(LISTING_CONDITION_TEXT).toBe("Very Good Condition");
  });

  it("REGRESSION: gracefully omits the Size UK segment when ukSize is blank, rather than producing 'Size UK ' with nothing after it", () => {
    const title = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colour: "White & Blue", ukSize: null }));
    expect(title).toBe('On Cloudmonster Running Trainers - "White & Blue" - Very Good Condition');
    expect(title).not.toContain("Size UK");
  });

  it("REGRESSION: gracefully omits the colour segment when colour is blank, rather than a bare pair of quotes", () => {
    const title = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colour: null, ukSize: "10" }));
    expect(title).toBe("On Cloudmonster Running Trainers - Very Good Condition - Size UK 10");
    expect(title).not.toContain('""');
  });

  it("REGRESSION: gracefully joins only whichever of brand/model/productType are present, never a double space for a missing one", () => {
    const title = generateListingTitle(fields({ brand: "On", model: null, productType: "Running Trainers", colour: "White & Blue", ukSize: "10" }));
    expect(title).toBe('On Running Trainers - "White & Blue" - Very Good Condition - Size UK 10');
    expect(title).not.toMatch(/ {2}/);
  });

  it("still produces a usable title (just the condition) when every structured field is blank", () => {
    const title = generateListingTitle(fields());
    expect(title).toBe("Very Good Condition");
  });

  it("treats an empty/whitespace-only string the same as null (never a stray blank segment)", () => {
    const title = generateListingTitle(fields({ brand: "On", model: "  ", productType: "Running Trainers", colour: "", ukSize: "10" }));
    expect(title).toBe('On Running Trainers - Very Good Condition - Size UK 10');
  });
});

describe("generateListingDescription — byte-for-byte template except UK size and SKU", () => {
  it("substitutes only UK size and SKU, leaving every other paragraph exactly as given", () => {
    const description = generateListingDescription({ ukSize: "10.5", sku: "1648" });
    const paragraphs = description.split("\n\n\n\n\n");
    expect(paragraphs).toEqual([
      "Size - UK 10.5",
      "Condition: Very Good Condition, Minor signs of use as pictured ✅",
      "Doesn't come with original packaging ✅",
      "Always authentic & trusted seller ✅",
      "\u{1F3B1}10-20% Discount for Bundles, have a look!",
      "\u{1F69A}Everything sent Same day or Next day of purchasing\u{1F4E6}",
      "Please look at my other items, loads of other Rab, north face, mountain equipment, on clouds, ASICS, Ralph Lauren and adidas available",
      "SKU: 1648",
    ]);
  });

  it("REGRESSION: substitutes an empty string for a blank UK size/SKU (never conditionally omitting the line)", () => {
    const description = generateListingDescription({ ukSize: null, sku: null });
    const paragraphs = description.split("\n\n\n\n\n");
    expect(paragraphs[0]).toBe("Size - UK ");
    expect(paragraphs[paragraphs.length - 1]).toBe("SKU: ");
  });

  it("never varies the fixed condition/packaging/authenticity/discount/shipping/cross-sell paragraphs regardless of input", () => {
    const a = generateListingDescription({ ukSize: "6", sku: "1111" });
    const b = generateListingDescription({ ukSize: "12", sku: "2222" });
    const fixedParagraphs = (text: string) => text.split("\n\n\n\n\n").slice(1, -1);
    expect(fixedParagraphs(a)).toEqual(fixedParagraphs(b));
  });

  it("is a pure function — same input always produces the exact same output", () => {
    const a = generateListingDescription({ ukSize: "9", sku: "1234" });
    const b = generateListingDescription({ ukSize: "9", sku: "1234" });
    expect(a).toBe(b);
  });
});

describe("regeneration without another AI call", () => {
  it("REGRESSION: re-running generateListingTitle/generateListingDescription against the same stored structured fields always reproduces the identical listing text — no AI call, no randomness, no hidden state", () => {
    const stored = fields({ brand: "Hoka", model: "Clifton 9", productType: "Running Trainers", colour: "Black & Orange", ukSize: "8", sku: "1900" });
    const title1 = generateListingTitle(stored);
    const title2 = generateListingTitle(stored);
    const description1 = generateListingDescription(stored);
    const description2 = generateListingDescription(stored);
    expect(title1).toBe(title2);
    expect(description1).toBe(description2);
  });

  it("editing one structured field changes only the parts of the title/description that field affects", () => {
    const before = fields({ brand: "Hoka", model: "Clifton 9", productType: "Running Trainers", colour: "Black & Orange", ukSize: "8", sku: "1900" });
    const after = { ...before, ukSize: "9" };
    expect(generateListingTitle(before)).toContain("Size UK 8");
    expect(generateListingTitle(after)).toContain("Size UK 9");
    expect(generateListingDescription(before)).toContain("Size - UK 8");
    expect(generateListingDescription(after)).toContain("Size - UK 9");
    // Nothing else in the title changed.
    expect(generateListingTitle(before).replace("Size UK 8", "Size UK 9")).toBe(generateListingTitle(after));
  });
});
