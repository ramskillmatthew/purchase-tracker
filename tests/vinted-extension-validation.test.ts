import { describe, expect, it } from "vitest";
import { validateBatchItem, validateBatchPayload, validatePhoto, isValidPairingCodeShape } from "../vinted-draft-queue-extension/shared/validation.js";

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "item-1", draftId: "draft-1", queuePosition: 0, sku: "AA1711",
    title: "Nike Pegasus Trainers", description: "desc", brand: "Nike", model: "Pegasus",
    productType: "Trainers", condition: "Very Good Condition", ukSize: "9", audience: "mens",
    colours: ["Black"], materials: ["Mesh"], pricePence: 4500, priceDisplay: "£45.00",
    vintedCategoryId: 1906, vintedCategoryPath: "Men > Shoes > Trainers",
    photos: [{ position: 0, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0", fileName: "01.jpg" }],
    coverPhotoPosition: 0,
    ...overrides,
  };
}
function validPayload(overrides: Record<string, unknown> = {}) {
  return { batchId: "batch-1", expiresAt: "2026-08-05T10:00:00.000Z", items: [validItem()], ...overrides };
}

describe("validatePhoto", () => {
  it("accepts a valid photo", () => { expect(validatePhoto({ position: 0, path: "/api/extension/batch/photos/x/0", fileName: "01.jpg" })).toEqual([]); });
  it("rejects a negative position, a blank path, a blank fileName", () => {
    expect(validatePhoto({ position: -1, path: "/api/extension/batch/photos/x/0", fileName: "01.jpg" }).length).toBeGreaterThan(0);
    expect(validatePhoto({ position: 0, path: "", fileName: "01.jpg" }).length).toBeGreaterThan(0);
    expect(validatePhoto({ position: 0, path: "/api/extension/batch/photos/x/0", fileName: "" }).length).toBeGreaterThan(0);
  });
  it("rejects a non-object", () => { expect(validatePhoto(null).length).toBeGreaterThan(0); });
});

describe("validateBatchItem — mirrors the server's own required-field shape", () => {
  it("accepts a fully valid item", () => { expect(validateBatchItem(validItem())).toEqual([]); });

  it("rejects each required field when missing/blank", () => {
    expect(validateBatchItem(validItem({ itemId: "" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ title: "" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ description: "" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ brand: "" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ productType: "" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ condition: "" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ audience: "" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ vintedCategoryPath: "" })).length).toBeGreaterThan(0);
  });

  it("accepts null for sku/model/ukSize — genuinely optional", () => {
    expect(validateBatchItem(validItem({ sku: null, model: null, ukSize: null }))).toEqual([]);
  });

  it("rejects a non-positive pricePence or vintedCategoryId", () => {
    expect(validateBatchItem(validItem({ pricePence: 0 })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ pricePence: -100 })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ vintedCategoryId: 0 })).length).toBeGreaterThan(0);
  });

  it("rejects colours/materials that aren't string arrays", () => {
    expect(validateBatchItem(validItem({ colours: "Black" })).length).toBeGreaterThan(0);
    expect(validateBatchItem(validItem({ materials: [1, 2] })).length).toBeGreaterThan(0);
  });

  it("rejects an empty photos array — a listing can never be processed with zero photos", () => {
    expect(validateBatchItem(validItem({ photos: [] })).length).toBeGreaterThan(0);
  });

  it("rejects a non-object item without throwing", () => {
    expect(validateBatchItem(null)).toEqual(["Item is not an object."]);
    expect(validateBatchItem(undefined)).toEqual(["Item is not an object."]);
  });
});

describe("validateBatchPayload", () => {
  it("accepts a fully valid payload", () => {
    const result = validateBatchPayload(validPayload());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a malformed payload (missing batchId) without throwing", () => {
    const result = validateBatchPayload({ ...validPayload(), batchId: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an empty items array", () => {
    const result = validateBatchPayload(validPayload({ items: [] }));
    expect(result.valid).toBe(false);
  });

  it("rejects more than 5 items", () => {
    const items = Array.from({ length: 6 }, (_, i) => validItem({ itemId: `item-${i}`, draftId: `draft-${i}` }));
    const result = validateBatchPayload(validPayload({ items }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => /exceeds the maximum/.test(e))).toBe(true);
  });

  it("propagates a nested item's own validation errors with an 'items:' style path is not required, but the message itself is present", () => {
    const result = validateBatchPayload(validPayload({ items: [validItem({ title: "" })] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => /title is required/.test(e))).toBe(true);
  });

  it("never throws on completely garbage input", () => {
    expect(() => validateBatchPayload(null)).not.toThrow();
    expect(() => validateBatchPayload("nope")).not.toThrow();
    expect(() => validateBatchPayload(42)).not.toThrow();
    expect(validateBatchPayload(null).valid).toBe(false);
  });
});

describe("isValidPairingCodeShape", () => {
  it("accepts an 8-character alphanumeric code", () => { expect(isValidPairingCodeShape("ABCD1234")).toBe(true); });
  it("accepts lowercase (normalised elsewhere, not here)", () => { expect(isValidPairingCodeShape("abcd1234")).toBe(true); });
  it("rejects too-short or too-long codes", () => {
    expect(isValidPairingCodeShape("AB")).toBe(false);
    expect(isValidPairingCodeShape("A".repeat(40))).toBe(false);
  });
  it("rejects non-alphanumeric characters and non-strings", () => {
    expect(isValidPairingCodeShape("ABCD-123")).toBe(false);
    expect(isValidPairingCodeShape(12345678 as unknown as string)).toBe(false);
    expect(isValidPairingCodeShape(null as unknown as string)).toBe(false);
  });
});
