import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const { supabaseRequest } = vi.hoisted(() => ({ supabaseRequest: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import {
  AVAILABLE_PURCHASES_DEFAULT_LIMIT, AVAILABLE_PURCHASES_MAX_LIMIT, buildAvailablePurchasesQuery,
  clampLimit, clampOffset, sanitizeSearchTerm, searchAvailablePurchases,
} from "@/lib/sales/available-purchases";

beforeEach(() => { supabaseRequest.mockReset(); });

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1", order_date: "2026-01-01", purchased_from: "Vinted", seller_name: "Some Seller", sku: "SKU1",
    item_description: "Item", item_size: "M", quantity: 1, item_condition: "Brand new", category: "Other",
    price_purchased: 10, arrived: null, stock_status: "in_stock", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return { json: async () => body, headers: { get: (key: string) => headers[key.toLowerCase()] ?? null } };
}

describe("sanitizeSearchTerm", () => {
  it("strips PostgREST/ilike-pattern-significant characters", () => {
    expect(sanitizeSearchTerm("pokemon%*,()box")).toBe("pokemonbox");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeSearchTerm("  pokemon box  ")).toBe("pokemon box");
  });

  it("leaves an ordinary search phrase untouched", () => {
    expect(sanitizeSearchTerm("pokemon first partner series 3 box")).toBe("pokemon first partner series 3 box");
  });
});

describe("clampLimit / clampOffset", () => {
  it("REQUIREMENT: defaults to a sensible page size when missing or invalid", () => {
    expect(clampLimit(null)).toBe(AVAILABLE_PURCHASES_DEFAULT_LIMIT);
    expect(clampLimit(undefined)).toBe(AVAILABLE_PURCHASES_DEFAULT_LIMIT);
    expect(clampLimit("not-a-number")).toBe(AVAILABLE_PURCHASES_DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(AVAILABLE_PURCHASES_DEFAULT_LIMIT);
    expect(clampLimit(-5)).toBe(AVAILABLE_PURCHASES_DEFAULT_LIMIT);
  });

  it("REQUIREMENT: caps at a maximum so a caller can never request an unbounded page", () => {
    expect(clampLimit(100000)).toBe(AVAILABLE_PURCHASES_MAX_LIMIT);
  });

  it("truncates a fractional limit", () => {
    expect(clampLimit("12.9")).toBe(12);
  });

  it("offset defaults to 0 for missing/invalid/negative values", () => {
    expect(clampOffset(null)).toBe(0);
    expect(clampOffset("bogus")).toBe(0);
    expect(clampOffset(-10)).toBe(0);
  });

  it("accepts a valid positive offset", () => {
    expect(clampOffset("50")).toBe(50);
  });
});

describe("buildAvailablePurchasesQuery", () => {
  it("REQUIREMENT: always filters to in_stock purchases only", () => {
    expect(buildAvailablePurchasesQuery("")).toContain("stock_status=eq.in_stock");
  });

  it("REQUIREMENT: with no term, returns every in-stock purchase (no or= filter)", () => {
    expect(buildAvailablePurchasesQuery("")).not.toContain("or=(");
  });

  it("REQUIREMENT: searches description, SKU, seller, and supplier with a case-insensitive partial match", () => {
    const query = buildAvailablePurchasesQuery("pokemon");
    expect(query).toContain("item_description.ilike.*pokemon*");
    expect(query).toContain("sku.ilike.*pokemon*");
    expect(query).toContain("seller_name.ilike.*pokemon*");
    expect(query).toContain("purchased_from.ilike.*pokemon*");
  });

  it("most-recent-first, stable order", () => {
    expect(buildAvailablePurchasesQuery("")).toContain("order=order_date.desc,created_at.desc");
  });
});

describe("searchAvailablePurchases — two-query availability filter", () => {
  it("REQUIREMENT: excludes a candidate that has an active sale_items row, even though it's stock_status=in_stock", async () => {
    supabaseRequest
      .mockResolvedValueOnce(jsonResponse([purchase({ id: "a" }), purchase({ id: "b" })], { "content-range": "0-1/2" }))
      .mockResolvedValueOnce(jsonResponse([{ purchase_id: "a" }]));

    const { results, total } = await searchAvailablePurchases("", 25, 0);
    expect(results.map(r => r.id)).toEqual(["b"]);
    expect(total).toBe(2);
  });

  it("does not run the second (active-sale-item) query at all when the first page is empty", async () => {
    supabaseRequest.mockResolvedValueOnce(jsonResponse([], { "content-range": "*/0" }));
    const { results, total } = await searchAvailablePurchases("nonexistent", 25, 0);
    expect(results).toEqual([]);
    expect(total).toBe(0);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
  });

  it("returns every candidate when none of them have an active sale item", async () => {
    supabaseRequest
      .mockResolvedValueOnce(jsonResponse([purchase({ id: "a" }), purchase({ id: "b" })], { "content-range": "0-1/2" }))
      .mockResolvedValueOnce(jsonResponse([]));

    const { results } = await searchAvailablePurchases("", 25, 0);
    expect(results.map(r => r.id)).toEqual(["a", "b"]);
  });

  it("REQUIREMENT: paginates via the Range header using the exact offset/limit given", async () => {
    supabaseRequest
      .mockResolvedValueOnce(jsonResponse([], { "content-range": "*/0" }));
    await searchAvailablePurchases("", 25, 50);
    const [, init] = supabaseRequest.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Range: "50-74" });
  });

  it("REQUIREMENT: distinct suppliers with matching descriptions each return their own separate purchase row (never merged)", async () => {
    supabaseRequest
      .mockResolvedValueOnce(jsonResponse([
        purchase({ id: "john-lewis-1", item_description: "pokemon first partner series 3 box", purchased_from: "John Lewis", price_purchased: 19.49 }),
        purchase({ id: "hamleys-1", item_description: "pokemon first partner series 3 box", purchased_from: "Hamleys", price_purchased: 19.98 }),
      ], { "content-range": "0-1/2" }))
      .mockResolvedValueOnce(jsonResponse([]));

    const { results } = await searchAvailablePurchases("pokemon first partner", 25, 0);
    expect(results).toHaveLength(2);
    expect(new Set(results.map(r => r.id)).size).toBe(2);
    expect(results.map(r => r.purchased_from).sort()).toEqual(["Hamleys", "John Lewis"]);
  });
});

describe("app/api/sales/available-purchases/route.ts (structural)", () => {
  const source = readFileSync("app/api/sales/available-purchases/route.ts", "utf8");

  it("requires owner authentication", () => {
    expect(source).toContain("await requireOwner();");
  });

  it("reads q/limit/offset from the query string and clamps limit/offset", () => {
    expect(source).toContain('searchParams.get("q")');
    expect(source).toContain("clampLimit(searchParams.get(\"limit\"))");
    expect(source).toContain("clampOffset(searchParams.get(\"offset\"))");
  });

  it("routes failures through the shared safeApiError helper", () => {
    expect(source).toContain("safeApiError(error,");
  });
});
