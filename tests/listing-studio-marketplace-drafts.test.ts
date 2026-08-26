import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(),
  supabaseRequestAll: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

import {
  listMarketplaceDraftsForProduct, listMarketplaceDraftsForProducts, getMarketplaceDraft,
  upsertMarketplaceDraft, patchMarketplaceDraft, deleteMarketplaceDraft,
} from "@/lib/listing-studio/marketplace-drafts";

const OWNER_ID = "owner-1";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1", product_draft_id: PRODUCT_ID, owner_id: OWNER_ID, marketplace: "EBAY_UK",
    source_type: "generated", content_mode: "seo_optimised",
    title: "Nike Trainers", description: "A pair of trainers.",
    category_id: null, category_name: null, category_path: null, category_source: null, category_confidence: null,
    condition_value: null,
    price_pence: 2000, quantity: 1, currency: "GBP",
    status: "needs_information",
    readiness_json: { ready: false, completionPercent: 50, requiredComplete: 4, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
    validation_messages_json: [], ai_generation_json: null,
    source_draft_id: null, source_ebay_item_id: null,
    dynamic_data_json: {}, settings_json: {},
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
});

describe("row <-> domain mapping", () => {
  it("maps every column to its camelCase domain field", async () => {
    supabaseRequestAll.mockResolvedValue([row()]);
    const [draft] = await listMarketplaceDraftsForProduct(OWNER_ID, PRODUCT_ID);
    expect(draft).toMatchObject({
      id: "draft-1", productDraftId: PRODUCT_ID, ownerId: OWNER_ID, marketplace: "EBAY_UK",
      sourceType: "generated", contentMode: "seo_optimised", title: "Nike Trainers",
      pricePence: 2000, quantity: 1, currency: "GBP", status: "needs_information",
    });
    expect(draft.readiness.ready).toBe(false);
  });

  it("REGRESSION: a brand-new row with an empty readiness_json ('{}') never crashes and reports a safe not-ready default", async () => {
    supabaseRequestAll.mockResolvedValue([row({ readiness_json: {} })]);
    const [draft] = await listMarketplaceDraftsForProduct(OWNER_ID, PRODUCT_ID);
    expect(draft.readiness).toEqual({ ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 0, recommendedComplete: 0, recommendedTotal: 0 });
  });

  it("getMarketplaceDraft returns null when no row matches, never throws", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    expect(await getMarketplaceDraft(OWNER_ID, PRODUCT_ID, "EBAY_UK")).toBeNull();
  });

  it("listMarketplaceDraftsForProducts groups rows by their product id", async () => {
    supabaseRequestAll.mockResolvedValue([row({ product_draft_id: "a" }), row({ product_draft_id: "b" }), row({ product_draft_id: "a", marketplace: "VINTED" })]);
    const grouped = await listMarketplaceDraftsForProducts(OWNER_ID, ["a", "b"]);
    expect(grouped.get("a")).toHaveLength(2);
    expect(grouped.get("b")).toHaveLength(1);
  });

  it("listMarketplaceDraftsForProducts returns an empty map without a request when given no product ids", async () => {
    const grouped = await listMarketplaceDraftsForProducts(OWNER_ID, []);
    expect(grouped.size).toBe(0);
    expect(supabaseRequestAll).not.toHaveBeenCalled();
  });
});

describe("upsertMarketplaceDraft — idempotent create-or-update", () => {
  it("REQUIREMENT: upserts on the (product_draft_id, marketplace) unique constraint, never a plain insert", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ id: "draft-1" }]), { status: 201 }));
    const id = await upsertMarketplaceDraft({
      productDraftId: PRODUCT_ID, ownerId: OWNER_ID, marketplace: "EBAY_UK",
      sourceType: "generated", contentMode: "seo_optimised",
      status: "needs_information", readiness: { ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
      validationMessages: [],
    });
    expect(id).toBe("draft-1");
    const [path, init] = supabaseRequest.mock.calls[0];
    expect(path).toContain("on_conflict=product_draft_id,marketplace");
    expect((init as RequestInit).headers).toMatchObject({ Prefer: "resolution=merge-duplicates,return=representation" });
  });

  it("REGRESSION: a field left undefined is never sent, so a retried request never clobbers an already-set value with null", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ id: "draft-1" }]), { status: 201 }));
    await upsertMarketplaceDraft({
      productDraftId: PRODUCT_ID, ownerId: OWNER_ID, marketplace: "EBAY_UK",
      sourceType: "generated", contentMode: "seo_optimised",
      status: "needs_information", readiness: { ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
      validationMessages: [],
      // title/description/category* deliberately omitted
    });
    const body = JSON.parse((supabaseRequest.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("category_id");
  });

  it("throws a clear error if the upsert somehow returns no row", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([]), { status: 201 }));
    await expect(upsertMarketplaceDraft({
      productDraftId: PRODUCT_ID, ownerId: OWNER_ID, marketplace: "EBAY_UK",
      sourceType: "generated", contentMode: "seo_optimised",
      status: "draft", readiness: { ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 0, recommendedComplete: 0, recommendedTotal: 0 },
      validationMessages: [],
    })).rejects.toThrow();
  });
});

describe("patchMarketplaceDraft / deleteMarketplaceDraft", () => {
  it("patch always stamps updated_at and scopes by both id and owner_id", async () => {
    supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
    await patchMarketplaceDraft(OWNER_ID, "draft-1", { title: "New title" });
    const [path, init] = supabaseRequest.mock.calls[0];
    expect(path).toContain(`id=eq.draft-1`);
    expect(path).toContain(`owner_id=eq.${OWNER_ID}`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.title).toBe("New title");
    expect(body.updated_at).toBeTruthy();
  });

  it("delete scopes by both id and owner_id, never a bare id-only delete", async () => {
    supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteMarketplaceDraft(OWNER_ID, "draft-1");
    const [path] = supabaseRequest.mock.calls[0];
    expect(path).toContain(`id=eq.draft-1`);
    expect(path).toContain(`owner_id=eq.${OWNER_ID}`);
  });
});
