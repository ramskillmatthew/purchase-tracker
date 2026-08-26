import { describe, expect, it } from "vitest";
import { validateDraftReadiness, type ReadinessInput } from "@/lib/listing-studio/readiness";
import type { FieldValue, ListingFieldData } from "@/lib/listing-studio/types";

function field<T>(overrides: Partial<FieldValue<T>> = {}): FieldValue<T> {
  return {
    value: null, confidence: "unconfirmed", source: "label", sourceImageId: null,
    aiGenerated: true, userConfirmed: false, conflict: false,
    ...overrides,
  } as FieldValue<T>;
}

function completeInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  const fields: ListingFieldData = {
    sku: field({ value: "TA-1001", userConfirmed: true }),
    brand: field({ value: "Nike", confidence: "high" }),
    condition: field({ value: "Brand new", userConfirmed: true }),
    ...overrides.fields,
  };
  return {
    imageCount: 4,
    fields,
    title: "Nike Air Max 90",
    description: "A great pair of trainers.",
    category: "Accessories", // deliberately size-exempt so the base fixture doesn't need a size
    sizeLabel: null,
    suggestedPricePence: 4500,
    confirmedPricePence: null,
    hasUnresolvedCriticalConflict: false,
    ...overrides,
  };
}

describe("validateDraftReadiness — Stage 1 spec §10 required-fields gate", () => {
  it("a fully complete, size-exempt-category draft is ready with nothing missing", () => {
    const result = validateDraftReadiness(completeInput());
    expect(result).toEqual({ ready: true, missing: [] });
  });

  it("missing photo when imageCount is 0", () => {
    const result = validateDraftReadiness(completeInput({ imageCount: 0 }));
    expect(result.ready).toBe(false);
    expect(result.missing).toContain("photo");
  });

  it("missing sku when the sku field isn't confirmed or confident", () => {
    const result = validateDraftReadiness(completeInput({ fields: { sku: field({ value: "TA-1001", confidence: "low" }) } }));
    expect(result.missing).toContain("sku");
  });

  it("missing title/description when blank or whitespace-only", () => {
    expect(validateDraftReadiness(completeInput({ title: "" })).missing).toContain("title");
    expect(validateDraftReadiness(completeInput({ title: "   " })).missing).toContain("title");
    expect(validateDraftReadiness(completeInput({ description: null })).missing).toContain("description");
  });

  it("missing brand when the brand field is low-confidence and unconfirmed", () => {
    const result = validateDraftReadiness(completeInput({ fields: { brand: field({ value: "Nike", confidence: "low" }) } }));
    expect(result.missing).toContain("brand");
  });

  it("missing category when blank", () => {
    expect(validateDraftReadiness(completeInput({ category: null })).missing).toContain("category");
  });

  it("missing condition when unconfirmed/low-confidence", () => {
    const result = validateDraftReadiness(completeInput({ fields: { condition: field({ value: "Good", confidence: "medium" }) } }));
    expect(result.missing).toContain("condition");
  });

  it("missing price when neither suggested nor confirmed price exists", () => {
    const result = validateDraftReadiness(completeInput({ suggestedPricePence: null, confirmedPricePence: null }));
    expect(result.missing).toContain("price");
  });

  it("a confirmed price alone (no AI suggestion) satisfies the price requirement", () => {
    const result = validateDraftReadiness(completeInput({ suggestedPricePence: null, confirmedPricePence: 5000 }));
    expect(result.missing).not.toContain("price");
  });

  it("an unresolved critical conflict blocks readiness even when every field is otherwise complete", () => {
    const result = validateDraftReadiness(completeInput({ hasUnresolvedCriticalConflict: true }));
    expect(result.ready).toBe(false);
    expect(result.missing).toContain("unresolved_conflict");
  });

  describe("category-specific size requirement", () => {
    it("shoes require a usable size — missing size blocks readiness", () => {
      const result = validateDraftReadiness(completeInput({ category: "Shoes", sizeLabel: null }));
      expect(result.missing).toContain("size");
    });

    it("shoes with a confirmed size are ready", () => {
      const result = validateDraftReadiness(completeInput({ category: "Shoes", sizeLabel: "UK 9" }));
      expect(result.missing).not.toContain("size");
      expect(result.ready).toBe(true);
    });

    it("a category that does not require size is never blocked by a missing size", () => {
      const result = validateDraftReadiness(completeInput({ category: "Accessories", sizeLabel: null }));
      expect(result.missing).not.toContain("size");
    });
  });

  it("REQUIREMENT: an unconfident/unset optional field like material never blocks readiness — it isn't checked at all", () => {
    // completeInput() never sets fields.materials — readiness must not care.
    const result = validateDraftReadiness(completeInput());
    expect(result.ready).toBe(true);
  });

  it("reports every missing requirement at once, not just the first one found", () => {
    const result = validateDraftReadiness({
      imageCount: 0, fields: {}, title: null, description: null, category: null,
      sizeLabel: null, suggestedPricePence: null, confirmedPricePence: null, hasUnresolvedCriticalConflict: false,
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(["photo", "sku", "title", "description", "brand", "category", "condition", "price"]));
    expect(result.missing).not.toContain("size"); // category is null -> categoryRequiresSize(null) is false
  });
});
