import { describe, expect, it } from "vitest";
import { confirmField, isFieldConfirmedOrConfident, markFieldIncorrect, mergeFieldData, mergeFieldValue } from "@/lib/listing-studio/field-value";
import type { FieldValue, ListingFieldData } from "@/lib/listing-studio/types";

function field<T>(overrides: Partial<FieldValue<T>> = {}): FieldValue<T> {
  return {
    value: null, confidence: "unconfirmed", source: "label", sourceImageId: null,
    aiGenerated: true, userConfirmed: false, conflict: false,
    ...overrides,
  } as FieldValue<T>;
}

describe("mergeFieldValue — the core 'never silently overwrite a confirmed field' rule", () => {
  it("a confirmed existing field is returned untouched when the incoming value differs", () => {
    const existing = field({ value: "Nike", userConfirmed: true });
    const incoming = field({ value: "Adidas", confidence: "high" });
    expect(mergeFieldValue(existing, incoming)).toBe(existing);
  });

  it("an unconfirmed existing field is replaced by the incoming value", () => {
    const existing = field({ value: "Nike", userConfirmed: false });
    const incoming = field({ value: "Adidas", confidence: "high" });
    expect(mergeFieldValue(existing, incoming)).toBe(incoming);
  });

  it("with no existing field at all, the incoming value is used", () => {
    const incoming = field({ value: "Nike" });
    expect(mergeFieldValue(undefined, incoming)).toBe(incoming);
  });

  it("forceReplace explicitly overrides a confirmed field", () => {
    const existing = field({ value: "Nike", userConfirmed: true });
    const incoming = field({ value: "Adidas" });
    expect(mergeFieldValue(existing, incoming, { forceReplace: true })).toBe(incoming);
  });
});

describe("mergeFieldData — merging a full AI-pass result field by field", () => {
  it("leaves a confirmed field untouched while updating an unconfirmed neighbour in the same call", () => {
    const existing: ListingFieldData = {
      brand: field({ value: "Nike", userConfirmed: true }),
      model: field({ value: "Air Max 90", userConfirmed: false }),
    };
    const incoming: Partial<ListingFieldData> = {
      brand: field({ value: "Adidas" }),
      model: field({ value: "Air Max 95", confidence: "high" }),
    };
    const result = mergeFieldData(existing, incoming);
    expect(result.brand).toBe(existing.brand);
    expect(result.model).toBe(incoming.model);
  });

  it("fields not present in the incoming result are left entirely alone", () => {
    const existing: ListingFieldData = { sku: field({ value: "TA-1001" }) };
    const result = mergeFieldData(existing, {});
    expect(result.sku).toBe(existing.sku);
  });

  it("forceReplaceFields lets a specific confirmed field be overwritten while other confirmed fields stay protected", () => {
    const existing: ListingFieldData = {
      brand: field({ value: "Nike", userConfirmed: true }),
      sku: field({ value: "TA-1001", userConfirmed: true }),
    };
    const incoming: Partial<ListingFieldData> = {
      brand: field({ value: "Adidas" }),
      sku: field({ value: "TA-9999" }),
    };
    const result = mergeFieldData(existing, incoming, { forceReplaceFields: ["brand"] });
    expect(result.brand).toBe(incoming.brand);
    expect(result.sku).toBe(existing.sku); // sku was NOT in forceReplaceFields — stays protected
  });
});

describe("confirmField — a user explicitly confirming a value", () => {
  it("marks the field high-confidence, user-sourced, confirmed, and clears any conflict", () => {
    const existing = field<string>({ sourceImageId: "img-1", conflict: true });
    const result = confirmField(existing, "Nike");
    expect(result).toEqual({
      value: "Nike", confidence: "high", source: "user", sourceImageId: "img-1",
      aiGenerated: false, userConfirmed: true, conflict: false,
    });
  });

  it("works with no prior field at all (first-time manual entry)", () => {
    const result = confirmField<string>(undefined, "TA-1001");
    expect(result.value).toBe("TA-1001");
    expect(result.userConfirmed).toBe(true);
    expect(result.sourceImageId).toBeNull();
  });
});

describe("markFieldIncorrect — clearing a confirmation so regeneration can replace it again", () => {
  it("clears userConfirmed and confidence without inventing a new value", () => {
    const existing = field({ value: "Nike", userConfirmed: true, confidence: "high" });
    const result = markFieldIncorrect(existing);
    expect(result.userConfirmed).toBe(false);
    expect(result.confidence).toBe("unconfirmed");
    expect(result.value).toBe("Nike"); // value itself is preserved, only trust is revoked
  });
});

describe("isFieldConfirmedOrConfident — the gate readiness validation relies on", () => {
  it("false when the field is undefined", () => {
    expect(isFieldConfirmedOrConfident(undefined)).toBe(false);
  });
  it("false when the value is null even if marked confirmed", () => {
    expect(isFieldConfirmedOrConfident(field({ value: null, userConfirmed: true }))).toBe(false);
  });
  it("true when user-confirmed with a real value, regardless of confidence", () => {
    expect(isFieldConfirmedOrConfident(field({ value: "Nike", userConfirmed: true, confidence: "low" }))).toBe(true);
  });
  it("true when high-confidence even without explicit user confirmation", () => {
    expect(isFieldConfirmedOrConfident(field({ value: "Nike", userConfirmed: false, confidence: "high" }))).toBe(true);
  });
  it("false for medium/low/unconfirmed/conflict confidence without user confirmation", () => {
    for (const confidence of ["medium", "low", "unconfirmed", "conflict"] as const) {
      expect(isFieldConfirmedOrConfident(field({ value: "Nike", userConfirmed: false, confidence }))).toBe(false);
    }
  });
});
