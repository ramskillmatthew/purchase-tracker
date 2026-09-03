import { describe, expect, it } from "vitest";
import { toEbayInventoryCondition, EBAY_CONDITION_ENUM_VALUES } from "@/lib/listing-studio/ebay-condition";

/**
 * Corrective pass (failed first eBay draft, root cause) — genuine
 * behavioural tests for the one translator that must never again let a
 * display label reach eBay's Inventory API `condition` field.
 */
describe("toEbayInventoryCondition — the exact bug that failed Batch 1", () => {
  it("REQUIREMENT 1: 'Used – Very Good' (this app's own generated label, en dash) maps to USED_VERY_GOOD", () => {
    expect(toEbayInventoryCondition("Used – Very Good")).toEqual({ ok: true, enumValue: "USED_VERY_GOOD" });
  });

  it("REQUIREMENT 2: hyphen and en-dash variants map identically", () => {
    for (const label of ["Used - Very Good", "Used – Very Good", "used very good", "USED VERY GOOD", "Used   Very   Good"]) {
      expect(toEbayInventoryCondition(label)).toEqual({ ok: true, enumValue: "USED_VERY_GOOD" });
    }
  });

  it("REQUIREMENT 6: no USED_EXCELLENT fallback remains for a missing/blank condition", () => {
    expect(toEbayInventoryCondition(null)).toEqual({ ok: false, reason: "Missing or unsupported eBay condition." });
    expect(toEbayInventoryCondition(undefined)).toEqual({ ok: false, reason: "Missing or unsupported eBay condition." });
    expect(toEbayInventoryCondition("")).toEqual({ ok: false, reason: "Missing or unsupported eBay condition." });
    expect(toEbayInventoryCondition("   ")).toEqual({ ok: false, reason: "Missing or unsupported eBay condition." });
  });

  it("REQUIREMENT 4/5: an unknown/ambiguous value fails closed with a precise blocker, never a guess", () => {
    for (const label of ["Mint", "Gently used", "Condition: unclear", "9/10", "??"]) {
      const result = toEbayInventoryCondition(label);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason).toBe("Missing or unsupported eBay condition.");
    }
  });

  it("never returns USED_EXCELLENT for an unrecognised value (the exact old failure mode)", () => {
    const result = toEbayInventoryCondition("some made up condition");
    expect(result.ok).toBe(false);
  });
});

describe("REQUIREMENT 3: every internal/legacy condition form the app can generate or plausibly store", () => {
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
    ["Used", "USED_EXCELLENT"], ["Pre-owned", "USED_EXCELLENT"],
    ["Pre-owned - Fair", "PRE_OWNED_FAIR"],
    ["Used – Very Good", "USED_VERY_GOOD"], ["Very Good", "USED_VERY_GOOD"],
    ["Used Good", "USED_GOOD"], ["Good", "USED_GOOD"],
    ["Used Acceptable", "USED_ACCEPTABLE"], ["Acceptable", "USED_ACCEPTABLE"],
    ["For parts or not working", "FOR_PARTS_OR_NOT_WORKING"],
    // Already-correct enum tokens must pass straight through unchanged.
    ["USED_VERY_GOOD", "USED_VERY_GOOD"], ["new", "NEW"],
  ];
  for (const [label, expected] of cases) {
    it(`"${label}" -> ${expected}`, () => {
      expect(toEbayInventoryCondition(label)).toEqual({ ok: true, enumValue: expected });
    });
  }
});

describe("REQUIREMENT 7: display labels never reach the API payload — this app's own generated labels are display-only", () => {
  it("the generation module's own label function is documented as UI-facing, never as an API value", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-draft-generation.ts", "utf8") as string;
    expect(source).toMatch(/UI-facing condition label/);
  });

  it("the batch processor's payload builder always routes conditionValue through toEbayInventoryCondition, never sends it raw", async () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-draft-batches.ts", "utf8") as string;
    expect(source).not.toMatch(/condition:\s*draft\.conditionValue/);
    expect(source).toContain("toEbayInventoryCondition(draft.conditionValue)");
  });
});
