import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest, resolveEbayAspects, getEbayAspectDefinitions, getMarketplaceSettingsDefaults } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  resolveEbayAspects: vi.fn(),
  getEbayAspectDefinitions: vi.fn(),
  getMarketplaceSettingsDefaults: vi.fn(async () => ({} as Record<string, unknown>)),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/listing-studio/ebay-aspect-service", () => ({ resolveEbayAspects, getEbayAspectDefinitions }));
vi.mock("@/lib/listing-studio/marketplace-drafts", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/marketplace-drafts")>();
  return { ...actual, getMarketplaceSettingsDefaults };
});

import { GET as getRoute, POST as suggestRoute, PATCH as patchRoute } from "@/app/api/listing-studio/groups/[draftId]/ebay-aspects/route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }
function jsonRequest(body: unknown) { return new Request("http://test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

function ebayDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdraft-1", product_draft_id: DRAFT_ID, owner_id: "owner-1", marketplace: "EBAY_UK",
    source_type: "generated", content_mode: "seo_optimised", title: "Elite Trainer Box", description: "desc",
    category_id: "183454", category_name: "CCG Sealed Boxes", category_path: "Collectables > CCG Sealed Boxes",
    category_source: "ai", category_confidence: "high", category_alternatives_json: [], category_search_terms: "x",
    condition_value: "New", price_pence: 3499, quantity: 1, currency: "GBP",
    status: "needs_information", readiness_json: {}, validation_messages_json: [], ai_generation_json: null,
    source_draft_id: null, source_ebay_item_id: null, dynamic_data_json: {}, settings_json: {},
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
function productRow(overrides: Record<string, unknown> = {}) {
  return { brand: "Pokémon TCG", model: null, product_type: "Elite Trainer Box", colours: [], material: null, shared_facts_json: {}, ai_result_json: null, ...overrides };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  resolveEbayAspects.mockReset(); getEbayAspectDefinitions.mockReset(); getMarketplaceSettingsDefaults.mockReset();
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
  getMarketplaceSettingsDefaults.mockResolvedValue({});
});

describe("GET /api/listing-studio/groups/[draftId]/ebay-aspects — read-only, never triggers AI", () => {
  it("404s when no eBay draft exists yet", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await getRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("returns empty groups (no error) when no category has been selected yet", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ category_id: null })]);
    const response = await getRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.required).toEqual([]);
    expect(getEbayAspectDefinitions).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: returns current definitions and stored values without ever calling the suggestion pipeline", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ dynamic_data_json: { Game: { value: "Pokémon TCG", confidence: "high", source: "x", appliedAutomatically: true, needsReview: false, userConfirmed: false, updatedAt: "x" } } })]);
    getEbayAspectDefinitions.mockResolvedValue({ status: "success", stale: false, grouped: { required: [{ name: "Game", usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: null, allowedValues: ["Pokémon TCG"] }], recommended: [], optional: [] } });
    const response = await getRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.required[0].name).toBe("Game");
    expect(body.dynamicData.Game.value).toBe("Pokémon TCG");
    expect(resolveEbayAspects).not.toHaveBeenCalled();
  });

  it("an honest configuration error, never a fabricated result", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow()]);
    getEbayAspectDefinitions.mockResolvedValue({ status: "not_configured" });
    const response = await getRoute(new Request("http://test"), params());
    expect(response.status).toBe(503);
  });
});

describe("POST /api/listing-studio/groups/[draftId]/ebay-aspects", () => {
  it("404s with a clear message when no eBay draft exists yet", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await suggestRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("REQUIREMENT: refuses to run without a selected category first — item specifics are category-specific", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ category_id: null })]);
    const response = await suggestRoute(new Request("http://test"), params());
    expect(response.status).toBe(400);
    expect(resolveEbayAspects).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: a required aspect left unresolved blocks readiness with a blocking message, a recommended one only suggests", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("listing_marketplace_drafts?") ? [ebayDraftRow()] : path.startsWith("listing_drafts?") ? [productRow()] : []);
    resolveEbayAspects.mockResolvedValue({
      status: "success", stale: false,
      grouped: { required: [{ name: "Game", usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: null, allowedValues: ["Pokémon TCG"] }], recommended: [{ name: "EAN", usage: "RECOMMENDED", mode: "FREE_TEXT", cardinality: "SINGLE", maxLength: null, allowedValues: [] }], optional: [] },
      dynamicData: {
        Game: { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: true, userConfirmed: false, updatedAt: "x" },
        EAN: { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "x" },
      },
      aiCost: null,
    });
    const response = await suggestRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.readiness.ready).toBe(false);
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    const gameMessage = patchBody.validation_messages_json.find((m: { field: string }) => m.field === "Game");
    const eanMessage = patchBody.validation_messages_json.find((m: { field: string }) => m.field === "EAN");
    expect(gameMessage.severity).toBe("blocking");
    expect(eanMessage.severity).toBe("suggestion");
  });

  it("REQUIREMENT: becomes ready once every required aspect is filled with high/medium confidence", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("listing_marketplace_drafts?") ? [ebayDraftRow()] : path.startsWith("listing_drafts?") ? [productRow()] : []);
    resolveEbayAspects.mockResolvedValue({
      status: "success", stale: false,
      grouped: { required: [{ name: "Game", usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE", maxLength: null, allowedValues: ["Pokémon TCG"] }], recommended: [], optional: [] },
      dynamicData: { Game: { value: "Pokémon TCG", confidence: "high", source: "shared_facts", appliedAutomatically: true, needsReview: false, userConfirmed: false, updatedAt: "x" } },
      aiCost: null,
    });
    const response = await suggestRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.readiness.ready).toBe(true);
  });

  it("an honest configuration error, never a fabricated result", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("listing_marketplace_drafts?") ? [ebayDraftRow()] : path.startsWith("listing_drafts?") ? [productRow()] : []);
    resolveEbayAspects.mockResolvedValue({ status: "not_configured" });
    const response = await suggestRoute(new Request("http://test"), params());
    expect(response.status).toBe(503);
  });
});

describe("PATCH /api/listing-studio/groups/[draftId]/ebay-aspects — manual edit/confirm", () => {
  it("404s when the eBay draft doesn't exist", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await patchRoute(jsonRequest({ aspectName: "Game", value: "Pokémon TCG" }), params());
    expect(response.status).toBe(404);
  });

  it("REQUIREMENT: a manual confirm sets userConfirmed=true, letting a low-confidence value now count for readiness", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ dynamic_data_json: {} })]);
    const response = await patchRoute(jsonRequest({ aspectName: "Game", value: "Pokémon TCG", confirm: true }), params());
    expect(response.status).toBe(200);
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.dynamic_data_json.Game).toMatchObject({ value: "Pokémon TCG", source: "manual", userConfirmed: true });
  });

  it("preserves every other aspect already stored — a single-field edit is not a full replace", async () => {
    supabaseRequestAll.mockResolvedValue([ebayDraftRow({ dynamic_data_json: { Manufacturer: { value: "The Pokémon Company", confidence: "high", source: "x", appliedAutomatically: true, needsReview: false, userConfirmed: false, updatedAt: "x" } } })]);
    await patchRoute(jsonRequest({ aspectName: "Game", value: "Pokémon TCG" }), params());
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("listing_marketplace_drafts?id=eq."));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.dynamic_data_json.Manufacturer.value).toBe("The Pokémon Company");
    expect(patchBody.dynamic_data_json.Game.value).toBe("Pokémon TCG");
  });
});
