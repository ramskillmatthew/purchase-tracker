import { describe, expect, it } from "vitest";
import {
  buildPurchaseMatchIndex, matchSkuToPurchase, describePurchaseMatch, buildPurchaseSkuLookupQueries,
  MAX_SKU_LOOKUP_CHUNK_SIZE, type PurchaseMatchRecord,
} from "@/lib/listing-studio/purchase-match";

function purchase(overrides: Partial<PurchaseMatchRecord> = {}): PurchaseMatchRecord {
  return { id: "p1", sku: "AA1711", order_date: "2026-01-15", item_description: "On Cloud 5", price_purchased: 18.5, ...overrides };
}

describe("matchSkuToPurchase — Milestone 6: exact, case-insensitive, trimmed SKU matching only", () => {
  it("exact SKU match", () => {
    const index = buildPurchaseMatchIndex([purchase()]);
    const result = matchSkuToPurchase("AA1711", index);
    expect(result).toEqual({ status: "matched", sku: "AA1711", purchasePricePence: 1850 });
  });

  it("case-insensitive exact match", () => {
    const index = buildPurchaseMatchIndex([purchase({ sku: "AA1711" })]);
    expect(matchSkuToPurchase("aa1711", index).status).toBe("matched");
    expect(matchSkuToPurchase("Aa1711", index).status).toBe("matched");
  });

  it("whitespace is normalised on both sides before matching", () => {
    const index = buildPurchaseMatchIndex([purchase({ sku: "  AA1711  " })]);
    expect(matchSkuToPurchase("  aa1711  ", index).status).toBe("matched");
  });

  it("REGRESSION: never a partial/substring match — AA1711 must not match AA17110 or vice versa", () => {
    const index = buildPurchaseMatchIndex([purchase({ sku: "AA17110" })]);
    expect(matchSkuToPurchase("AA1711", index).status).toBe("not_found");

    const index2 = buildPurchaseMatchIndex([purchase({ sku: "AA1711" })]);
    expect(matchSkuToPurchase("AA17110", index2).status).toBe("not_found");
  });

  it("REGRESSION: leading zeroes are preserved and meaningful — never coerced to a number", () => {
    const index = buildPurchaseMatchIndex([purchase({ sku: "007" })]);
    expect(matchSkuToPurchase("007", index).status).toBe("matched");
    expect(matchSkuToPurchase("7", index).status).toBe("not_found");
    expect(matchSkuToPurchase("70", index).status).toBe("not_found");
  });

  it("missing SKU (null or blank) reports missing_sku without touching the index at all", () => {
    const index = buildPurchaseMatchIndex([purchase()]);
    expect(matchSkuToPurchase(null, index)).toEqual({ status: "missing_sku" });
    expect(matchSkuToPurchase("", index)).toEqual({ status: "missing_sku" });
    expect(matchSkuToPurchase("   ", index)).toEqual({ status: "missing_sku" });
  });

  it("purchase not found for a genuinely absent SKU", () => {
    const index = buildPurchaseMatchIndex([purchase({ sku: "BB2222" })]);
    expect(matchSkuToPurchase("AA1711", index)).toEqual({ status: "not_found", sku: "AA1711" });
  });

  it("duplicate purchase matches — never silently picks one, includes safe identifying info for every match", () => {
    const index = buildPurchaseMatchIndex([
      purchase({ id: "p1", order_date: "2026-01-01", item_description: "On Cloud 5 (unit 1)", price_purchased: 18.5 }),
      purchase({ id: "p2", order_date: "2026-01-01", item_description: "On Cloud 5 (unit 2)", price_purchased: 18.5 }),
    ]);
    const result = matchSkuToPurchase("AA1711", index);
    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate") {
      expect(result.matches).toHaveLength(2);
      expect(result.matches).toEqual([
        { orderDate: "2026-01-01", itemDescription: "On Cloud 5 (unit 1)", pricePence: 1850 },
        { orderDate: "2026-01-01", itemDescription: "On Cloud 5 (unit 2)", pricePence: 1850 },
      ]);
      // Never summed, never averaged — each match's own price is reported independently.
    }
  });

  it("REGRESSION: never sums or averages duplicate prices", () => {
    const index = buildPurchaseMatchIndex([
      purchase({ price_purchased: 10 }),
      purchase({ price_purchased: 20 }),
    ]);
    const result = matchSkuToPurchase("AA1711", index);
    if (result.status === "duplicate") {
      expect(result.matches.map(m => m.pricePence)).toEqual([1000, 2000]);
    } else {
      throw new Error("expected duplicate");
    }
  });

  it("invalid/null purchase price is reported as null, never NaN, never 0, never a crash", () => {
    const index = buildPurchaseMatchIndex([purchase({ price_purchased: null })]);
    expect(matchSkuToPurchase("AA1711", index)).toEqual({ status: "matched", sku: "AA1711", purchasePricePence: null });

    const indexBlank = buildPurchaseMatchIndex([purchase({ price_purchased: "" as unknown as number })]);
    const blankResult = matchSkuToPurchase("AA1711", indexBlank);
    expect(blankResult.status).toBe("matched");
    if (blankResult.status === "matched") expect(blankResult.purchasePricePence).toBeNull();
  });

  it("safely parses a numeric-string price (a possible PostgREST/driver response shape)", () => {
    const index = buildPurchaseMatchIndex([purchase({ price_purchased: "18.50" as unknown as number })]);
    expect(matchSkuToPurchase("AA1711", index)).toEqual({ status: "matched", sku: "AA1711", purchasePricePence: 1850 });
  });

  it("does not modify the purchase record or the listing SKU during lookup — pure, no mutation", () => {
    const record = purchase();
    const frozen = Object.freeze({ ...record });
    const index = buildPurchaseMatchIndex([frozen]);
    const sku = "AA1711";
    matchSkuToPurchase(sku, index);
    expect(frozen).toEqual(record);
    expect(sku).toBe("AA1711");
  });
});

describe("describePurchaseMatch — the exact fixed line shown in the details panel for each outcome", () => {
  it("matched with a valid price", () => {
    expect(describePurchaseMatch({ status: "matched", sku: "AA1711", purchasePricePence: 1850 })).toBe("You paid: £18.50");
  });

  it("matched but the purchase's own price is unavailable", () => {
    expect(describePurchaseMatch({ status: "matched", sku: "AA1711", purchasePricePence: null })).toBe("Purchase price unavailable");
  });

  it("missing SKU", () => {
    expect(describePurchaseMatch({ status: "missing_sku" })).toBe("Purchase price unavailable — SKU missing");
  });

  it("not found", () => {
    expect(describePurchaseMatch({ status: "not_found", sku: "AA1711" })).toBe("No purchase found for SKU AA1711");
  });

  it("duplicate", () => {
    expect(describePurchaseMatch({ status: "duplicate", sku: "AA1711", matches: [] })).toBe("Multiple purchases found for SKU AA1711");
  });
});

describe("buildPurchaseMatchIndex — the one-time index build behind the batched lookup", () => {
  it("ignores purchases with a null or blank SKU entirely", () => {
    const index = buildPurchaseMatchIndex([purchase({ sku: null }), purchase({ sku: "" }), purchase({ sku: "   " })]);
    expect(index.size).toBe(0);
  });

  it("REGRESSION: comfortably handles 100+ purchase records and 100+ listing lookups with zero additional network calls — a pure in-memory Map lookup per listing", () => {
    const records = Array.from({ length: 150 }, (_, i) => purchase({ id: `p${i}`, sku: `SKU${i}` }));
    const index = buildPurchaseMatchIndex(records);
    expect(index.size).toBe(150);
    for (let i = 0; i < 150; i++) {
      expect(matchSkuToPurchase(`SKU${i}`, index)).toMatchObject({ status: "matched" });
    }
    // A SKU with no purchase among the 150 still resolves correctly.
    expect(matchSkuToPurchase("SKU999", index).status).toBe("not_found");
  });
});

describe("buildPurchaseSkuLookupQueries — Follow-up correction: restricting the purchase lookup to only relevant SKUs, never the whole purchases table", () => {
  it("makes zero purchase requests when given no SKUs at all", () => {
    expect(buildPurchaseSkuLookupQueries([])).toEqual([]);
    expect(buildPurchaseSkuLookupQueries([null, null, "", "   "])).toEqual([]);
  });

  it("builds exactly one query for a handful of SKUs", () => {
    const queries = buildPurchaseSkuLookupQueries(["AA1711", "BB2222"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("purchases?select=id,sku,order_date,item_description,price_purchased");
    expect(queries[0]).toContain("sku.ilike.AA1711");
    expect(queries[0]).toContain("sku.ilike.BB2222");
  });

  it("REGRESSION: never fetches the whole table — no unbounded query without an sku filter", () => {
    const queries = buildPurchaseSkuLookupQueries(["AA1711"]);
    expect(queries[0]).not.toContain("sku=not.is.null");
    expect(queries[0]).toMatch(/or=\(/);
  });

  it("deduplicates repeated/blank SKUs before building the query", () => {
    const queries = buildPurchaseSkuLookupQueries(["AA1711", "AA1711", null, "", "  "]);
    expect(queries).toHaveLength(1);
    expect((queries[0].match(/sku\.ilike\./g) ?? []).length).toBe(1);
  });

  it("trims each SKU before using it in the query", () => {
    const queries = buildPurchaseSkuLookupQueries(["  AA1711  "]);
    expect(queries[0]).toContain("sku.ilike.AA1711");
    expect(queries[0]).not.toContain("sku.ilike.%20AA1711");
  });

  it(`chunks into bounded batches of at most ${MAX_SKU_LOOKUP_CHUNK_SIZE} unique SKUs per query`, () => {
    const skus = Array.from({ length: MAX_SKU_LOOKUP_CHUNK_SIZE + 1 }, (_, i) => `SKU${i}`);
    const queries = buildPurchaseSkuLookupQueries(skus);
    expect(queries).toHaveLength(2);
    expect((queries[0].match(/sku\.ilike\./g) ?? []).length).toBe(MAX_SKU_LOOKUP_CHUNK_SIZE);
    expect((queries[1].match(/sku\.ilike\./g) ?? []).length).toBe(1);
  });

  it("exactly MAX_SKU_LOOKUP_CHUNK_SIZE unique SKUs still fits in one query (boundary, not off-by-one)", () => {
    const skus = Array.from({ length: MAX_SKU_LOOKUP_CHUNK_SIZE }, (_, i) => `SKU${i}`);
    expect(buildPurchaseSkuLookupQueries(skus)).toHaveLength(1);
  });

  it("REGRESSION: escapes literal % and _ characters in a SKU so they can never be misread as SQL LIKE wildcards, preserving exact matching", () => {
    const queries = buildPurchaseSkuLookupQueries(["50%OFF", "A_B"]);
    expect(queries[0]).toContain(encodeURIComponent("sku.ilike.50\\%OFF"));
    expect(queries[0]).toContain(encodeURIComponent("sku.ilike.A\\_B"));
  });

  it("every returned query string is ready to pass straight to supabaseRequestAll — a complete path, not a fragment", () => {
    const [query] = buildPurchaseSkuLookupQueries(["AA1711"]);
    expect(query.startsWith("purchases?")).toBe(true);
  });
});
