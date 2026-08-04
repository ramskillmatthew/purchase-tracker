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

import { POST as refreshListingTextRoute } from "@/app/api/listing-studio/groups/[draftId]/refresh-listing-text/route";
import { AuthError } from "@/lib/auth/server";
import { generateListingDescription, generateListingTitle } from "@/lib/listing-studio/listing-template";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }

// generated_description defaults to whatever the real template deterministically
// produces from ukSize/sku below — never hand-duplicated — so a fixture whose
// model/productType are already "clean" is a genuine full no-op, matching what
// the real generate/fields routes would have persisted at generation time.
function draftRow(overrides: Record<string, unknown> = {}) {
  const ukSize = (overrides.uk_size as string | undefined) ?? "3";
  const sku = (overrides.sku as string | undefined) ?? "1648";
  return {
    id: DRAFT_ID,
    brand: "Hoka", model: "Clifton 9 Youth", product_type: "Running Trainers",
    colours: ["Black", "Grey"], material: "Mesh", uk_size: ukSize, sku,
    vinted_audience: "womens",
    generated_title: 'Hoka Clifton 9 Youth Running Trainers - "Black & Grey" - Very Good Condition - Size UK 3',
    generated_description: generateListingDescription({ ukSize, sku }),
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear();
  supabaseRequestAll.mockReset();
  supabaseRequest.mockReset();
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("POST /api/listing-studio/groups/[draftId]/refresh-listing-text — existing-draft repair for children's wording in customer-facing text", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    expect(response.status).toBe(401);
  });

  it("404s for a draft that doesn't belong to this owner", async () => {
    supabaseRequestAll.mockResolvedValueOnce([]);
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("REGRESSION (the exact production example): a legacy 'Clifton 9 Youth' footwear/Women's draft is cleaned — model AND the regenerated title lose 'Youth'", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]);
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.changed).toBe(true);
    expect(body.model).toBe("Clifton 9");
    expect(body.generatedTitle).not.toMatch(/\bYouth\b/i);
    expect(body.generatedTitle).toBe('Hoka Clifton 9 Running Trainers - "Black & Grey" - Very Good Condition - Size UK 3');
  });

  it("persists ONLY model, product_type, generated_title, generated_description, updated_at — never SKU, size, colours, material, brand, audience, or category", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow()]);
    await refreshListingTextRoute(new Request("http://test"), params());
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(Object.keys(patchBody).sort()).toEqual(["generated_description", "generated_title", "model", "product_type", "updated_at"].sort());
  });

  it("preserves SKU, size, colours, material, brand, category, and audience exactly — they are read only to build the template, never touched or returned as changed", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ sku: "9999", uk_size: "3.5", colours: ["Navy"], material: "Suede", brand: "Hoka" })]);
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.generatedTitle).not.toContain("9999"); // SKU is never IN the title (sanity — title template doesn't include SKU)
    expect(body.generatedTitle).toContain("Size UK 3.5");
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody).not.toHaveProperty("sku");
    expect(patchBody).not.toHaveProperty("uk_size");
    expect(patchBody).not.toHaveProperty("colours");
    expect(patchBody).not.toHaveProperty("material");
    expect(patchBody).not.toHaveProperty("vinted_audience");
    expect(patchBody).not.toHaveProperty("vinted_category_id");
  });

  it("REGRESSION: an already-clean footwear/Women's draft is a genuine no-op — changed:false, and no PATCH is issued at all", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({
      model: "Clifton 9", generated_title: 'Hoka Clifton 9 Running Trainers - "Black & Grey" - Very Good Condition - Size UK 3',
    })]);
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.changed).toBe(false);
    expect(supabaseRequest.mock.calls.some(c => (c[1] as RequestInit)?.method === "PATCH")).toBe(false);
  });

  it("REGRESSION: non-footwear drafts are a no-op, even with children's wording in the model", async () => {
    const fields = { brand: "Hoka", model: "Girls Puffer", productType: "Jacket", colours: ["Black", "Grey"], material: "Mesh", ukSize: "3", sku: "1648" };
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ product_type: "Jacket", model: "Girls Puffer", generated_title: generateListingTitle(fields) })]);
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.changed).toBe(false);
    expect(body.model).toBe("Girls Puffer");
  });

  it("REGRESSION: Men's footwear drafts are a no-op, even with children's wording in the model", async () => {
    const fields = { brand: "Hoka", model: "Junior Racer", productType: "Running Trainers", colours: ["Black", "Grey"], material: "Mesh", ukSize: "3", sku: "1648" };
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "mens", model: "Junior Racer", generated_title: generateListingTitle(fields) })]);
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.changed).toBe(false);
    expect(body.model).toBe("Junior Racer");
  });

  it("also cleans a still-uncorrected Boys/Girls draft's text, using the EFFECTIVE (normalised) audience for gating, without itself writing vinted_audience", async () => {
    supabaseRequestAll.mockResolvedValueOnce([draftRow({ vinted_audience: "girls" })]);
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.changed).toBe(true);
    expect(body.model).toBe("Clifton 9");
    const patchCall = supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody).not.toHaveProperty("vinted_audience");
  });

  it("REGRESSION: no AI call is possible — this route imports no AI-calling module at all", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/groups/[draftId]/refresh-listing-text/route.ts", "utf8"));
    expect(source).not.toContain("listing-generation-ai");
    expect(source).not.toContain("vinted-category-selection-ai");
    expect(source).not.toContain("vinted-audience-reassessment-ai");
    expect(source).not.toContain("Anthropic");
  });

  it("catches everything through safeApiError", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await refreshListingTextRoute(new Request("http://test"), params());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});
