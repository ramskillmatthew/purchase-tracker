import { describe, expect, it } from "vitest";
import { uploadSessionRequestSchema, updateListingFieldsRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { MAX_FILES_PER_SELECTION } from "@/lib/listing-studio/upload-limits";
import { VINTED_COLOURS, VINTED_MATERIALS } from "@/lib/listing-studio/listing-generation-schemas";

function file(overrides: Partial<{ filename: string; mimeType: string; fileSize: number }> = {}) {
  return { filename: "photo.jpg", mimeType: "image/jpeg", fileSize: 1_500_000, ...overrides };
}

describe("uploadSessionRequestSchema — REGRESSION: one-file and 25-file upload sessions (PGRST103 fix)", () => {
  it("accepts a single-file upload session", () => {
    const result = uploadSessionRequestSchema.safeParse({ files: [file()] });
    expect(result.success).toBe(true);
  });

  it("accepts a 25-file upload session", () => {
    const files = Array.from({ length: 25 }, (_, i) => file({ filename: `photo-${i}.jpg` }));
    const result = uploadSessionRequestSchema.safeParse({ files });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.files).toHaveLength(25);
  });

  it("accepts up to MAX_FILES_PER_SELECTION files", () => {
    const files = Array.from({ length: MAX_FILES_PER_SELECTION }, (_, i) => file({ filename: `photo-${i}.jpg` }));
    expect(uploadSessionRequestSchema.safeParse({ files }).success).toBe(true);
  });

  it("rejects more than MAX_FILES_PER_SELECTION files", () => {
    const files = Array.from({ length: MAX_FILES_PER_SELECTION + 1 }, (_, i) => file({ filename: `photo-${i}.jpg` }));
    expect(uploadSessionRequestSchema.safeParse({ files }).success).toBe(false);
  });

  it("rejects an empty file list", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [] }).success).toBe(false);
  });

  it("accepts every supported image MIME type", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(uploadSessionRequestSchema.safeParse({ files: [file({ mimeType })] }).success).toBe(true);
    }
  });

  it("rejects an unsupported MIME type", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [file({ mimeType: "application/pdf" })] }).success).toBe(false);
  });

  it("accepts an optional draftId to append to an existing group", () => {
    const result = uploadSessionRequestSchema.safeParse({ draftId: "11111111-1111-4111-8111-111111111111", files: [file()] });
    expect(result.success).toBe(true);
  });

  it("accepts draftId omitted entirely (server finds-or-creates Unsorted)", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [file()] }).success).toBe(true);
  });

  it("rejects an unexpected extra property (.strict())", () => {
    expect(uploadSessionRequestSchema.safeParse({ files: [file()], extra: true }).success).toBe(false);
  });
});

function fieldsBody(overrides: Partial<{ brand: string | null; model: string | null; productType: string | null; colours: string[]; material: string | null; ukSize: string | null; sku: string | null; vintedAudience: string; vintedCategoryId: number | null }> = {}) {
  return {
    brand: "Nike", model: "Pegasus", productType: "Trainers",
    colours: ["Black", "White"], material: "Mesh", ukSize: "9", sku: "1648",
    // Milestone 7 (Vinted category catalogue sync).
    // Follow-up correction (2026-08-04).
    vintedAudience: "mens",
    vintedCategoryId: null,
    ...overrides,
  };
}

describe("updateListingFieldsRequestSchema — Milestone 6 (Vinted-aware colours/materials): Edit Fields validated against the exact same Vinted enums as the AI", () => {
  it("valid colour selection: accepts a single colour or exactly two", () => {
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ colours: ["Black"] })).success).toBe(true);
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ colours: ["Black", "White"] })).success).toBe(true);
  });

  it("empty colour array: accepted (nothing set)", () => {
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ colours: [] })).success).toBe(true);
  });

  it("maximum two colours: rejects three or more", () => {
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ colours: ["Black", "White", "Grey"] })).success).toBe(false);
  });

  it("REGRESSION: invalid enum rejection — a colour not on the Vinted list is rejected, exactly like an AI-side violation would be", () => {
    for (const invalidColour of ["Tan", "Maroon", "Ivory", "cream"]) {
      expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ colours: [invalidColour] })).success).toBe(false);
    }
  });

  it("every VINTED_COLOURS value is individually accepted", () => {
    for (const colour of VINTED_COLOURS) {
      expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ colours: [colour] })).success).toBe(true);
    }
  });

  it("material enum validation: accepts every VINTED_MATERIALS value", () => {
    for (const material of VINTED_MATERIALS) {
      expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ material })).success).toBe(true);
    }
  });

  it("null material: accepted", () => {
    const result = updateListingFieldsRequestSchema.safeParse(fieldsBody({ material: null }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.material).toBeNull();
  });

  it("REGRESSION: invalid enum rejection — a material not on the Vinted list is rejected", () => {
    for (const invalidMaterial of ["Vinyl", "Spandex", "cotton", "Faux Leather"]) {
      expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ material: invalidMaterial })).success).toBe(false);
    }
  });

  it("Edit Fields behaviour: brand/model/productType/ukSize/sku remain plain nullable text, unaffected by the enum change", () => {
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ brand: null, model: null, productType: null, ukSize: null, sku: null })).success).toBe(true);
  });

  it("rejects an unexpected extra property (.strict())", () => {
    expect(updateListingFieldsRequestSchema.safeParse({ ...fieldsBody(), extra: true }).success).toBe(false);
  });

  it("Milestone 7 (Vinted category catalogue sync): vintedCategoryId accepts a positive integer or null", () => {
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ vintedCategoryId: 1906 })).success).toBe(true);
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ vintedCategoryId: null })).success).toBe(true);
  });

  it("Milestone 7: rejects a zero, negative, or non-integer vintedCategoryId", () => {
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ vintedCategoryId: 0 })).success).toBe(false);
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ vintedCategoryId: -1 })).success).toBe(false);
    expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ vintedCategoryId: 1.5 })).success).toBe(false);
  });

  it("Follow-up correction (2026-08-04): vintedAudience accepts every one of the 6 exact enum values", () => {
    for (const value of ["mens", "womens", "boys", "girls", "unisex", "unknown"]) {
      expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ vintedAudience: value })).success).toBe(true);
    }
  });

  it("Follow-up correction: rejects a free-text or out-of-enum vintedAudience", () => {
    for (const value of ["man", "Men", "kids", ""]) {
      expect(updateListingFieldsRequestSchema.safeParse(fieldsBody({ vintedAudience: value })).success).toBe(false);
    }
  });

  it("Follow-up correction: vintedAudience is required, not omittable — the fields route relies on always receiving it to detect a genuine change", () => {
    const body = fieldsBody() as Record<string, unknown>;
    delete body.vintedAudience;
    expect(updateListingFieldsRequestSchema.safeParse(body).success).toBe(false);
  });
});
