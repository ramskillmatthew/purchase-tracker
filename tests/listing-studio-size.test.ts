import { describe, expect, it } from "vitest";
import { categoryRequiresSize, hasUsableSize } from "@/lib/listing-studio/size";
import type { FieldValue, ListingFieldData } from "@/lib/listing-studio/types";

function field<T>(overrides: Partial<FieldValue<T>> = {}): FieldValue<T> {
  return {
    value: null, confidence: "unconfirmed", source: "label", sourceImageId: null,
    aiGenerated: true, userConfirmed: false, conflict: false,
    ...overrides,
  } as FieldValue<T>;
}

describe("categoryRequiresSize — Stage 1 spec §10: 'Shoes require size, some accessories may not'", () => {
  it("shoes/footwear-shaped categories require a size", () => {
    for (const category of ["Shoes", "footwear", "Trainers", "boots"]) expect(categoryRequiresSize(category)).toBe(true);
  });

  it("clothing-shaped categories require a size", () => {
    for (const category of ["Clothing", "tops", "Jeans", "dresses"]) expect(categoryRequiresSize(category)).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(categoryRequiresSize("  SHOES  ")).toBe(true);
  });

  it("an unrecognised/accessory-shaped category does not require size", () => {
    expect(categoryRequiresSize("Accessories")).toBe(false);
    expect(categoryRequiresSize("Jewellery")).toBe(false);
  });

  it("null/undefined/blank category does not require size (missing category is flagged separately by readiness validation)", () => {
    expect(categoryRequiresSize(null)).toBe(false);
    expect(categoryRequiresSize(undefined)).toBe(false);
    expect(categoryRequiresSize("")).toBe(false);
  });
});

describe("hasUsableSize", () => {
  it("true when a manually typed sizeLabel is present, even with no confident field data", () => {
    expect(hasUsableSize({}, "UK 9")).toBe(true);
  });

  it("false when sizeLabel is blank/whitespace and no size field is confirmed/confident", () => {
    expect(hasUsableSize({}, "   ")).toBe(false);
    expect(hasUsableSize({}, null)).toBe(false);
  });

  it("true when sizeUk is user-confirmed even if sizeLabel is blank", () => {
    const fields: Pick<ListingFieldData, "sizeUk" | "sizeEu" | "sizeUs"> = { sizeUk: field({ value: "9", userConfirmed: true }) };
    expect(hasUsableSize(fields, null)).toBe(true);
  });

  it("true when sizeEu is high-confidence without explicit user confirmation", () => {
    const fields: Pick<ListingFieldData, "sizeUk" | "sizeEu" | "sizeUs"> = { sizeEu: field({ value: "43", confidence: "high" }) };
    expect(hasUsableSize(fields, null)).toBe(true);
  });

  it("false when the only size field present is low-confidence and unconfirmed", () => {
    const fields: Pick<ListingFieldData, "sizeUk" | "sizeEu" | "sizeUs"> = { sizeUs: field({ value: "10", confidence: "low" }) };
    expect(hasUsableSize(fields, null)).toBe(false);
  });

  it("does not require all three size systems — one usable one is enough", () => {
    const fields: Pick<ListingFieldData, "sizeUk" | "sizeEu" | "sizeUs"> = { sizeUk: field({ value: "9", userConfirmed: true }) };
    expect(hasUsableSize(fields, null)).toBe(true);
  });
});
