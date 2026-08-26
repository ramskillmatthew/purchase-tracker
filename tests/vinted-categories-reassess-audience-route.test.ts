import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, supabaseRequestAll, supabaseRequest,
  prepareListingGenerationImageInputs, runVintedAudiencePhotoReassessment, resolveVintedCategoryAssignment,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  prepareListingGenerationImageInputs: vi.fn(async () => ({ blocks: [{ imageId: "img-1", content: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "" } } }], skipped: [] })),
  runVintedAudiencePhotoReassessment: vi.fn(),
  resolveVintedCategoryAssignment: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/listing-studio/listing-generation-image-input", () => ({ prepareListingGenerationImageInputs }));
vi.mock("@/lib/listing-studio/vinted-audience-reassessment-ai", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-audience-reassessment-ai")>();
  return { ...actual, runVintedAudiencePhotoReassessment };
});
vi.mock("@/lib/listing-studio/vinted-category-assignment", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-category-assignment")>();
  return { ...actual, resolveVintedCategoryAssignment };
});

import { POST as reassessAudienceRoute } from "@/app/api/listing-studio/groups/[draftId]/reassess-audience/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, brand: "New Balance", model: "327", product_type: "Trainers",
    vinted_audience: "unknown", vinted_audience_source: "ai", vinted_audience_evidence: ["Label in photo 1 shows UK 5 / EU 37.5"],
    vinted_category_id: null, vinted_category_path: null, vinted_category_source: null, vinted_category_status: "audience_missing",
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  prepareListingGenerationImageInputs.mockClear();
  runVintedAudiencePhotoReassessment.mockReset();
  resolveVintedCategoryAssignment.mockReset();
  supabaseRequest.mockImplementation(async () => new Response(null, { status: 204 }));
});

describe("POST /api/listing-studio/groups/[draftId]/reassess-audience — explicit, cost-warned photo-based action", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await reassessAudienceRoute(new Request("http://test"), params());
    expect(response.status).toBe(401);
  });

  it("404s when the listing doesn't belong to this owner", async () => {
    supabaseRequestAll.mockResolvedValueOnce([]);
    const response = await reassessAudienceRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("manual audience remains protected: is a no-op and never calls the AI when the audience is already a manual pick", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience_source: "manual", vinted_audience: "mens" })]);
    const response = await reassessAudienceRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempted).toBe(false);
    expect(body.vintedAudience).toBe("mens");
    expect(runVintedAudiencePhotoReassessment).not.toHaveBeenCalled();
    expect(prepareListingGenerationImageInputs).not.toHaveBeenCalled();
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("400s when this group has no uploaded photos to reassess from", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow()] : []));
    const response = await reassessAudienceRoute(new Request("http://test"), params());
    expect(response.status).toBe(400);
    expect(runVintedAudiencePhotoReassessment).not.toHaveBeenCalled();
  });

  it("sends this draft's stored brand/model/productType and prior audience/evidence to the photo reassessment call", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "womens", vintedAudienceEvidence: ["Box label explicitly says WMNS"],
      model: "claude-sonnet-5", inputTokens: 900, outputTokens: 20,
    });

    await reassessAudienceRoute(new Request("http://test"), params());

    expect(runVintedAudiencePhotoReassessment).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        brand: "New Balance", model: "327", productType: "Trainers",
        priorVintedAudience: "unknown", priorEvidence: ["Label in photo 1 shows UK 5 / EU 37.5"],
      }),
    );
  });

  it("a successful reassessment persists the new audience + evidence, protects the manual-source column value as 'ai', and re-resolves the category since it was stuck on audience_missing", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "womens", vintedAudienceEvidence: ["Box label explicitly says WMNS"],
      model: "claude-sonnet-5", inputTokens: 900, outputTokens: 20,
    });
    resolveVintedCategoryAssignment.mockResolvedValueOnce({
      result: { reason: "category_assigned", categoryId: 2001, categoryPath: "Women > Shoes > Trainers", method: "deterministic" },
      aiCost: null,
    });

    const response = await reassessAudienceRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempted).toBe(true);
    expect(body.vintedAudience).toBe("womens");
    expect(body.vintedAudienceEvidence).toEqual(["Box label explicitly says WMNS"]);
    expect(body.vintedCategoryId).toBe(2001);
    expect(body.vintedCategoryStatus).toBe("category_assigned");

    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_audience).toBe("womens");
    expect(patchBody.vinted_audience_source).toBe("ai");
    expect(patchBody.vinted_audience_evidence).toEqual(["Box label explicitly says WMNS"]);
    expect(patchBody.vinted_category_id).toBe(2001);
  });

  it("never re-resolves the category when it wasn't stuck on audience_missing (e.g. already manually chosen)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ vinted_category_source: "manual", vinted_category_status: "category_assigned", vinted_category_id: 42, vinted_category_path: "Manual > Path" })];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "mens", vintedAudienceEvidence: ["Model identified as the men's version"],
      model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1,
    });

    const response = await reassessAudienceRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(resolveVintedCategoryAssignment).not.toHaveBeenCalled();
    expect(body.vintedCategoryId).toBe(42);
    expect(body.vintedCategoryPath).toBe("Manual > Path");
  });

  it("a failed AI reassessment returns 502, changes nothing, and logs a failed audit row", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({ status: "request_failed" });

    const response = await reassessAudienceRoute(new Request("http://test"), params());
    expect(response.status).toBe(502);
    // No listing_drafts PATCH is ever issued on failure.
    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeUndefined();
    const costLogCall = supabaseRequest.mock.calls.find((c) => c[0] === "vinted_category_selection_ai_calls");
    const costLogBody = JSON.parse((costLogCall![1] as RequestInit).body as string);
    expect(costLogBody.call_type).toBe("audience_reassessment_photo");
    expect(costLogBody.status).toBe("failed");
  });

  it("logs the audience AI call with call_type 'audience_reassessment_photo' and real token counts on success", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "womens", vintedAudienceEvidence: ["Box label explicitly says WMNS"],
      model: "claude-sonnet-5", inputTokens: 900, outputTokens: 20,
    });
    resolveVintedCategoryAssignment.mockResolvedValueOnce({ result: { reason: "audience_missing", categoryId: null, categoryPath: null }, aiCost: null });

    await reassessAudienceRoute(new Request("http://test"), params());
    const costLogCall = supabaseRequest.mock.calls.find((c) => c[0] === "vinted_category_selection_ai_calls");
    const costLogBody = JSON.parse((costLogCall![1] as RequestInit).body as string);
    expect(costLogBody.call_type).toBe("audience_reassessment_photo");
    expect(costLogBody.input_tokens).toBe(900);
    expect(costLogBody.output_tokens).toBe(20);
    expect(costLogBody.candidate_count).toBeNull();
  });
});

describe("POST /api/listing-studio/groups/[draftId]/reassess-audience — Business-rule follow-up correction: footwear must never be listed under a children's Vinted audience", () => {
  it("REGRESSION: a photo reassessment returning 'boys' for a footwear draft is normalised to 'womens' before being used for category resolution and persistence", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()]; // product_type "Trainers" (footwear), vinted_category_status "audience_missing" by default
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "boys", vintedAudienceEvidence: ["Box label explicitly says BOYS"],
      model: "claude-sonnet-5", inputTokens: 900, outputTokens: 20,
    });
    resolveVintedCategoryAssignment.mockResolvedValueOnce({
      result: { reason: "category_assigned", categoryId: 2632, categoryPath: "Women > Shoes > Trainers", method: "deterministic" },
      aiCost: null, vintedAudience: "womens",
    });

    const response = await reassessAudienceRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("womens");
    expect(body.vintedCategoryPath).toBe("Women > Shoes > Trainers");
    // The category resolver was called with the ALREADY-normalised audience.
    expect(resolveVintedCategoryAssignment).toHaveBeenCalledWith(expect.objectContaining({ vintedAudience: "womens" }));

    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_audience).toBe("womens");
  });

  it("REGRESSION: normalises the persisted audience even when the category-resolution block is skipped entirely (category wasn't stuck on audience_missing) — closes the exact gap where this route used to persist the raw AI result unconditionally", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ vinted_category_status: "no_candidates", vinted_category_source: null })];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "girls", vintedAudienceEvidence: ["Style code belongs to a girls' release"],
      model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1,
    });

    const response = await reassessAudienceRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("womens");
    expect(resolveVintedCategoryAssignment).not.toHaveBeenCalled(); // confirms the gap this closes: normalisation never depended on this call running

    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_audience).toBe("womens");
  });

  it("REGRESSION: 'boys'/'girls' on a non-footwear product type is returned/persisted completely unchanged", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ product_type: "Jacket", vinted_category_status: "no_candidates", vinted_category_source: null })];
      if (path.startsWith("listing_draft_images?")) return [{ id: "img-1", storage_path: "p", mime_type: "image/jpeg" }];
      return [];
    });
    runVintedAudiencePhotoReassessment.mockResolvedValueOnce({
      status: "success", vintedAudience: "boys", vintedAudienceEvidence: ["Kids clothing tag says Boys"],
      model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1,
    });

    const response = await reassessAudienceRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("boys");
  });
});
