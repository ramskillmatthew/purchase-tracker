import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, supabaseRequestAll, supabaseRequest,
  prepareListingGenerationImageInputs, runListingGenerationAnalysis, runVintedCategorySelection,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  prepareListingGenerationImageInputs: vi.fn(async () => ({ blocks: [{ id: "img-1", content: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "" } } }], skipped: [] })),
  runListingGenerationAnalysis: vi.fn(),
  runVintedCategorySelection: vi.fn(),
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

import { POST as generateRoute } from "@/app/api/listing-studio/groups/[draftId]/generate/route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }

// Follow-up correction (2026-08-04): vintedAudience is now independent of
// sourceSize.gender — aiFields() defaults sourceSize.gender to null (the
// realistic common case for footwear, per the New Balance 9060 bug) while
// vintedAudience.value carries the real audience signal instead.
// vintedAudience "womens" + productType "Trainers" -> deriveDraftAudience
// "women" + deriveDraftItemFamily "footwear" -> the single branch "Women >
// Shoes" (id 16) — matches this milestone's real verified branch table.
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

// Two plausible candidates under the "Women > Shoes" branch by default —
// exercises the ambiguous (AI-required) path. A dedicated test below
// overrides this to exactly one candidate to exercise the deterministic
// (no-AI-call) shortcut.
function twoCandidates() {
  return [
    { id: 1906, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null },
    { id: 1907, label: "Running shoes", full_path: "Women > Shoes > Running shoes", audience: "womens", item_family: null },
  ];
}
function categoryRow(overrides: Record<string, unknown> = {}) {
  return { id: 1906, code: null, label: "Trainers", full_path: "Women > Shoes > Trainers", parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "womens", item_family: null, ...overrides };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, title: "Group 1", uk_size: null, uk_size_source: null,
    vinted_category_id: null, vinted_category_path: null, vinted_category_source: null, vinted_category_status: null,
    vinted_audience: null, vinted_audience_source: null,
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockClear();
  prepareListingGenerationImageInputs.mockClear();
  runListingGenerationAnalysis.mockReset();
  runVintedCategorySelection.mockReset();
  supabaseRequest.mockImplementation(async (path: string) => {
    if (path.startsWith("vinted_categories?")) return new Response(JSON.stringify(twoCandidates()), { status: 200 });
    return new Response(null, { status: 204 });
  });
});

describe("POST /api/listing-studio/groups/[draftId]/generate — the exact New Balance 9060 Trainers production bug", () => {
  it("a shoe with no sourceSize.gender (common — most footwear size tags print no gender) still gets a category, using the independent vintedAudience field", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      if (path.includes("vinted_categories?id=eq.1906")) return [categoryRow()];
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({
      status: "success",
      data: aiFields({
        brand: { value: "New Balance", confidence: "high" }, model: { value: "9060", confidence: "high" },
        colours: { value: ["Grey", "Light blue"], confidence: "high" }, material: { value: "Suede", confidence: "high" },
        sourceSize: { system: "UK", value: "6", gender: null, confidence: "high" }, // exactly the reported bug input
        vintedAudience: { value: "womens", confidence: "medium" },
      }),
    });
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: 1906, model: "claude-sonnet-5", inputTokens: 400, outputTokens: 10 });

    const response = await generateRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(1906);
    expect(body.vintedCategoryPath).toBe("Women > Shoes > Trainers");
    expect(body.vintedAudience).toBe("womens");
  });

  it("REGRESSION: before this fix, a null sourceSize.gender alone would have produced NO category and NO failure record — now it always produces a persisted vinted_category_status either way", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    // Audience genuinely unknown this time (AI couldn't tell either) —
    // the important behaviour is that this is now VISIBLE (a real status
    // is recorded), not that a category gets guessed.
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields({ vintedAudience: { value: "unknown", confidence: "low" } }) });

    const response = await generateRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBeNull();
    expect(body.vintedCategoryStatus).toBe("audience_missing");
  });
});

describe("POST /api/listing-studio/groups/[draftId]/generate — Milestone 7 follow-up: branch-scoped, deterministic-first category selection", () => {
  it("a validated AI category selection (ambiguous candidates) is persisted, and productType/generated title/description are unaffected by it", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      if (path.includes("vinted_categories?id=eq.1906")) return [categoryRow()];
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields() });
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: 1906, model: "claude-sonnet-5", inputTokens: 500, outputTokens: 20 });

    const response = await generateRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(1906);
    expect(body.vintedCategoryPath).toBe("Women > Shoes > Trainers");
    expect(body.vintedCategorySource).toBe("ai");
    expect(body.productType).toBe("Trainers");
    expect(body.generatedTitle).toContain("Nike");
    expect(runVintedCategorySelection).toHaveBeenCalledTimes(1);

    // Cost log recorded for the actual AI call.
    const costLogCall = supabaseRequest.mock.calls.find((c) => c[0] === "vinted_category_selection_ai_calls");
    expect(costLogCall).toBeTruthy();
    const costLogBody = JSON.parse((costLogCall![1] as RequestInit).body as string);
    expect(costLogBody).toMatchObject({ draft_id: DRAFT_ID, model: "claude-sonnet-5", input_tokens: 500, output_tokens: 20, candidate_count: 2, status: "success" });
    expect(typeof costLogBody.estimated_cost_usd).toBe("number");
  });

  it("a single unambiguous deterministic candidate is assigned WITHOUT ever calling the AI, and logs no AI cost", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_categories?id=eq.1906")) return new Response(JSON.stringify([categoryRow()]), { status: 200 });
      if (path.startsWith("vinted_categories?")) return new Response(JSON.stringify([twoCandidates()[0]]), { status: 200 }); // exactly one candidate
      return new Response(null, { status: 204 });
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      if (path.includes("vinted_categories?id=eq.1906")) return [categoryRow()];
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields() });

    const response = await generateRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(1906);
    expect(body.vintedCategorySource).toBe("ai");
    expect(runVintedCategorySelection).not.toHaveBeenCalled();
    expect(supabaseRequest.mock.calls.find((c) => c[0] === "vinted_category_selection_ai_calls")).toBeUndefined();
  });

  it("an AI selection outside the supplied candidates is rejected and never persisted; the previous known-good category is kept untouched", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ vinted_category_id: 5000, vinted_category_path: "Existing > Path", vinted_category_source: "ai" })];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      if (path.includes("vinted_categories?id=eq.9999")) return []; // not found
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields() });
    // 9999 was never in the candidate list returned by the mocked search above.
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: 9999, model: "claude-sonnet-5", inputTokens: 500, outputTokens: 20 });

    const response = await generateRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(5000);
    expect(body.vintedCategoryPath).toBe("Existing > Path");
    expect(body.vintedCategorySource).toBe("ai");
    // Never persisted the invalid id.
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_category_id).toBe(5000);
  });

  it("null category (AI confidently found nothing among ambiguous candidates) is accepted, persisted as null, with no source (nothing was actually assigned) and a recorded reason", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields() });
    runVintedCategorySelection.mockResolvedValueOnce({ status: "success", vintedCategoryId: null, model: "claude-sonnet-5", inputTokens: 500, outputTokens: 20 });

    const response = await generateRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedCategoryId).toBeNull();
    expect(body.vintedCategorySource).toBeNull();
    expect(body.vintedCategoryStatus).toBe("ai_selection_invalid");
  });

  it("never overwrites a manually-chosen category, and never even calls the category-selection AI or its candidate search", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ vinted_category_id: 5000, vinted_category_path: "Manual > Path", vinted_category_source: "manual" })];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields() });

    const response = await generateRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(5000);
    expect(body.vintedCategorySource).toBe("manual");
    expect(runVintedCategorySelection).not.toHaveBeenCalled();
    expect(supabaseRequest.mock.calls.some((c) => c[0].startsWith("vinted_categories?"))).toBe(false);
  });

  it("vintedAudience 'unknown' (genuinely undeterminable) skips automatic selection entirely — no candidate search, no AI call, but IS recorded as audience_missing", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields({ vintedAudience: { value: "unknown", confidence: "low" } }) });

    const response = await generateRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedCategoryId).toBeNull();
    expect(body.vintedCategoryStatus).toBe("audience_missing");
    expect(runVintedCategorySelection).not.toHaveBeenCalled();
    expect(supabaseRequest.mock.calls.some((c) => c[0].startsWith("vinted_categories?"))).toBe(false);
  });

  it("vintedAudience 'unisex' does not silently choose Men or Women — also audience_missing, never a guess", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields({ vintedAudience: { value: "unisex", confidence: "high" } }) });

    const response = await generateRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedCategoryId).toBeNull();
    expect(body.vintedCategoryStatus).toBe("audience_missing");
    expect(runVintedCategorySelection).not.toHaveBeenCalled();
  });

  it("a manually-corrected audience (vinted_audience_source='manual') is never overwritten by a fresh regenerate, even if the new AI pass disagrees", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ vinted_audience: "mens", vinted_audience_source: "manual" })];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      if (path.includes("vinted_categories?id=eq.")) return [categoryRow({ id: 1231, full_path: "Men > Shoes" })];
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") ? new Response(JSON.stringify([{ id: 1231, label: "Shoes", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 }) : new Response(null, { status: 204 })
    ));
    // The fresh AI pass now disagrees and says "womens" — must be ignored.
    runListingGenerationAnalysis.mockResolvedValueOnce({ status: "success", data: aiFields({ vintedAudience: { value: "womens", confidence: "high" } }) });

    const response = await generateRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("mens");
    expect(body.vintedAudienceSource).toBe("manual");
  });
});
