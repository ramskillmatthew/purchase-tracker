import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { PATCH as sellingPriceRoute } from "@/app/api/listing-studio/groups/[draftId]/selling-price/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }
function patchRequest(body: unknown) {
  return new Request(`http://test/api/listing-studio/groups/${DRAFT_ID}/selling-price`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  supabaseRequestAll.mockResolvedValue([{ id: DRAFT_ID }]);
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("PATCH /api/listing-studio/groups/[draftId]/selling-price — Milestone 6: manual Vinted selling price save", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "45.00" }), params());
    expect(response.status).toBe(401);
  });

  it("404s when the listing doesn't belong to this owner", async () => {
    supabaseRequestAll.mockResolvedValueOnce([]);
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "45.00" }), params());
    expect(response.status).toBe(404);
  });

  it("a valid whole-pound value saves as integer pence", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "45" }), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sellingPricePence).toBe(4500);
  });

  it("a valid pounds-and-pence value saves as integer pence", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "18.50" }), params());
    const body = await response.json();
    expect(body.sellingPricePence).toBe(1850);
  });

  it("REGRESSION: blank is rejected with no write", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "" }), params());
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION: zero is rejected with no write", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "0" }), params());
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION: negative is rejected with no write", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "-5" }), params());
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION: a malformed value is rejected with no write", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "abc" }), params());
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION: an excessive value is rejected with no write", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "999999999" }), params());
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("stores the value as an exact integer pence, never a float", async () => {
    await sellingPriceRoute(patchRequest({ sellingPrice: "19.99" }), params());
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.confirmed_price_pence).toBe(1999);
    expect(Number.isInteger(patchBody.confirmed_price_pence)).toBe(true);
  });

  it("REGRESSION: only confirmed_price_pence and updated_at are ever written — never SKU, category, audience, colours, material, brand, model, or generated title/description", () => {
    return sellingPriceRoute(patchRequest({ sellingPrice: "45.00" }), params()).then(async () => {
      const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
      const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(Object.keys(patchBody).sort()).toEqual(["confirmed_price_pence", "updated_at"]);
    });
  });

  it("REGRESSION: the PATCH is scoped to this draft id and this owner alone", async () => {
    await sellingPriceRoute(patchRequest({ sellingPrice: "45.00" }), params());
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    expect(patchCall![0]).toBe(`listing_drafts?id=eq.${DRAFT_ID}&owner_id=eq.owner-1`);
  });

  it("REGRESSION: no AI call, no AI analysis run, no AI cost-log row — this route only ever writes to listing_drafts", async () => {
    await sellingPriceRoute(patchRequest({ sellingPrice: "45.00" }), params());
    expect(supabaseRequest.mock.calls.every(c => !(c[0] as string).startsWith("listing_analysis_runs"))).toBe(true);
    expect(supabaseRequest.mock.calls.every(c => !(c[0] as string).startsWith("vinted_category_selection_ai_calls"))).toBe(true);
  });

  it("rejects a request body shaped as a pre-computed number rather than the raw string", async () => {
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: 4500 }), params());
    expect(response.status).toBe(400);
  });

  it("catches everything through safeApiError, never a raw error", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await sellingPriceRoute(patchRequest({ sellingPrice: "45.00" }), params());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("db exploded");
  });
});
