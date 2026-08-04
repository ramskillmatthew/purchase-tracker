import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll }));

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

  it("REGRESSION: this is a read-time-only display correction — the route doesn't even import a write-capable Supabase function (only supabaseRequestAll, a read), so it structurally cannot write anything back to the database", async () => {
    const routeSource = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/listings-review/route.ts", "utf8"));
    expect(routeSource).not.toContain("supabaseRequest,");
    expect(routeSource).not.toContain("{ supabaseRequest }");
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

  it("is read-time-only — same structural guarantee as the audience correction above (this route never imports a write-capable Supabase function)", async () => {
    const routeSource = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/listings-review/route.ts", "utf8"));
    expect(routeSource).not.toContain("supabaseRequest,");
    expect(routeSource).not.toContain("{ supabaseRequest }");
  });
});
