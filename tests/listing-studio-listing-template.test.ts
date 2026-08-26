import { describe, expect, it } from "vitest";
import { generateListingTitle, generateListingDescription, LISTING_CONDITION_TEXT, type GeneratedListingFields } from "@/lib/listing-studio/listing-template";

function fields(overrides: Partial<GeneratedListingFields> = {}): GeneratedListingFields {
  return { brand: null, model: null, productType: null, colours: [], material: null, ukSize: null, sku: null, ...overrides };
}

describe("generateListingTitle — exact template: Brand Model Product Type - \"Colour\" - Very Good Condition - Size UK X", () => {
  it("reproduces the exact given example: On Cloudmonster Running Trainers", () => {
    const title = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colours: ["White", "Blue"], ukSize: "10.5" }));
    expect(title).toBe('On Cloudmonster Running Trainers - "White & Blue" - Very Good Condition - Size UK 10.5');
  });

  it("reproduces the exact given example: Nike Pegasus Trail 5 Trainers", () => {
    const title = generateListingTitle(fields({ brand: "Nike", model: "Pegasus Trail 5", productType: "Trainers", colours: ["Black", "White"], ukSize: "6" }));
    expect(title).toBe('Nike Pegasus Trail 5 Trainers - "Black & White" - Very Good Condition - Size UK 6');
  });

  it("a single colour renders with no '&' at all", () => {
    const title = generateListingTitle(fields({ brand: "Nike", model: "React Vision DSMX", productType: "Trainers", colours: ["Yellow"], ukSize: "10" }));
    expect(title).toBe('Nike React Vision DSMX Trainers - "Yellow" - Very Good Condition - Size UK 10');
  });

  it("always includes the exact, unvarying condition text", () => {
    const title = generateListingTitle(fields({ brand: "Adidas", model: "Samba", productType: "Trainers", colours: ["Black"], ukSize: "9" }));
    expect(title).toContain(LISTING_CONDITION_TEXT);
    expect(LISTING_CONDITION_TEXT).toBe("Very Good Condition");
  });

  it("REGRESSION: gracefully omits the Size UK segment when ukSize is blank, rather than producing 'Size UK ' with nothing after it", () => {
    const title = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colours: ["White", "Blue"], ukSize: null }));
    expect(title).toBe('On Cloudmonster Running Trainers - "White & Blue" - Very Good Condition');
    expect(title).not.toContain("Size UK");
  });

  describe("Milestone 6 (Vinted-aware colours) — title generation using the new colours array", () => {
    it("REGRESSION: gracefully omits the colour segment entirely when colours is an empty array, rather than a bare pair of quotes", () => {
      const title = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colours: [], ukSize: "10" }));
      expect(title).toBe("On Cloudmonster Running Trainers - Very Good Condition - Size UK 10");
      expect(title).not.toContain('""');
    });

    it("two colours are joined with the exact same ' & ' the old free-text convention used", () => {
      const title = generateListingTitle(fields({ brand: "Nike", model: "Air Max", productType: "Trainers", colours: ["Cream", "Grey"], ukSize: "7" }));
      expect(title).toBe('Nike Air Max Trainers - "Cream & Grey" - Very Good Condition - Size UK 7');
    });

    it("Multi and Clear (the enum's special-case colours) render exactly like any other colour", () => {
      expect(generateListingTitle(fields({ brand: "Nike", model: "Dunk", productType: "Trainers", colours: ["Multi"], ukSize: "8" })))
        .toContain('"Multi"');
      expect(generateListingTitle(fields({ brand: "Crocs", model: "Classic Clog", productType: "Sandals", colours: ["Clear"], ukSize: "6" })))
        .toContain('"Clear"');
    });

    it("material never appears in the title at all, regardless of whether it's set", () => {
      const withMaterial = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colours: ["Black"], material: "Mesh", ukSize: "10" }));
      const withoutMaterial = generateListingTitle(fields({ brand: "On", model: "Cloudmonster", productType: "Running Trainers", colours: ["Black"], material: null, ukSize: "10" }));
      expect(withMaterial).toBe(withoutMaterial);
      expect(withMaterial).not.toContain("Mesh");
    });
  });

  it("REGRESSION: gracefully joins only whichever of brand/model/productType are present, never a double space for a missing one", () => {
    const title = generateListingTitle(fields({ brand: "On", model: null, productType: "Running Trainers", colours: ["White", "Blue"], ukSize: "10" }));
    expect(title).toBe('On Running Trainers - "White & Blue" - Very Good Condition - Size UK 10');
    expect(title).not.toMatch(/ {2}/);
  });

  it("still produces a usable title (just the condition) when every structured field is blank", () => {
    const title = generateListingTitle(fields());
    expect(title).toBe("Very Good Condition");
  });

  it("treats an empty/whitespace-only string the same as null (never a stray blank segment)", () => {
    const title = generateListingTitle(fields({ brand: "On", model: "  ", productType: "Running Trainers", colours: [], ukSize: "10" }));
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

  it("REGRESSION: never references colours or material — this Pick<...> type doesn't even accept them", () => {
    const description = generateListingDescription({ ukSize: "9", sku: "1234" });
    expect(description).not.toMatch(/colour|material/i);
  });

  it("business-rule follow-up correction: structurally can never carry children's audience wording (Youth/Kids/Junior/Boys/Girls/Child/Children) — the template only ever substitutes ukSize and sku, never brand/model/productType, for ANY input including a raw un-cleaned SKU/size", () => {
    const description = generateListingDescription({ ukSize: "3", sku: "YOUTH-1648" }); // even an unusual literal SKU value
    // Only the SKU line itself may legitimately contain the substring — the
    // rest of the fixed template text never can, by construction.
    const [, ...fixedParagraphs] = description.split("\n\n\n\n\n");
    const skuParagraph = fixedParagraphs.pop();
    expect(fixedParagraphs.join(" ")).not.toMatch(/\b(youth|kids?|juniors?|boys?|girls?|child(ren)?)\b/i);
    expect(skuParagraph).toBe("SKU: YOUTH-1648");
  });
});

describe("regeneration without another AI call", () => {
  it("REGRESSION: re-running generateListingTitle/generateListingDescription against the same stored structured fields always reproduces the identical listing text — no AI call, no randomness, no hidden state", () => {
    const stored = fields({ brand: "Hoka", model: "Clifton 9", productType: "Running Trainers", colours: ["Black", "Orange"], material: "Mesh", ukSize: "8", sku: "1900" });
    const title1 = generateListingTitle(stored);
    const title2 = generateListingTitle(stored);
    const description1 = generateListingDescription(stored);
    const description2 = generateListingDescription(stored);
    expect(title1).toBe(title2);
    expect(description1).toBe(description2);
  });

  it("editing one structured field changes only the parts of the title/description that field affects", () => {
    const before = fields({ brand: "Hoka", model: "Clifton 9", productType: "Running Trainers", colours: ["Black", "Orange"], ukSize: "8", sku: "1900" });
    const after = { ...before, ukSize: "9" };
    expect(generateListingTitle(before)).toContain("Size UK 8");
    expect(generateListingTitle(after)).toContain("Size UK 9");
    expect(generateListingDescription(before)).toContain("Size - UK 8");
    expect(generateListingDescription(after)).toContain("Size - UK 9");
    // Nothing else in the title changed.
    expect(generateListingTitle(before).replace("Size UK 8", "Size UK 9")).toBe(generateListingTitle(after));
  });

  it("editing colours changes only the colour segment of the title", () => {
    const before = fields({ brand: "Hoka", model: "Clifton 9", productType: "Running Trainers", colours: ["Black", "Orange"], ukSize: "8" });
    const after = { ...before, colours: ["Cream", "Grey"] };
    expect(generateListingTitle(before)).toContain('"Black & Orange"');
    expect(generateListingTitle(after)).toContain('"Cream & Grey"');
    expect(generateListingTitle(before).replace('"Black & Orange"', '"Cream & Grey"')).toBe(generateListingTitle(after));
  });
});
