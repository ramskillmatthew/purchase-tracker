import { describe, expect, it } from "vitest";
import {
  listingGenerationFieldsSchema, describeListingGenerationFailure,
  LISTING_GENERATION_TOOL, LISTING_GENERATION_SYSTEM_PROMPT,
  VINTED_COLOURS, VINTED_MATERIALS,
  type ListingGenerationFields,
} from "@/lib/listing-studio/listing-generation-schemas";

function validFields(overrides: Partial<ListingGenerationFields> = {}): ListingGenerationFields {
  return {
    brand: { value: "On", confidence: "high" },
    model: { value: "Cloudmonster", confidence: "high" },
    productType: { value: "Running Trainers", confidence: "high" },
    colours: { value: ["White", "Blue"], confidence: "medium" },
    material: { value: "Mesh", confidence: "medium" },
    sourceSize: { system: "UK", value: "10.5", gender: null, confidence: "high" },
    // Follow-up correction (2026-08-04, extended 2026-08-05).
    vintedAudience: { value: "unisex", confidence: "medium" },
    vintedAudienceEvidence: ["Item design has no gendered distinction"],
    sku: { value: "1648", confidence: "high" },
    notes: null,
    ...overrides,
  };
}

describe("listingGenerationFieldsSchema — structured product fields only, never a title, description, or converted size", () => {
  it("accepts a fully-populated, well-formed response", () => {
    expect(listingGenerationFieldsSchema.safeParse(validFields()).success).toBe(true);
  });

  it("accepts every field being null/empty (nothing confidently identified) as long as confidence is still reported", () => {
    const allBlank = validFields({
      brand: { value: null, confidence: "low" }, model: { value: null, confidence: "low" },
      productType: { value: null, confidence: "low" }, colours: { value: [], confidence: "low" },
      material: { value: null, confidence: "low" },
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

  describe("colours (Milestone 6, Vinted-aware) — up to 2 exact enum values, empty array if unclear, never free text", () => {
    it("valid colour selection: accepts a single colour", () => {
      expect(listingGenerationFieldsSchema.safeParse(validFields({ colours: { value: ["Black"], confidence: "high" } })).success).toBe(true);
    });

    it("valid colour selection: accepts exactly two colours", () => {
      expect(listingGenerationFieldsSchema.safeParse(validFields({ colours: { value: ["Black", "White"], confidence: "high" } })).success).toBe(true);
    });

    it("empty colour array: accepted when nothing can be confidently matched", () => {
      const result = listingGenerationFieldsSchema.safeParse(validFields({ colours: { value: [], confidence: "low" } }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.colours.value).toEqual([]);
    });

    it("maximum two colours: rejects three or more", () => {
      expect(listingGenerationFieldsSchema.safeParse(validFields({ colours: { value: ["Black", "White", "Grey"], confidence: "high" } })).success).toBe(false);
    });

    it("REGRESSION: invalid enum rejection — a colour not on the Vinted list is rejected, never silently accepted as free text", () => {
      for (const invalidColour of ["Tan", "Maroon", "Ivory", "Olive", "cream", "BLACK"]) {
        expect(listingGenerationFieldsSchema.safeParse(validFields({ colours: { value: [invalidColour] as never, confidence: "high" } })).success).toBe(false);
      }
    });

    it("every value in VINTED_COLOURS is individually accepted (exact case, exact spelling)", () => {
      for (const colour of VINTED_COLOURS) {
        expect(listingGenerationFieldsSchema.safeParse(validFields({ colours: { value: [colour], confidence: "high" } })).success).toBe(true);
      }
    });

    it("VINTED_COLOURS has exactly the 29 values from the spec, in order", () => {
      expect(VINTED_COLOURS).toEqual([
        "Black", "Grey", "White", "Cream", "Beige", "Apricot", "Orange", "Coral", "Red", "Burgundy",
        "Pink", "Rose", "Purple", "Lilac", "Light blue", "Blue", "Navy", "Turquoise", "Mint", "Green",
        "Dark green", "Khaki", "Brown", "Mustard", "Yellow", "Silver", "Gold", "Multi", "Clear",
      ]);
    });
  });

  describe("material (Milestone 6, Vinted-aware) — a single exact enum value, or null, never free text", () => {
    it("material enum validation: accepts every value in VINTED_MATERIALS", () => {
      for (const material of VINTED_MATERIALS) {
        expect(listingGenerationFieldsSchema.safeParse(validFields({ material: { value: material, confidence: "high" } })).success).toBe(true);
      }
    });

    it("null material: accepted when it can't be confidently identified", () => {
      const result = listingGenerationFieldsSchema.safeParse(validFields({ material: { value: null, confidence: "low" } }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.material.value).toBeNull();
    });

    it("REGRESSION: invalid enum rejection — a material not on the Vinted list is rejected, never silently accepted as free text", () => {
      for (const invalidMaterial of ["Vinyl", "Spandex", "cotton", "LEATHER", "Faux Leather"]) {
        expect(listingGenerationFieldsSchema.safeParse(validFields({ material: { value: invalidMaterial as never, confidence: "high" } })).success).toBe(false);
      }
    });

    it("REGRESSION: rejects an array for material — exactly one value or null, never a list", () => {
      expect(listingGenerationFieldsSchema.safeParse(validFields({ material: { value: ["Leather"] as never, confidence: "high" } })).success).toBe(false);
    });

    it("VINTED_MATERIALS has exactly the 55 values from the spec, in order", () => {
      expect(VINTED_MATERIALS).toEqual([
        "Acrylic", "Alpaca", "Bamboo", "Canvas", "Cardboard", "Cashmere", "Ceramic", "Chiffon", "Corduroy", "Cotton",
        "Denim", "Down", "Elastane", "Faux fur", "Faux leather", "Felt", "Flannel", "Fleece", "Foam", "Glass",
        "Gold", "Jute", "Lace", "Latex", "Leather", "Linen", "Merino", "Mesh", "Metal", "Mohair",
        "Neoprene", "Nylon", "Paper", "Patent leather", "Plastic", "Polyester", "Porcelain", "Rattan", "Rubber", "Satin",
        "Sequin", "Silicone", "Silk", "Silver", "Steel", "Stone", "Straw", "Suede", "Tulle", "Tweed",
        "Velour", "Velvet", "Viscose", "Wood", "Wool",
      ]);
    });
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
    expect(LISTING_GENERATION_TOOL.input_schema.required).toEqual(["brand", "model", "productType", "colours", "material", "sourceSize", "vintedAudience", "vintedAudienceEvidence", "sku", "notes"]);
    expect(LISTING_GENERATION_TOOL.input_schema.additionalProperties).toBe(false);
    const brandSchema = (LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { additionalProperties?: boolean; required?: string[] }>).brand;
    expect(brandSchema.additionalProperties).toBe(false);
    expect(brandSchema.required).toEqual(["value", "confidence"]);
  });

  it("Milestone 6: colours.value is a JSON array of the exact Vinted enum, capped at maxItems 2", () => {
    const properties = LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { properties: Record<string, { type?: string; items?: { enum?: unknown[] }; maxItems?: number }> }>;
    const coloursValue = properties.colours.properties.value;
    expect(coloursValue.type).toBe("array");
    expect(coloursValue.maxItems).toBe(2);
    expect(coloursValue.items?.enum).toEqual([...VINTED_COLOURS]);
  });

  it("Milestone 6: material.value is a single string-or-null with the exact Vinted material enum (plus null)", () => {
    const properties = LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { properties: Record<string, { type?: unknown; enum?: unknown[] }> }>;
    const materialValue = properties.material.properties.value;
    expect(materialValue.type).toEqual(["string", "null"]);
    expect(materialValue.enum).toEqual([...VINTED_MATERIALS, null]);
  });

  it("Follow-up correction (2026-08-04): vintedAudience.value is a non-nullable string with the exact 6-value enum", () => {
    const properties = LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { properties: Record<string, { type?: unknown; enum?: unknown[] }> }>;
    const audienceValue = properties.vintedAudience.properties.value;
    expect(audienceValue.type).toBe("string");
    expect(audienceValue.enum).toEqual(["mens", "womens", "boys", "girls", "unisex", "unknown"]);
  });

  it("REGRESSION: never defines a bare 'colour' or free-text material property anywhere", () => {
    const properties = Object.keys(LISTING_GENERATION_TOOL.input_schema.properties as Record<string, unknown>);
    expect(properties).not.toContain("colour");
    expect(properties).toContain("colours");
    expect(properties).toContain("material");
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

  it("Follow-up correction (2026-08-05): vintedAudienceEvidence is a JSON array of up to 6 short strings", () => {
    const properties = LISTING_GENERATION_TOOL.input_schema.properties as Record<string, { type?: string; items?: { type?: string }; maxItems?: number }>;
    const evidence = properties.vintedAudienceEvidence;
    expect(evidence.type).toBe("array");
    expect(evidence.maxItems).toBe(6);
    expect(evidence.items?.type).toBe("string");
  });
});

describe("listingGenerationFieldsSchema — vintedAudience + vintedAudienceEvidence, every named regression scenario from the follow-up correction (2026-08-05)", () => {
  it("explicit men's label evidence parses as mens", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudience: { value: "mens", confidence: "high" },
      vintedAudienceEvidence: ["Box label explicitly says Men's"],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("mens");
  });

  it("explicit women's label evidence parses as womens", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudience: { value: "womens", confidence: "high" },
      vintedAudienceEvidence: ["Box label explicitly says WMNS"],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("womens");
  });

  it("men's style code/model evidence parses as mens", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudience: { value: "mens", confidence: "high" },
      vintedAudienceEvidence: ["Model identified as the men's version"],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("mens");
  });

  it("women's style code/model evidence parses as womens", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudience: { value: "womens", confidence: "high" },
      vintedAudienceEvidence: ["Style code belongs to women's release"],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("womens");
  });

  it("missing gender on the size label but strong model evidence still parses as the correct audience — sourceSize.gender is independent of vintedAudience", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      sourceSize: { system: "UK", value: "9", gender: null, confidence: "high" },
      vintedAudience: { value: "mens", confidence: "high" },
      vintedAudienceEvidence: ["Model identified as the men's version"],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sourceSize.gender).toBeNull();
      expect(parsed.data.vintedAudience.value).toBe("mens");
    }
  });

  it("a low UK size alone, with no other evidence, is expected to be reported as unknown (never guessed) — the schema itself accepts unknown with empty evidence", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      sourceSize: { system: "UK", value: "3", gender: null, confidence: "high" },
      vintedAudience: { value: "unknown", confidence: "low" },
      vintedAudienceEvidence: [],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("unknown");
  });

  it("a high UK size alone, with no other evidence, is expected to be reported as unknown (never guessed)", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      sourceSize: { system: "UK", value: "13", gender: null, confidence: "high" },
      vintedAudience: { value: "unknown", confidence: "low" },
      vintedAudienceEvidence: [],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("unknown");
  });

  it("conflicting evidence is expected to be reported as unknown, with the conflict named in evidence", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudience: { value: "unknown", confidence: "low" },
      vintedAudienceEvidence: ["One label signal suggests mens, another suggests womens, with nothing to break the tie"],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("unknown");
  });

  it("genuine unisex evidence parses as unisex", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudience: { value: "unisex", confidence: "high" },
      vintedAudienceEvidence: ["Explicitly marketed as a unisex release with no separate men's/women's version"],
    }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vintedAudience.value).toBe("unisex");
  });

  it("REGRESSION: rejects more than 6 evidence statements", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudienceEvidence: Array.from({ length: 7 }, (_, i) => `Signal ${i}`),
    }));
    expect(parsed.success).toBe(false);
  });

  it("REGRESSION: rejects an evidence statement longer than 200 characters", () => {
    const parsed = listingGenerationFieldsSchema.safeParse(validFields({
      vintedAudienceEvidence: ["x".repeat(201)],
    }));
    expect(parsed.success).toBe(false);
  });

  it("REGRESSION: rejects a missing vintedAudienceEvidence field entirely — it is required, not optional", () => {
    const fields = validFields();
    const withoutEvidence = { ...fields } as Partial<typeof fields>;
    delete withoutEvidence.vintedAudienceEvidence;
    expect(listingGenerationFieldsSchema.safeParse(withoutEvidence).success).toBe(false);
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

  describe("COLOURS (Milestone 6, Vinted-aware) — only the exact Vinted list, max 2, never a synonym, empty array if unclear", () => {
    it("names every one of the 29 Vinted colours in the prompt text", () => {
      for (const colour of VINTED_COLOURS) expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(colour);
    });

    it("REGRESSION: explicitly caps at two and forbids inventing/synonyms", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/UP TO TWO colours/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Nn]ever invent a colour/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/never use a synonym or shade name that isn't on this list/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Nn]ever return more than two values/);
    });

    it("gives Multi/Clear as the answer for rainbow/transparent items, and tells the model to return an empty array when unsure", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/rainbow or many-coloured item is "Multi"/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/transparent item is "Clear"/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/return an empty array — never guess/);
    });
  });

  describe("MATERIAL (Milestone 6, Vinted-aware) — only the exact Vinted list, single value or null, never invented", () => {
    it("names every one of the 55 Vinted materials in the prompt text", () => {
      for (const material of VINTED_MATERIALS) expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(material);
    });

    it("REGRESSION: forbids inventing a material or using a synonym, and instructs null when uncertain", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Nn]ever invent a material/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/never use a synonym that isn't on this list/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/leave the value null — never guess/);
    });
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

    it("Follow-up correction (2026-08-04): explicitly warns that sourceSize.gender is a different question from vintedAudience, and must never stand in for it", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/sourceSize\.gender describes the SIZE SCALE ONLY/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/is NOT the same question as vintedAudience/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/a null\/absent sourceSize\.gender must never be treated as evidence that vintedAudience is unclear/);
    });
  });

  describe("VINTED AUDIENCE (follow-up correction, 2026-08-05) — priority-ordered evidence, 'unknown' only after actively weighing it, size is supporting evidence only", () => {
    it("forbids defaulting to unknown just because the size label has no explicit M/W marker", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Do NOT default to "unknown" just because the size label has no explicit M\/W marker/);
    });

    it("gives an explicit, ordered evidence priority: label\\/department text, then model\\/style-code knowledge, then brand knowledge, then design, then size last", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/\(1\) Explicit gender or department text visible on labels, packaging, or product information/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/\(2\) A model name or style code that you know is specifically sold as a men's or women's release/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/\(3\) Reliable general brand\/model knowledge even without a specific style code/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/\(4\) Product design and construction, ONLY where strongly indicative/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/\(5\) Size range — SUPPORTING evidence only, and only alongside at least one of \(1\)-\(4\)/);
    });

    it("REGRESSION: a low or high size alone is never sufficient — size can only ever support another signal, never stand alone", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/A low or high UK\/EU\/US size ALONE is never sufficient by itself to decide mens\/womens\/boys\/girls/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Never reason like "this size sits in the womens range" as your sole justification/);
    });

    it("treats agreeing multiple signals as MORE confident, never a reason for caution", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/When multiple signals are available and they agree, that agreement makes the answer more confident, not less/);
    });

    it("requires unisex to be explicitly evidenced, never a default for an unsure case", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Report "unisex" ONLY when the item is explicitly evidenced as a genuinely unisex product with no gendered distinction/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/never as a default and never merely because you are unsure/);
    });

    it("REGRESSION: 'unknown' is only correct after genuinely working through the priority order, not as a first resort", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Report "unknown" when evidence is genuinely absent or conflicting/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/after actually working through priorities \(1\)-\(5\) above, not as a first resort/);
    });

    it("requires vintedAudienceEvidence to name the specific factual signal(s), never a confidence percentage", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/vintedAudienceEvidence: list the SPECIFIC factual signal\(s\) that led to your vintedAudience answer/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Never include a confidence percentage or number in this list/);
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/Leave this an empty array only when vintedAudience is "unknown" because there was genuinely nothing to cite/);
    });

    it("REGRESSION: sourceSize.gender absence is never itself evidence that vintedAudience is unclear", () => {
      expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/a null\/absent sourceSize\.gender must never be treated as evidence that vintedAudience is unclear/);
    });
  });

  it("SKU: read the white inventory sticker, search every photo, exact given examples, blank on disagreement/absence, never invent", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/white inventory sticker inside the shoe/);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/search every single photo/);
    for (const sku of ["1648", "1672", "1728"]) expect(LISTING_GENERATION_SYSTEM_PROMPT).toContain(sku);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/disagree with each other, or none can be found at all, leave the value null/);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/[Nn]ever invent a SKU/);
  });

  it("confidence guidance: high only when certain, prefer null (or empty array for colours) over a low-confidence guess for model/colours/material/sourceSize/vintedAudience/SKU", () => {
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/"high" only when you are genuinely certain/);
    expect(LISTING_GENERATION_SYSTEM_PROMPT).toMatch(/model, colours, material, sourceSize, vintedAudience, and SKU/);
  });
});
