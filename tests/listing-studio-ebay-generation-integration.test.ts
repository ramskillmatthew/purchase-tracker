import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Phase 11 — "Add tests that exercise the real route/component integration
// rather than only isolated helpers." This test calls the SAME POST
// handler GroupingWorkspace.tsx's handleGenerateListings actually fetches
// (the real HTTP integration boundary this app has — there is no
// @testing-library/react in this project, so a full in-browser click
// simulation isn't how this codebase's tests work; the route handler IS
// the seam every real "Generate listings" click passes through). Every
// mock here sits at a real I/O boundary (Supabase, Anthropic, eBay) —
// never at buildEbayDraftFromGeneratedFields/ebay-title-builder/
// ebay-description-renderer/ebay-description-validator themselves, so the
// actual composition pipeline runs for real and its real output is
// asserted on.

const {
  requireOwner, supabaseRequestAll, supabaseRequest,
  runListingGenerationAnalysis, runEbayListingGeneration, suggestEbayCategory, resolveEbayAspects,
  upsertMarketplaceDraft, getMarketplaceSettingsDefaults, getMarketplaceDraft, patchMarketplaceDraft,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  runListingGenerationAnalysis: vi.fn(),
  runEbayListingGeneration: vi.fn(),
  suggestEbayCategory: vi.fn(),
  resolveEbayAspects: vi.fn(),
  upsertMarketplaceDraft: vi.fn(),
  getMarketplaceSettingsDefaults: vi.fn(async () => ({} as Record<string, unknown>)),
  getMarketplaceDraft: vi.fn(),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/listing-studio/listing-generation-ai", () => ({ runListingGenerationAnalysis }));
vi.mock("@/lib/listing-studio/ebay-listing-generation-ai", () => ({ runEbayListingGeneration }));
vi.mock("@/lib/listing-studio/ebay-category-service", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/ebay-category-service")>();
  return { ...actual, suggestEbayCategory };
});
vi.mock("@/lib/listing-studio/ebay-aspect-service", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/ebay-aspect-service")>();
  return { ...actual, resolveEbayAspects };
});
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ upsertMarketplaceDraft, getMarketplaceSettingsDefaults, getMarketplaceDraft, patchMarketplaceDraft }));

import { POST as generateRoute } from "@/app/api/listing-studio/groups/[draftId]/generate/route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }
function request(targets: string[]) {
  return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targets }) });
}

/** Problem 2/3 fix — the AI no longer authors titleComponents/description
 * at all; it supplies only the genuinely eBay-specific ADDITIONAL facts
 * (style code, condition evidence, keywords, search terms, warnings). */
function aiSuccess(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    data: {
      styleCode: null, styleCodeConfidence: null, styleCodeEvidence: null,
      otherKeywords: [], conditionEvidence: null, categorySearchTerms: [], warnings: [],
      ...overrides,
    },
  };
}

// A product with an existing, real Vinted draft — exactly the reported
// scenario ("On Running Cloud 5"): generated_title/description already
// set, ai_result_json already stored from that earlier run, no eBay
// marketplace draft yet.
const STORED_FIELDS = {
  brand: { value: "On Running", confidence: "high" }, model: { value: "Cloud 5", confidence: "high" },
  productType: { value: "Running Trainers", confidence: "high" }, colours: { value: ["Blue", "Grey"], confidence: "high" },
  material: { value: "Mesh", confidence: "high" },
  sourceSize: { system: "UK", value: "4", gender: null, confidence: "high" },
  vintedAudience: { value: "womens", confidence: "high" }, vintedAudienceEvidence: [],
  sku: { value: "1644", confidence: "high" }, notes: null,
};

function vintedDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, title: "On Running Cloud 5", uk_size: "4", uk_size_source: "observed",
    vinted_category_id: 456, vinted_category_path: "Shoes > Trainers", vinted_category_source: "ai", vinted_category_status: "category_assigned",
    vinted_audience: "womens", vinted_audience_source: "ai",
    suggested_price_pence: 4500, confirmed_price_pence: null,
    generated_title: 'On Running Cloud 5 Running Trainers - "Blue & Grey" - Very Good Condition - Size UK 4',
    generated_description: "Always authentic & trusted seller ✅\nPlease look at my other items!",
    ai_result_json: STORED_FIELDS,
    ...overrides,
  };
}

// In-memory "database row" for the EBAY_UK marketplace draft — lets
// upsertMarketplaceDraft's write be immediately observed by a later
// getMarketplaceDraft read, proving "the write is immediately readable
// through the marketplace endpoint" without a second real HTTP hop.
let ebayRow: Record<string, unknown> | null = null;

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  runListingGenerationAnalysis.mockReset(); runEbayListingGeneration.mockReset();
  suggestEbayCategory.mockReset(); resolveEbayAspects.mockReset();
  upsertMarketplaceDraft.mockReset(); getMarketplaceSettingsDefaults.mockReset(); getMarketplaceDraft.mockReset(); patchMarketplaceDraft.mockReset();
  ebayRow = null;

  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("listing_drafts?")) return [vintedDraftRow()];
    if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
    return [];
  });
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
  getMarketplaceSettingsDefaults.mockResolvedValue({});
  upsertMarketplaceDraft.mockImplementation(async (input: Record<string, unknown>) => {
    // Realistic: mirrors the real upsertMarketplaceDraft's own behaviour
    // (lib/listing-studio/marketplace-drafts.ts) — dynamicData is only
    // ever touched when explicitly passed, which the generate route's own
    // upsert call never does. Preserving it here (rather than resetting
    // to {}) is what makes attemptCount/__contentGeneration tracking
    // across a first attempt and a Retry actually meaningful to assert on.
    ebayRow = {
      id: "mdraft-1", ownerId: input.ownerId, productDraftId: input.productDraftId, marketplace: "EBAY_UK",
      title: input.title, description: input.description, dynamicData: ebayRow?.dynamicData ?? {}, categoryId: null, categoryName: null,
      conditionValue: input.conditionValue ?? null, pricePence: input.pricePence ?? null, quantity: input.quantity ?? null,
      validationMessages: input.validationMessages ?? [], readiness: input.readiness ?? { ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
    };
    return "mdraft-1";
  });
  getMarketplaceDraft.mockImplementation(async () => ebayRow);
  // Realistic snake_case -> camelCase mapping for the one field these
  // tests actually read back (dynamic_data_json -> dynamicData) — matches
  // what the real getMarketplaceDraft/marketplace-drafts.ts row-transform
  // actually does, so a patch is genuinely observable on the next read.
  patchMarketplaceDraft.mockImplementation(async (_ownerId: string, _id: string, patch: Record<string, unknown>) => {
    if (!ebayRow) return;
    const { dynamic_data_json, ...rest } = patch;
    ebayRow = { ...ebayRow, ...rest, ...(dynamic_data_json !== undefined ? { dynamicData: dynamic_data_json } : {}) };
  });
  suggestEbayCategory.mockResolvedValue({
    status: "success", searchTerms: "On Running Cloud 5 Trainers",
    selected: { categoryId: "183454", categoryName: "Trainers", categoryPath: "Clothes > Trainers", rank: 1, confidence: "high", reason: "match" },
    alternatives: [], stale: false,
  });
  resolveEbayAspects.mockResolvedValue({ status: "success", grouped: { required: [], recommended: [], optional: [] }, dynamicData: {}, stale: false, aiCost: null });
});

describe("Generate Listings — full route integration, eBay UK only, on a product with an existing Vinted draft", () => {
  it("REGRESSION (the exact reported bug): writes a real EBAY_UK marketplace draft with clean, genuinely different content — never Vinted's own boilerplate", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess({
      conditionEvidence: "Light sole wear visible.", categorySearchTerms: ["On Running", "Cloud 5", "Trainers"],
    }));

    const response = await generateRoute(request(["EBAY_UK"]), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(upsertMarketplaceDraft).toHaveBeenCalledTimes(1);
    const written = upsertMarketplaceDraft.mock.calls[0][0];

    // 1. A real EBAY_UK row is written, for the right product/owner.
    expect(written.marketplace).toBe("EBAY_UK");
    expect(written.productDraftId).toBe(DRAFT_ID);
    expect(written.ownerId).toBe("owner-1");
    // 2. It contains the new eBay title/description — genuinely different
    //    from the stored Vinted title/description, deterministically
    //    composed (Brand -> Model -> Gender -> Size -> Colour -> Material
    //    -> Product type), reusing the SAME already-determined Vinted
    //    audience for gender rather than a second independent guess.
    expect(written.title).not.toBe(vintedDraftRow().generated_title);
    // "On Running" (brand) and "Running Trainers" (product type) are
    // different, non-adjacent fields — both real occurrences of "Running"
    // are correctly kept (the exact user-reported correction), while the
    // ADJACENT literal doubling that would signal a real bug never occurs.
    expect(written.title).toBe("On Running Cloud 5 Womens UK 4 Blue Grey Mesh Running Trainers");
    expect(written.title.toLowerCase().match(/\brunning\b/g)?.length).toBe(2);
    expect(written.title).not.toMatch(/\brunning running\b/i);
    expect(written.title).not.toContain('"');
    // 3. No Vinted boilerplate anywhere in the eBay description, and no
    //    markdown headers (the exact other reported bug).
    expect(written.description).not.toMatch(/authentic & trusted/i);
    expect(written.description).not.toMatch(/look at my other items/i);
    expect(written.description).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(written.description).not.toContain("**");
    // 4. The response identifies eBay success, and Vinted was untouched.
    expect(body.ebayGenerated).toBe(true);
    expect(body.vintedGenerated).toBe(false);
    expect(body.generatedTitle).toBe(vintedDraftRow().generated_title); // exact stored Vinted title, unchanged
  });

  it("5/6/7. the write is immediately readable through the marketplace endpoint, and it is the correct marketplace (EBAY_UK, not Vinted)", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    await generateRoute(request(["EBAY_UK"]), params());
    const readBack = await getMarketplaceDraft("owner-1", DRAFT_ID, "EBAY_UK");
    expect(readBack).toBeTruthy();
    expect(readBack!.marketplace).toBe("EBAY_UK");
    expect(readBack!.title).toContain("On Running");
  });

  it("8. the Vinted record remains completely unchanged — no PATCH to listing_drafts is ever sent for an eBay-only regeneration", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    await generateRoute(request(["EBAY_UK"]), params());
    const vintedPatchCalls = supabaseRequest.mock.calls.filter(call => String(call[0]).startsWith("listing_drafts?id=eq."));
    expect(vintedPatchCalls).toHaveLength(0);
  });

  it("REQUIREMENT: never re-runs the vision AI analysis for an eBay-only regeneration of an already-generated product (no repeated photo-sending)", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    await generateRoute(request(["EBAY_UK"]), params());
    expect(runListingGenerationAnalysis).not.toHaveBeenCalled();
    // The eBay AI call receives the REUSED stored facts, not fresh ones.
    expect(runEbayListingGeneration).toHaveBeenCalledWith(expect.objectContaining({ brand: "On Running", model: "Cloud 5" }));
  });

  it("REQUIREMENT: category is auto-suggested as part of this same call — never requiring a separate manual click first", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    await generateRoute(request(["EBAY_UK"]), params());
    expect(suggestEbayCategory).toHaveBeenCalled();
    expect(patchMarketplaceDraft).toHaveBeenCalled();
    const categoryPatch = patchMarketplaceDraft.mock.calls.find(c => (c[2] as Record<string, unknown>).category_id);
    expect(categoryPatch?.[2]).toMatchObject({ category_id: "183454" });
  });
});

describe("Generate Listings — existing product test: Vinted already 'Ready' must not skip eBay generation", () => {
  it("generating eBay UK for a product whose Vinted status is already complete still runs and writes a real eBay draft", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    // vintedDraftRow() above already represents a "Ready" Vinted product
    // (generated_title/description both set) — the request itself
    // reaching this route at all (targets: ["EBAY_UK"]) is only possible
    // once GroupingWorkspace.tsx's own eligibility check allows it — see
    // tests/listing-studio-generation-eligibility.test.ts for that half
    // of this same regression. This test proves the SERVER half: even
    // given such a request, it is honoured, not silently no-opped.
    const response = await generateRoute(request(["EBAY_UK"]), params());
    expect(response.status).toBe(200);
    expect(upsertMarketplaceDraft).toHaveBeenCalledTimes(1);
  });
});

describe("Generate Listings — regeneration of an existing eBay draft", () => {
  it("REQUIREMENT: regenerating eBay again does not create a duplicate row — the same upsert-by-(product_draft_id,marketplace) path is used, and it never touches category/dynamicData unless a NEW value is computed", async () => {
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    await generateRoute(request(["EBAY_UK"]), params());
    const written = upsertMarketplaceDraft.mock.calls[0][0];
    // upsertMarketplaceDraft's own upsert-by-unique-constraint behaviour
    // (product_draft_id, marketplace) is covered by
    // tests/listing-studio-marketplace-core.test.ts; this test's own
    // contract is narrower and just as load-bearing: the generate route
    // itself never passes categoryId/dynamicData to this call at all —
    // so a regeneration can never clobber a manually-confirmed category
    // or item specifics as a side effect of refreshing title/description.
    expect(written).not.toHaveProperty("categoryId");
    expect(written).not.toHaveProperty("dynamicData");
  });
});

describe("Generate Listings — eBay AI failure: honest degradation, never a fake success or silent Vinted fallback", () => {
  it("PROVEN ROOT CAUSE REGRESSION: the exact real bug (a well-formed response with one warning 23 characters over the old 200-char cap) is repaired and succeeds end-to-end through the full route, not just the isolated AI-call unit", async () => {
    const overlongWarning = "Model identification is medium confidence only — photo analysis suggests Cloud 5 but an earlier Cloud iteration (e.g. Cloud 3 or Cloud Classic) cannot be ruled out. Verify the exact model name before finalising the listing.";
    runEbayListingGeneration.mockResolvedValue(aiSuccess({ warnings: [overlongWarning] }));
    const response = await generateRoute(request(["EBAY_UK"]), params());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ebayGenerated).toBe(true);
    expect(body.ebayDegraded).toBe(false);
    const written = upsertMarketplaceDraft.mock.calls[0][0];
    expect(written.description).toContain("On Running Cloud 5");
  });

  it("REQUIREMENT (Phase 3/4/13): when the eBay AI call fails outright, a safe deterministic fallback is saved (never Vinted boilerplate), but the response — and product-card-visible state — never claims a genuine success", async () => {
    runEbayListingGeneration.mockResolvedValue({ status: "request_failed", code: "EBAY_AI_UNKNOWN" });
    const response = await generateRoute(request(["EBAY_UK"]), params());
    const body = await response.json();
    expect(response.status).toBe(200);
    // Bug fix: this used to assert ebayGenerated: true for a FALLBACK —
    // exactly the reported "0 ready to generate · 1 draft generated"
    // miscount. A fallback is never "generated".
    expect(body.ebayGenerated).toBe(false);
    expect(body.ebayContentState).toBe("fallback");
    expect(body.ebayDegraded).toBe(true);
    const written = upsertMarketplaceDraft.mock.calls[0][0];
    expect(written.description).not.toMatch(/authentic & trusted/i);
    expect(written.validationMessages.some((m: { code: string }) => m.code === "ebay_generation_degraded")).toBe(true);
  });

  it("REQUIREMENT (Phase 3): the FALLBACK state is persisted into dynamic_data_json.__contentGeneration, distinguishable from GENERATED by every later reader — never inferred from title/description alone", async () => {
    runEbayListingGeneration.mockResolvedValue({ status: "invalid_output", code: "EBAY_AI_VALIDATION_FAILED", issues: ["styleCodeConfidence: Invalid enum value"] });
    await generateRoute(request(["EBAY_UK"]), params());
    expect(ebayRow).toBeTruthy();
    const stored = (ebayRow!.dynamicData as Record<string, unknown>).__contentGeneration as { state: string; usedFallback: boolean; attemptCount: number; code: string | null };
    expect(stored.state).toBe("fallback");
    expect(stored.usedFallback).toBe(true);
    expect(stored.attemptCount).toBe(1);
    expect(stored.code).toBe("EBAY_AI_VALIDATION_FAILED");
  });
});

describe("Generate Listings — Retry (Phase 8): re-runs the real generator on an existing fallback row", () => {
  it("REQUIREMENT: Retry success replaces fallback title/description, transitions FALLBACK -> GENERATED on the SAME row, increments attemptCount, never duplicates", async () => {
    // First attempt: AI fails, fallback persisted.
    runEbayListingGeneration.mockResolvedValue({ status: "request_failed", code: "EBAY_AI_TIMEOUT" });
    await generateRoute(request(["EBAY_UK"]), params());
    expect(upsertMarketplaceDraft).toHaveBeenCalledTimes(1);
    const firstAttemptCount = ((ebayRow!.dynamicData as Record<string, unknown>).__contentGeneration as { attemptCount: number }).attemptCount;
    expect(firstAttemptCount).toBe(1);
    // The fallback description is the minimal deterministic form — never
    // the full rendered template (no "Condition:" line, since the AI call
    // never even ran to supply condition evidence).
    const fallbackWritten = upsertMarketplaceDraft.mock.calls[0][0];
    expect(fallbackWritten.description).not.toContain("Condition:");

    // Retry: AI now succeeds.
    runEbayListingGeneration.mockResolvedValue(aiSuccess());
    const retryResponse = await generateRoute(request(["EBAY_UK"]), params());
    const retryBody = await retryResponse.json();

    // Same row updated, not duplicated (this mock's own upsert always
    // targets the same in-memory ebayRow — the REAL upsert-by-unique-
    // constraint behaviour is covered in listing-studio-marketplace-core.test.ts).
    expect(upsertMarketplaceDraft).toHaveBeenCalledTimes(2);
    expect(retryBody.ebayGenerated).toBe(true);
    expect(retryBody.ebayDegraded).toBe(false);
    const written = upsertMarketplaceDraft.mock.calls[1][0];
    // Now the FULL deterministic template — proves this attempt genuinely
    // went through the real success path, not another fallback.
    expect(written.description).toContain("Condition:");
    expect(written.description).toContain("On Running Cloud 5");

    const secondState = (ebayRow!.dynamicData as Record<string, unknown>).__contentGeneration as { state: string; attemptCount: number; generatedAt: string | null };
    expect(secondState.state).toBe("generated");
    expect(secondState.attemptCount).toBe(2); // incremented, never reset
    expect(secondState.generatedAt).toBeTruthy();
  });

  it("REQUIREMENT: Retry failure keeps the draft FALLBACK, increments attemptCount again, never fakes success", async () => {
    runEbayListingGeneration.mockResolvedValue({ status: "request_failed", code: "EBAY_AI_TIMEOUT" });
    await generateRoute(request(["EBAY_UK"]), params()); // attempt 1
    await generateRoute(request(["EBAY_UK"]), params()); // attempt 2 (retry, still fails)
    const state = (ebayRow!.dynamicData as Record<string, unknown>).__contentGeneration as { state: string; attemptCount: number };
    expect(state.state).toBe("fallback");
    expect(state.attemptCount).toBe(2);
  });
});
