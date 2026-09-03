import { describe, expect, it } from "vitest";
import { toEbayInventoryCondition, EBAY_CONDITION_ENUM_VALUES } from "@/lib/listing-studio/ebay-condition";

/**
 * SAFETY CORRECTION PASS — the previous version of this translator
 * optimistically mapped bare, ungraded labels ("Used", "Pre-owned") to
 * USED_EXCELLENT, and bare "Good" to USED_GOOD despite eBay's own
 * vocabulary using "Good" for two different conditions (USED_GOOD vs
 * GOOD_REFURBISHED). These tests prove the corrected fail-closed
 * behaviour and the preserved safe mappings.
 */
describe("toEbayInventoryCondition — fail-closed for ambiguous/ungraded labels", () => {
  it("REQUIREMENT: bare 'Used' fails closed — never optimistically upgraded to USED_EXCELLENT", () => {
    const result = toEbayInventoryCondition("Used");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Choose a specific eBay condition.");
  });

  it("REQUIREMENT: bare 'Pre-owned' fails closed unless accompanied by an authoritative grade", () => {
    for (const label of ["Pre-owned", "Preowned", "pre owned"]) {
      const result = toEbayInventoryCondition(label);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason).toBe("Choose a specific eBay condition.");
    }
  });

  it("REQUIREMENT: 'Pre-owned - Good' fails closed — eBay's own display synonym for USED_EXCELLENT is confusingly named and never trusted blindly", () => {
    const result = toEbayInventoryCondition("Pre-owned - Good");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Choose a specific eBay condition.");
  });

  it("REQUIREMENT: bare 'Good' fails closed — ambiguous against eBay's own 'Good - Refurbished', never assumed to mean USED_GOOD", () => {
    const result = toEbayInventoryCondition("Good");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Choose a specific eBay condition.");
  });

  it("REQUIREMENT: bare 'Fair' is never inferred without an authoritative canonical source", () => {
    const result = toEbayInventoryCondition("Fair");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Choose a specific eBay condition.");
  });

  it("'Open Box Used' fails closed — eBay's own table lists 'Open Box' as a synonym for BOTH NEW_OTHER and USED_EXCELLENT depending on context; never guessed", () => {
    const result = toEbayInventoryCondition("Open Box Used");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Choose a specific eBay condition.");
  });

  it("REQUIREMENT: unknown conditions fail closed with the generic message, distinct from the ambiguous-term message", () => {
    for (const label of ["Mint", "Gently used", "9/10", "??", "some made up condition"]) {
      const result = toEbayInventoryCondition(label);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason).toBe("Missing or unsupported eBay condition.");
    }
  });

  it("REQUIREMENT: empty/missing conditions fail closed", () => {
    for (const value of [null, undefined, "", "   "]) {
      const result = toEbayInventoryCondition(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("Missing or unsupported eBay condition.");
    }
  });

  it("REQUIREMENT: no generic/ambiguous condition ever resolves to USED_EXCELLENT — the exact old failure mode", () => {
    for (const label of ["Used", "Pre-owned", "Pre-owned - Good", "some made up condition", null]) {
      const result = toEbayInventoryCondition(label);
      if (result.ok) expect(result.enumValue).not.toBe("USED_EXCELLENT");
      else expect(result.ok).toBe(false);
    }
  });

  it("REQUIREMENT: no fuzzy substring match accidentally upgrades a condition — a longer unrelated phrase containing 'good' or 'used' is never silently matched", () => {
    for (const label of ["This item is used but I forgot the grade", "Good but not sure how good", "a really good deal"]) {
      const result = toEbayInventoryCondition(label);
      expect(result.ok, label).toBe(false);
    }
  });
});

describe("toEbayInventoryCondition — preserved, explicit, safe mappings", () => {
  it("REQUIREMENT 4: the confirmed SKU 1644 mapping is unchanged — 'Used – Very Good' -> USED_VERY_GOOD", () => {
    expect(toEbayInventoryCondition("Used – Very Good")).toEqual({ ok: true, enumValue: "USED_VERY_GOOD" });
  });

  it("hyphen/en-dash/case/spacing variants of the same explicit grade all map identically", () => {
    for (const label of ["Used - Very Good", "Used – Very Good", "used very good", "USED VERY GOOD", "Used   Very   Good", "Very Good"]) {
      expect(toEbayInventoryCondition(label)).toEqual({ ok: true, enumValue: "USED_VERY_GOOD" });
    }
  });

  it("REQUIREMENT: explicit 'Used - Good' maps to USED_GOOD (the ambiguity is resolved by the explicit 'used' pairing, unlike bare 'Good')", () => {
    expect(toEbayInventoryCondition("Used - Good")).toEqual({ ok: true, enumValue: "USED_GOOD" });
    expect(toEbayInventoryCondition("Used Good")).toEqual({ ok: true, enumValue: "USED_GOOD" });
  });

  it("REQUIREMENT: explicit 'Used - Acceptable' maps to USED_ACCEPTABLE", () => {
    expect(toEbayInventoryCondition("Used - Acceptable")).toEqual({ ok: true, enumValue: "USED_ACCEPTABLE" });
    expect(toEbayInventoryCondition("Acceptable")).toEqual({ ok: true, enumValue: "USED_ACCEPTABLE" });
  });

  it("REQUIREMENT: explicit 'Used - Excellent' maps to USED_EXCELLENT — the grade must be stated explicitly, never inferred from bare 'Used'", () => {
    expect(toEbayInventoryCondition("Used - Excellent")).toEqual({ ok: true, enumValue: "USED_EXCELLENT" });
    expect(toEbayInventoryCondition("Used Excellent")).toEqual({ ok: true, enumValue: "USED_EXCELLENT" });
  });

  it("New (unopened) and its explicit synonyms still map to NEW — no competing eBay condition shares this word", () => {
    for (const label of ["New", "Brand New", "New with tags", "New with box"]) {
      expect(toEbayInventoryCondition(label)).toEqual({ ok: true, enumValue: "NEW" });
    }
  });

  it("an already-correct enum token passes through unchanged, case/spacing-insensitive", () => {
    expect(toEbayInventoryCondition("USED_VERY_GOOD")).toEqual({ ok: true, enumValue: "USED_VERY_GOOD" });
    expect(toEbayInventoryCondition("used_very_good")).toEqual({ ok: true, enumValue: "USED_VERY_GOOD" });
  });
});

describe("REQUIREMENT 3: every retained internal/legacy condition form the app can generate or plausibly store — all explicitly graded", () => {
  const cases: Array<[string, (typeof EBAY_CONDITION_ENUM_VALUES)[number]]> = [
    ["New", "NEW"], ["Brand New", "NEW"], ["New with box", "NEW"], ["New with tags", "NEW"], ["NWT", "NEW"],
    ["New other", "NEW_OTHER"], ["New without tags", "NEW_OTHER"], ["NWOT", "NEW_OTHER"], ["Open box", "NEW_OTHER"],
    ["New with defects", "NEW_WITH_DEFECTS"],
    ["Certified Refurbished", "CERTIFIED_REFURBISHED"],
    ["Excellent - Refurbished", "EXCELLENT_REFURBISHED"],
    ["Very Good - Refurbished", "VERY_GOOD_REFURBISHED"],
    ["Good - Refurbished", "GOOD_REFURBISHED"],
    ["Seller refurbished", "SELLER_REFURBISHED"], ["Remanufactured", "SELLER_REFURBISHED"],
    ["Like New", "LIKE_NEW"],
    ["Pre-owned - Excellent", "PRE_OWNED_EXCELLENT"],
    ["Pre-owned - Fair", "PRE_OWNED_FAIR"],
    ["Used – Very Good", "USED_VERY_GOOD"], ["Very Good", "USED_VERY_GOOD"],
    ["Used - Good", "USED_GOOD"],
    ["Used - Excellent", "USED_EXCELLENT"],
    ["Used - Acceptable", "USED_ACCEPTABLE"], ["Acceptable", "USED_ACCEPTABLE"],
    ["For parts or not working", "FOR_PARTS_OR_NOT_WORKING"],
    // Already-correct enum tokens must pass straight through unchanged.
    ["USED_VERY_GOOD", "USED_VERY_GOOD"], ["new", "NEW"],
  ];
  for (const [label, expected] of cases) {
    it(`"${label}" -> ${expected}`, () => {
      expect(toEbayInventoryCondition(label)).toEqual({ ok: true, enumValue: expected });
    });
  }

  it("every ambiguous bare term named in the corrective-pass audit is now rejected, never mapped", () => {
    for (const label of ["Used", "Pre-owned", "Pre-owned - Good", "Good", "Fair", "Open box used"]) {
      const result = toEbayInventoryCondition(label);
      expect(result.ok, label).toBe(false);
    }
  });
});

describe("REQUIREMENT 6: the retained ConditionEnum list itself — re-verified against authoritative eBay documentation", () => {
  it("contains exactly the 16 tokens confirmed via two independent fetches of eBay's own condition-ID reference page", () => {
    expect([...EBAY_CONDITION_ENUM_VALUES].sort()).toEqual([
      "CERTIFIED_REFURBISHED", "EXCELLENT_REFURBISHED", "FOR_PARTS_OR_NOT_WORKING", "GOOD_REFURBISHED",
      "LIKE_NEW", "NEW", "NEW_OTHER", "NEW_WITH_DEFECTS", "PRE_OWNED_EXCELLENT", "PRE_OWNED_FAIR",
      "SELLER_REFURBISHED", "USED_ACCEPTABLE", "USED_EXCELLENT", "USED_GOOD", "USED_VERY_GOOD", "VERY_GOOD_REFURBISHED",
    ].sort());
  });
});
