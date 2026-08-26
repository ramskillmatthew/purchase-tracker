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
// A genuinely COMPLETE, ready-in-every-dimension draft by default — every
// individual test overrides exactly the one field it's testing, so a test
// asserting "blocked because X" can never accidentally pass/fail because
// of some OTHER, unrelated field this route now also checks.
function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    brand: "Nike", model: "Pegasus", product_type: "Trainers", colours: ["Black"], material: "Mesh",
    uk_size: "9", sku: "1648", condition: "Good condition from photos",
    generated_title: "Nike Pegasus Trainers", generated_description: "A great pair of trainers.",
    vinted_audience: "womens",
    vinted_category_id: 1906, vinted_category_status: "category_assigned",
    confirmed_price_pence: 4500,
    ...overrides,
  };
}

// Every test that reaches the category/photo lookups needs the mocked
// sequence [draft row, category row, image rows] — this helper wires that
// up once so individual tests only ever override what they're testing.
function mockDraftAndDependencies(draftOverrides: Record<string, unknown> = {}, categoryOverrides: Record<string, unknown> | null = {}, images: { id: string }[] = [{ id: "img-1" }]) {
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("listing_drafts?")) return [draftRow(draftOverrides)];
    if (path.startsWith("listing_draft_images?")) return images;
    return categoryOverrides === null ? [] : [category(categoryOverrides)];
  });
}

beforeEach(() => { requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockClear(); });

describe("POST /api/listing-studio/groups/[draftId]/mark-ready — full server-side readiness revalidation (closes the 'direct API request bypasses the UI' gap)", () => {
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

  it("succeeds and sets review_marked_ready_at when every required field, the category, at least one photo, and the price are all valid", async () => {
    mockDraftAndDependencies();
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.draftId).toBe(DRAFT_ID);
    expect(typeof body.reviewMarkedReadyAt).toBe("string");
    expect(supabaseRequest).toHaveBeenCalledWith(expect.stringContaining("listing_drafts"), expect.objectContaining({ method: "PATCH" }));
  });

  describe("REGRESSION: a direct API request cannot mark an incomplete listing ready by bypassing the UI — every genuinely required field is independently blocked", () => {
    it("blocked when brand is missing", async () => {
      mockDraftAndDependencies({ brand: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing Brand");
    });

    it("blocked when product type is missing", async () => {
      mockDraftAndDependencies({ product_type: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing Product Type");
    });

    it("blocked when colours are empty", async () => {
      mockDraftAndDependencies({ colours: [] });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing Colour");
    });

    it("blocked when UK size is missing for a footwear product type", async () => {
      mockDraftAndDependencies({ uk_size: null, product_type: "Trainers" });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing Size");
    });

    it("NOT blocked on size when the product type genuinely has no size (e.g. a bag) — UK size is only required where the category/product needs it", async () => {
      mockDraftAndDependencies({ uk_size: null, product_type: "Handbag" });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(200);
    });

    it("blocked when SKU is missing — SKU is mandatory under this app's existing business rule", async () => {
      mockDraftAndDependencies({ sku: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing SKU");
    });

    it("blocked when the generated title is blank", async () => {
      mockDraftAndDependencies({ generated_title: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing title");
    });

    it("blocked when the generated description is blank", async () => {
      mockDraftAndDependencies({ generated_description: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing description");
    });

    it("blocked when condition is missing", async () => {
      mockDraftAndDependencies({ condition: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing condition");
    });

    it("blocked when the Vinted audience is null or 'unknown'", async () => {
      mockDraftAndDependencies({ vinted_audience: "unknown" });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing audience");
    });

    it("blocked (400) when the draft has no category at all", async () => {
      mockDraftAndDependencies({ vinted_category_id: null }, null);
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.warnings).toContain("Missing category");
      expect(supabaseRequest).not.toHaveBeenCalled();
    });

    it("blocked (400) when the stored category id no longer resolves to any row (deleted/unknown)", async () => {
      mockDraftAndDependencies({}, null);
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
    });

    it("blocked (400) when the stored category has since gone inactive", async () => {
      mockDraftAndDependencies({}, { is_active: false });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
    });

    it("blocked (400) when the stored category is non-selectable", async () => {
      mockDraftAndDependencies({}, { is_selectable: false });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
    });

    it("blocked (400) when the stored category is not a leaf", async () => {
      mockDraftAndDependencies({}, { is_leaf: false });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
    });

    it("shows the specific, actionable 'Audience required' instead of the generic 'Missing category' whenever that's genuinely why", async () => {
      mockDraftAndDependencies({ vinted_category_id: null, vinted_category_status: "audience_missing" }, null);
      const response = await markReadyRoute(new Request("http://test"), params());
      expect((await response.json()).warnings).toContain("Audience required");
    });

    it("blocked when there are no uploaded photos at all", async () => {
      mockDraftAndDependencies({}, {}, []);
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("No uploaded photos");
    });

    it("blocked when there is no saved selling price at all", async () => {
      mockDraftAndDependencies({ confirmed_price_pence: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
      expect((await response.json()).warnings).toContain("Missing selling price");
    });

    it("blocked when the saved selling price is zero", async () => {
      mockDraftAndDependencies({ confirmed_price_pence: 0 });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
    });

    it("blocked when the saved selling price is negative (defensive — the save route itself never persists this)", async () => {
      mockDraftAndDependencies({ confirmed_price_pence: -100 });
      const response = await markReadyRoute(new Request("http://test"), params());
      expect(response.status).toBe(400);
    });

    it("multiple missing fields are all reported together, not just the first one found", async () => {
      mockDraftAndDependencies({ brand: null, sku: null, confirmed_price_pence: null });
      const response = await markReadyRoute(new Request("http://test"), params());
      const body = await response.json();
      expect(body.warnings).toEqual(expect.arrayContaining(["Missing SKU", "Missing Brand", "Missing selling price"]));
    });
  });

  it("a listing with a valid price but no matching purchase is still allowed to be marked ready — the purchase-price lookup is never itself a readiness requirement", async () => {
    mockDraftAndDependencies();
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    expect(supabaseRequestAll.mock.calls.some(c => (c[0] as string).startsWith("purchases"))).toBe(false);
  });

  it("a listing whose SKU matches MULTIPLE purchases (a duplicate match) is still allowed to be marked ready, as long as everything this route actually checks is valid — the purchase match status is invisible to this route entirely (it never queries purchases at all)", async () => {
    mockDraftAndDependencies();
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    expect(supabaseRequestAll.mock.calls.every(c => !(c[0] as string).startsWith("purchases"))).toBe(true);
  });

  it("REGRESSION: never trusts client-supplied data — every check is derived from a fresh database fetch for this draft id/owner, this request has no body at all", async () => {
    mockDraftAndDependencies();
    await markReadyRoute(new Request("http://test", { method: "POST" }), params());
    expect(supabaseRequestAll.mock.calls[0][0]).toContain(`owner_id=eq.owner-1`);
  });
});

describe("POST /api/listing-studio/groups/[draftId]/mark-ready — Business-rule follow-up correction: Ready validation sees the normalised Women value", () => {
  it("a legacy footwear draft still stored as 'boys' (predating the normalisation rule) is NOT blocked by 'missing audience' — Ready validation treats it exactly as the resolved 'womens' value it normalises to", async () => {
    mockDraftAndDependencies({ vinted_audience: "boys" });
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
  });

  it("same for a legacy 'girls' footwear draft", async () => {
    mockDraftAndDependencies({ vinted_audience: "girls" });
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
  });

  it("REGRESSION: 'boys'/'girls' on a non-footwear product type is untouched by this rule — still a genuinely resolved (non-missing) audience, so Ready is still reachable", async () => {
    mockDraftAndDependencies({ vinted_audience: "boys", product_type: "Jacket" }, { full_path: "Kids > Boys clothing > Jacket", audience: "boys" });
    const response = await markReadyRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
  });
});
