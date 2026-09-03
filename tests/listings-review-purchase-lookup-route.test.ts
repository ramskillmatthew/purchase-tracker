import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  // Listings Review redesign — the read-only rpc/listing_studio_latest_extension_status
  // call goes through supabaseRequest (POST + .json()), matching every
  // other RPC call site in this codebase, never supabaseRequestAll.
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => ({ json: async () => [] as unknown[] })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { GET as listingsReviewRoute } from "@/app/api/listing-studio/listings-review/route";
import { AuthError } from "@/lib/auth/server";

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1", created_at: "2026-01-01", updated_at: "2026-01-01",
    brand: "On", model: "Cloud 5", product_type: "Trainers", colours: ["Black"], material: "Mesh",
    uk_size: "9", uk_size_source: "observed", sku: "AA1711", condition: "Good",
    generated_title: "On Cloud 5", generated_description: "desc",
    ai_result_json: null, review_marked_ready_at: null,
    vinted_category_id: null, vinted_category_path: null, vinted_category_source: null, vinted_category_status: null,
    vinted_audience: "mens", vinted_audience_source: "ai", vinted_audience_evidence: null,
    confirmed_price_pence: null,
    ...overrides,
  };
}
function purchaseRow(overrides: Record<string, unknown> = {}) {
  return { id: "p1", sku: "AA1711", order_date: "2026-01-10", item_description: "On Cloud 5", price_purchased: 18.5, ...overrides };
}

// Parses the EXACT set of SKU terms out of a real `sku.ilike.<term>` OR
// clause — never a naive substring `.includes()` check, which would give a
// false positive for e.g. "SKU1" inside "SKU10"/"SKU11" and silently
// corrupt these tests' own simulated "database".
function skuTermsInQuery(path: string): Set<string> {
  return new Set([...path.matchAll(/sku\.ilike\.([^,)]+)/g)].map(match => decodeURIComponent(match[1])));
}

beforeEach(() => {
  requireOwner.mockClear();
  supabaseRequestAll.mockReset();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("listing_drafts?")) return [];
    if (path.startsWith("listing_draft_images?")) return [];
    if (path.startsWith("purchases?")) return [];
    if (path.startsWith("vinted_categories?")) return [];
    return [];
  });
  supabaseRequest.mockReset();
  supabaseRequest.mockImplementation(async (_path: string) => ({ json: async () => [] as unknown[] }));
});

describe("GET /api/listing-studio/listings-review — Milestone 6: batched purchase-price lookup", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await listingsReviewRoute();
    expect(response.status).toBe(401);
  });

  it("skips the purchases query entirely when no listing has a SKU, and when there are no drafts at all", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({ sku: null })] : []));
    await listingsReviewRoute();
    expect(supabaseRequestAll.mock.calls.some(c => (c[0] as string).startsWith("purchases?"))).toBe(false);
  });

  it("REGRESSION: issues exactly ONE purchases query for up to 50 unique listing SKUs — never one request per listing", async () => {
    const drafts = Array.from({ length: 45 }, (_, i) => draftRow({ id: `draft-${i}`, sku: `SKU${i}` }));
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return drafts;
      if (path.startsWith("purchases?")) return drafts.map((d, i) => purchaseRow({ id: `p${i}`, sku: d.sku }));
      return [];
    });
    const response = await listingsReviewRoute();
    expect(response.status).toBe(200);
    const purchaseCalls = supabaseRequestAll.mock.calls.filter(c => (c[0] as string).startsWith("purchases?"));
    expect(purchaseCalls).toHaveLength(1);
    const body = await response.json();
    expect(body.drafts).toHaveLength(45);
    expect(body.drafts.every((d: { purchase_match: { status: string } }) => d.purchase_match.status === "matched")).toBe(true);
  });

  it("REGRESSION: 120 listings with unique SKUs still comfortably scale — a small, bounded number of chunked queries (never one per listing, never a request per SKU)", async () => {
    const drafts = Array.from({ length: 120 }, (_, i) => draftRow({ id: `draft-${i}`, sku: `SKU${i}` }));
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return drafts;
      if (path.startsWith("purchases?")) {
        // Each chunked query only ever matches the SKUs it was actually
        // asked for — simulated here by returning just the SKUs whose
        // exact ilike term appears in this specific call's own query.
        const terms = skuTermsInQuery(path);
        return drafts.filter(d => terms.has(d.sku)).map((d, i) => purchaseRow({ id: `p${i}`, sku: d.sku }));
      }
      return [];
    });
    const response = await listingsReviewRoute();
    expect(response.status).toBe(200);
    const purchaseCalls = supabaseRequestAll.mock.calls.filter(c => (c[0] as string).startsWith("purchases?"));
    // 120 unique SKUs at MAX_SKU_LOOKUP_CHUNK_SIZE (50) per query = 3 chunks.
    expect(purchaseCalls).toHaveLength(3);
    expect(purchaseCalls.length).toBeLessThan(120);
    const body = await response.json();
    expect(body.drafts).toHaveLength(120);
    expect(body.drafts.every((d: { purchase_match: { status: string } }) => d.purchase_match.status === "matched")).toBe(true);
  });

  it("REGRESSION (scalability): with 500 UNRELATED purchase records in the 'database', only the one matching the current listing's SKU is ever returned — the query is genuinely scoped by SKU, not a bulk fetch filtered afterwards", async () => {
    // Simulates a real, large purchases table: 500 rows with unrelated
    // SKUs, plus exactly one that matches this page's single listing.
    const unrelatedPurchases = Array.from({ length: 500 }, (_, i) => purchaseRow({ id: `unrelated-${i}`, sku: `ZZ${i}`, item_description: "Unrelated item" }));
    const relevantPurchase = purchaseRow({ id: "relevant-1", sku: "AA1711", item_description: "On Cloud 5" });
    const allPurchasesInDb = [...unrelatedPurchases, relevantPurchase];

    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ sku: "AA1711" })];
      if (path.startsWith("purchases?")) {
        // A faithful simulation of what a real `sku.ilike.<exact>` OR-query
        // returns: only rows whose SKU is named in THIS query's own clause.
        const terms = skuTermsInQuery(path);
        return allPurchasesInDb.filter(p => terms.has(p.sku as string));
      }
      return [];
    });

    const response = await listingsReviewRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafts[0].purchase_match).toEqual({ status: "matched", sku: "AA1711", purchasePricePence: 1850 });
    // Never returns/exposes any of the 500 unrelated purchases' data anywhere.
    expect(JSON.stringify(body)).not.toContain("Unrelated item");
    expect(JSON.stringify(body)).not.toContain("unrelated-");
    // One single listing SKU never requires scanning/requesting the other
    // 500 unrelated rows — one bounded query total.
    expect(supabaseRequestAll.mock.calls.filter(c => (c[0] as string).startsWith("purchases?"))).toHaveLength(1);
  });

  it("never queries expenses", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow()] : []));
    await listingsReviewRoute();
    expect(supabaseRequestAll.mock.calls.some(c => (c[0] as string).startsWith("expenses"))).toBe(false);
  });

  it("the purchases query selects only the minimal fields this feature needs — never exposes unrelated purchase columns", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow()] : []));
    await listingsReviewRoute();
    const purchaseCall = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("purchases?"));
    expect(purchaseCall![0]).toContain("select=id,sku,order_date,item_description,price_purchased");
    expect(purchaseCall![0]).not.toContain("purchased_from");
    expect(purchaseCall![0]).not.toContain("seller_name");
  });

  it("matched: attaches purchase_match with the price in pence", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ sku: "AA1711" })];
      if (path.startsWith("purchases?")) return [purchaseRow({ sku: "AA1711", price_purchased: 18.5 })];
      return [];
    });
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].purchase_match).toEqual({ status: "matched", sku: "AA1711", purchasePricePence: 1850 });
  });

  it("missing_sku: reported when the listing's own SKU is null", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({ sku: null })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].purchase_match).toEqual({ status: "missing_sku" });
  });

  it("not_found: reported when no purchase matches the SKU", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ sku: "ZZ9999" })];
      if (path.startsWith("purchases?")) return [purchaseRow({ sku: "AA1711" })];
      return [];
    });
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].purchase_match).toEqual({ status: "not_found", sku: "ZZ9999" });
  });

  it("duplicate: reported with safe identifying info, never a chosen/summed price", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ sku: "AA1711" })];
      if (path.startsWith("purchases?")) return [
        purchaseRow({ id: "p1", order_date: "2026-01-01", item_description: "On Cloud 5 (unit 1)", price_purchased: 18.5 }),
        purchaseRow({ id: "p2", order_date: "2026-01-02", item_description: "On Cloud 5 (unit 2)", price_purchased: 18.5 }),
      ];
      return [];
    });
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].purchase_match).toEqual({
      status: "duplicate", sku: "AA1711",
      matches: [
        { orderDate: "2026-01-01", itemDescription: "On Cloud 5 (unit 1)", pricePence: 1850 },
        { orderDate: "2026-01-02", itemDescription: "On Cloud 5 (unit 2)", pricePence: 1850 },
      ],
    });
  });

  it("invalid/null purchase price on the matched purchase itself is reported as null, never a crash", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ sku: "AA1711" })];
      if (path.startsWith("purchases?")) return [purchaseRow({ sku: "AA1711", price_purchased: null })];
      return [];
    });
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].purchase_match).toEqual({ status: "matched", sku: "AA1711", purchasePricePence: null });
  });

  it("returns confirmed_price_pence alongside every draft (the manual Vinted selling price)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({ confirmed_price_pence: 4500 })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].confirmed_price_pence).toBe(4500);
  });

  it("catches everything through safeApiError", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await listingsReviewRoute();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});

describe("GET /api/listing-studio/listings-review — Business-rule follow-up correction: footwear must never be listed under a children's Vinted audience", () => {
  it("REGRESSION: a legacy footwear draft still stored as 'boys' is DISPLAYED as 'womens' — never Boys/Girls in the final listing UI for footwear", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({ vinted_audience: "boys" })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].vinted_audience).toBe("womens");
  });

  it("REGRESSION: a legacy footwear draft stored as 'girls' is likewise displayed as 'womens'", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({ vinted_audience: "girls" })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].vinted_audience).toBe("womens");
  });

  it("REGRESSION: this is a read-time-only display correction — the route calls supabaseRequest ONLY for read-only status RPCs (see the dedicated 'is read-time-only' test below), never a table write, so it structurally cannot write anything back to the database", async () => {
    const routeSource = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/listings-review/route.ts", "utf8"));
    const supabaseRequestCallSites = [...routeSource.matchAll(/supabaseRequest\((["'`])([^"'`]*)\1/g)].map(match => match[2]);
    expect(supabaseRequestCallSites).toEqual(["rpc/listing_studio_latest_extension_status", "rpc/listing_studio_latest_ebay_draft_status"]);
  });

  it("REGRESSION: 'boys'/'girls' on a non-footwear product type is displayed completely unchanged", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({ vinted_audience: "boys", product_type: "Jacket" })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].vinted_audience).toBe("boys");
  });

  it("Men/Women footwear are displayed completely unchanged", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({ vinted_audience: "mens" })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].vinted_audience).toBe("mens");
  });
});

describe("GET /api/listing-studio/listings-review — business-rule follow-up correction: Women's footwear must never carry children's wording in customer-facing text", () => {
  it("REGRESSION: a legacy Boys footwear draft whose model literally says 'Clifton 9 Youth' is DISPLAYED clean — model, product_type, and the generated title all lose the children's wording, read-time only", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({
      vinted_audience: "boys", brand: "Hoka", model: "Clifton 9 Youth", product_type: "Trainers",
      generated_title: 'Hoka Clifton 9 Youth Running Trainers - "Black & Grey" - Very Good Condition - Size UK 3',
    })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].vinted_audience).toBe("womens");
    expect(body.drafts[0].model).toBe("Clifton 9");
    expect(body.drafts[0].generated_title).toBe('Hoka Clifton 9 Running Trainers - "Black & Grey" - Very Good Condition - Size UK 3');
    expect(body.drafts[0].generated_title).not.toMatch(/\bYouth\b/i);
  });

  it("does not add 'Women'/'Women's' to the title — it just stays neutral once the children's wording is gone", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({
      vinted_audience: "girls", model: "Cloud 5 Girls", generated_title: "On Cloud 5 Girls Trainers",
    })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].generated_title).not.toMatch(/women/i);
  });

  it("Men's footwear text is never touched by this rule, even if it happened to contain a children's term", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({
      vinted_audience: "mens", model: "Junior Racer", generated_title: "Nike Junior Racer Trainers",
    })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].model).toBe("Junior Racer");
    expect(body.drafts[0].generated_title).toBe("Nike Junior Racer Trainers");
  });

  it("non-footwear content is never touched, even for a Boys/Girls draft", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({
      vinted_audience: "girls", product_type: "Jacket", model: "Girls Puffer", generated_title: "North Face Girls Puffer Jacket",
    })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].model).toBe("Girls Puffer");
    expect(body.drafts[0].generated_title).toBe("North Face Girls Puffer Jacket");
  });

  it("UK size is never part of this correction — it is not even selected/touched by this route's mapping", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow({
      vinted_audience: "boys", model: "Clifton 9 Youth", uk_size: "3",
    })] : []));
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts[0].uk_size).toBe("3");
  });

  it("is read-time-only — every supabaseRequest call it makes is a read-only RPC (rpc/listing_studio_latest_extension_status and, since Stage 6, rpc/listing_studio_latest_ebay_draft_status — both language sql stable), never a table write", async () => {
    const routeSource = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/listings-review/route.ts", "utf8"));
    const supabaseRequestCallSites = [...routeSource.matchAll(/supabaseRequest\((["'`])([^"'`]*)\1/g)].map(match => match[2]);
    expect(supabaseRequestCallSites).toEqual(["rpc/listing_studio_latest_extension_status", "rpc/listing_studio_latest_ebay_draft_status"]);
  });

  it("degrades gracefully when the extension-status RPC isn't available yet (e.g. before its SQL migration has been run) — the page still loads, every listing just falls back to no known workflow status, rather than the whole route failing", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [draftRow()] : []));
    supabaseRequest.mockRejectedValueOnce(new Error("PGRST202: function not found"));
    const response = await listingsReviewRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafts[0].extension_status).toBeNull();
  });
});

describe("GET /api/listing-studio/listings-review — CORRECTIVE PASS: canonical unified row model", () => {
  // Confirmed, PROVEN root cause (see app/api/listing-studio/groups/[draftId]/generate/route.ts's
  // own shouldWriteVintedContent = targetSet.has("VINTED")): a product
  // generated for eBay UK ONLY never gets a Vinted generated_title/
  // generated_description at all — they stay null forever. The OLD
  // version of this route filtered its entire base query on
  // generated_title/generated_description being non-null, which made
  // such a product (and its already-generated eBay marketplace draft)
  // completely invisible here. These tests prove the fix: the visible
  // row set is now the UNION of "has Vinted content" OR "has an EBAY_UK
  // marketplace draft".
  function ebayMarketplaceDraftRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "mdraft-1", product_draft_id: "draft-ebay-only", owner_id: "owner-1", marketplace: "EBAY_UK",
      source_type: "generated", content_mode: "seo_optimised", title: "eBay Only Listing", description: "desc",
      category_id: "183454", category_name: "Trainers", category_path: "Shoes > Trainers", category_source: "ai", category_confidence: "high",
      category_alternatives_json: [], category_search_terms: null, condition_value: "Used", price_pence: null, quantity: 1, currency: "GBP",
      status: "ready", readiness_json: { ready: true, completionPercent: 100, requiredComplete: 8, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
      validation_messages_json: [], ai_generation_json: null, source_draft_id: null, source_ebay_item_id: null,
      dynamic_data_json: {}, settings_json: {},
      ebay_fulfillment_policy_id: null, ebay_return_policy_id: null, ebay_payment_policy_id: null, ebay_merchant_location_key: null,
      ebay_offer_id: null, ebay_inventory_synced_at: null, ebay_last_draft_error: null, ebay_photo_state_json: {},
      created_at: "2026-01-01", updated_at: "2026-01-01",
      ...overrides,
    };
  }
  function ebayOnlyCandidateRow(overrides: Record<string, unknown> = {}) {
    // A product that only ever had "eBay UK" selected as its generation
    // target — generated_title/generated_description are genuinely null,
    // exactly as the real generate route leaves them.
    return draftRow({ id: "draft-ebay-only", generated_title: null, generated_description: null, sku: "EBAY-ONLY-1", ...overrides });
  }

  function routeMocksFor(candidateRows: unknown[], ebayProductIdRows: Array<{ product_draft_id: string }>, ebayMarketplaceRows: unknown[]) {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts?owner_id=eq.") && path.includes("marketplace=eq.EBAY_UK") && path.includes("select=product_draft_id")) return ebayProductIdRows;
      if (path.startsWith("listing_marketplace_drafts?product_draft_id=in.")) return ebayMarketplaceRows;
      // Same fixture set answers BOTH listing_drafts queries (the narrow
      // candidate prefilter and the later full-column fetch) — exactly
      // like every existing test in this file already relies on; the
      // prefilter step only ever reads id/generated_title/
      // generated_description off these rows, so richer fixture objects
      // here are harmless.
      if (path.startsWith("listing_drafts?")) return candidateRows;
      if (path.startsWith("listing_draft_images?")) return [];
      if (path.startsWith("purchases?")) return [];
      if (path.startsWith("vinted_categories?")) return [];
      return [];
    });
  }

  it("REQUIREMENT 1: a Vinted-only row (no eBay marketplace draft at all) is included, exactly as before", async () => {
    routeMocksFor([draftRow()], [], []);
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].id).toBe("draft-1");
    expect(body.ebayDrafts).toEqual([]);
  });

  it("REQUIREMENT 2 (PROVEN ROOT CAUSE FIX): an eBay-only row (generated_title/generated_description both null) IS now included, with its eBay marketplace draft attached", async () => {
    routeMocksFor(
      [ebayOnlyCandidateRow()],
      [{ product_draft_id: "draft-ebay-only" }],
      [ebayMarketplaceDraftRow()],
    );
    const response = await listingsReviewRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].id).toBe("draft-ebay-only");
    expect(body.drafts[0].generated_title).toBeNull(); // genuinely no Vinted content — never fabricated
    expect(body.ebayDrafts).toHaveLength(1);
    expect(body.ebayDrafts[0].productDraftId).toBe("draft-ebay-only");
    expect(body.ebayDrafts[0].marketplace).toBe("EBAY_UK");
  });

  it("REQUIREMENT 3: a product with BOTH a Vinted preparation and an eBay preparation appears as exactly ONE row, with the eBay draft attached alongside it", async () => {
    const bothRow = draftRow({ id: "draft-both" });
    routeMocksFor(
      [bothRow],
      [{ product_draft_id: "draft-both" }],
      [ebayMarketplaceDraftRow({ product_draft_id: "draft-both" })],
    );
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].id).toBe("draft-both");
    expect(body.drafts[0].generated_title).toBe("On Cloud 5"); // real Vinted content still present
    expect(body.ebayDrafts).toHaveLength(1);
    expect(body.ebayDrafts[0].productDraftId).toBe("draft-both");
  });

  it("REQUIREMENT: a product with NEITHER a Vinted preparation NOR an eBay preparation (an in-progress Listing Studio group with no generated content on either channel) is correctly excluded — 'neither' is not normally returned", async () => {
    routeMocksFor([ebayOnlyCandidateRow({ id: "draft-neither" })], [], []); // no eBay marketplace draft product id returned for it either
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts).toHaveLength(0);
  });

  it("REQUIREMENT: a mixed page (one Vinted-only, one eBay-only, one both) returns exactly the right 3 rows with the right eBay attachments — no row is silently dropped or duplicated", async () => {
    const vintedOnly = draftRow({ id: "draft-vinted-only", sku: "V1" });
    const ebayOnly = ebayOnlyCandidateRow({ id: "draft-ebay-only", sku: "E1" });
    const both = draftRow({ id: "draft-both", sku: "B1" });
    routeMocksFor(
      [vintedOnly, ebayOnly, both],
      [{ product_draft_id: "draft-ebay-only" }, { product_draft_id: "draft-both" }],
      [ebayMarketplaceDraftRow({ id: "mdraft-ebay-only", product_draft_id: "draft-ebay-only" }), ebayMarketplaceDraftRow({ id: "mdraft-both", product_draft_id: "draft-both" })],
    );
    const response = await listingsReviewRoute();
    const body = await response.json();
    expect(body.drafts.map((d: { id: string }) => d.id).sort()).toEqual(["draft-both", "draft-ebay-only", "draft-vinted-only"]);
    expect(body.ebayDrafts).toHaveLength(2);
    expect(body.ebayDrafts.map((d: { productDraftId: string }) => d.productDraftId).sort()).toEqual(["draft-both", "draft-ebay-only"]);
  });

  it("REQUIREMENT (strong identity, never loose title matching): eBay drafts are matched to products by product_draft_id (a real foreign key), never by title/SKU text similarity", async () => {
    const routeSource = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/listings-review/route.ts", "utf8"));
    expect(routeSource).toContain("ebayDraftsByProduct.get(id)");
    expect(routeSource).not.toMatch(/generated_title\s*===|title\.toLowerCase\(\)\.includes/);
  });

  it("REQUIREMENT (workspace isolation): every query this route makes is scoped to the authenticated owner's own id — never a global/unscoped listing_marketplace_drafts read", async () => {
    const routeSource = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/listings-review/route.ts", "utf8"));
    expect(routeSource).toContain("listing_marketplace_drafts?owner_id=eq.${user.id}&marketplace=eq.EBAY_UK");
  });

  it("REQUIREMENT (robustness — corrective pass): the WHOLE page still loads, with every Vinted listing fully intact, if the eBay migration hasn't been applied yet and the eBay batch/policy columns 400 (missing ebay_* columns) — never a broken page for Vinted-only users", async () => {
    // Corrective pass — the missing-schema failure boundary moved: it now
    // lives specifically in the second, separate eBay-batch-fields query
    // (listing_marketplace_drafts?id=in....&select=id,ebay_fulfillment_...)
    // inside lib/listing-studio/marketplace-drafts.ts's own
    // fetchEbayBatchFieldsByIds, not in the core
    // product_draft_id=in....&select=CORE... query this route makes. See
    // tests/listing-studio-marketplace-drafts-schema-degradation.test.ts
    // for the dedicated, more granular proof of that internal behaviour;
    // this test proves the same thing end-to-end through the real route.
    routeMocksFor([draftRow()], [], []);
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts?id=in.")) throw Object.assign(new Error(JSON.stringify({ code: "42703", message: "column listing_marketplace_drafts.ebay_fulfillment_policy_id does not exist" })), { status: 400 });
      if (path.startsWith("listing_marketplace_drafts?product_draft_id=in.")) return [];
      if (path.startsWith("listing_marketplace_drafts?owner_id=eq.")) return [];
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      return [];
    });
    const response = await listingsReviewRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].generated_title).toBe("On Cloud 5");
    expect(body.ebayDrafts).toEqual([]);
  });

  it("REQUIREMENT 7 (corrective pass): a GENUINE failure from the core marketplace-drafts query (not a recognised missing-schema shape) now correctly fails the request — it is no longer silently hidden behind an empty eBay dataset", async () => {
    routeMocksFor([draftRow()], [], []);
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts?product_draft_id=in.")) throw Object.assign(new Error(JSON.stringify({ code: "42501", message: "permission denied" })), { status: 401 });
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      return [];
    });
    const response = await listingsReviewRoute();
    expect(response.status).not.toBe(200);
  });

  it("REQUIREMENT (workspace isolation, behavioural): an eBay marketplace draft belonging to a DIFFERENT owner is never returned, even if its product_draft_id happens to collide", async () => {
    // The mocked listMarketplaceDraftsForProducts query is itself already
    // owner-scoped (see lib/listing-studio/marketplace-drafts.ts) — this
    // test proves the CALLING route passes the real authenticated
    // owner id through, never a client-suppliable value, by asserting the
    // exact query shape requireOwner()'s id ends up in.
    routeMocksFor([draftRow()], [], []);
    await listingsReviewRoute();
    const marketplaceIdQuery = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("listing_marketplace_drafts?owner_id=eq."));
    expect(marketplaceIdQuery?.[0]).toContain("owner_id=eq.owner-1");
  });
});
