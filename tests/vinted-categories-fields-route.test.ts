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

import { PATCH as fieldsRoute } from "@/app/api/listing-studio/groups/[draftId]/fields/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }

function fieldsBody(overrides: Record<string, unknown> = {}) {
  return {
    brand: "Nike", model: "Pegasus", productType: "Trainers",
    colours: ["Black"], material: "Mesh", ukSize: "9", sku: "1648",
    vintedAudience: "womens", vintedCategoryId: null,
    ...overrides,
  };
}
function patchRequest(body: Record<string, unknown>) {
  return new Request(`http://test/api/listing-studio/groups/${DRAFT_ID}/fields`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
// Matches fieldsBody()'s own default vintedAudience ("womens") so
// audienceChanged is false unless a test deliberately overrides one or the
// other — keeps the manual-category-pick tests focused on just that.
function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, vinted_audience: "womens", vinted_audience_source: "ai",
    vinted_category_id: null, vinted_category_path: null, vinted_category_source: null,
    ...overrides,
  };
}
function category(overrides: Record<string, unknown> = {}) {
  return { id: 1906, code: null, label: "Trainers", full_path: "Women > Shoes > Trainers", parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "womens", item_family: null, ...overrides };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  // Default: any category search returns no candidates (harmless
  // "no_candidates" outcome) — tests that need real candidates override
  // this explicitly.
  supabaseRequest.mockImplementation(async (path: string) => (
    path.startsWith("vinted_categories?") ? new Response(JSON.stringify([]), { status: 200 }) : new Response(null, { status: 204 })
  ));
});

describe("PATCH /api/listing-studio/groups/[draftId]/fields — Milestone 7 manual category selection", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await fieldsRoute(patchRequest(fieldsBody()), params());
    expect(response.status).toBe(401);
  });

  it("clearing the category (null), audience unchanged, is always allowed with no catalogue lookup", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]); // draft ownership + current state check
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: null })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBeNull();
    expect(body.vintedCategoryPath).toBeNull();
    expect(body.vintedCategorySource).toBeNull();
    // Only the draft-ownership lookup ran — no getVintedCategoryById lookup for a null id.
    expect(supabaseRequestAll).toHaveBeenCalledTimes(1);
  });

  it("a valid, active/selectable/leaf category id persists with source 'manual' and its current full path", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]);
    supabaseRequestAll.mockResolvedValueOnce([category()]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: 1906 })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(1906);
    expect(body.vintedCategoryPath).toBe("Women > Shoes > Trainers");
    expect(body.vintedCategorySource).toBe("manual");
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_category_id).toBe(1906);
    expect(patchBody.vinted_category_source).toBe("manual");
  });

  it("rejects a category id that doesn't resolve to any row", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]);
    supabaseRequestAll.mockResolvedValueOnce([]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: 9999 })), params());
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("rejects an inactive category", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]);
    supabaseRequestAll.mockResolvedValueOnce([category({ is_active: false })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: 1906 })), params());
    expect(response.status).toBe(400);
  });

  it("rejects a non-selectable category", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]);
    supabaseRequestAll.mockResolvedValueOnce([category({ is_selectable: false })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: 1906 })), params());
    expect(response.status).toBe(400);
  });

  it("does not alter productType/title-relevant fields based on the category — only its own fields change", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]);
    supabaseRequestAll.mockResolvedValueOnce([category()]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: 1906, productType: "Trainers" })), params());
    const body = await response.json();
    expect(body.productType).toBe("Trainers");
  });

  it("REGRESSION (2026-08-07): a later fields update does not clear an already-assigned category, and does not silently reclassify an untouched AI-assigned category as manual — the client always echoes back the current category id even when the user never touched the picker", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({
      vinted_category_id: 2632, vinted_category_path: "Women > Shoes > Trainers", vinted_category_source: "ai",
    })]);
    // Only edits SKU — vintedCategoryId is the SAME id the draft already
    // has (exactly what EditListingFieldsDialog's local state does when
    // the user never opens/changes the category picker).
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: 2632, sku: "1699" })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(2632);
    expect(body.vintedCategoryPath).toBe("Women > Shoes > Trainers");
    // The whole point of this regression: source stays "ai", NOT flipped
    // to "manual" just because a non-null id was resubmitted unchanged.
    expect(body.vintedCategorySource).toBe("ai");
    // No catalogue re-validation lookup was needed for an unchanged id —
    // only the draft-ownership lookup ran.
    expect(supabaseRequestAll).toHaveBeenCalledTimes(1);
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_category_id).toBe(2632);
    expect(patchBody.vinted_category_source).toBe("ai");
  });

  it("REGRESSION: genuinely picking a DIFFERENT category still correctly marks it manual, even when one was already AI-assigned", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({
      vinted_category_id: 2632, vinted_category_path: "Women > Shoes > Trainers", vinted_category_source: "ai",
    })]);
    supabaseRequestAll.mockResolvedValueOnce([category({ id: 2951, label: "Lace-up shoes", full_path: "Women > Shoes > Lace-up shoes" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedCategoryId: 2951 })), params());
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(2951);
    expect(body.vintedCategorySource).toBe("manual");
  });
});

describe("PATCH /api/listing-studio/groups/[draftId]/fields — Follow-up correction (2026-08-04): audience selector", () => {
  it("persists a manual audience change and marks its source 'manual'", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "unknown" })]);
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") ? new Response(JSON.stringify([]), { status: 200 }) : new Response(null, { status: 204 })
    ));
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedAudience: "mens" })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedAudience).toBe("mens");
    expect(body.vintedAudienceSource).toBe("manual");
  });

  it("does not mark audience as manual when it's resubmitted unchanged", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "mens", vinted_audience_source: "ai" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedAudience: "mens" })), params());
    const body = await response.json();
    expect(body.vintedAudienceSource).toBe("ai");
  });

  it("changing audience with no manual category in the same save clears an incompatible AI category and recomputes it", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?")) return [{ id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1231, root_id: 5, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null }];
      return [draftRow({ vinted_audience: "unknown", vinted_category_id: null })];
    });
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_categories?")) return new Response(JSON.stringify([{ id: 1906, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedAudience: "mens", vintedCategoryId: null })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBe(1906);
    expect(body.vintedCategorySource).toBe("ai");
  });

  it("a manual category pick in the SAME save always wins over an audience-driven recompute", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?id=eq.1906")) return [category()];
      return [draftRow({ vinted_audience: "unknown" })];
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedAudience: "mens", vintedCategoryId: 1906 })), params());
    const body = await response.json();
    expect(body.vintedCategorySource).toBe("manual");
    expect(body.vintedCategoryId).toBe(1906);
  });

  it("never touches brand/model/colours/material/size/SKU when only the audience changes", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?")) return [];
      return [draftRow({ vinted_audience: "unknown" })];
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedAudience: "mens", brand: "New Balance", model: "9060" })), params());
    const body = await response.json();
    expect(body.brand).toBe("New Balance");
    expect(body.model).toBe("9060");
    expect(body.colours).toEqual(["Black"]);
    expect(body.material).toBe("Mesh");
    expect(body.ukSize).toBe("9");
    expect(body.sku).toBe("1648");
  });
});
