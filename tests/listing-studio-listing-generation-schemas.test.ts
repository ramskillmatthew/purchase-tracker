import { describe, expect, it } from "vitest";
import {
  listingGenerationFieldsSchema, describeListingGenerationFailure,
  LISTING_GENERATION_TOOL, LISTING_GENERATION_SYSTEM_PROMPT,
  type ListingGenerationFields,
} from "@/lib/listing-studio/listing-generation-schemas";

function validFields(overrides: Partial<ListingGenerationFields> = {}): ListingGenerationFields {
  return {
    brand: { value: "On", confidence: "high" },
    model: { value: "Cloudmonster", confidence: "high" },
    productType: { value: "Running Trainers", confidence: "high" },
    colour: { value: "White & Blue", confidence: "medium" },
    sourceSize: { system: "UK", value: "10.5", gender: null, confidence: "high" },
    sku: { value: "1648", confidence: "high" },
    notes: null,
    ...overrides,
  };
}

describe("listingGenerationFieldsSchema — structured product fields only, never a title, description, or converted size", () => {
  it("accepts a fully-populated, well-formed response", () => {
    expect(listingGenerationFieldsSchema.safeParse(validFields()).success).toBe(true);
  });

  it("accepts every field being null (nothing confidently identified) as long as confidence is still reported", () => {
    const allBlank = validFields({
      brand: { value: null, confidence: "low" }, model: { value: null, confidence: "low" },
      productType: { value: null, confidence: "low" }, colour: { value: null, confidence: "low" },
      sourceSize: { system: null, value: null, gender: null, confidence: "low" }, sku: { value: null, confidence: "low" },
    });
    expect(listingGenerationFieldsSchema.safeParse(allBlank).success).toBe(true);
  });

  it("REGRESSION: rejects a response that includes a title or description field — this architecture never allows the AI to author either", () => {
    const withTitle = { ...validFields(), title: "On Cloudmonster Running Trainers" };
    expect(listingGenerationFieldsSchema.safeParse(withTitle).success).toBe(false);
    const withDescription = { ...validFields(), description: "Size - UK 10.5..." };
    expect(listingGenerationFieldsSchema.safeParse(withDescription).success).toBe(false);
  });

  it("rejects an invalid confidence value on any field, including sourceSize", () => {
    const invalid = validFields({ sku: { value: "1648", confidence: "certain" as never } });
    expect(listingGenerationFieldsSchema.safeParse(invalid).success).toBe(false);
    const invalidSize = validFields({ sourceSize: { system: "UK", value: "9", gender: null, confidence: "certain" as never } });
    expect(listingGenerationFieldsSchema.safeParse(invalidSize).success).toBe(false);
  });

  it("rejects a missing field entirely (schema is .strict() and every field is required)", () => {
    const { sku: _omit, ...withoutSku } = validFields();
    expect(listingGenerationFieldsSchema.safeParse(withoutSku).success).toBe(false);
  });

  it("rejects an unexpected extra field anywhere in the response", () => {
    expect(listingGenerationFieldsSchema.safeParse({ ...validFields(), madeUpField: 1 }).success).toBe(false);
    expect(listingGenerationFieldsSchema.safeParse({ ...validFields(), brand: { ...validFields().brand, extra: 1 } }).success).toBe(false);
  });

  it("rejects an empty-string field value — blank must be represented as null, not an empty string", () => {
    expect(listingGenerationFieldsSchema.safeParse(validFields({ brand: { value: "", confidence: "high" } })).success).toBe(false);
  });

  it("accepts notes being null or a real string, and rejects an empty-string notes", () => {
    expect(listingGenerationFieldsSchema.safeParse(validFields({ notes: null })).success).toBe(true);
    expect(listingGenerationFieldsSchema.safeParse(validFields({ notes: "Two disagreeing SKU stickers found." })).success).toBe(true);
    expect(listingGenerationFieldsSchema.safeParse(validFields({ notes: "" })).success).toBe(false);
  });

  it("rejects a field value or notes text over its length cap", () => {
    expect(listingGenerationFieldsSchema.safeParse(validFields({ brand: { value: "x".repeat(200), confidence: "high" } })).success).toBe(false);
    expect(listingGenerationFieldsSchema.safeParse(validFields({ notes: "x".repeat(600) })).success).toBe(false);
  });

  describe("sourceSize — Milestone 4 sizing correction: system + value + gender, never a converted UK value", () => {
    it("accepts every valid system (UK/EU/US) and every valid gender (mens/womens/unisex/childrens)", () => {
      for (const system of ["UK", "EU", "US"] as const) {
        expect(listingGenerationFieldsSchema.safeParse(validFields({ sourceSize: { system, value: "9", gender: null, confidence: "high" } })).success).toBe(true);
      }
      for (const gender of ["mens", "womens", "unisex", "childrens"] as const) {
        expect(listingGenerationFieldsSchema.safeParse(validFields({ sourceSize: { system: "US", value: "9", gender, confidence: "high" } })).success).toBe(true);
      }
    });

    it("REGRESSION: rejects an invalid system value — the AI can only ever report UK, EU, or US, never a converted/synthetic system", () => {
      expect(listingGenerationFieldsSchema.safeParse(validFields({ sourceSize: { system: "CM" as never, value: "27", gender: null, confidence: "high" } })).success).toBe(false);
    });

    it("system and value may independently be null — a partial/inconsistent pair is a valid schema-level state (the application, not the schema, treats it as 'no usable source size')", () => {
      expect(listingGenerationFieldsSchema.safeParse(validFields({ sourceSize: { system: "EU", value: null, gender: null, confidence: "low" } })).success).toBe(true);
      expect(listingGenerationFieldsSchema.safeParse(validFields({ sourceSize: { system: null, value: "42", gender: null, confidence: "low" } })).success).toBe(true);
    });

    it("rejects an unexpected extra field inside sourceSize (e.g. a 'ukSize' or 'convertedValue' the AI might invent)", () => {
      expect(listingGenerationFieldsSchema.safeParse(validFields({ sourceSize: { system: "UK", value: "9", gender: null, confidence: "high", ukSize: "9" } as never })).success).toBe(false);
    });

    it("rejects a missing gender or confidence key inside sourceSize — every sub-field is required", () => {
      expect(listingGenerationFieldsSchema.safeParse({ ...validFields(), sourceSize: { system: "UK", value: "9", confidence: "high" } }).success).toBe(false);
    });
  });
});

describe("LISTING_GENERATION_TOOL — forced tool-use schema", () => {
  it("requires every structured field plus notes, and forbids extra properties at both the top level and per-field", () => {
    expect(LISTING_GENERATION_TOOL.input_schema.required).toEqual(["brand", "model", "productType", "colour", "sourceSize", "sku", "notes"]);
    expect(LISTING_GENERATION_TOOL.input_schema.additionalProperties).toBe(false);
    const brandSchema = (LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { additionalProperties?: boolean; required?: string[] }>).brand;
    expect(brandSchema.additionalProperties).toBe(false);
    expect(brandSchema.required).toEqual(["value", "confidence"]);
  });

  it("REGRESSION: sourceSize requires system/value/gender/confidence, and forbids extra properties — never a bare ukSize field", () => {
    const sourceSizeSchema = (LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { additionalProperties?: boolean; required?: string[] }>).sourceSize;
    expect(sourceSizeSchema.required).toEqual(["system", "value", "gender", "confidence"]);
    expect(sourceSizeSchema.additionalProperties).toBe(false);
    const properties = Object.keys(LISTING_GENERATION_TOOL.input_schema.properties as Record<string, unknown>);
    expect(properties).not.toContain("ukSize");
  });

  it("Milestone 4 sizing coverage correction: sourceSize.gender's JSON-schema enum includes childrens alongside mens/womens/unisex/null", () => {
    const sourceSizeSchema = (LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { properties: Record<string, { enum?: unknown[] }> }>).sourceSize;
    expect(sourceSizeSchema.properties.gender.enum).toEqual(["mens", "womens", "unisex", "childrens", null]);
  });

  it("never defines a title or description property", () => {
    const properties = Object.keys(LISTING_GENERATION_TOOL.input_schema.properties as Record<string, unknown>);
    expect(properties).not.toContain("title");
    expect(properties).not.toContain("description");
  });

  it("has a stable name matching what lib/listing-studio/listing-generation-ai.ts forces via tool_choice", () => {
    expect(LISTING_GENERATION_TOOL.name).toBe("propose_listing_fields");
  });
});

describe("describeListingGenerationFailure", () => {
  it("returns a fixed, safe sentence for every failure category — never a raw error or model output", () => {
    for (const status of ["not_configured", "request_failed", "no_tool_call", "invalid_output"] as const) {
      expect(typeof describeListingGenerationFailure(status)).toBe("string");
      expect(describeListingGenerationFailure(status).length).toBeGreaterThan(0);
    }
  });
});

describe("LISTING_GENERATION_SYSTEM_PROMPT — every hard rule from the spec, pinned so a future edit can't silently drop one", () => {
  it("forces exactly one tool call, never free-form prose, never a title/description", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/call that tool exactly once/i);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Nn]ever return a title, a description/);
  });

  it("BRAND: never invent, leave null if unclear, with the exact given examples", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Nn]ever invent a brand/);
    for (const brand of ["Nike", "Adidas", "On", "ASICS", "New Balance", "Hoka", "Birkenstock"]) {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(brand);
    }
  });

  it("MODEL / SILHOUETTE: never guess, with the exact given examples", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/leave the value null — never guess/);
    for (const model of ["Cloudmonster", "Cloud 5", "Gel Kayano 14", "Pegasus Trail 5", "Arizona", "Boston"]) {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(model);
    }
  });

  it("PRODUCT TYPE: a generic type, with the exact given examples", () => {
    for (const type of ["Running Trainers", "Trail Running Trainers", "Walking Shoes", "Sandals", "Slides", "Football Boots"]) {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(type);
    }
  });

  it("COLOUR: plain description with '&', or an official colourway only if confident — never guess an official name", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain('"White & Blue"');
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain('"Solar Red"');
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain('"OG Neon"');
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/never guess an official colourway name/);
  });

  describe("SIZE (Milestone 4 sizing correction) — report only what's printed, never convert, UK > EU > US priority, gender only if explicit", () => {
    it("instructs the AI to prefer a directly printed UK size over EU/US shown on the same label", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/always prefer a directly printed UK size over any EU or US size shown on the very same label/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/even when more than one system is printed together/);
    });

    it("only falls back to EU, then only to US, when the higher-priority system isn't visible", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Only if no UK size is visible anywhere/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Only if neither UK nor EU is visible/);
    });

    it("REGRESSION: explicitly forbids the AI from converting or writing a converted value itself", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/You must NEVER convert between sizing systems yourself, and never write a converted value/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/the application does that separately, deterministically/);
    });

    it("gender is reported only if the label itself states it — never guessed from the shoe's appearance", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/leave gender null if the label doesn't state it/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/never guess gender from the shoe's general style or appearance/);
    });

    it("conflicting size labels across photos, or no confidently-readable size at all, leave both system and value null", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/leave sourceSize\.system and sourceSize\.value both null rather than picking one/);
    });

    it("Milestone 4 sizing coverage correction: childrens is only reported on explicit label wording, never inferred from the shoe's style", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/only report sourceSize\.gender as "childrens" when the label or packaging itself explicitly says so/i);
      for (const word of ["Kids", "Youth", "Toddler", "Infant"]) expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(word);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/never inferred just because the shoe looks small or youth-styled/);
    });
  });

  it("SKU: read the white inventory sticker, search every photo, exact given examples, blank on disagreement/absence, never invent", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/white inventory sticker inside the shoe/);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/search every single photo/);
    for (const sku of ["1648", "1672", "1728"]) expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(sku);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/disagree with each other, or none can be found at all, leave the value null/);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Nn]ever invent a SKU/);
  });

  it("confidence guidance: high only when certain, prefer null over a low-confidence guess for model/colour/sourceSize/SKU", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/"high" only when you are genuinely certain/);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Pp]refer leaving a value null over a low-confidence guess.*sourceSize/);
  });
});
