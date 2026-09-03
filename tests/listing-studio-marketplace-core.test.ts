import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { resolveMarketplaceSettings, defaultContentModeForSourceType, FALLBACK_MARKETPLACE_DRAFT_SETTINGS } from "@/lib/listing-studio/marketplace-settings";
import { marketplacesForTarget } from "@/lib/listing-studio/marketplace-types";
import { marketplaceDraftSettingsSchema, sharedFactsSchema } from "@/lib/validation/listing-studio-marketplace";

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
      // Phase 4/5 fix — explicit here, matching this test's own "nothing
      // at all to check" premise: hasGeneratedContent defaults to true
      // when a caller omits it entirely (existing-caller backward
      // compatibility — every REAL caller now passes it explicitly, see
      // ebay-draft-generation.ts and friends), but that default would
      // otherwise contradict this specific test's own "all false -> 0%"
      // scenario.
      hasGeneratedContent: false,
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

// The old deterministic-only generateEbayTitle/generateEbayDescription
// (lib/listing-studio/ebay-listing-template.ts) is superseded and deleted
// — see lib/listing-studio/ebay-title-builder.ts (composition/validation)
// and tests/listing-studio-ebay-title-builder.test.ts for its replacement,
// which fixes the exact reported "On Running ... Running Trainers"
// duplication this old module never guarded against.

// buildEbayDraftFromGeneratedFields is now async and AI-driven — see
// tests/listing-studio-ebay-draft-generation.test.ts for its own
// dedicated, properly-mocked coverage (this file keeps only the pure,
// synchronous marketplace-core pieces).

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
