import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, supabaseRequestAll, supabaseRequest,
  prepareListingGenerationImageInputs, runListingGenerationAnalysis, runVintedCategorySelection,
  upsertMarketplaceDraft, getMarketplaceSettingsDefaults,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  prepareListingGenerationImageInputs: vi.fn(async () => ({ blocks: [{ id: "img-1", content: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "" } } }], skipped: [] })),
  runListingGenerationAnalysis: vi.fn(),
  runVintedCategorySelection: vi.fn(),
  upsertMarketplaceDraft: vi.fn(async (_input: {
    status: string; pricePence?: number | null; quantity?: number | null; contentMode: string;
    readiness: { ready: boolean }; validationMessages: { code: string }[];
  }) => "marketplace-draft-1"),
  getMarketplaceSettingsDefaults: vi.fn(async () => ({} as Record<string, unknown>)),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/listing-studio/listing-generation-image-input", () => ({ prepareListingGenerationImageInputs }));
vi.mock("@/lib/listing-studio/listing-generation-ai", () => ({ runListingGenerationAnalysis }));
vi.mock("@/lib/listing-studio/vinted-category-selection-ai", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-category-selection-ai")>();
  return { ...actual, runVintedCategorySelection };
});
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ upsertMarketplaceDraft, getMarketplaceSettingsDefaults }));

import { POST as generateRoute } from "@/app/api/listing-studio/groups/[draftId]/generate/route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }
function requestWithTargets(targets?: string[], extra: Record<string, unknown> = {}) {
  return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: targets ? JSON.stringify({ targets, ...extra }) : undefined });
}

function aiFields(overrides: Record<string, unknown> = {}) {
  return {
    brand: { value: "Nike", confidence: "high" }, model: { value: "Pegasus", confidence: "high" },
    productType: { value: "Trainers", confidence: "high" }, colours: { value: ["Black"], confidence: "high" },
    material: { value: "Mesh", confidence: "high" },
    sourceSize: { system: "UK", value: "9", gender: null, confidence: "high" },
    vintedAudience: { value: "womens", confidence: "high" },
    sku: { value: "1648", confidence: "high" }, notes: null,
    ...overrides,
  };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, title: "Group 1", uk_size: null, uk_size_source: null,
    vinted_category_id: null, vinted_category_path: null, vinted_category_source: null, vinted_category_status: null,
    vinted_audience: null, vinted_audience_source: null,
    suggested_price_pence: null, confirmed_price_pence: null,
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockClear();
  prepareListingGenerationImageInputs.mockClear();
  runListingGenerationAnalysis.mockReset();
  runVintedCategorySelection.mockReset();
  upsertMarketplaceDraft.mockClear();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("listing_drafts?")) return [draftRow()];
    if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
    return [];
  });
  // No manual vinted category candidates configured — deriveDraftAudience/
  // deterministic assignment will simply find zero candidates, which is
  // fine: these tests are about the eBay branch, not Vinted category
  // resolution. Must be a real JSON array (never a bare 204/null body) —
  // resolveVintedCategoryAssignment calls response.json() directly on
  // whatever supabaseRequest("vinted_categories?...") returns.
  supabaseRequest.mockImplementation(async (path: string) => {
    if (path.startsWith("vinted_categories?")) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(null, { status: 204 });
  });
  runListingGenerationAnalysis.mockResolvedValue({ status: "success", data: aiFields() });
});

describe("POST /api/listing-studio/groups/[draftId]/generate — Stage 2 marketplace targets", () => {
  it("REGRESSION: omitting the request body entirely still defaults to VINTED-only and never touches the marketplace-drafts table", async () => {
    const response = await generateRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ebayDraft).toBeUndefined();
    expect(upsertMarketplaceDraft).not.toHaveBeenCalled();
  });

  it("targets: ['EBAY_UK'] alone creates exactly one eBay marketplace draft, reusing the SAME AI analysis call (never a second photo-analysis call)", async () => {
    const response = await generateRoute(requestWithTargets(["EBAY_UK"]), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ebayDraft).toBeDefined();
    expect(body.ebayDraft.title).toContain("Nike");
    expect(runListingGenerationAnalysis).toHaveBeenCalledTimes(1);
    expect(upsertMarketplaceDraft).toHaveBeenCalledTimes(1);
    expect(upsertMarketplaceDraft).toHaveBeenCalledWith(expect.objectContaining({
      productDraftId: DRAFT_ID, ownerId: "owner-1", marketplace: "EBAY_UK",
      sourceType: "generated", contentMode: "seo_optimised",
    }));
  });

  it("targets: ['VINTED','EBAY_UK'] (Both) produces the Vinted response fields AND an eBay draft from one shared analysis call", async () => {
    const response = await generateRoute(requestWithTargets(["VINTED", "EBAY_UK"]), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.generatedTitle).toBeTruthy(); // Vinted fields still present
    expect(body.ebayDraft).toBeDefined();
    expect(runListingGenerationAnalysis).toHaveBeenCalledTimes(1);
    expect(upsertMarketplaceDraft).toHaveBeenCalledTimes(1);
  });

  it("REQUIREMENT: a freshly-generated eBay draft is 'needs_information', never falsely 'ready', while category/condition/price are still unset (Stage 4/5 not yet wired in)", async () => {
    await generateRoute(requestWithTargets(["EBAY_UK"]), params());
    const call = upsertMarketplaceDraft.mock.calls[0][0];
    expect(call.status).toBe("needs_information");
    expect(call.readiness.ready).toBe(false);
    expect(call.validationMessages.some((m: { code: string }) => m.code === "category_not_set")).toBe(true);
    expect(call.validationMessages.some((m: { code: string }) => m.code === "condition_not_set")).toBe(true);
    expect(call.validationMessages.some((m: { code: string }) => m.code === "price_not_set")).toBe(true);
  });

  it("uses the group's confirmed (or suggested) price for the eBay draft when one already exists", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ confirmed_price_pence: 2500, suggested_price_pence: 2000 })];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    await generateRoute(requestWithTargets(["EBAY_UK"]), params());
    const call = upsertMarketplaceDraft.mock.calls[0][0];
    expect(call.pricePence).toBe(2500);
    expect(call.validationMessages.some((m: { code: string }) => m.code === "price_not_set")).toBe(false);
  });

  it("never invents brand/model/product type text — an eBay title with no identified product still generates safely and flags a warning", async () => {
    runListingGenerationAnalysis.mockResolvedValue({ status: "success", data: aiFields({ brand: { value: null, confidence: "low" }, model: { value: null, confidence: "low" }, productType: { value: null, confidence: "low" } }) });
    await generateRoute(requestWithTargets(["EBAY_UK"]), params());
    const call = upsertMarketplaceDraft.mock.calls[0][0];
    expect(call.validationMessages.some((m: { code: string }) => m.code === "no_identified_product")).toBe(true);
  });

  it("rejects an unrecognised marketplace target with a 400, never silently ignoring it", async () => {
    const response = await generateRoute(requestWithTargets(["MARS_UK"]), params());
    expect(response.status).toBe(400);
    expect(upsertMarketplaceDraft).not.toHaveBeenCalled();
  });

  it("a failed AI analysis never creates an eBay draft either", async () => {
    runListingGenerationAnalysis.mockResolvedValue({ status: "request_failed" });
    const response = await generateRoute(requestWithTargets(["EBAY_UK"]), params());
    expect(response.status).toBe(502);
    expect(upsertMarketplaceDraft).not.toHaveBeenCalled();
  });

  describe("Stage 3 settings hierarchy applied to a freshly-generated eBay draft", () => {
    it("REQUIREMENT: quantity always resolves to a real default (never left unset) — Quantity defaults to 1", async () => {
      getMarketplaceSettingsDefaults.mockResolvedValueOnce({});
      await generateRoute(requestWithTargets(["EBAY_UK"]), params());
      const call = upsertMarketplaceDraft.mock.calls[0][0];
      expect(call.quantity).toBe(1);
      expect(call.validationMessages.some((m: { code: string }) => m.code === "quantity_not_set")).toBe(false);
    });

    it("REGRESSION: an account-level default quantity is applied when no batch override is sent", async () => {
      getMarketplaceSettingsDefaults.mockResolvedValueOnce({ quantity: 5 });
      await generateRoute(requestWithTargets(["EBAY_UK"]), params());
      const call = upsertMarketplaceDraft.mock.calls[0][0];
      expect(call.quantity).toBe(5);
    });

    it("REGRESSION: a batch-level override in the request body wins over the account default", async () => {
      getMarketplaceSettingsDefaults.mockResolvedValueOnce({ quantity: 5 });
      await generateRoute(requestWithTargets(["EBAY_UK"], { ebaySettings: { quantity: 9 } }), params());
      const call = upsertMarketplaceDraft.mock.calls[0][0];
      expect(call.quantity).toBe(9);
    });

    it("REQUIREMENT: an imported eBay listing's exact-copy content mode is never silently flipped to SEO-optimised by an account default", async () => {
      // This route only ever builds a freshly-GENERATED draft (imported
      // listings are created by the eBay import process route instead), so
      // its own default is always seo_optimised unless the owner's account
      // default or this batch explicitly says otherwise.
      getMarketplaceSettingsDefaults.mockResolvedValueOnce({ contentMode: "exact_copy" });
      await generateRoute(requestWithTargets(["EBAY_UK"]), params());
      const call = upsertMarketplaceDraft.mock.calls[0][0];
      expect(call.contentMode).toBe("exact_copy");
    });
  });
});
