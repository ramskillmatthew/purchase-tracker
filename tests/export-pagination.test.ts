import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});

import { GET as purchasesExportGet } from "@/app/api/export/purchases/route";
import { GET as expensesExportGet } from "@/app/api/export/expenses/route";

function purchaseRow(id: number) {
  return {
    id: `p-${id}`, order_date: "2026-01-15", purchased_from: "Vinted", sku: `SKU${id}`,
    arrived: true, item_description: `Item ${id}`, item_size: "M", item_condition: "Brand new", category: "Other", price_purchased: 9.99,
  };
}
function expenseRow(id: number) {
  return { id: `e-${id}`, purchase_date: "2026-01-15", purchased_from: "Royal Mail", arrived: null, item_description: `Postage ${id}`, cost: 3.5 };
}

function jsonPageResponse(rows: unknown[], from: number, total: number) {
  const end = from + rows.length - 1;
  return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json", "Content-Range": rows.length ? `${from}-${end}/${total}` : `*/${total}` } });
}

/** Splits a full dataset into the sequence of page responses PostgREST would return for a given page size. */
function mockPagedFetch(fetchMock: ReturnType<typeof vi.fn>, allRows: unknown[], pageSize: number) {
  fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
    const range = new Headers(init.headers).get("Range") ?? "0-999";
    const [fromRaw] = range.split("-");
    const from = Number(fromRaw);
    const page = allRows.slice(from, from + pageSize);
    return jsonPageResponse(page, from, allRows.length);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  requireOwner.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function exportRequest(url: string) {
  return new Request(url);
}

describe("GET /api/export/purchases — no longer truncated at 1,000 rows", () => {
  it("1. fewer than 1,000 purchases exports every row", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 42 }, (_, i) => purchaseRow(i)), 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv.trim().split("\r\n")).toHaveLength(43); // 1 heading row + 42 data rows
  });

  it("2. exactly 1,000 purchases are all exported", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 1000 }, (_, i) => purchaseRow(i)), 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv.trim().split("\r\n")).toHaveLength(1001);
  });

  it("3. 1,001 purchases are all exported (one row past the old cutoff)", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 1001 }, (_, i) => purchaseRow(i)), 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv.trim().split("\r\n")).toHaveLength(1002);
  });

  it("4. 1,798 purchases are all exported — the reported real-world scale", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 1798 }, (_, i) => purchaseRow(i)), 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(1799);
  });

  it("5. more than 2,000 purchases are all exported across at least three pages", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 2500 }, (_, i) => purchaseRow(i)), 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv.trim().split("\r\n")).toHaveLength(2501);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("7. every record appears exactly once — no duplicates, no gaps", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 1798 }, (_, i) => purchaseRow(i)), 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    const skus = csv.trim().split("\r\n").slice(1).map(line => line.split(",")[2]);
    expect(new Set(skus).size).toBe(1798);
  });

  it("8. ordering remains correct across page boundaries", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 1500 }, (_, i) => purchaseRow(i)), 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    const skus = csv.trim().split("\r\n").slice(1).map(line => line.split(",")[2]);
    expect(skus).toEqual(Array.from({ length: 1500 }, (_, i) => `SKU${i}`));
  });

  it("14. a failure on a later page returns an error, never a partial CSV", async () => {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) return jsonPageResponse(Array.from({ length: 1000 }, (_, i) => purchaseRow(i)), 0, 1500);
      return new Response("Database request failed.", { status: 500 });
    });
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("SKU0"); // no partial CSV content leaked
    expect(body.toLowerCase()).not.toContain("purchases"); // no raw DB error text either
  });

  it("requires authentication", async () => {
    const { AuthError } = await import("@/lib/auth/server");
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    expect(response.status).toBe(401);
  });
});

describe("GET /api/export/purchases — CSV format unchanged", () => {
  it("9/10. headings and column order are unchanged apart from the new Category column", async () => {
    mockPagedFetch(fetchMock, [purchaseRow(1)], 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toBe("Order Date,Purchased From,SKU,Arrived,Item Description,Item Size,Item Condition,Category,Price Purchased");
  });

  it("11. commas within a value remain escaped", async () => {
    mockPagedFetch(fetchMock, [{ ...purchaseRow(1), purchased_from: "Vinted, UK" }], 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv).toContain('"Vinted, UK"');
  });

  it("12. quotes within a value remain escaped", async () => {
    mockPagedFetch(fetchMock, [{ ...purchaseRow(1), item_description: 'He said "hi"' }], 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv).toContain('"He said ""hi"""');
  });

  it("13. line breaks within a value remain escaped", async () => {
    mockPagedFetch(fetchMock, [{ ...purchaseRow(1), item_description: "Line one\nLine two" }], 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv).toContain('"Line one\nLine two"');
  });

  it("preserves the existing filename and Content-Type header", async () => {
    mockPagedFetch(fetchMock, [purchaseRow(1)], 1000);
    const response = await purchasesExportGet(exportRequest("http://test/api/export/purchases?start=2026-01-01&end=2026-02-01"));
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="purchases-2026-01-01-2026-02-01.csv"');
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });

  it("the by-ids export path is also paginated and keeps its own distinct filename", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    mockPagedFetch(fetchMock, [{ ...purchaseRow(1), id }], 1000);
    const response = await purchasesExportGet(exportRequest(`http://test/api/export/purchases?ids=${id}`));
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="purchases-import-batch.csv"');
    const csv = await response.text();
    expect(csv.trim().split("\r\n")).toHaveLength(2);
  });
});

describe("GET /api/export/expenses — no longer truncated at 1,000 rows", () => {
  it("6. more than 1,000 expenses are all exported", async () => {
    mockPagedFetch(fetchMock, Array.from({ length: 1200 }, (_, i) => expenseRow(i)), 1000);
    const response = await expensesExportGet(exportRequest("http://test/api/export/expenses?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv.trim().split("\r\n")).toHaveLength(1201);
  });

  it("9/10. headings and column order are unchanged", async () => {
    mockPagedFetch(fetchMock, [expenseRow(1)], 1000);
    const response = await expensesExportGet(exportRequest("http://test/api/export/expenses?start=2026-01-01&end=2026-01-31"));
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toBe("Order Date,Purchased From,Arrived,Item Description,Cost");
  });

  it("14. a failure on a later page returns an error, never a partial CSV", async () => {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) return jsonPageResponse(Array.from({ length: 1000 }, (_, i) => expenseRow(i)), 0, 1300);
      return new Response("Database request failed.", { status: 500 });
    });
    const response = await expensesExportGet(exportRequest("http://test/api/export/expenses?start=2026-01-01&end=2026-01-31"));
    expect(response.status).toBe(500);
  });

  it("preserves the existing filename", async () => {
    mockPagedFetch(fetchMock, [expenseRow(1)], 1000);
    const response = await expensesExportGet(exportRequest("http://test/api/export/expenses?start=2026-01-01&end=2026-02-01"));
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="expenses-2026-01-01-2026-02-01.csv"');
  });
});
