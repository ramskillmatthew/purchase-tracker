import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest, getEbayItemConditionPolicies } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  getEbayItemConditionPolicies: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/listing-studio/ebay-taxonomy-client", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/listing-studio/ebay-taxonomy-client")>()),
  getEbayItemConditionPolicies,
}));

import { GET as listRoute } from "@/app/api/listing-studio/groups/[draftId]/marketplace-drafts/route";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/listing-studio/groups/[draftId]/marketplace-drafts/[marketplace]/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }
function marketplaceParams(marketplace = "EBAY_UK") { return { params: Promise.resolve({ draftId: DRAFT_ID, marketplace }) }; }

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdraft-1", product_draft_id: DRAFT_ID, owner_id: "owner-1", marketplace: "EBAY_UK",
    source_type: "generated", content_mode: "seo_optimised",
    title: "Nike Trainers", description: "A pair of trainers.",
    category_id: null, category_name: null, category_path: null, category_source: null, category_confidence: null,
    condition_value: null, price_pence: null, quantity: null, currency: "GBP",
    status: "needs_information",
    readiness_json: { ready: false, completionPercent: 25, requiredComplete: 2, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
    validation_messages_json: [], ai_generation_json: null, source_draft_id: null, source_ebay_item_id: null,
    dynamic_data_json: {}, settings_json: {},
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
  getEbayItemConditionPolicies.mockReset();
  getEbayItemConditionPolicies.mockResolvedValue({ ok: true, data: [] });
});

describe("GET /api/listing-studio/groups/[draftId]/marketplace-drafts", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await listRoute(new Request("http://test"), params());
    expect(response.status).toBe(401);
  });

  it("returns every marketplace draft for the product, mapped to domain shape", async () => {
    supabaseRequestAll.mockResolvedValue([row()]);
    const response = await listRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].marketplace).toBe("EBAY_UK");
  });

  it("rejects a malformed group id before querying anything", async () => {
    const response = await listRoute(new Request("http://test"), { params: Promise.resolve({ draftId: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    expect(supabaseRequestAll).not.toHaveBeenCalled();
  });
});

describe("GET /api/listing-studio/groups/[draftId]/marketplace-drafts/[marketplace]", () => {
  it("404s when this product has no draft for that marketplace", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await getRoute(new Request("http://test"), marketplaceParams());
    expect(response.status).toBe(404);
  });

  it("returns the draft when found", async () => {
    supabaseRequestAll.mockResolvedValue([row()]);
    const response = await getRoute(new Request("http://test"), marketplaceParams());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.draft.title).toBe("Nike Trainers");
  });
});

describe("PATCH /api/listing-studio/groups/[draftId]/marketplace-drafts/[marketplace]", () => {
  function patchRequest(body: unknown) {
    return new Request("http://test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  it("404s when the draft doesn't exist", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await patchRoute(patchRequest({ pricePence: 2000 }), marketplaceParams());
    expect(response.status).toBe(404);
  });

  it("REQUIREMENT: setting price and quantity moves a draft closer to ready but never claims ready while category/condition are still missing", async () => {
    supabaseRequestAll.mockResolvedValue([row()]);
    const response = await patchRoute(patchRequest({ pricePence: 2000, quantity: 1 }), marketplaceParams());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("needs_information");
    expect(body.readiness.ready).toBe(false);
    expect(body.validationMessages.some((m: { code: string }) => m.code === "price_not_set")).toBe(false);
    expect(body.validationMessages.some((m: { code: string }) => m.code === "category_not_set")).toBe(true);
  });

  it("REQUIREMENT: becomes ready once every required field (including category/condition) is present", async () => {
    supabaseRequestAll.mockResolvedValue([row({ category_id: "cat-1", condition_value: "New", price_pence: 2000, quantity: 1 })]);
    const response = await patchRoute(patchRequest({ description: "Updated description." }), marketplaceParams());
    const body = await response.json();
    expect(body.status).toBe("ready");
    expect(body.readiness.ready).toBe(true);
  });

  it("saves an exact category-supported eBay condition and clears the condition blocker", async () => {
    supabaseRequestAll.mockResolvedValue([row({
      category_id: "95672", category_name: "Trainers", price_pence: 2000, quantity: 1,
      validation_messages_json: [{ code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" }],
    })]);
    getEbayItemConditionPolicies.mockResolvedValue({ ok: true, data: [
      { conditionId: "2990", conditionDescription: "Pre-owned - Excellent", conditionHelpText: "Like new, no visible flaws or signs of use." },
    ] });
    const response = await patchRoute(patchRequest({ conditionValue: "Pre-owned - Excellent" }), marketplaceParams());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.validationMessages.some((message: { code: string }) => message.code === "condition_not_set")).toBe(false);
    const patchCall = supabaseRequest.mock.calls.find(call => String(call[0]).includes("listing_marketplace_drafts?id=eq."));
    const saved = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(saved.condition_value).toBe("Pre-owned - Excellent");
    expect(saved.dynamic_data_json.__conditionSelection).toMatchObject({ value: "Pre-owned - Excellent", source: "manual", userConfirmed: true });
  });

  it("saves price, condition and every staged item-specific change in one atomic editor request", async () => {
    supabaseRequestAll.mockResolvedValue([row({
      category_id: "95672", category_name: "Trainers", quantity: 1,
      dynamic_data_json: { Brand: { value: "Old brand", confidence: "high", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: true, updatedAt: "2026-01-01T00:00:00.000Z" } },
    })]);
    getEbayItemConditionPolicies.mockResolvedValue({ ok: true, data: [
      { conditionId: "2990", conditionDescription: "Pre-owned - Excellent", conditionHelpText: "Like new, no visible flaws or signs of use." },
    ] });
    const brand = { value: "New Balance", confidence: "high", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: true, updatedAt: "2026-10-28T10:00:00.000Z" };
    const productFacts = { brand: "New Balance", ukShoeSize: "3", itemFamily: "footwear", updatedAt: "2026-10-28T09:00:00.000Z" };
    const contentGeneration = { state: "generated", attemptCount: 1, generatedAt: "2026-10-28T09:00:00.000Z" };
    const response = await patchRoute(patchRequest({
      pricePence: 3000,
      conditionValue: "Pre-owned - Excellent",
      dynamicData: { Brand: brand, __productFacts: productFacts, __contentGeneration: contentGeneration },
    }), marketplaceParams());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pricePence).toBe(3000);
    expect(body.conditionValue).toBe("Pre-owned - Excellent");
    expect(body.dynamicData.Brand).toEqual(brand);
    expect(body.dynamicData.__productFacts).toEqual(productFacts);
    expect(body.dynamicData.__contentGeneration).toEqual(contentGeneration);
    const patchCall = supabaseRequest.mock.calls.find(call => String(call[0]).includes("listing_marketplace_drafts?id=eq."));
    const saved = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(saved.price_pence).toBe(3000);
    expect(saved.condition_value).toBe("Pre-owned - Excellent");
    expect(saved.dynamic_data_json.Brand).toEqual(brand);
    expect(saved.dynamic_data_json.__productFacts).toEqual(productFacts);
  });

  it("does not re-contact eBay when Save & close submits an unchanged condition", async () => {
    supabaseRequestAll.mockResolvedValue([row({
      category_id: "95672", condition_value: "Pre-owned - Excellent", price_pence: 3000, quantity: 1,
    })]);
    const response = await patchRoute(patchRequest({ pricePence: 3500, conditionValue: "Pre-owned - Excellent", dynamicData: {} }), marketplaceParams());
    expect(response.status).toBe(200);
    expect(getEbayItemConditionPolicies).not.toHaveBeenCalled();
  });

  it("rejects a condition eBay does not support in the selected category", async () => {
    supabaseRequestAll.mockResolvedValue([row({ category_id: "95672" })]);
    getEbayItemConditionPolicies.mockResolvedValue({ ok: true, data: [
      { conditionId: "3000", conditionDescription: "Pre-owned - Good", conditionHelpText: "Gently used." },
    ] });
    const response = await patchRoute(patchRequest({ conditionValue: "Very Good" }), marketplaceParams());
    expect(response.status).toBe(400);
  });

  it("REGRESSION: a settings-only patch merges into existing settings rather than replacing them", async () => {
    supabaseRequestAll.mockResolvedValue([row({ settings_json: { automationMode: "strict" } })]);
    await patchRoute(patchRequest({ settings: { allowOffers: true } }), marketplaceParams());
    const patchCall = supabaseRequest.mock.calls.find(call => String(call[0]).includes("listing_marketplace_drafts?id=eq."));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.settings_json).toEqual({ automationMode: "strict", allowOffers: true });
  });

  it("rejects an unrecognised marketplace segment", async () => {
    supabaseRequestAll.mockResolvedValue([row()]);
    const response = await patchRoute(patchRequest({ pricePence: 2000 }), marketplaceParams("MARS"));
    expect(response.status).toBe(400);
  });
});
