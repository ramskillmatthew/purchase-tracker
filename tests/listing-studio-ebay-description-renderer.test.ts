import { describe, expect, it } from "vitest";
import {
  renderEbayDescription, resolveEbayConditionText, EBAY_STANDARD_PREOWNED_CONDITION_TEXT,
  type EbayDescriptionFacts,
} from "@/lib/listing-studio/ebay-description-renderer";
import { validateEbayDescription } from "@/lib/listing-studio/ebay-description-validator";

function facts(overrides: Partial<EbayDescriptionFacts> = {}): EbayDescriptionFacts {
  return {
    brand: null, model: null, gender: null, productType: null, ukShoeSize: null, clothingSize: null,
    primaryColour: null, secondaryColour: null, material: null, styleCode: null, internalSku: null,
    includesText: null, itemFamily: "footwear", conditionText: EBAY_STANDARD_PREOWNED_CONDITION_TEXT,
    ...overrides,
  };
}

// Product spec's own exact, verbatim required example — the primary
// snapshot test for this renderer.
const NEW_BALANCE_EXAMPLE = `New Balance 2002R Men's Trainers – UK 9

Genuine New Balance 2002R trainers in grey, UK size 9.

Condition: Very good pre-owned condition. Light signs of previous wear as shown in the photographs.

Details
• Model: 2002R
• Size: UK 9
• Colour: Grey
• Style code: M2002RST
• Includes: Trainers only
• SKU: 1648

Please review all photographs carefully as they form part of the condition description.

Orders are securely packaged and dispatched promptly.`;

describe("renderEbayDescription — EXACT snapshot: product spec's own New Balance 2002R example", () => {
  it("reproduces the required template byte-for-byte, including spacing, bullet ordering, and the final SKU bullet", () => {
    const description = renderEbayDescription(facts({
      brand: "New Balance", model: "2002R", gender: "mens", productType: "Trainers", ukShoeSize: "9",
      primaryColour: "Grey", styleCode: "M2002RST", internalSku: "1648",
    }));
    expect(description).toBe(NEW_BALANCE_EXAMPLE);
  });

  it("blank line separates every logical section (headline / genuine sentence / condition / Details / photo note / dispatch note)", () => {
    const description = renderEbayDescription(facts({
      brand: "New Balance", model: "2002R", gender: "mens", productType: "Trainers", ukShoeSize: "9",
      primaryColour: "Grey", styleCode: "M2002RST", internalSku: "1648",
    }));
    const blocks = description.split("\n\n");
    expect(blocks.length).toBe(6);
  });

  it("REQUIREMENT: never contains markdown markers, matching the reported bug (\"**Key Details**\" headers)", () => {
    const description = renderEbayDescription(facts({ brand: "Nike", model: "Pegasus", productType: "Trainers", ukShoeSize: "9" }));
    expect(description).not.toContain("**");
    expect(description).not.toMatch(/^#{1,6}\s/m);
  });

  it("REQUIREMENT: never contains Vinted-style boilerplate — this renderer has no free-form prose to leak it", () => {
    const description = renderEbayDescription(facts({ brand: "Nike", model: "Pegasus", productType: "Trainers", ukShoeSize: "9", internalSku: "1648" }));
    expect(validateEbayDescription(description).map(i => i.code)).not.toContain("vinted_boilerplate");
    expect(description.toLowerCase()).not.toContain("bundle");
    expect(description.toLowerCase()).not.toContain("look at my other");
  });
});

// The real reported product, exactly as specified: On Running Cloud 5,
// Women's, UK 4, Blue & White, Mesh, no manufacturer style code
// confidently known, internal SKU 1644. Every blank line below is a real
// blank line in the source — this is a byte-for-byte required shape, not
// an illustrative example.
const ON_RUNNING_CLOUD_5_EXAMPLE = `On Running Cloud 5 Women's Trainers – UK 4

Genuine On Running Cloud 5 trainers in blue and white, UK size 4.

Condition: Very good pre-owned condition. Light signs of previous wear as shown in the photographs.

Details
• Model: Cloud 5
• Size: UK 4
• Colour: Blue & White
• Material: Mesh
• Includes: Trainers only
• SKU: 1644

Please review all photographs carefully as they form part of the condition description.

Orders are securely packaged and dispatched promptly.`;

describe("renderEbayDescription — EXACT snapshot: the real reported On Running Cloud 5 product (Blue & White, Mesh, SKU 1644)", () => {
  const description = renderEbayDescription(facts({
    brand: "On Running", model: "Cloud 5", gender: "womens", productType: "Trainers", ukShoeSize: "4",
    primaryColour: "Blue", secondaryColour: "White", material: "Mesh", internalSku: "1644",
  }));

  it("reproduces the required template byte-for-byte, including every blank line", () => {
    expect(description).toBe(ON_RUNNING_CLOUD_5_EXAMPLE);
  });

  it("checks every newline explicitly — never merely that the sentences exist somewhere in the string", () => {
    // Exactly 6 logical blocks, joined by exactly ONE blank line each (a
    // literal "\n\n" between every pair) — never a single "\n" (no blank
    // line) and never "\n\n\n" or more (an extra, unwanted blank line).
    expect(description.split("\n\n").length).toBe(6);
    expect(description).not.toMatch(/\n{3,}/);
    expect(description.split("\n").filter(line => line === "").length).toBe(5); // exactly 5 blank lines between 6 blocks

    const lines = description.split("\n");
    expect(lines).toEqual([
      "On Running Cloud 5 Women's Trainers – UK 4",
      "",
      "Genuine On Running Cloud 5 trainers in blue and white, UK size 4.",
      "",
      "Condition: Very good pre-owned condition. Light signs of previous wear as shown in the photographs.",
      "",
      "Details",
      "• Model: Cloud 5",
      "• Size: UK 4",
      "• Colour: Blue & White",
      "• Material: Mesh",
      "• Includes: Trainers only",
      "• SKU: 1644",
      "",
      "Please review all photographs carefully as they form part of the condition description.",
      "",
      "Orders are securely packaged and dispatched promptly.",
    ]);
  });

  it("the Details block itself has NO blank lines between its own heading and bullets (single '\\n' only within that block)", () => {
    const detailsBlock = description.split("\n\n").find(b => b.startsWith("Details"))!;
    expect(detailsBlock.split("\n")).toEqual([
      "Details", "• Model: Cloud 5", "• Size: UK 4", "• Colour: Blue & White",
      "• Material: Mesh", "• Includes: Trainers only", "• SKU: 1644",
    ]);
  });

  it("never uses \\r\\n — plain \\n line endings only, so spacing survives storage/transport unchanged", () => {
    expect(description).not.toContain("\r");
  });
});

describe("renderEbayDescription — omitting unknown optional bullets", () => {
  it("omits Style code, Material, and SKU bullets entirely when unknown, rather than writing 'unknown'", () => {
    const description = renderEbayDescription(facts({ brand: "Nike", model: "Pegasus", productType: "Trainers", ukShoeSize: "9", primaryColour: "Black" }));
    expect(description).not.toContain("Style code");
    expect(description).not.toContain("Material");
    expect(description).not.toContain("SKU");
    expect(description).not.toMatch(/unknown/i);
  });

  it("REQUIREMENT: the internal SKU, when present, is ALWAYS the last Details bullet — never interleaved with manufacturer facts", () => {
    const description = renderEbayDescription(facts({
      brand: "Nike", model: "Pegasus", productType: "Trainers", ukShoeSize: "9", primaryColour: "Black",
      material: "Mesh", styleCode: "AJ1234", internalSku: "1648",
    }));
    const detailsBlock = description.split("\n\n").find(b => b.startsWith("Details"))!;
    const lines = detailsBlock.split("\n").filter(l => l.startsWith("•"));
    expect(lines[lines.length - 1]).toBe("• SKU: 1648");
  });

  it("adds a Material bullet (between Colour and Style code) when material is confidently known — the On Running Cloud 5 case", () => {
    const description = renderEbayDescription(facts({
      brand: "On Running", model: "Cloud 5", gender: "womens", productType: "Trainers", ukShoeSize: "4",
      primaryColour: "Blue", secondaryColour: "White", material: "Mesh", internalSku: "1644",
    }));
    const detailsBlock = description.split("\n\n").find(b => b.startsWith("Details"))!;
    const lines = detailsBlock.split("\n").filter(l => l.startsWith("•"));
    expect(lines).toEqual([
      "• Model: Cloud 5", "• Size: UK 4", "• Colour: Blue & White", "• Material: Mesh",
      "• Includes: Trainers only", "• SKU: 1644",
    ]);
  });
});

describe("renderEbayDescription — headline and genuine-product sentence", () => {
  it("headline: Brand Model Gender's ProductType – UK Size (possessive gender, en dash)", () => {
    const description = renderEbayDescription(facts({ brand: "Nike", model: "Pegasus 40", gender: "womens", productType: "Trainers", ukShoeSize: "7" }));
    expect(description.split("\n\n")[0]).toBe("Nike Pegasus 40 Women's Trainers – UK 7");
  });

  it("omits the gender segment cleanly when gender is unknown", () => {
    const description = renderEbayDescription(facts({ brand: "Nike", model: "Pegasus 40", gender: null, productType: "Trainers", ukShoeSize: "7" }));
    expect(description.split("\n\n")[0]).toBe("Nike Pegasus 40 Trainers – UK 7");
  });

  it("genuine-product sentence lowercases product type and colour", () => {
    const description = renderEbayDescription(facts({ brand: "Nike", model: "Pegasus", productType: "Running Trainers", ukShoeSize: "9", primaryColour: "Black" }));
    const sentence = description.split("\n\n")[1];
    expect(sentence).toBe("Genuine Nike Pegasus running trainers in black, UK size 9.");
  });

  it("REQUIREMENT: two colours read as natural prose ('blue and white'), never a bare space — the real reported On Running Cloud 5 case", () => {
    const description = renderEbayDescription(facts({
      brand: "On Running", model: "Cloud 5", gender: "womens", productType: "Trainers", ukShoeSize: "4",
      primaryColour: "Blue", secondaryColour: "White", material: "Mesh", internalSku: "1644",
    }));
    const sentence = description.split("\n\n")[1];
    expect(sentence).toBe("Genuine On Running Cloud 5 trainers in blue and white, UK size 4.");
    // The Details bullet still reads as a concise label, "&" not "and".
    const detailsBlock = description.split("\n\n").find(b => b.startsWith("Details"))!;
    expect(detailsBlock).toContain("• Colour: Blue & White");
  });
});

describe("renderEbayDescription — clothing", () => {
  it("uses clothing size wording ('size {clothingSize}') instead of 'UK size'", () => {
    const description = renderEbayDescription(facts({
      itemFamily: "clothing", brand: "Nike", model: "Tech Fleece", gender: "mens", productType: "Hoodie",
      primaryColour: "Black", clothingSize: "Large",
    }));
    expect(description.split("\n\n")[0]).toBe("Nike Tech Fleece Men's Hoodie – Size Large");
    expect(description.split("\n\n")[1]).toBe("Genuine Nike Tech Fleece hoodie in black, size Large.");
  });
});

describe("resolveEbayConditionText", () => {
  it("defaults to the standard pre-owned sentence when no evidence is given — the overwhelmingly common case for this business", () => {
    expect(resolveEbayConditionText(null)).toEqual({ text: EBAY_STANDARD_PREOWNED_CONDITION_TEXT, state: "very_good_preowned" });
  });

  it("REQUIREMENT: never uses evasive text ('assess for yourself') when the standard wording IS supported", () => {
    const resolution = resolveEbayConditionText("Light wear on the sole.");
    expect(resolution.text).toBe(EBAY_STANDARD_PREOWNED_CONDITION_TEXT);
    expect(resolution.text).not.toMatch(/assess.*yourself|see photos for condition/i);
  });

  it("a genuinely new/unworn item gets its own honest sentence, never the pre-owned default", () => {
    const resolution = resolveEbayConditionText("Brand new, unworn, tags still attached.");
    expect(resolution.state).toBe("new");
    expect(resolution.text).toContain("Brand new");
    expect(resolution.text).not.toContain("pre-owned");
  });

  it("REQUIREMENT: a flagged defect is never silently smoothed into the standard sentence — marked needs_review with no fabricated wording", () => {
    const resolution = resolveEbayConditionText("There is a small tear near the sole and a stain on the upper.");
    expect(resolution.state).toBe("needs_review");
    expect(resolution.text).toBeNull();
  });
});
