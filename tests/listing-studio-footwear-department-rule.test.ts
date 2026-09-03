import { describe, expect, it } from "vitest";
import { isFootwearSizeBelowUk7, requiresWomensDepartment, categoryTextIndicatesWomens } from "@/lib/listing-studio/footwear-department-rule";

describe("isFootwearSizeBelowUk7 — the ONE deterministic below-UK-7 threshold, shared by eBay and Vinted", () => {
  for (const size of ["3", "4", "5", "6", "6.5"]) {
    it(`REQUIREMENT: UK size ${size} is below the UK 7 threshold`, () => expect(isFootwearSizeBelowUk7(size)).toBe(true));
  }
  for (const size of ["7", "7.5", "8", "10"]) {
    it(`REQUIREMENT: UK size ${size} is NOT below the UK 7 threshold`, () => expect(isFootwearSizeBelowUk7(size)).toBe(false));
  }
  it("a null/empty/non-numeric size is never treated as below UK 7 — the rule only fires on a genuinely known size", () => {
    expect(isFootwearSizeBelowUk7(null)).toBe(false);
    expect(isFootwearSizeBelowUk7(undefined)).toBe(false);
    expect(isFootwearSizeBelowUk7("")).toBe(false);
    expect(isFootwearSizeBelowUk7("unknown")).toBe(false);
  });
});

describe("requiresWomensDepartment — gated to footwear only", () => {
  it("REQUIREMENT: footwear at UK 4 requires Women's", () => expect(requiresWomensDepartment("footwear", "4")).toBe(true));
  it("clothing at any size never triggers the footwear rule", () => expect(requiresWomensDepartment("clothing", "4")).toBe(false));
  it("an uncertain item family never triggers the rule", () => expect(requiresWomensDepartment("uncertain", "4")).toBe(false));
});

describe("categoryTextIndicatesWomens — recognises real eBay category text, never fabricates one", () => {
  it("recognises the real eBay UK category path from the screenshots", () => {
    expect(categoryTextIndicatesWomens("Women's Shoes > Women > Clothes, Shoes & Accessories > Trainers")).toBe(true);
  });
  it("recognises a bare 'Women' department name", () => expect(categoryTextIndicatesWomens("Women")).toBe(true));
  it("does not match Men's or Children's category text", () => {
    expect(categoryTextIndicatesWomens("Men's Shoes > Men > Trainers")).toBe(false);
    expect(categoryTextIndicatesWomens("Kids > Boys' Shoes")).toBe(false);
  });
  it("null/empty text is never treated as Women's", () => {
    expect(categoryTextIndicatesWomens(null)).toBe(false);
    expect(categoryTextIndicatesWomens("")).toBe(false);
  });
});
