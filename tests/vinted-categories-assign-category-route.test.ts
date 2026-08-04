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

import { POST as assignCategoryRoute } from "@/app/api/listing-studio/groups/[draftId]/assign-category/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, brand: "New Balance", model: "9060", product_type: "Trainers",
    vinted_audience: "mens", vinted_audience_source: "ai", vinted_audience_evidence: null,
    vinted_category_id: null, vinted_category_path: null, vinted_category_source: null,
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  supabaseRequest.mockImplementation(async (path: string) => (
    path.startsWith("vinted_categories?") ? new Response(JSON.stringify([]), { status: 200 }) : new Response(null, { status: 204 })
  ));
});

describe("POST /api/listing-studio/groups/[draftId]/assign-category — 'Assign category' retry action", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await assignCategoryRoute(new Request("http://test"), params());
    expect(response.status).toBe(401);
  });

  it("404s when the listing doesn't belong to this owner", async () => {
    supabaseRequestAll.mockResolvedValueOnce([]);
    const response = await assignCategoryRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("is a no-op (never overwrites) when the category is already manually chosen", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_category_id: 999, vinted_category_path: "Manual > Path", vinted_category_source: "manual" })]);
    const response = await assignCategoryRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempted).toBe(false);
    expect(body.vintedCategoryId).toBe(999);
    // No PATCH write, no AI call, no candidate search.
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("assigns a deterministic match using only stored fields — no photo reanalysis, no title/description/size/SKU/colour/material changes", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.includes("vinted_categories?id=eq.1906")) return [{ id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1231, root_id: 5, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null }];
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") ? new Response(JSON.stringify([{ id: 1906, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 }) : new Response(null, { status: 204 })
    ));

    const response = await assignCategoryRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempted).toBe(true);
    expect(body.vintedCategoryId).toBe(1906);
    expect(body.vintedCategorySource).toBe("ai");
    expect(body.vintedCategoryStatus).toBe("category_assigned");

    // Only the category-specific fields were written — no title/description/size/SKU/colour/material keys at all.
    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(Object.keys(patchBody).sort()).toEqual(["updated_at", "vinted_audience", "vinted_audience_evidence", "vinted_category_id", "vinted_category_path", "vinted_category_source", "vinted_category_status"].sort());
  });

  it("persists audience_missing when the stored audience is unresolved", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "unknown" })]);
    const response = await assignCategoryRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedCategoryStatus).toBe("audience_missing");
    expect(body.message).toMatch(/Men or Women/);
  });

  it("manual audience remains protected: a manually-chosen audience is never overwritten, even though the category itself is still assignable", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ vinted_audience: "unisex", vinted_audience_source: "manual", vinted_audience_evidence: null })];
      if (path.includes("vinted_categories?id=eq.1906")) return [{ id: 1906, code: null, label: "Trainers", full_path: "Unisex > Shoes > Trainers", parent_id: 1231, root_id: 5, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "unisex", item_family: null }];
      return [];
    });
    const response = await assignCategoryRoute(new Request("http://test"), params());
    const body = await response.json();
    // A manually-set "unisex" audience is preserved exactly as chosen — even
    // though resolveVintedCategoryAssignment treats "unisex" the same as
    // "unknown" for category-branch selection (Vinted has no unisex
    // catalogue branch), so this listing still needs a category picked
    // manually. The audience itself is never silently changed.
    expect(body.vintedAudience).toBe("unisex");
    expect(body.vintedAudienceEvidence).toBeNull();
    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_audience).toBe("unisex");
    expect(patchBody.vinted_audience_evidence).toBeNull();
  });
});
