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
// Every pre-existing test in this file implicitly assumes a Vinted draft
// already exists (this dialog/route long predates marketplace isolation)
// — generated_title/generated_description default to non-null here so
// that established behaviour keeps being exercised unchanged; the
// dedicated "no Vinted draft yet" describe block below overrides these to
// null to exercise the actual marketplace-isolation fix.
function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, vinted_audience: "womens", vinted_audience_source: "ai",
    vinted_category_id: null, vinted_category_path: null, vinted_category_source: null, vinted_category_status: null,
    generated_title: "Existing Title", generated_description: "Existing description.",
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

describe("PATCH /api/listing-studio/groups/[draftId]/fields — Business-rule follow-up correction: footwear must never be listed under a children's Vinted audience", () => {
  it("submitting 'boys' for a footwear product type persists 'womens' instead — never the raw submitted value", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?id=eq.1906")) return [category()];
      return [draftRow({ vinted_audience: "unknown" })]; // stored value differs from "womens", so this is genuinely an audience-driven recompute
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ productType: "Trainers", vintedAudience: "boys" })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedAudience).toBe("womens");
  });

  it("submitting 'girls' for a footwear product type persists 'womens' too", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?id=eq.1906")) return [category()];
      return [draftRow({ vinted_audience: "unknown" })];
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ productType: "Trainers", vintedAudience: "girls" })), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("womens");
  });

  it("REGRESSION: 'boys' on a non-footwear product type (e.g. clothing) is saved completely unchanged", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?")) return [];
      return [draftRow({ vinted_audience: "unknown" })];
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ productType: "Jacket", vintedAudience: "boys" })), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("boys");
  });

  it("REGRESSION: when the stored draft is ALREADY 'womens' (already correct, e.g. previously normalised), resubmitting 'womens' for footwear is NOT treated as an audience change — no unnecessary category recompute", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "womens", vinted_category_id: 1906, vinted_category_path: "Women > Shoes > Trainers", vinted_category_source: "ai" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ productType: "Trainers", vintedAudience: "womens", vintedCategoryId: null })), params());
    const body = await response.json();
    expect(body.vintedAudienceSource).toBe("ai"); // not reclassified as "manual" — nothing actually changed
    expect(body.vintedCategoryId).toBeNull(); // vintedCategoryId: null was explicitly submitted and honoured — unrelated to this rule
  });

  it("REGRESSION: UK size is never touched by this normalisation", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?id=eq.1906")) return [category()];
      return [draftRow({ vinted_audience: "unknown" })];
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ productType: "Trainers", vintedAudience: "boys", ukSize: "3" })), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("womens");
    expect(body.ukSize).toBe("3");
  });
});

describe("PATCH /api/listing-studio/groups/[draftId]/fields — business-rule follow-up correction: Women's footwear text must never carry children's audience wording", () => {
  it("REGRESSION (the exact production example): submitting model 'Clifton 9 Youth' for a footwear item already Women's persists 'Clifton 9' and a title with no 'Youth'", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "womens" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ brand: "Hoka", model: "Clifton 9 Youth", productType: "Running Trainers", vintedAudience: "womens", ukSize: "3" })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe("Clifton 9");
    expect(body.generatedTitle).not.toMatch(/\bYouth\b/i);
    expect(body.generatedTitle).toContain("Hoka Clifton 9 Running Trainers");
    expect(body.ukSize).toBe("3");
  });

  it("submitting 'boys'/'girls' together with children's wording in model: both the audience AND the text are normalised in the same save", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.includes("vinted_categories?id=eq.1906")) return [category()];
      return [draftRow({ vinted_audience: "unknown" })];
    });
    const response = await fieldsRoute(patchRequest(fieldsBody({ model: "Junior Clifton 9", productType: "Trainers", vintedAudience: "girls" })), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("womens");
    expect(body.model).toBe("Clifton 9");
  });

  it("REGRESSION: non-footwear model text is never touched, even for a Boys/Girls draft", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "unknown" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ model: "Girls Puffer", productType: "Jacket", vintedAudience: "girls" })), params());
    const body = await response.json();
    expect(body.model).toBe("Girls Puffer");
  });

  it("Men's footwear model text is never touched by this rule", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "mens" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ model: "Junior Racer", productType: "Trainers", vintedAudience: "mens" })), params());
    const body = await response.json();
    expect(body.model).toBe("Junior Racer");
  });

  it("REGRESSION: resubmitting an already-clean model is not treated specially — same value in, same value out, source untouched", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "womens", model: "Clifton 9" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ model: "Clifton 9", productType: "Trainers", vintedAudience: "womens" })), params());
    const body = await response.json();
    expect(body.model).toBe("Clifton 9");
  });
});

describe("PATCH /api/listing-studio/groups/[draftId]/fields — marketplace-isolation fix: a shared-fields edit must never silently CREATE a Vinted draft", () => {
  it("PROVEN ROOT CAUSE FIX: a product with NO Vinted draft yet (e.g. an eBay-only generated product) saves the shared fields, but generated_title/generated_description stay null — never fabricated as a side effect of an unrelated edit", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ generated_title: null, generated_description: null })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ brand: "New Balance", sku: "1699" })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.brand).toBe("New Balance"); // the shared fact IS saved
    expect(body.sku).toBe("1699");
    expect(body.generatedTitle).toBeNull();
    expect(body.generatedDescription).toBeNull();
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.generated_title).toBeNull();
    expect(patchBody.generated_description).toBeNull();
  });

  it("PROVEN ROOT CAUSE FIX: the same product's Vinted category is never resolved/written either — no manual-pick validation, no AI recompute, no listing_analysis_runs audit row", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ generated_title: null, generated_description: null, vinted_category_id: null })]);
    // Attempts a manual category pick AND an audience change in the same
    // save — both would normally trigger category resolution.
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedAudience: "mens", vintedCategoryId: 1906 })), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vintedCategoryId).toBeNull();
    expect(body.vintedCategorySource).toBeNull();
    // Only the draft-ownership lookup ran — no getVintedCategoryById lookup at all.
    expect(supabaseRequestAll).toHaveBeenCalledTimes(1);
    const analysisRunCalls = supabaseRequest.mock.calls.filter(c => typeof c[0] === "string" && c[0].startsWith("listing_analysis_runs"));
    expect(analysisRunCalls).toHaveLength(0);
  });

  it("REQUIREMENT: the shared vinted_audience field is still saved even with no Vinted draft yet — audience is reused by eBay's own title/description gender selection, not Vinted-exclusive", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ generated_title: null, generated_description: null, vinted_audience: "unknown" })]);
    const response = await fieldsRoute(patchRequest(fieldsBody({ vintedAudience: "mens", vintedCategoryId: null })), params());
    const body = await response.json();
    expect(body.vintedAudience).toBe("mens");
    expect(body.vintedAudienceSource).toBe("manual");
  });

  it("REQUIREMENT: once a Vinted draft genuinely exists (generated_title/generated_description already set), the exact same edit DOES regenerate the derived title/description — the fix is scoped to the missing-draft case only", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]); // default draftRow() already has generated_title/generated_description set
    const response = await fieldsRoute(patchRequest(fieldsBody({ brand: "New Balance", model: "2002R", productType: "Trainers" })), params());
    const body = await response.json();
    expect(body.generatedTitle).toContain("New Balance 2002R");
    expect(body.generatedTitle).not.toBeNull();
  });
});
