import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest, suggestEbayCategory, getCachedCategoryTreeId, getCategorySuggestions } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  suggestEbayCategory: vi.fn(),
  getCachedCategoryTreeId: vi.fn(),
  getCategorySuggestions: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/listing-studio/ebay-category-service", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/ebay-category-service")>();
  return { ...actual, suggestEbayCategory };
});
vi.mock("@/lib/listing-studio/ebay-taxonomy-cache", () => ({ getCachedCategoryTreeId }));
vi.mock("@/lib/listing-studio/ebay-taxonomy-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/ebay-taxonomy-client")>();
  return { ...actual, getCategorySuggestions };
});

import { POST as suggestRoute, PATCH as patchRoute } from "@/app/api/listing-studio/groups/[draftId]/ebay-category/route";
import { POST as searchRoute } from "@/app/api/listing-studio/groups/[draftId]/ebay-category/search/route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }
function jsonRequest(body: unknown) { return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

function productRow(overrides: Record<string, unknown> = {}) {
  return { brand: "Pokémon TCG", model: null, product_type: "Elite Trainer Box", shared_facts_json: {}, ...overrides };
}
function ebayDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdraft-1", product_draft_id: DRAFT_ID, owner_id: "owner-1", marketplace: "EBAY_UK",
    source_type: "generated", content_mode: "seo_optimised", title: "Elite Trainer Box", description: "desc",
    category_id: null, category_name: null, category_path: null, category_source: null, category_confidence: null,
    category_alternatives_json: [], category_search_terms: null,
    condition_value: null, price_pence: 2000, quantity: 1, currency: "GBP",
    status: "needs_information", readiness_json: {}, validation_messages_json: [], ai_generation_json: null,
    source_draft_id: null, source_ebay_item_id: null, dynamic_data_json: {}, settings_json: {},
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  suggestEbayCategory.mockReset(); getCachedCategoryTreeId.mockReset(); getCategorySuggestions.mockReset();
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("POST /api/listing-studio/groups/[draftId]/ebay-category", () => {
  it("404s when the product doesn't exist", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await suggestRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("404s with a clear message when no eBay draft has been generated yet", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("listing_drafts?") ? [productRow()] : []);
    const response = await suggestRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/Generate an eBay draft/i);
  });

  it("REQUIREMENT: persists the selected category and clears the category_not_set blocker on success", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("listing_drafts?") ? [productRow()] : path.startsWith("listing_marketplace_drafts?") ? [ebayDraftRow({ condition_value: "New", validation_messages_json: [{ code: "category_not_set", message: "x", field: "category", severity: "blocking" }] })] : []);
    suggestEbayCategory.mockResolvedValue({
      status: "success", searchTerms: "Pokémon TCG Elite Trainer Box", stale: false,
      selected: { categoryId: "183454", categoryName: "CCG Sealed Boxes", categoryPath: "Collectables > CCG Sealed Boxes", rank: 1, confidence: "high", reason: "Strong match." },
      alternatives: [],
    });
    const response = await suggestRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.category_id).toBe("183454");
    expect(body.category_source).toBe("ai");
    expect(body.validation_messages_json.some((m: { code: string }) => m.code === "category_not_set")).toBe(false);
  });

  it("a low-confidence result adds a review warning, never a blocker, and is still persisted", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("listing_drafts?") ? [productRow()] : path.startsWith("listing_marketplace_drafts?") ? [ebayDraftRow({ condition_value: "New" })] : []);
    suggestEbayCategory.mockResolvedValue({
      status: "success", searchTerms: "terms", stale: false,
      selected: { categoryId: "183454", categoryName: "CCG Sealed Boxes", categoryPath: "Collectables > CCG Sealed Boxes", rank: 1, confidence: "low", reason: "Uncertain." },
      alternatives: [],
    });
    const response = await suggestRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.selected.confidence).toBe("low");
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.validation_messages_json.some((m: { code: string; severity: string }) => m.code === "category_needs_confirmation" && m.severity === "warning")).toBe(true);
  });

  it("REQUIREMENT: surfaces an honest 'not configured' response, never a fabricated category", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("listing_drafts?") ? [productRow()] : path.startsWith("listing_marketplace_drafts?") ? [ebayDraftRow()] : []);
    suggestEbayCategory.mockResolvedValue({ status: "not_configured" });
    const response = await suggestRoute(new Request("http://test"), params());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/not been configured/i);
  });
});

describe("POST /api/listing-studio/groups/[draftId]/ebay-category/search", () => {
  it("rejects an empty query", async () => {
    const response = await searchRoute(jsonRequest({ query: "" }), params());
    expect(response.status).toBe(400);
  });

  it("returns ranked results without persisting anything", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: false } });
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [{ category: { categoryId: "1", categoryName: "A" }, categoryTreeNodeAncestors: [], relevancy: "50.0" }, { category: { categoryId: "2", categoryName: "B" }, categoryTreeNodeAncestors: [], relevancy: "90.0" }] });
    const response = await searchRoute(jsonRequest({ query: "trainers" }), params());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results[0].categoryId).toBe("2"); // higher relevancy first
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("an honest configuration error when eBay access isn't set up", async () => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: false, error: "not_configured" });
    const response = await searchRoute(jsonRequest({ query: "trainers" }), params());
    expect(response.status).toBe(503);
  });
});

describe("PATCH /api/listing-studio/groups/[draftId]/ebay-category — manual category change", () => {
  beforeEach(() => {
    getCachedCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: false } });
  });

  it("404s when the eBay draft doesn't exist", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await patchRoute(jsonRequest({ categoryId: "1", searchTerms: "trainers" }), params());
    expect(response.status).toBe(404);
  });

  it("REQUIREMENT: re-verifies the chosen id against a FRESH eBay response — never trusts the client's claim alone", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ condition_value: "New" })]);
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [{ category: { categoryId: "999", categoryName: "Real Category" }, categoryTreeNodeAncestors: [{ categoryId: "1", categoryName: "Root" }], relevancy: "100.0" }] });
    const response = await patchRoute(jsonRequest({ categoryId: "999", searchTerms: "real category search" }), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.categoryName).toBe("Real Category");
    expect(body.categoryPath).toBe("Root > Real Category");
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.category_source).toBe("manual");
    expect(patchBody.category_confidence).toBeNull();
  });

  it("REGRESSION (safety-critical): rejects a categoryId that eBay's fresh response does NOT contain — never persists a fabricated selection", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow()]);
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [{ category: { categoryId: "111", categoryName: "Something Else" }, categoryTreeNodeAncestors: [], relevancy: "50.0" }] });
    const response = await patchRoute(jsonRequest({ categoryId: "999-does-not-exist", searchTerms: "made up" }), params());
    expect(response.status).toBe(422);
    expect(supabaseRequest).not.toHaveBeenCalledWith(expect.stringContaining("listing_marketplace_drafts?id=eq."), expect.anything());
  });

  it("REGRESSION: a category change clears dynamic_data_json — stale item-specifics from the old category never survive", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ dynamic_data_json: { Game: { value: "Pokémon TCG", confidence: "high", source: "ai", appliedAutomatically: true, needsReview: false, userConfirmed: false, updatedAt: "x" } } })]);
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [{ category: { categoryId: "999", categoryName: "New Category" }, categoryTreeNodeAncestors: [], relevancy: "100.0" }] });
    await patchRoute(jsonRequest({ categoryId: "999", searchTerms: "new category" }), params());
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.dynamic_data_json).toEqual({});
  });

  it("moves the previously-selected category into the alternatives list rather than discarding it", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ category_id: "old-1", category_name: "Old Category", category_path: "Root > Old Category" })]);
    getCategorySuggestions.mockResolvedValue({ ok: true, data: [{ category: { categoryId: "new-1", categoryName: "New Category" }, categoryTreeNodeAncestors: [], relevancy: "100.0" }] });
    await patchRoute(jsonRequest({ categoryId: "new-1", searchTerms: "new category" }), params());
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.category_alternatives_json.some((a: { categoryId: string }) => a.categoryId === "old-1")).toBe(true);
  });
});
