import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  supabaseRequestAll, resolveEbayAspects, getMarketplaceDraft, patchMarketplaceDraft,
  getMarketplaceSettingsDefaults, resolveMarketplaceSettings, readContentGenerationState,
} = vi.hoisted(() => ({
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  resolveEbayAspects: vi.fn(),
  getMarketplaceDraft: vi.fn(),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => undefined),
  getMarketplaceSettingsDefaults: vi.fn(async () => null),
  resolveMarketplaceSettings: vi.fn(() => ({ automationMode: "balanced" as const })),
  readContentGenerationState: vi.fn(() => ({ state: "generated" as const })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll }));
vi.mock("@/lib/listing-studio/ebay-aspect-service", () => ({ resolveEbayAspects }));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft, patchMarketplaceDraft, getMarketplaceSettingsDefaults }));
vi.mock("@/lib/listing-studio/marketplace-settings", () => ({ resolveMarketplaceSettings }));
vi.mock("@/lib/listing-studio/ebay-content-generation-state", () => ({ readContentGenerationState }));

import { autoResolveAndPersistEbayAspects } from "@/lib/listing-studio/ebay-aspect-persistence";
import type { MarketplaceDraft, MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

function aspectValue(overrides: Partial<MarketplaceDynamicData[string]> = {}): MarketplaceDynamicData[string] {
  return { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

function draft(overrides: Partial<MarketplaceDraft> = {}): MarketplaceDraft {
  return {
    id: "mdraft-1", productDraftId: "product-1", marketplace: "EBAY_UK", sourceType: "generated", contentMode: "seo_optimised",
    title: "On Running Cloud 5 Womens UK 4 Blue Grey Mesh Running Trainers", description: "desc",
    categoryId: "93427", categoryName: "Women's Trainers", categoryPath: "Clothes, Shoes & Accessories > Women's Trainers",
    categorySource: "ai", categoryConfidence: "high", categoryAlternatives: [], categorySearchTerms: "On Running Cloud 5",
    conditionValue: "Pre-owned", pricePence: null, quantity: 1, currency: "GBP", status: "needs_information",
    readiness: { ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 0, recommendedComplete: 0, recommendedTotal: 0 },
    validationMessages: [], dynamicData: {}, settings: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as MarketplaceDraft;
}

beforeEach(() => {
  supabaseRequestAll.mockReset(); resolveEbayAspects.mockReset(); getMarketplaceDraft.mockReset();
  patchMarketplaceDraft.mockReset(); getMarketplaceSettingsDefaults.mockReset(); resolveMarketplaceSettings.mockReset();
  supabaseRequestAll.mockResolvedValue([{ brand: null, model: null, product_type: null, colours: null, material: null, shared_facts_json: {}, ai_result_json: null }]);
  getMarketplaceSettingsDefaults.mockResolvedValue(null);
  resolveMarketplaceSettings.mockReturnValue({ automationMode: "balanced" });
  readContentGenerationState.mockReturnValue({ state: "generated" });
  patchMarketplaceDraft.mockResolvedValue(undefined);
});

describe("autoResolveAndPersistEbayAspects — dynamic_data_json merge safety", () => {
  it("PROVEN ROOT CAUSE FIX: never wipes the __packageSize reserved pseudo-aspect when saving freshly resolved item specifics", async () => {
    const existingDynamicData: MarketplaceDynamicData = {
      __packageSize: aspectValue({ value: "medium_parcel", confidence: "high", source: "default", updatedAt: "2026-01-01T00:00:00.000Z" }),
    };
    getMarketplaceDraft.mockResolvedValue(draft({ dynamicData: existingDynamicData }));
    resolveEbayAspects.mockResolvedValue({
      status: "success",
      dynamicData: { Brand: aspectValue({ value: "On Running", confidence: "high", source: "product_facts" }) },
      grouped: { required: [], recommended: [], optional: [] },
    });

    await autoResolveAndPersistEbayAspects("owner-1", "product-1");

    const patchArg = patchMarketplaceDraft.mock.calls[0][2] as { dynamic_data_json: MarketplaceDynamicData };
    expect(patchArg.dynamic_data_json.__packageSize).toEqual(existingDynamicData.__packageSize);
    expect(patchArg.dynamic_data_json.Brand.value).toBe("On Running");
  });

  it("PROVEN ROOT CAUSE FIX: never overwrites a manually confirmed aspect value with a fresh automatic suggestion", async () => {
    const existingDynamicData: MarketplaceDynamicData = {
      Colour: aspectValue({ value: "Navy", confidence: "high", source: "manual", userConfirmed: true }),
    };
    getMarketplaceDraft.mockResolvedValue(draft({ dynamicData: existingDynamicData }));
    resolveEbayAspects.mockResolvedValue({
      status: "success",
      dynamicData: { Colour: aspectValue({ value: "Blue", confidence: "high", source: "product_facts" }) },
      grouped: { required: [], recommended: [], optional: [] },
    });

    await autoResolveAndPersistEbayAspects("owner-1", "product-1");

    const patchArg = patchMarketplaceDraft.mock.calls[0][2] as { dynamic_data_json: MarketplaceDynamicData };
    expect(patchArg.dynamic_data_json.Colour.value).toBe("Navy"); // manual override wins
  });

  it("REQUIREMENT: a manually entered US Shoe Size survives a later automatic resolution that marks it not_applicable", async () => {
    const existingDynamicData: MarketplaceDynamicData = {
      "US Shoe Size": aspectValue({ value: "6", confidence: "high", source: "manual", userConfirmed: true }),
    };
    getMarketplaceDraft.mockResolvedValue(draft({ dynamicData: existingDynamicData }));
    resolveEbayAspects.mockResolvedValue({
      status: "success",
      dynamicData: { "US Shoe Size": aspectValue({ value: null, confidence: "unknown", source: "not_applicable" }) },
      grouped: { required: [], recommended: [], optional: [] },
    });

    await autoResolveAndPersistEbayAspects("owner-1", "product-1");

    const patchArg = patchMarketplaceDraft.mock.calls[0][2] as { dynamic_data_json: MarketplaceDynamicData };
    expect(patchArg.dynamic_data_json["US Shoe Size"].value).toBe("6");
  });

  it("preserves __productFacts and __contentGeneration alongside freshly resolved real aspects", async () => {
    const existingDynamicData: MarketplaceDynamicData = {
      __productFacts: aspectValue({ value: "irrelevant-shape-for-this-test" }),
      __contentGeneration: aspectValue({ value: "irrelevant-shape-for-this-test" }),
    };
    getMarketplaceDraft.mockResolvedValue(draft({ dynamicData: existingDynamicData }));
    resolveEbayAspects.mockResolvedValue({ status: "success", dynamicData: { Brand: aspectValue({ value: "On Running", confidence: "high" }) }, grouped: { required: [], recommended: [], optional: [] } });

    await autoResolveAndPersistEbayAspects("owner-1", "product-1");

    const patchArg = patchMarketplaceDraft.mock.calls[0][2] as { dynamic_data_json: MarketplaceDynamicData };
    expect(patchArg.dynamic_data_json.__productFacts).toEqual(existingDynamicData.__productFacts);
    expect(patchArg.dynamic_data_json.__contentGeneration).toEqual(existingDynamicData.__contentGeneration);
  });
});

describe("autoResolveAndPersistEbayAspects — productFacts wiring", () => {
  it("REQUIREMENT: reads __productFacts from the eBay draft's own dynamicData and passes it to resolveEbayAspects, even when the base listing_drafts row has no structured facts at all", async () => {
    const productFacts = {
      brand: "On Running", model: "Cloud 5", productType: "Running Trainers", colours: ["Blue", "Grey"], material: "Mesh",
      ukShoeSize: "4", clothingSize: null, gender: "womens" as const, itemFamily: "footwear" as const, internalSku: "1644",
      styleCode: null, conditionState: "very_good_preowned" as const, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    getMarketplaceDraft.mockResolvedValue(draft({ dynamicData: { __productFacts: productFacts as unknown as MarketplaceDynamicData[string] } }));
    resolveEbayAspects.mockResolvedValue({ status: "success", dynamicData: {}, grouped: { required: [], recommended: [], optional: [] } });

    await autoResolveAndPersistEbayAspects("owner-1", "product-1");

    const resolveArg = resolveEbayAspects.mock.calls[0][0];
    expect(resolveArg.productFacts).toMatchObject({ brand: "On Running", model: "Cloud 5", ukShoeSize: "4", gender: "womens" });
  });
});

describe("autoResolveAndPersistEbayAspects — validation message dedup", () => {
  it("PROVEN ROOT CAUSE FIX: running the pipeline twice never accumulates duplicate selling-settings messages", async () => {
    const existingMessages = [
      { code: "price_not_set", message: "A price is required.", field: "price", severity: "blocking" as const },
      { code: "price_not_set", message: "A price is required.", field: "price", severity: "blocking" as const },
    ];
    getMarketplaceDraft.mockResolvedValue(draft({ validationMessages: existingMessages, pricePence: null }));
    resolveEbayAspects.mockResolvedValue({ status: "success", dynamicData: {}, grouped: { required: [], recommended: [], optional: [] } });

    await autoResolveAndPersistEbayAspects("owner-1", "product-1");

    const patchArg = patchMarketplaceDraft.mock.calls[0][2] as { validation_messages_json: Array<{ code: string }> };
    const priceMessages = patchArg.validation_messages_json.filter(m => m.code === "price_not_set");
    expect(priceMessages.length).toBe(1);
  });
});
