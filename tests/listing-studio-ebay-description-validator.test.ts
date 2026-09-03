import { describe, expect, it } from "vitest";
import { validateEbayDescription, repairEbayDescription } from "@/lib/listing-studio/ebay-description-validator";

describe("validateEbayDescription", () => {
  it("accepts a clean, product-specific description", () => {
    expect(validateEbayDescription("Nike Pegasus 40 running trainers in black.\n\nCondition: light sole wear, no rips or tears.")).toEqual([]);
  });

  it("flags an empty description", () => {
    expect(validateEbayDescription("").map(i => i.code)).toEqual(["empty"]);
  });

  it("REQUIREMENT (adversarial): flags the exact reported Vinted boilerplate phrases", () => {
    const description = "Always authentic & trusted seller ✅\n10-20% Discount for Bundles, have a look!\nPlease look at my other items";
    const codes = validateEbayDescription(description).map(i => i.code);
    expect(codes).toContain("vinted_boilerplate");
    expect(codes).toContain("emoji");
  });

  it("flags emojis anywhere in the description", () => {
    expect(validateEbayDescription("Great trainers 🔥 in good condition.").map(i => i.code)).toContain("emoji");
  });

  it("flags external links", () => {
    expect(validateEbayDescription("See more at https://example.com/shop").map(i => i.code)).toContain("external_link");
  });

  it("flags active/script content", () => {
    expect(validateEbayDescription('<script>alert(1)</script> Nice trainers').map(i => i.code)).toContain("active_content");
  });

  it("flags hashtags", () => {
    expect(validateEbayDescription("Great trainers #sale #trending").map(i => i.code)).toContain("hashtag");
  });

  it("REQUIREMENT: flags a bare SKU mixed into ordinary prose", () => {
    const codes = validateEbayDescription("These are great trainers. SKU: AB123 available now.").map(i => i.code);
    expect(codes).toContain("sku_leakage");
  });

  it("Problem 3 fix: allows an internal SKU as the LAST bullet under a 'Details' heading", () => {
    const codes = validateEbayDescription("Great trainers in good condition.\n\nDetails\n• Model: Pegasus 40\n• SKU: AB123").map(i => i.code);
    expect(codes).not.toContain("sku_leakage");
    expect(codes).not.toContain("sku_not_last");
  });

  it("REGRESSION: flags a SKU bullet under 'Details' that is NOT the last bullet", () => {
    const codes = validateEbayDescription("Great trainers.\n\nDetails\n• SKU: AB123\n• Model: Pegasus 40").map(i => i.code);
    expect(codes).toContain("sku_not_last");
  });

  it("flags a SKU bullet under a heading other than 'Details' (e.g. the old 'Reference' convention is no longer accepted)", () => {
    const codes = validateEbayDescription("Great trainers in good condition.\n\nReference\n• SKU: AB123").map(i => i.code);
    expect(codes).toContain("sku_leakage");
  });

  it("Problem 3's exact reported bug: flags markdown-style '**bold**' headers", () => {
    const codes = validateEbayDescription("**Key Details**\nSome trainers.\n\n**Condition**\nGood.").map(i => i.code);
    expect(codes).toContain("markdown_markup");
  });

  it("flags markdown '#' heading markers", () => {
    expect(validateEbayDescription("# Trainers\n\nGreat condition.").map(i => i.code)).toContain("markdown_markup");
  });

  it("never flags a clean, deterministically-rendered description (the New Balance 2002R example shape)", () => {
    const description = "New Balance 2002R Men's Trainers – UK 9\n\nGenuine New Balance 2002R trainers in grey, UK size 9.\n\nCondition: Very good pre-owned condition. Light signs of previous wear as shown in the photographs.\n\nDetails\n• Model: 2002R\n• Size: UK 9\n• Colour: Grey\n• Style code: M2002RST\n• Includes: Trainers only\n• SKU: 1648\n\nPlease review all photographs carefully as they form part of the condition description.\n\nOrders are securely packaged and dispatched promptly.";
    expect(validateEbayDescription(description)).toEqual([]);
  });
});

describe("repairEbayDescription", () => {
  it("strips lines containing banned Vinted phrases, keeping the rest intact", () => {
    const description = "Nike Pegasus 40 trainers in black.\nAlways authentic & trusted seller ✅\nLight sole wear visible.\nPlease look at my other items";
    const repaired = repairEbayDescription(description);
    expect(repaired).toContain("Nike Pegasus 40 trainers in black.");
    expect(repaired).toContain("Light sole wear visible.");
    expect(repaired).not.toContain("authentic & trusted");
    expect(repaired).not.toContain("look at my other items");
  });

  it("strips emoji-only/hashtag lines", () => {
    const repaired = repairEbayDescription("Great condition.\n🔥🔥🔥\n#sale");
    expect(repaired).toBe("Great condition.");
  });

  it("collapses resulting excess blank lines", () => {
    const repaired = repairEbayDescription("Line one.\nAlways authentic & trusted seller\nLine two.");
    expect(repaired).not.toMatch(/\n{3,}/);
  });

  it("never invents replacement text — a fully-banned description repairs to an empty string", () => {
    expect(repairEbayDescription("Always authentic & trusted seller\nPlease look at my other items")).toBe("");
  });

  it("leaves an already-clean description completely unchanged", () => {
    const clean = "Nike Pegasus 40 trainers.\n\nCondition: light wear.";
    expect(repairEbayDescription(clean)).toBe(clean);
  });
});
