import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { resolveMarketplaceSettings, defaultContentModeForSourceType, FALLBACK_MARKETPLACE_DRAFT_SETTINGS } from "@/lib/listing-studio/marketplace-settings";
import { generateEbayTitle, generateEbayDescription, EBAY_TITLE_MAX_LENGTH } from "@/lib/listing-studio/ebay-listing-template";
import { buildEbayDraftFromGeneratedFields } from "@/lib/listing-studio/ebay-draft-generation";
import { marketplacesForTarget } from "@/lib/listing-studio/marketplace-types";
import { marketplaceDraftSettingsSchema, sharedFactsSchema } from "@/lib/validation/listing-studio-marketplace";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";

describe("marketplacesForTarget", () => {
  it("BOTH expands to both real marketplaces, never stored as its own value", () => {
    expect(marketplacesForTarget("BOTH")).toEqual(["VINTED", "EBAY_UK"]);
  });
  it("a single target maps to itself", () => {
    expect(marketplacesForTarget("EBAY_UK")).toEqual(["EBAY_UK"]);
    expect(marketplacesForTarget("VINTED")).toEqual(["VINTED"]);
  });
});

describe("computeMarketplaceReadiness", () => {
  const allCore = { hasCategory: true, hasCondition: true, hasTitle: true, hasDescriptionOrGenerationPath: true, hasPhoto: true, hasPrice: true, hasQuantity: true, hasSufficientSellingSettings: true };

  it("ready only when every required check (core + required aspects) is complete", () => {
    const readiness = computeMarketplaceReadiness({ ...allCore, requiredAspectsFilled: [true, true], recommendedAspectsFilled: [] });
    expect(readiness.ready).toBe(true);
    expect(readiness.completionPercent).toBe(100);
  });

  it("REGRESSION: a single missing required core field blocks readiness, even with every aspect filled", () => {
    const readiness = computeMarketplaceReadiness({ ...allCore, hasCategory: false, requiredAspectsFilled: [true], recommendedAspectsFilled: [] });
    expect(readiness.ready).toBe(false);
  });

  it("REGRESSION: a missing REQUIRED aspect blocks readiness", () => {
    const readiness = computeMarketplaceReadiness({ ...allCore, requiredAspectsFilled: [true, false], recommendedAspectsFilled: [] });
    expect(readiness.ready).toBe(false);
  });

  it("a missing RECOMMENDED aspect never blocks readiness, only lowers completionPercent", () => {
    const readiness = computeMarketplaceReadiness({ ...allCore, requiredAspectsFilled: [], recommendedAspectsFilled: [true, false] });
    expect(readiness.ready).toBe(true);
    expect(readiness.completionPercent).toBeLessThan(100);
    expect(readiness.recommendedComplete).toBe(1);
    expect(readiness.recommendedTotal).toBe(2);
  });

  it("returns 0% completion (not NaN or a crash) when there is nothing at all to check", () => {
    const readiness = computeMarketplaceReadiness({
      hasCategory: false, hasCondition: false, hasTitle: false, hasDescriptionOrGenerationPath: false,
      hasPhoto: false, hasPrice: false, hasQuantity: false, hasSufficientSellingSettings: false,
      requiredAspectsFilled: [], recommendedAspectsFilled: [],
    });
    expect(readiness.completionPercent).toBe(0);
    expect(readiness.ready).toBe(false);
  });
});

describe("resolveMarketplaceSettings — 3-level hierarchy (account -> batch -> per-draft)", () => {
  it("falls all the way back to fixed application defaults when nothing is set at any level", () => {
    expect(resolveMarketplaceSettings(null, null, null)).toEqual(FALLBACK_MARKETPLACE_DRAFT_SETTINGS);
  });

  it("account defaults apply when nothing more specific overrides them", () => {
    const resolved = resolveMarketplaceSettings({ automationMode: "strict" }, null, null);
    expect(resolved.automationMode).toBe("strict");
    expect(resolved.quantity).toBe(FALLBACK_MARKETPLACE_DRAFT_SETTINGS.quantity);
  });

  it("REGRESSION: batch settings win over account defaults", () => {
    const resolved = resolveMarketplaceSettings({ automationMode: "strict" }, { automationMode: "fast" }, null);
    expect(resolved.automationMode).toBe("fast");
  });

  it("REGRESSION: a per-draft override wins over both account defaults and batch settings", () => {
    const resolved = resolveMarketplaceSettings({ quantity: 5 }, { quantity: 10 }, { quantity: 1 });
    expect(resolved.quantity).toBe(1);
  });

  it("an explicit key at a lower level survives when a higher level omits that key entirely", () => {
    const resolved = resolveMarketplaceSettings({ allowOffers: true }, {}, { quantity: 3 });
    expect(resolved.allowOffers).toBe(true);
    expect(resolved.quantity).toBe(3);
  });
});

describe("defaultContentModeForSourceType", () => {
  it("a freshly photo-generated draft defaults to SEO optimised", () => {
    expect(defaultContentModeForSourceType("generated")).toBe("seo_optimised");
  });
  it("REGRESSION: an eBay-imported draft defaults to exact copy, never automatically rewritten", () => {
    expect(defaultContentModeForSourceType("imported_ebay")).toBe("exact_copy");
  });
});

describe("generateEbayTitle / generateEbayDescription — professional tone, never inventing facts", () => {
  const fullFields = { brand: "Nike", model: "Pegasus 40", productType: "Running Trainers", colours: ["Black", "White"], material: "Mesh", ukSize: "9", conditionLabel: "Used" };

  it("composes brand/model/product type, colour and size in the documented order", () => {
    expect(generateEbayTitle(fullFields)).toBe("Nike Pegasus 40 Running Trainers - Black White - Size UK 9");
  });

  it("REGRESSION: never exceeds eBay's real title length limit, truncating at a whole word", () => {
    const longFields = { ...fullFields, model: "A".repeat(100) };
    const title = generateEbayTitle(longFields);
    expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
    expect(title.endsWith(" ")).toBe(false);
  });

  it("omits a missing field's segment rather than producing a malformed double dash", () => {
    const title = generateEbayTitle({ brand: "Nike", model: null, productType: null, colours: [], material: null, ukSize: null, conditionLabel: null });
    expect(title).toBe("Nike");
    expect(title).not.toContain("--");
  });

  it("description only states facts actually supplied — never invents a missing one", () => {
    const description = generateEbayDescription({ brand: null, model: null, productType: null, colours: [], material: null, ukSize: null, conditionLabel: null });
    expect(description).toBe("");
  });

  it("description includes exactly the supplied facts, no emoji, no marketing filler", () => {
    const description = generateEbayDescription(fullFields);
    expect(description).toContain("Nike Pegasus 40 Running Trainers.");
    expect(description).toContain("Colour: Black, White.");
    expect(description).toContain("Material: Mesh.");
    expect(description).toContain("Size: UK 9.");
    expect(description).toContain("Condition: Used.");
    expect(description).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe("buildEbayDraftFromGeneratedFields", () => {
  function fields(overrides: Record<string, unknown> = {}): ListingGenerationFields {
    return {
      brand: { value: "Nike", confidence: "high" }, model: { value: "Pegasus", confidence: "high" },
      productType: { value: "Trainers", confidence: "high" }, colours: { value: ["Black"], confidence: "high" },
      material: { value: "Mesh", confidence: "high" },
      sourceSize: { system: "UK", value: "9", gender: null, confidence: "high" },
      vintedAudience: { value: "womens", confidence: "high" },
      vintedAudienceEvidence: [], sku: { value: "1648", confidence: "high" }, notes: null,
      ...overrides,
    } as ListingGenerationFields;
  }

  it("REQUIREMENT: never claims ready when category/condition are unresolved — always needs_information at this stage", () => {
    const result = buildEbayDraftFromGeneratedFields({ fields: fields(), ukSize: "9", hasPhoto: true, pricePence: 2000, quantity: 1 });
    expect(result.status).toBe("needs_information");
    expect(result.readiness.ready).toBe(false);
    expect(result.conditionValue).toBeNull();
  });

  it("reuses the exact same structured facts already extracted for Vinted — no second AI call needed", () => {
    const result = buildEbayDraftFromGeneratedFields({ fields: fields(), ukSize: "9", hasPhoto: true, pricePence: 2000, quantity: 1 });
    expect(result.title).toBe("Nike Pegasus Trainers - Black - Size UK 9");
  });

  it("flags missing price and quantity as blocking, but not when they're supplied", () => {
    const missing = buildEbayDraftFromGeneratedFields({ fields: fields(), ukSize: "9", hasPhoto: true, pricePence: null, quantity: null });
    expect(missing.validationMessages.map(m => m.code)).toEqual(expect.arrayContaining(["price_not_set", "quantity_not_set"]));
    const present = buildEbayDraftFromGeneratedFields({ fields: fields(), ukSize: "9", hasPhoto: true, pricePence: 2000, quantity: 1 });
    expect(present.validationMessages.map(m => m.code)).not.toEqual(expect.arrayContaining(["price_not_set", "quantity_not_set"]));
  });
});

describe("marketplaceDraftSettingsSchema", () => {
  it("accepts a partial settings object", () => {
    expect(marketplaceDraftSettingsSchema.safeParse({ automationMode: "fast" }).success).toBe(true);
  });
  it("rejects an unrecognised key", () => {
    expect(marketplaceDraftSettingsSchema.safeParse({ notARealSetting: true }).success).toBe(false);
  });
  it("rejects quantity <= 0", () => {
    expect(marketplaceDraftSettingsSchema.safeParse({ quantity: 0 }).success).toBe(false);
  });
});

describe("sharedFactsSchema", () => {
  it("accepts a fact with full provenance", () => {
    expect(sharedFactsSchema.safeParse({ ean: { value: "5012345678900", source: "photo_analysis", confidence: "high", confirmed: false } }).success).toBe(true);
  });
  it("REGRESSION: distinguishes a confirmed fact from a merely-suggested one — confirmed is required, not inferred", () => {
    const parsed = sharedFactsSchema.parse({ ean: { value: "123", source: "ai_suggestion", confidence: "low", confirmed: false } });
    expect(parsed.ean?.confirmed).toBe(false);
  });
  it("rejects an unknown source", () => {
    expect(sharedFactsSchema.safeParse({ ean: { value: "123", source: "guessed", confidence: "low", confirmed: false } }).success).toBe(false);
  });
});
