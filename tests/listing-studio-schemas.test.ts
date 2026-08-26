import { describe, expect, it } from "vitest";
import { fieldValueSchema, listingConflictSchema, listingFieldDataSchema, listingWarningSchema } from "@/lib/validation/listing-studio";
import {
  consistencyCheckResultSchema,
  imageQualityResultSchema,
  labelExtractionResultSchema,
  listingGenerationResultSchema,
  visualIdentificationResultSchema,
} from "@/lib/listing-studio/ai-schemas";
import { z } from "zod";

const IMG = "33333333-3333-4333-8333-333333333333";

describe("fieldValueSchema — the shared per-field validator", () => {
  const schema = fieldValueSchema(z.string());
  const valid = { value: "Nike", confidence: "high", source: "label", sourceImageId: IMG, aiGenerated: true, userConfirmed: false, conflict: false };

  it("accepts a fully valid field value", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("accepts a null value (unreadable/unknown)", () => {
    expect(schema.safeParse({ ...valid, value: null }).success).toBe(true);
  });

  it("rejects a missing required property", () => {
    const { confidence: _confidence, ...withoutConfidence } = valid;
    expect(schema.safeParse(withoutConfidence).success).toBe(false);
  });

  it("rejects an unexpected extra property (.strict())", () => {
    expect(schema.safeParse({ ...valid, extra: "nope" }).success).toBe(false);
  });

  it("rejects an invalid confidence enum value", () => {
    expect(schema.safeParse({ ...valid, confidence: "very-high" }).success).toBe(false);
  });

  it("rejects an invalid source enum value", () => {
    expect(schema.safeParse({ ...valid, source: "guess" }).success).toBe(false);
  });

  it("rejects a non-uuid sourceImageId", () => {
    expect(schema.safeParse({ ...valid, sourceImageId: "not-a-uuid" }).success).toBe(false);
  });

  it("accepts a null sourceImageId", () => {
    expect(schema.safeParse({ ...valid, sourceImageId: null }).success).toBe(true);
  });
});

describe("listingFieldDataSchema", () => {
  it("accepts an empty object (a freshly created draft has no fields analysed yet)", () => {
    expect(listingFieldDataSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial set of fields with the correct per-field value types", () => {
    const result = listingFieldDataSchema.safeParse({
      brand: { value: "Nike", confidence: "high", source: "visual", sourceImageId: null, aiGenerated: true, userConfirmed: false, conflict: false },
      colours: { value: ["Black", "White"], confidence: "medium", source: "visual", sourceImageId: null, aiGenerated: true, userConfirmed: false, conflict: false },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognised field name (.strict())", () => {
    expect(listingFieldDataSchema.safeParse({ notARealField: {} }).success).toBe(false);
  });

  it("rejects colours as a plain string instead of an array", () => {
    const result = listingFieldDataSchema.safeParse({
      colours: { value: "Black", confidence: "high", source: "visual", sourceImageId: null, aiGenerated: true, userConfirmed: false, conflict: false },
    });
    expect(result.success).toBe(false);
  });
});

describe("listingWarningSchema / listingConflictSchema — always identify the affected field (or null)", () => {
  it("accepts a warning tied to a specific field", () => {
    expect(listingWarningSchema.safeParse({ code: "low_confidence", message: "Brand could not be confirmed.", field: "brand" }).success).toBe(true);
  });

  it("accepts a warning with no specific field (field: null)", () => {
    expect(listingWarningSchema.safeParse({ code: "missing_view", message: "No sole photo provided.", field: null }).success).toBe(true);
  });

  it("rejects a warning missing the field property entirely", () => {
    expect(listingWarningSchema.safeParse({ code: "x", message: "y" }).success).toBe(false);
  });

  it("a conflict additionally carries the conflicting values", () => {
    const result = listingConflictSchema.safeParse({ code: "size_conflict", message: "Two different sizes found.", field: "sizeUk", values: ["8", "9"] });
    expect(result.success).toBe(true);
  });
});

describe("AI stage schemas — Stage 1 spec §7/§17", () => {
  it("PASS 1 image_quality: accepts a valid response", () => {
    const result = imageQualityResultSchema.safeParse({
      sameProductConfidence: "high",
      imageRoles: [{ imageId: IMG, role: "main", confidence: "high" }],
      missingPhotoWarnings: [],
      unusableImageWarnings: [],
      groupingWarnings: [],
      hasReadableLabel: true,
    });
    expect(result.success).toBe(true);
  });

  it("PASS 1: rejects an invalid image role", () => {
    const result = imageQualityResultSchema.safeParse({
      sameProductConfidence: "high", imageRoles: [{ imageId: IMG, role: "not-a-role", confidence: "high" }],
      missingPhotoWarnings: [], unusableImageWarnings: [], groupingWarnings: [], hasReadableLabel: true,
    });
    expect(result.success).toBe(false);
  });

  it("PASS 1: rejects a non-uuid image reference", () => {
    const result = imageQualityResultSchema.safeParse({
      sameProductConfidence: "high", imageRoles: [{ imageId: "img-1", role: "main", confidence: "high" }],
      missingPhotoWarnings: [], unusableImageWarnings: [], groupingWarnings: [], hasReadableLabel: true,
    });
    expect(result.success).toBe(false);
  });

  it("PASS 1: rejects a missing required property", () => {
    const result = imageQualityResultSchema.safeParse({ sameProductConfidence: "high", imageRoles: [], missingPhotoWarnings: [], groupingWarnings: [], hasReadableLabel: true });
    expect(result.success).toBe(false);
  });

  it("PASS 2 label_extraction: accepts null for every unreadable field, preserving rawText separately", () => {
    const result = labelExtractionResultSchema.safeParse({
      labels: [{
        imageId: IMG, rawText: "NIKE UK 9 EU 43", brand: { value: "Nike", confidence: "high" },
        sizeSystemsShown: ["UK", "EU"], sizeUk: { value: "9", confidence: "high" }, sizeEu: { value: "43", confidence: "high" },
        sizeUs: null, styleCode: null, sku: null, productCode: null, colourCode: null, materialText: null,
        countryOfManufacture: null, otherText: [],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("PASS 2: rejects an unexpected extra property on a label entry", () => {
    const result = labelExtractionResultSchema.safeParse({
      labels: [{
        imageId: IMG, rawText: null, brand: null, sizeSystemsShown: [], sizeUk: null, sizeEu: null, sizeUs: null,
        styleCode: null, sku: null, productCode: null, colourCode: null, materialText: null, countryOfManufacture: null,
        otherText: [], extraField: "nope",
      }],
    });
    expect(result.success).toBe(false);
  });

  it("PASS 3 visual_identification: accepts a valid response with nullable identification fields", () => {
    const result = visualIdentificationResultSchema.safeParse({
      productType: { value: "Trainers", confidence: "high" },
      brand: { value: null, confidence: "low" },
      model: { value: null, confidence: "unconfirmed" },
      silhouette: { value: "Air Max 90", confidence: "medium" },
      colourway: { value: null, confidence: "low" },
      mainColour: { value: "Black", confidence: "high" },
      secondaryColours: { value: ["White"], confidence: "medium" },
      department: { value: "Menswear", confidence: "medium" },
      category: { value: "Shoes", confidence: "high" },
      subcategory: { value: null, confidence: "low" },
      material: { value: ["Leather", "Rubber"], confidence: "medium" },
      approximateCondition: { value: "Good condition", confidence: "medium" },
      visibleDefects: [],
      distinguishingDetails: ["Visible stitching detail on the heel"],
    });
    expect(result.success).toBe(true);
  });

  it("PASS 3: rejects material as a single string instead of an array", () => {
    const base = {
      productType: { value: "Trainers", confidence: "high" }, brand: { value: null, confidence: "low" },
      model: { value: null, confidence: "low" }, silhouette: { value: null, confidence: "low" },
      colourway: { value: null, confidence: "low" }, mainColour: { value: null, confidence: "low" },
      secondaryColours: { value: [], confidence: "low" }, department: { value: null, confidence: "low" },
      category: { value: "Shoes", confidence: "high" }, subcategory: { value: null, confidence: "low" },
      approximateCondition: { value: "Good", confidence: "medium" }, visibleDefects: [], distinguishingDetails: [],
    };
    const result = visualIdentificationResultSchema.safeParse({ ...base, material: { value: "Leather", confidence: "medium" } });
    expect(result.success).toBe(false);
  });

  it("PASS 4 consistency_check: accepts a valid response including conflicts tied to a field", () => {
    const result = consistencyCheckResultSchema.safeParse({
      confirmedFacts: [{ field: "brand", value: "Nike" }],
      conflicts: [{ code: "size_conflict", message: "Label shows UK 8, visual guess suggests UK 9.", field: "sizeUk", values: ["8", "9"] }],
      missingRequiredInformation: ["No readable label image."],
      fieldsRequiringReview: ["sku"],
      overallConfidence: "medium",
      readyForGeneration: false,
    });
    expect(result.success).toBe(true);
  });

  it("PASS 4: rejects an invalid field name in fieldsRequiringReview", () => {
    const result = consistencyCheckResultSchema.safeParse({
      confirmedFacts: [], conflicts: [], missingRequiredInformation: [], fieldsRequiringReview: ["not_a_real_field"],
      overallConfidence: "medium", readyForGeneration: false,
    });
    expect(result.success).toBe(false);
  });

  it("PASS 5 generation: accepts a valid full listing", () => {
    const result = listingGenerationResultSchema.safeParse({
      title: "Nike Air Max 90 UK 9", description: "Good condition, some light wear.", brand: "Nike", model: "Air Max 90",
      silhouette: "Air Max", category: "Shoes", subcategory: "Trainers", size: "UK 9", condition: "Good condition",
      colour: "Black/White", material: "Leather", suggestedPricePence: 4500, searchKeywords: ["nike", "air max 90"], warnings: [],
    });
    expect(result.success).toBe(true);
  });

  it("PASS 5: rejects a negative suggested price", () => {
    const result = listingGenerationResultSchema.safeParse({
      title: "x", description: "y", brand: null, model: null, silhouette: null, category: "Shoes", subcategory: null,
      size: null, condition: "Good", colour: null, material: null, suggestedPricePence: -100, searchKeywords: [], warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it("PASS 5: rejects an unreasonably large suggested price", () => {
    const result = listingGenerationResultSchema.safeParse({
      title: "x", description: "y", brand: null, model: null, silhouette: null, category: "Shoes", subcategory: null,
      size: null, condition: "Good", colour: null, material: null, suggestedPricePence: 999_999_999, searchKeywords: [], warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it("PASS 5: rejects a non-integer suggested price (pence must be whole)", () => {
    const result = listingGenerationResultSchema.safeParse({
      title: "x", description: "y", brand: null, model: null, silhouette: null, category: "Shoes", subcategory: null,
      size: null, condition: "Good", colour: null, material: null, suggestedPricePence: 45.5, searchKeywords: [], warnings: [],
    });
    expect(result.success).toBe(false);
  });
});
