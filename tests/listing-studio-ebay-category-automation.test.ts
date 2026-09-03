import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequestAll, suggestEbayCategory, getMarketplaceDraft, patchMarketplaceDraft } = vi.hoisted(() => ({
  supabaseRequestAll: vi.fn(async () => [] as unknown[]),
  suggestEbayCategory: vi.fn(),
  getMarketplaceDraft: vi.fn(),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll }));
vi.mock("@/lib/listing-studio/ebay-category-service", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/ebay-category-service")>();
  return { ...actual, suggestEbayCategory };
});
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft, patchMarketplaceDraft }));

const { autoSuggestAndPersistEbayCategory } = await import("@/lib/listing-studio/ebay-category-automation");

function ebayDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdraft-1", productDraftId: "p1", ownerId: "owner-1", marketplace: "EBAY_UK" as const,
    sourceType: "generated" as const, contentMode: "seo_optimised" as const, title: "On Running Cloud 5", description: "desc",
    categoryId: null, categoryName: null, categoryPath: null, categorySource: null, categoryConfidence: null,
    categoryAlternatives: [], categorySearchTerms: null, conditionValue: null, pricePence: 2000, quantity: 1, currency: "GBP",
    status: "needs_information" as const, readiness: { ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
    validationMessages: [], aiGeneration: null, sourceDraftId: null, sourceEbayItemId: null, dynamicData: {}, settings: {},
    ebayFulfillmentPolicyId: null, ebayReturnPolicyId: null, ebayPaymentPolicyId: null, ebayMerchantLocationKey: null,
    ebayOfferId: null, ebayInventorySyncedAt: null, ebayLastDraftError: null, ebayPhotoState: {},
    ebayFeedDraftCreatedAt: null, ebayFeedLastError: null,
    createdAt: "x", updatedAt: "x",
    ...overrides,
  };
}
function selected(confidence: "high" | "medium" | "low", overrides: Partial<{ categoryId: string; categoryName: string; categoryPath: string }> = {}) {
  return { categoryId: "183454", categoryName: "Trainers", categoryPath: "Clothes > Trainers", rank: 1, confidence, reason: "match", ...overrides };
}
function footwearProductFacts(overrides: Record<string, unknown> = {}) {
  return {
    brand: "On Running", model: "Cloud 5", productType: "Running Trainers", colours: ["Blue"], material: "Mesh",
    ukShoeSize: "4", clothingSize: null, gender: "womens", itemFamily: "footwear", internalSku: "1644",
    styleCode: null, conditionState: "very_good_preowned", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  supabaseRequestAll.mockReset(); suggestEbayCategory.mockReset(); getMarketplaceDraft.mockReset(); patchMarketplaceDraft.mockReset();
  supabaseRequestAll.mockResolvedValue([{ brand: "On Running", model: "Cloud 5", product_type: "Trainers", shared_facts_json: {} }]);
});

describe("autoSuggestAndPersistEbayCategory — confidence-tiered persistence", () => {
  it("REQUIREMENT: high confidence is auto-selected and persisted, no review flag in Balanced mode", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("high"), alternatives: [], stale: false });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft());
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
    const patch = patchMarketplaceDraft.mock.calls[0][2];
    expect(patch.category_id).toBe("183454");
    expect(patch.category_source).toBe("ai");
  });

  it("REQUIREMENT: medium confidence is auto-selected but always flagged for review", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("medium"), alternatives: [], stale: false });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft());
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(true);
    const patch = patchMarketplaceDraft.mock.calls[0][2];
    const validationMessages = patch.validation_messages_json as { code: string }[];
    expect(validationMessages.some(m => m.code === "category_needs_confirmation")).toBe(true);
  });

  it("REQUIREMENT (spec-critical): low confidence is NEVER auto-selected — category_id stays unset, alternatives show top choices", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("low"), alternatives: [selected("low")], stale: false });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft());
    expect(outcome.status).toBe("left_unresolved");
    const patch = patchMarketplaceDraft.mock.calls[0][2];
    expect(patch.category_id).toBeUndefined(); // never written
    const alternatives = patch.category_alternatives_json as unknown[];
    expect(alternatives.length).toBeGreaterThan(0); // top choices ARE shown
  });

  it("REQUIREMENT: Strict mode flags even a high-confidence category for confirmation", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("high"), alternatives: [], stale: false });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "strict", ebayDraft());
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(true);
  });

  it("REQUIREMENT: never fabricates a category — an upstream failure is reported honestly, nothing persisted", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "not_configured" });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft());
    expect(outcome.status).toBe("failed");
    expect(patchMarketplaceDraft).not.toHaveBeenCalled();
  });

  it("returns a clear failure (never throws) when no eBay draft exists yet", async () => {
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", undefined);
    expect(outcome.status).toBe("failed");
  });
});

describe("autoSuggestAndPersistEbayCategory — the deterministic below-UK-7 footwear department rule (PROVEN ROOT CAUSE FIX)", () => {
  it("REQUIREMENT: UK size 4, a Medium-confidence Women's category is auto-applied with no review — the deterministic rule corroborates it", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("medium", { categoryName: "Trainers", categoryPath: "Women's Shoes > Women > Clothes, Shoes & Accessories > Trainers" }), alternatives: [], stale: false });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "4" }) } }));
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
    const patch = patchMarketplaceDraft.mock.calls[0][2];
    // The RAW confidence eBay actually reported is preserved honestly —
    // never rewritten to "high" merely because the rule resolved review.
    expect(patch.category_confidence).toBe("medium");
    expect(patch.validation_messages_json as { code: string }[]).not.toContainEqual(expect.objectContaining({ code: "category_needs_confirmation" }));
  });

  for (const size of ["3", "4", "5", "6", "6.5"]) {
    it(`REQUIREMENT: UK size ${size} resolves to the Women's category, High effective confidence, no review`, async () => {
      suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("medium", { categoryPath: "Women's Shoes > Women > Trainers" }), alternatives: [], stale: false });
      const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: size }) } }));
      expect(outcome.status).toBe("applied");
      if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
    });
  }

  it("REQUIREMENT: UK size 7 does NOT use the automatic below-UK-7 rule — normal Medium-confidence review still applies", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("medium", { categoryPath: "Women's Shoes > Women > Trainers" }), alternatives: [], stale: false });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "7" }) } }));
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(true);
  });

  it("REQUIREMENT: a UK size 4 product where eBay's TOP suggestion is Men's still resolves to Women's via a real alternative — never a fabricated category", async () => {
    suggestEbayCategory.mockResolvedValue({
      status: "success", searchTerms: "x",
      selected: selected("high", { categoryId: "mens-1", categoryName: "Trainers", categoryPath: "Men's Shoes > Men > Trainers" }),
      alternatives: [selected("medium", { categoryId: "womens-1", categoryName: "Trainers", categoryPath: "Women's Shoes > Women > Trainers" })],
      stale: false,
    });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "4" }) } }));
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
    const patch = patchMarketplaceDraft.mock.calls[0][2];
    expect(patch.category_id).toBe("womens-1"); // the real Women's alternative, never the Men's top pick
    const alternatives = patch.category_alternatives_json as { categoryId: string }[];
    expect(alternatives.some(a => a.categoryId === "mens-1")).toBe(true); // Men's demoted to an alternative, not discarded
  });

  it("REQUIREMENT: a UK size 4 product with a Children's/Junior top suggestion still resolves to Women's via a real Women's alternative", async () => {
    suggestEbayCategory.mockResolvedValue({
      status: "success", searchTerms: "x",
      selected: selected("high", { categoryId: "kids-1", categoryName: "Kids Trainers", categoryPath: "Kids > Junior Trainers" }),
      alternatives: [selected("medium", { categoryId: "womens-1", categoryPath: "Women's Shoes > Women > Trainers" })],
      stale: false,
    });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "4" }) } }));
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
    expect(patchMarketplaceDraft.mock.calls[0][2].category_id).toBe("womens-1");
  });

  it("REQUIREMENT: a Men's/Children's alternative existing alongside the correct Women's selection never itself causes review", async () => {
    suggestEbayCategory.mockResolvedValue({
      status: "success", searchTerms: "x",
      selected: selected("medium", { categoryPath: "Women's Shoes > Women > Trainers" }),
      alternatives: [selected("medium", { categoryId: "mens-1", categoryPath: "Men's Shoes > Men > Trainers" }), selected("low", { categoryId: "kids-1", categoryPath: "Kids > Boys' Shoes" })],
      stale: false,
    });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "4" }) } }));
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
  });

  it("REQUIREMENT: even a LOW-confidence Women's category is auto-applied for a qualifying size — bypasses the ordinary 'never auto-select low confidence' safety net", async () => {
    suggestEbayCategory.mockResolvedValue({
      status: "success", searchTerms: "x",
      selected: selected("low", { categoryId: "mens-1", categoryPath: "Men's Shoes > Men > Trainers" }),
      alternatives: [selected("low", { categoryId: "womens-1", categoryPath: "Women's Shoes > Women > Trainers" })],
      stale: false,
    });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "4" }) } }));
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
    expect(patchMarketplaceDraft.mock.calls[0][2].category_id).toBe("womens-1");
  });

  it("REQUIREMENT: Strict mode's blanket confirmation requirement does not override the deterministic rule", async () => {
    suggestEbayCategory.mockResolvedValue({ status: "success", searchTerms: "x", selected: selected("high", { categoryPath: "Women's Shoes > Women > Trainers" }), alternatives: [], stale: false });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "strict", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "4" }) } }));
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(false);
  });

  it("SAFETY NET: a UK size 4 product with NO Women's category anywhere in the real suggestions genuinely needs review, rather than silently accepting a wrong department", async () => {
    suggestEbayCategory.mockResolvedValue({
      status: "success", searchTerms: "x",
      selected: selected("high", { categoryId: "mens-1", categoryPath: "Men's Shoes > Men > Trainers" }),
      alternatives: [selected("medium", { categoryId: "kids-1", categoryPath: "Kids > Boys' Shoes" })],
      stale: false,
    });
    const outcome = await autoSuggestAndPersistEbayCategory("owner-1", "p1", "balanced", ebayDraft({ dynamicData: { __productFacts: footwearProductFacts({ ukShoeSize: "4" }) } }));
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") expect(outcome.needsReview).toBe(true);
    const validationMessages = patchMarketplaceDraft.mock.calls[0][2].validation_messages_json as { code: string; message: string }[];
    expect(validationMessages.find(m => m.code === "category_needs_confirmation")?.message).toMatch(/Women's category/);
  });
});
