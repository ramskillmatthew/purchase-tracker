import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(async (_path: string) => new Response(JSON.stringify([
    { id: 1906, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null },
  ]), { status: 200 })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll: vi.fn(async () => []) }));

import { GET as searchRoute } from "@/app/api/listing-studio/vinted-categories/search/route";
import { AuthError } from "@/lib/auth/server";

function searchRequest(query: string) {
  return new Request(`http://test/api/listing-studio/vinted-categories/search?${query}`);
}

beforeEach(() => { requireOwner.mockClear(); supabaseRequest.mockClear(); });

describe("GET /api/listing-studio/vinted-categories/search", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await searchRoute(searchRequest("query=train"));
    expect(response.status).toBe(401);
  });

  it("rejects a query shorter than the minimum sensible length", async () => {
    const response = await searchRoute(searchRequest("query=t"));
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("accepts a query at the minimum length and returns bounded results", async () => {
    const response = await searchRoute(searchRequest("query=tr"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toEqual([{ id: 1906, label: "Trainers", fullPath: "Women > Shoes > Trainers", audience: "womens", itemFamily: null }]);
  });

  it("filters query characters that are significant to the underlying ilike search rather than rejecting the request", async () => {
    const response = await searchRoute(searchRequest("query=" + encodeURIComponent("tr%()")));
    expect(response.status).toBe(200);
  });

  it("only ever queries active + selectable categories", async () => {
    await searchRoute(searchRequest("query=trainers"));
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain("is_active=eq.true");
    expect(path).toContain("is_selectable=eq.true");
  });

  it("passes through audience and itemFamily filters", async () => {
    await searchRoute(searchRequest("query=trainers&audience=womens&itemFamily=footwear"));
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain("audience=eq.womens");
    expect(path).toContain("item_family=eq.footwear");
  });
});
