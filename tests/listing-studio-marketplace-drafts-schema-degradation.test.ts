import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequestAll } = vi.hoisted(() => ({ supabaseRequestAll: vi.fn() }));
vi.mock("@/lib/supabase", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase")>("@/lib/supabase");
  return { ...actual, supabaseRequestAll, supabaseRequest: vi.fn() };
});

import { listMarketplaceDraftsForProduct, listMarketplaceDraftsForProducts, getMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";

/**
 * Corrective pass — proves the root-cause fix for "an eBay marketplace
 * draft with real, already-generated content silently vanished from
 * Listings Review whenever supabase-ebay-draft-batches.sql hadn't been
 * applied". Distinguishes the two queries listMarketplaceDraftsForProducts
 * now makes (core columns vs. the Stage 6 batch/policy columns) by
 * inspecting the actual request path, not by call order — so these tests
 * exercise the real branching logic, not an assumption about call sequence.
 */
function missingColumnError(): Error & { status: number } {
  const error = new Error(JSON.stringify({ code: "42703", message: "column listing_marketplace_drafts.ebay_fulfillment_policy_id does not exist" })) as Error & { status: number };
  error.status = 400;
  return error;
}
function missingTableError(): Error & { status: number } {
  const error = new Error(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.ebay_draft_batches' in the schema cache" })) as Error & { status: number };
  error.status = 404;
  return error;
}
function authError(): Error & { status: number } {
  const error = new Error(JSON.stringify({ code: "42501", message: "permission denied for table listing_marketplace_drafts" })) as Error & { status: number };
  error.status = 401;
  return error;
}

const OWNER_ID = "owner-1";
const PRODUCT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const PRODUCT_B = "bbbbbbbb-1111-4111-8111-111111111111";

function coreRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1", product_draft_id: PRODUCT_A, owner_id: OWNER_ID, marketplace: "EBAY_UK",
    source_type: "generated", content_mode: "seo_optimised",
    title: "On Running Cloud 5", description: "A real, already-generated description.",
    category_id: "95672", category_name: "Trainers", category_path: "Trainers > Shoes", category_source: "ai", category_confidence: "medium",
    category_alternatives_json: [], category_search_terms: null,
    condition_value: "Used - Very Good",
    price_pence: 3500, quantity: 1, currency: "GBP",
    status: "ready",
    readiness_json: { ready: true, completionPercent: 72, requiredComplete: 9, requiredTotal: 9, recommendedComplete: 9, recommendedTotal: 16 },
    validation_messages_json: [], ai_generation_json: null,
    source_draft_id: null, source_ebay_item_id: null,
    dynamic_data_json: {}, settings_json: {},
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}
const isEbayFieldsQuery = (path: string) => path.includes("ebay_fulfillment_policy_id");

beforeEach(() => { supabaseRequestAll.mockReset(); });

describe("CORRECTIVE PASS — eBay draft visibility survives a missing batch migration", () => {
  it("REQUIREMENT 1: core eBay draft content (title/description/category/condition/price) is returned in full even when every optional batch column is absent", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) throw missingColumnError();
      return [coreRow()];
    });
    const drafts = await listMarketplaceDraftsForProduct(OWNER_ID, PRODUCT_A);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      title: "On Running Cloud 5", description: "A real, already-generated description.",
      categoryName: "Trainers", conditionValue: "Used - Very Good", pricePence: 3500,
    });
    expect(drafts[0].readiness.ready).toBe(true);
    // The migration-dependent fields degrade to their safe defaults —
    // never undefined, never a crash, never removed from the row shape.
    expect(drafts[0].ebayFulfillmentPolicyId).toBeNull();
    expect(drafts[0].ebayOfferId).toBeNull();
    expect(drafts[0].ebayPhotoState).toEqual({});
  });

  it("REQUIREMENT 1b: also degrades safely when the whole batch TABLE is missing (PGRST205), not just a column", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) throw missingTableError();
      return [coreRow()];
    });
    const draft = await getMarketplaceDraft(OWNER_ID, PRODUCT_A, "EBAY_UK");
    expect(draft?.title).toBe("On Running Cloud 5");
    expect(draft?.ebayReturnPolicyId).toBeNull();
  });

  it("REQUIREMENT 7: an unexpected error from the eBay-fields query (not a recognised missing-schema shape) is never silently converted into empty defaults — it propagates", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) throw authError();
      return [coreRow()];
    });
    await expect(getMarketplaceDraft(OWNER_ID, PRODUCT_A, "EBAY_UK")).rejects.toThrow();
  });

  it("REQUIREMENT 7b: an unexpected error from the CORE query also propagates — this was never wrapped in a fallback and still isn't", async () => {
    supabaseRequestAll.mockImplementation(async () => { throw authError(); });
    await expect(getMarketplaceDraft(OWNER_ID, PRODUCT_A, "EBAY_UK")).rejects.toThrow();
  });

  it("REQUIREMENT 3: an eBay-only product (no Vinted title/description at all) is still returned in full — this function has no dependency on Vinted content existing", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) return [{ id: "draft-2", ebay_fulfillment_policy_id: "251948545024", ebay_return_policy_id: null, ebay_payment_policy_id: null, ebay_merchant_location_key: null, ebay_offer_id: null, ebay_inventory_synced_at: null, ebay_last_draft_error: null, ebay_photo_state_json: {} }];
      return [coreRow({ id: "draft-2" })];
    });
    const draft = await getMarketplaceDraft(OWNER_ID, PRODUCT_A, "EBAY_UK");
    // The marketplace draft itself never carries Vinted title/description
    // (those live on listing_drafts, a separate table/row entirely) — this
    // proves the eBay row's OWN content and its batch fields both survive
    // together once the migration IS applied.
    expect(draft?.title).toBe("On Running Cloud 5");
    expect(draft?.ebayFulfillmentPolicyId).toBe("251948545024");
  });

  it("REQUIREMENT 2 + N+1 guard: listMarketplaceDraftsForProducts fetches core rows for every requested product in ONE query and eBay fields in exactly ONE more — never one query per row", async () => {
    let coreCalls = 0; let ebayFieldCalls = 0;
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) { ebayFieldCalls += 1; return []; }
      coreCalls += 1;
      return [coreRow({ id: "draft-a", product_draft_id: PRODUCT_A }), coreRow({ id: "draft-b", product_draft_id: PRODUCT_B, marketplace: "VINTED" })];
    });
    const grouped = await listMarketplaceDraftsForProducts(OWNER_ID, [PRODUCT_A, PRODUCT_B]);
    expect(coreCalls).toBe(1);
    expect(ebayFieldCalls).toBe(1);
    expect(grouped.get(PRODUCT_A)).toHaveLength(1);
    expect(grouped.get(PRODUCT_B)).toHaveLength(1);
  });

  it("REQUIREMENT 2b: a dual-prepared product's eBay row correctly carries its own real batch/policy fields once the migration IS applied (proves the merge path, not just the degrade path)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) return [{ id: "draft-1", ebay_fulfillment_policy_id: "251948545024", ebay_return_policy_id: "248160090024", ebay_payment_policy_id: "248160067024", ebay_merchant_location_key: null, ebay_offer_id: null, ebay_inventory_synced_at: null, ebay_last_draft_error: null, ebay_photo_state_json: { "img-1": { status: "uploaded", checkedAt: "2026-09-01T00:00:00.000Z" } } }];
      return [coreRow()];
    });
    const draft = await getMarketplaceDraft(OWNER_ID, PRODUCT_A, "EBAY_UK");
    expect(draft).toMatchObject({
      title: "On Running Cloud 5",
      ebayFulfillmentPolicyId: "251948545024", ebayReturnPolicyId: "248160090024", ebayPaymentPolicyId: "248160067024",
    });
    expect(draft?.ebayPhotoState).toEqual({ "img-1": { status: "uploaded", checkedAt: "2026-09-01T00:00:00.000Z" } });
  });

  it("REQUIREMENT 4: a Vinted-only row (no eBay marketplace draft exists at all for this product) is simply absent from the result — never a crash, never a phantom eBay entry", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) return [];
      return [coreRow({ marketplace: "VINTED" })];
    });
    const drafts = await listMarketplaceDraftsForProduct(OWNER_ID, PRODUCT_A);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].marketplace).toBe("VINTED");
  });

  it("skips the eBay-fields query entirely when there are no core rows to enrich (no wasted request)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (isEbayFieldsQuery(path)) throw new Error("should never be called with zero ids");
      return [];
    });
    const draft = await getMarketplaceDraft(OWNER_ID, PRODUCT_A, "EBAY_UK");
    expect(draft).toBeNull();
  });
});
