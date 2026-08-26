import { describe, it, expect } from "vitest";
import { canonicaliseVintedBrand } from "@/lib/listing-studio/vinted-brand-canonicalisation";

describe("canonicaliseVintedBrand — follow-up correction: AI 'On' must become Vinted's real brand 'On Running'", () => {
  it('REQUIREMENT: exact "On" (any case) becomes "On Running"', () => {
    expect(canonicaliseVintedBrand("On")).toBe("On Running");
    expect(canonicaliseVintedBrand("on")).toBe("On Running");
    expect(canonicaliseVintedBrand("ON")).toBe("On Running");
    expect(canonicaliseVintedBrand("oN")).toBe("On Running");
  });

  it("REQUIREMENT: trims whitespace before the exact comparison", () => {
    expect(canonicaliseVintedBrand("  On  ")).toBe("On Running");
    expect(canonicaliseVintedBrand("\tOn\n")).toBe("On Running");
  });

  it('REQUIREMENT: "On Running" itself is left unchanged', () => {
    expect(canonicaliseVintedBrand("On Running")).toBe("On Running");
  });

  it("REQUIREMENT: never a broad substring/prefix replacement — brands merely containing \"on\" are untouched", () => {
    expect(canonicaliseVintedBrand("On Cloud")).toBe("On Cloud");
    expect(canonicaliseVintedBrand("On Line")).toBe("On Line");
    expect(canonicaliseVintedBrand("On That Ass")).toBe("On That Ass");
    expect(canonicaliseVintedBrand("London")).toBe("London");
    expect(canonicaliseVintedBrand("Moncler")).toBe("Moncler");
  });

  it("unrelated brands pass through completely unchanged", () => {
    for (const brand of ["Nike", "Adidas", "ASICS", "New Balance", "Hoka", "Birkenstock"]) {
      expect(canonicaliseVintedBrand(brand)).toBe(brand);
    }
  });

  it("null passes through as null (AI genuinely couldn't identify a brand)", () => {
    expect(canonicaliseVintedBrand(null)).toBeNull();
  });
});
