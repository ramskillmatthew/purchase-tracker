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

describe("POST /api/listing-studio/groups/[draftId]/assign-category — Business-rule follow-up correction: footwear must never be listed under a children's Vinted audience", () => {
  it("REGRESSION: an existing footwear draft with a MANUAL Kids category and a 'girls' audience is corrected — the incompatible manual category is cleared and replaced with a fresh Women's footwear category, audience persisted as 'womens'", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) {
        return [draftRow({
          vinted_audience: "girls", vinted_audience_source: "ai",
          vinted_category_id: 1255, vinted_category_path: "Kids > Girls clothing > Shoes > Trainers", vinted_category_source: "manual",
        })];
      }
      if (path.includes("vinted_categories?id=eq.2632")) return [{ id: 2632, code: null, label: "Trainers", full_path: "Women > Shoes > Trainers", parent_id: 16, root_id: 4, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "womens", item_family: null }];
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));

    const response = await assignCategoryRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();

    // Not a no-op — the incompatible manual category didn't block this.
    expect(body.attempted).toBe(true);
    expect(body.vintedAudience).toBe("womens");
    expect(body.vintedCategoryId).toBe(2632);
    expect(body.vintedCategoryPath).toBe("Women > Shoes > Trainers");
    expect(body.vintedCategorySource).toBe("ai"); // the old "manual" Kids category is gone, replaced by a fresh AI-resolved one

    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_audience).toBe("womens");
    expect(patchBody.vinted_category_id).toBe(2632);
    expect(patchBody.vinted_category_path).toBe("Women > Shoes > Trainers");
    expect(patchBody.vinted_category_source).toBe("ai");
    expect(patchBody.vinted_category_path).not.toContain("Kids");
  });

  it("a manually-protected boys footwear audience is normalised to womens too", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) {
        return [draftRow({
          vinted_audience: "boys", vinted_audience_source: "manual",
          vinted_category_id: 1256, vinted_category_path: "Kids > Boys clothing > Shoes > Trainers", vinted_category_source: "manual",
        })];
      }
      if (path.includes("vinted_categories?id=eq.2632")) return [{ id: 2632, code: null, label: "Trainers", full_path: "Women > Shoes > Trainers", parent_id: 16, root_id: 4, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "womens", item_family: null }];
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") && path.includes("Women")
        ? new Response(JSON.stringify([{ id: 2632, label: "Trainers", full_path: "Women > Shoes > Trainers", audience: "womens", item_family: null }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 })
    ));

    const response = await assignCategoryRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("womens");
    expect(body.vintedCategoryPath).toBe("Women > Shoes > Trainers");
  });

  it("REGRESSION: a manually-chosen WOMEN's category on a womens-audience footwear draft remains fully protected — this correction never touches an already-compatible manual category", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({
      vinted_audience: "womens", vinted_audience_source: "ai",
      vinted_category_id: 2955, vinted_category_path: "Women > Shoes > Ballerinas", vinted_category_source: "manual",
    })]);
    const response = await assignCategoryRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.attempted).toBe(false); // unchanged no-op behaviour
    expect(body.vintedCategoryId).toBe(2955);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION: a manually-chosen category on a non-footwear boys/girls draft (e.g. Kids clothing) is still fully protected — this correction only ever fires for footwear", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({
      product_type: "Jacket", vinted_audience: "girls", vinted_audience_source: "ai",
      vinted_category_id: 1195, vinted_category_path: "Kids > Girls clothing > Jacket", vinted_category_source: "manual",
    })]);
    const response = await assignCategoryRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.attempted).toBe(false);
    expect(body.vintedCategoryId).toBe(1195);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});
