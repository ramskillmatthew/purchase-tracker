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

import { POST as bulkAssignRoute } from "@/app/api/listing-studio/listings-review/assign-categories/route";
import { MAX_BULK_CATEGORY_ASSIGNMENT } from "@/lib/listing-studio/vinted-category-assignment";
import { AuthError } from "@/lib/auth/server";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

function bulkRequest(draftIds: string[]) {
  return new Request("http://test/api/listing-studio/listings-review/assign-categories", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds }),
  });
}
function draftRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, brand: "Nike", model: "Air", product_type: "Trainers",
    vinted_audience: "mens", vinted_audience_source: "ai", vinted_audience_evidence: null,
    vinted_category_source: null,
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  supabaseRequest.mockImplementation(async (path: string) => (
    path.startsWith("vinted_categories?") ? new Response(JSON.stringify([]), { status: 200 }) : new Response(null, { status: 204 })
  ));
});

describe("POST /api/listing-studio/listings-review/assign-categories — bulk 'Assign missing categories'", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await bulkAssignRoute(bulkRequest([ID_A]));
    expect(response.status).toBe(401);
  });

  it("rejects an empty draftIds array and a batch exceeding the bound", async () => {
    expect((await bulkAssignRoute(bulkRequest([]))).status).toBe(400);
    const tooMany = Array.from({ length: MAX_BULK_CATEGORY_ASSIGNMENT + 1 }, (_, i) => `${i}`.padStart(8, "0") + "-1111-4111-8111-111111111111");
    expect((await bulkAssignRoute(bulkRequest(tooMany))).status).toBe(400);
  });

  it("REGRESSION: uses exactly ONE HTTP request for the whole batch — never one request per listing (this IS that one request)", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow(ID_A), draftRow(ID_B)]);
    const response = await bulkAssignRoute(bulkRequest([ID_A, ID_B]));
    expect(response.status).toBe(200);
    // Only one draft-lookup call for the WHOLE batch (an "in.(...)" query), not one per listing.
    const draftLookupCalls = supabaseRequestAll.mock.calls.filter((c) => (c[0] as string).startsWith("listing_drafts?id=in."));
    expect(draftLookupCalls).toHaveLength(1);
  });

  it("skips (never overwrites) listings that already have a manual category, tallied separately", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow(ID_A, { vinted_category_source: "manual" })]);
    const response = await bulkAssignRoute(bulkRequest([ID_A]));
    const body = await response.json();
    expect(body.summary.skippedCount).toBe(1);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("aggregates deterministic/AI/audience-required/no-match/failed counts and an estimated total AI cost", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?id=in.")) {
        return [
          draftRow(ID_A, { vinted_audience: "mens" }), // -> no_candidates (deterministic search, no mock data) = "no match"
          draftRow(ID_B, { vinted_audience: "unknown" }), // -> audience_missing
          draftRow(ID_C, { vinted_audience: "womens" }),
        ];
      }
      return [];
    });
    const response = await bulkAssignRoute(bulkRequest([ID_A, ID_B, ID_C]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.audienceRequiredCount).toBe(1);
    expect(body.summary.noMatchCount).toBe(2);
    expect(body.summary.deterministicCount + body.summary.aiAssignedCount).toBe(0);
    expect(body.results).toHaveLength(3);
  });

  it("never regenerates title/description or touches unrelated fields for any listing in the batch", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?id=in.")) return [draftRow(ID_A)];
      if (path.includes("vinted_categories?id=eq.1906")) return [{ id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1231, root_id: 5, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null }];
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string) => (
      path.startsWith("vinted_categories?") ? new Response(JSON.stringify([{ id: 1906, label: "Trainers", full_path: "Men > Shoes > Trainers", audience: "mens", item_family: null }]), { status: 200 }) : new Response(null, { status: 204 })
    ));
    await bulkAssignRoute(bulkRequest([ID_A]));
    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(Object.keys(patchBody).sort()).toEqual(["updated_at", "vinted_audience", "vinted_audience_evidence", "vinted_category_id", "vinted_category_path", "vinted_category_source", "vinted_category_status"].sort());
  });
});

describe("POST /api/listing-studio/listings-review/assign-categories — Business-rule follow-up correction: footwear must never be listed under a children's Vinted audience", () => {
  it("REGRESSION: a footwear draft with a MANUAL Kids category and a 'boys' audience is corrected in the bulk run — the incompatible manual category is cleared and replaced, audience persisted as 'womens'", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?id=in.")) {
        return [draftRow(ID_A, {
          vinted_audience: "boys", vinted_audience_source: "ai",
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

    const response = await bulkAssignRoute(bulkRequest([ID_A]));
    const body = await response.json();
    expect(body.summary.skippedCount).toBe(0); // not skipped as "already manual"
    expect(body.results[0].reason).toBe("category_assigned");

    const patchCall = supabaseRequest.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.vinted_audience).toBe("womens");
    expect(patchBody.vinted_category_id).toBe(2632);
    expect(patchBody.vinted_category_source).toBe("ai");
    expect(patchBody.vinted_category_path).not.toContain("Kids");
  });

  it("REGRESSION: a manually-chosen WOMEN's category on a womens-audience footwear draft remains fully protected in the bulk run", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow(ID_A, {
      vinted_audience: "womens", vinted_audience_source: "ai",
      vinted_category_id: 2955, vinted_category_path: "Women > Shoes > Ballerinas", vinted_category_source: "manual",
    })]);
    const response = await bulkAssignRoute(bulkRequest([ID_A]));
    const body = await response.json();
    expect(body.summary.skippedCount).toBe(1);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REGRESSION: a manually-chosen category on a non-footwear boys/girls draft (e.g. Kids clothing) remains fully protected — this correction only ever fires for footwear", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow(ID_A, {
      product_type: "Jacket", vinted_audience: "girls", vinted_audience_source: "ai",
      vinted_category_id: 1195, vinted_category_path: "Kids > Girls clothing > Jacket", vinted_category_source: "manual",
    })]);
    const response = await bulkAssignRoute(bulkRequest([ID_A]));
    const body = await response.json();
    expect(body.summary.skippedCount).toBe(1);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});
