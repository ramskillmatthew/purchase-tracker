import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, supabaseRequestAll, supabaseRequest,
  prepareListingGenerationImageInputs, runListingGenerationAnalysis, runVintedCategorySelection,
  upsertMarketplaceDraft, getMarketplaceSettingsDefaults, getMarketplaceDraft, patchMarketplaceDraft,
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
  // Step 5 (parcel-size suggestion) — the generate route reads the
  // just-upserted eBay draft back to check for a manually-confirmed
  // package size before writing a fresh suggestion. Defaults to "no
  // existing draft found" so every pre-existing test in this file (none of
  // which know or care about package suggestions) keeps exercising the
  // same silent, soft-failure no-op path it always has.
  getMarketplaceDraft: vi.fn(async () => null as { id: string; dynamicData: Record<string, unknown> } | null),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
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
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ upsertMarketplaceDraft, getMarketplaceSettingsDefaults, getMarketplaceDraft, patchMarketplaceDraft }));

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
  getMarketplaceDraft.mockReset(); getMarketplaceDraft.mockResolvedValue(null);
  patchMarketplaceDraft.mockReset();
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

  it("MARKETPLACE ISOLATION (proven root-cause fix): eBay UK selected on a BRAND-NEW product (no prior Vinted content at all) still runs the shared vision analysis to obtain facts, but never writes a Vinted draft — the previous single 'runVintedPipeline' boolean incorrectly ran the full Vinted-writing pipeline in exactly this case", async () => {
    // draftRow() has no generated_title/generated_description overrides —
    // this IS the brand-new-product case that exposed the bug: the old
    // `!alreadyHasVintedContent` fallback made `runVintedPipeline` true
    // even though only EBAY_UK was requested.
    const response = await generateRoute(requestWithTargets(["EBAY_UK"]), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    // Vision analysis still runs exactly once — facts are genuinely needed
    // for the eBay draft, and this is shared infrastructure, not itself a
    // "Vinted generation call" (Vinted's own title/description are
    // template-based, never AI-written).
    expect(runListingGenerationAnalysis).toHaveBeenCalledTimes(1);
    // But NOTHING Vinted-shaped is written: no PATCH to listing_drafts, no
    // Vinted analysis-run audit row, no Vinted category-selection call.
    const draftPatchCalls = supabaseRequest.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("listing_drafts?id=eq"));
    expect(draftPatchCalls).toHaveLength(0);
    const analysisRunCalls = supabaseRequest.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("listing_analysis_runs"));
    expect(analysisRunCalls).toHaveLength(0);
    expect(runVintedCategorySelection).not.toHaveBeenCalled();
    // The response honestly reports Vinted was never touched, not merely
    // "already ready".
    expect(body.vintedGenerated).toBe(false);
    // draftRow() never had a Vinted title/description in the first place —
    // JSON.stringify drops an undefined field entirely, so it's simply
    // absent from the response, never a fabricated placeholder value.
    expect(body.generatedTitle).toBeUndefined();
    expect(body.generatedDescription).toBeUndefined();
    // The eBay draft itself was still genuinely created.
    expect(body.ebayDraft).toBeDefined();
    expect(upsertMarketplaceDraft).toHaveBeenCalledTimes(1);
  });

  it("MARKETPLACE ISOLATION: eBay UK selected on a product that ALREADY has a Vinted draft leaves that Vinted draft completely untouched, byte-for-byte", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) {
        return [draftRow({ generated_title: "Existing Vinted Title", generated_description: "Existing Vinted Description", ai_result_json: aiFields({ vintedAudienceEvidence: ["Evidence"] }) })];
      }
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    const response = await generateRoute(requestWithTargets(["EBAY_UK"]), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    // No fresh vision call needed either — reuse whatever stored facts.
    expect(runListingGenerationAnalysis).not.toHaveBeenCalled();
    const draftPatchCalls = supabaseRequest.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("listing_drafts?id=eq"));
    expect(draftPatchCalls).toHaveLength(0);
    expect(body.vintedGenerated).toBe(false);
    expect(body.generatedTitle).toBe("Existing Vinted Title");
    expect(body.generatedDescription).toBe("Existing Vinted Description");
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

  describe("Step 5 (parcel-size suggestion) automatically applied as part of the eBay draft job", () => {
    it("REQUIREMENT: a fresh eBay draft with no prior package size gets a suggestion persisted via dynamic_data_json.__packageSize, never overwriting other stored aspects", async () => {
      getMarketplaceDraft.mockResolvedValue({ id: "mdraft-1", dynamicData: { Colour: { value: "Black", confidence: "high", source: "x", appliedAutomatically: true, needsReview: false, userConfirmed: true, updatedAt: "x" } } });
      await generateRoute(requestWithTargets(["EBAY_UK"]), params());
      expect(patchMarketplaceDraft).toHaveBeenCalled();
      const [ownerId, id, patch] = patchMarketplaceDraft.mock.calls[0];
      expect(ownerId).toBe("owner-1");
      expect(id).toBe("mdraft-1");
      const dynamicData = patch.dynamic_data_json as Record<string, { value: unknown; userConfirmed: boolean }>;
      expect(dynamicData.Colour.value).toBe("Black"); // untouched, still present
      expect(dynamicData.__packageSize).toBeTruthy();
      expect(dynamicData.__packageSize.userConfirmed).toBe(false);
    });

    it("Problem 8: persists structured product facts (style code, resolved condition state) via dynamic_data_json.__productFacts, ready for a future eBay API listing stage", async () => {
      getMarketplaceDraft.mockResolvedValue({ id: "mdraft-1", dynamicData: {} });
      await generateRoute(requestWithTargets(["EBAY_UK"]), params());
      const patch = patchMarketplaceDraft.mock.calls[0][2] as { dynamic_data_json: Record<string, unknown> };
      const productFacts = patch.dynamic_data_json.__productFacts as { styleCode: string | null; conditionState: string; updatedAt: string };
      expect(productFacts).toBeTruthy();
      expect(["very_good_preowned", "new", "needs_review"]).toContain(productFacts.conditionState);
      expect(productFacts.updatedAt).toBeTruthy();
    });

    it("REQUIREMENT (manual override always wins): a package size the owner already confirmed is never overwritten by a fresh suggestion", async () => {
      getMarketplaceDraft.mockResolvedValue({ id: "mdraft-1", dynamicData: { __packageSize: { value: "large_letter", confidence: "medium", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: true, updatedAt: "x" } } });
      await generateRoute(requestWithTargets(["EBAY_UK"]), params());
      // Phase 3 fix — patchMarketplaceDraft is now ALSO the write path for
      // the authoritative content-generation state (dynamicData.
      // __contentGeneration), so it's no longer expected to be uncalled
      // outright; the real, still-load-bearing assertion is that the
      // owner's own confirmed __packageSize choice is never part of that
      // write's payload.
      expect(patchMarketplaceDraft).toHaveBeenCalled();
      const dynamicDataPatch = (patchMarketplaceDraft.mock.calls[0][2] as { dynamic_data_json: Record<string, unknown> }).dynamic_data_json;
      expect(dynamicDataPatch.__packageSize).toEqual({ value: "large_letter", confidence: "medium", source: "manual", appliedAutomatically: false, needsReview: false, userConfirmed: true, updatedAt: "x" });
      expect(dynamicDataPatch.__contentGeneration).toBeTruthy();
    });

    it("never breaks 'Generate listings' when persisting the package suggestion fails — the eBay draft itself is still returned successfully", async () => {
      getMarketplaceDraft.mockRejectedValue(new Error("network blip"));
      const response = await generateRoute(requestWithTargets(["EBAY_UK"]), params());
      expect(response.status).toBe(200);
    });

    it("does nothing when no eBay draft is being generated (VINTED-only request)", async () => {
      await generateRoute(requestWithTargets(["VINTED"]), params());
      expect(getMarketplaceDraft).not.toHaveBeenCalled();
      expect(patchMarketplaceDraft).not.toHaveBeenCalled();
    });
  });
});
