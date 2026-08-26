import { describe, expect, it } from "vitest";
import { parseSellingPricePounds, formatPenceAsGBP, MAX_SELLING_PRICE_PENCE } from "@/lib/listing-studio/selling-price";

describe("parseSellingPricePounds — Milestone 6: the single source of truth for a valid Vinted selling price", () => {
  it("a valid whole-pound value parses to integer pence", () => {
    expect(parseSellingPricePounds("45")).toEqual({ valid: true, pence: 4500 });
  });

  it("a valid pounds-and-pence value parses to integer pence", () => {
    expect(parseSellingPricePounds("45.50")).toEqual({ valid: true, pence: 4550 });
    expect(parseSellingPricePounds("18.50")).toEqual({ valid: true, pence: 1850 });
  });

  it("a single decimal digit is accepted (45.5 -> £45.50)", () => {
    expect(parseSellingPricePounds("45.5")).toEqual({ valid: true, pence: 4550 });
  });

  it("REGRESSION: blank is rejected", () => {
    expect(parseSellingPricePounds("").valid).toBe(false);
    expect(parseSellingPricePounds("   ").valid).toBe(false);
  });

  it("REGRESSION: zero is rejected", () => {
    expect(parseSellingPricePounds("0")).toEqual({ valid: false, error: expect.stringContaining("greater than £0") });
    expect(parseSellingPricePounds("0.00").valid).toBe(false);
  });

  it("REGRESSION: negative is rejected", () => {
    expect(parseSellingPricePounds("-5")).toEqual({ valid: false, error: expect.stringContaining("negative") });
    expect(parseSellingPricePounds("-0.01").valid).toBe(false);
  });

  it("REGRESSION: malformed values are rejected", () => {
    for (const input of ["abc", "45,00", "45..00", "£", "one hundred", "45-", "NaN", "Infinity"]) {
      expect(parseSellingPricePounds(input).valid).toBe(false);
    }
  });

  it("REGRESSION: more than 2 decimal places is rejected (never a fractional penny)", () => {
    expect(parseSellingPricePounds("45.555").valid).toBe(false);
    expect(parseSellingPricePounds("45.001").valid).toBe(false);
  });

  it("REGRESSION: an excessive value is rejected", () => {
    const overLimit = (MAX_SELLING_PRICE_PENCE / 100 + 1).toString();
    expect(parseSellingPricePounds(overLimit)).toEqual({ valid: false, error: expect.stringContaining("under") });
  });

  it("exactly the maximum is accepted (boundary, not off-by-one)", () => {
    const atLimit = (MAX_SELLING_PRICE_PENCE / 100).toString();
    expect(parseSellingPricePounds(atLimit)).toEqual({ valid: true, pence: MAX_SELLING_PRICE_PENCE });
  });

  it("trims surrounding whitespace", () => {
    expect(parseSellingPricePounds("  45.00  ")).toEqual({ valid: true, pence: 4500 });
  });

  it("strips a leading £ defensively", () => {
    expect(parseSellingPricePounds("£45.00")).toEqual({ valid: true, pence: 4500 });
  });

  it("stored value is always an exact integer, never a float artefact", () => {
    const result = parseSellingPricePounds("19.99");
    expect(result.valid).toBe(true);
    if (result.valid) expect(Number.isInteger(result.pence)).toBe(true);
  });
});

describe("formatPenceAsGBP — two decimal places, £ prefix", () => {
  it("formats whole pounds with two decimal places", () => {
    expect(formatPenceAsGBP(4500)).toBe("£45.00");
  });

  it("formats pounds and pence", () => {
    expect(formatPenceAsGBP(1850)).toBe("£18.50");
  });

  it("formats a single-digit pence value with a leading zero", () => {
    expect(formatPenceAsGBP(4505)).toBe("£45.05");
  });

  it("null/undefined/non-finite format as empty string, never £0.00 or NaN", () => {
    expect(formatPenceAsGBP(null)).toBe("");
    expect(formatPenceAsGBP(undefined)).toBe("");
    expect(formatPenceAsGBP(NaN)).toBe("");
  });
});
