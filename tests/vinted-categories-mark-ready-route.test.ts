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

import { POST as markReadyRoute } from "@/app/api/listing-studio/groups/[draftId]/mark-ready/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }

function category(overrides: Record<string, unknown> = {}) {
  return { id: 1906, code: null, label: "Trainers", full_path: "Women > Shoes > Trainers", parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "womens", item_family: null, ...overrides };
}

beforeEach(() => { requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockClear(); });

describe("POST /api/listing-studio/groups/[draftId]/mark-ready — Milestone 7 server-side category revalidation", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(401);
  });

  it("404s when the listing doesn't belong to this owner", async () => {
    supabaseRequestAll.mockResolvedValueOnce([]);
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("blocked (400) when the draft has no category at all", async () => {
    supabaseRequestAll.mockResolvedValueOnce([{ id: DRAFT_ID, vinted_category_id: null }]);
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/valid Vinted category/);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("blocked (400) when the stored category id no longer resolves to any row (deleted/unknown)", async () => {
    supabaseRequestAll.mockResolvedValueOnce([{ id: DRAFT_ID, vinted_category_id: 1906 }]);
    supabaseRequestAll.mockResolvedValueOnce([]); // getVintedCategoryById -> not found
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(400);
  });

  it("blocked (400) when the stored category has since gone inactive", async () => {
    supabaseRequestAll.mockResolvedValueOnce([{ id: DRAFT_ID, vinted_category_id: 1906 }]);
    supabaseRequestAll.mockResolvedValueOnce([category({ is_active: false })]);
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(400);
  });

  it("blocked (400) when the stored category is non-selectable", async () => {
    supabaseRequestAll.mockResolvedValueOnce([{ id: DRAFT_ID, vinted_category_id: 1906 }]);
    supabaseRequestAll.mockResolvedValueOnce([category({ is_selectable: false })]);
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(400);
  });

  it("blocked (400) when the stored category is not a leaf", async () => {
    supabaseRequestAll.mockResolvedValueOnce([{ id: DRAFT_ID, vinted_category_id: 1906 }]);
    supabaseRequestAll.mockResolvedValueOnce([category({ is_leaf: false })]);
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(400);
  });

  it("succeeds and sets review_marked_ready_at when the stored category is currently active/selectable/leaf", async () => {
    supabaseRequestAll.mockResolvedValueOnce([{ id: DRAFT_ID, vinted_category_id: 1906 }]);
    supabaseRequestAll.mockResolvedValueOnce([category()]);
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.draftId).toBe(DRAFT_ID);
    expect(typeof body.reviewMarkedReadyAt).toBe("string");
    expect(supabaseRequest).toHaveBeenCalledWith(expect.stringContaining("listing_drafts"), expect.objectContaining({ method: "PATCH" }));
  });
});
