import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string): Promise<unknown[]> => []),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/supabase")>();
  return { ...actual, supabaseRequestAll };
});

import { GET as purchasesGet } from "@/app/api/purchases/route";
import { GET as expensesGet } from "@/app/api/expenses/route";

beforeEach(() => { requireOwner.mockClear(); supabaseRequestAll.mockClear(); });

function rowsOf(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: String(index) }));
}

describe("REQUIREMENT 12/16: GET /api/purchases is not capped at 1000 and preserves its response contract", () => {
  it("returns every row supabaseRequestAll produces, unmodified, as a plain JSON array", async () => {
    supabaseRequestAll.mockResolvedValueOnce(rowsOf(1798));
    const response = await purchasesGet();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1798);
  });

  it("uses the shared paginating helper rather than a single unbounded request", async () => {
    supabaseRequestAll.mockResolvedValueOnce(rowsOf(5));
    await purchasesGet();
    expect(supabaseRequestAll).toHaveBeenCalledTimes(1);
    const [path] = supabaseRequestAll.mock.calls[0];
    expect(path).toContain("purchases?select=*");
    expect(path).toContain("order=order_date.desc,created_at.desc");
  });

  it("propagates a paging failure as a safe error rather than a partial 200 response", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("boom"));
    const response = await purchasesGet();
    expect(response.status).toBe(500);
  });
});

describe("REQUIREMENT 15: GET /api/expenses uses the same shared pagination helper", () => {
  it("returns every row, unmodified, as a plain JSON array", async () => {
    supabaseRequestAll.mockResolvedValueOnce(rowsOf(1200));
    const response = await expensesGet();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1200);
  });

  it("uses the shared paginating helper rather than a single unbounded request", async () => {
    supabaseRequestAll.mockResolvedValueOnce(rowsOf(5));
    await expensesGet();
    expect(supabaseRequestAll).toHaveBeenCalledTimes(1);
    const [path] = supabaseRequestAll.mock.calls[0];
    expect(path).toContain("expenses?select=*");
  });
});

describe("REQUIREMENT 13/14: Home and Purchases pages consume the full dataset with no additional client-side truncation", () => {
  it("app/purchases/page.tsx never slices the fetched rows before computing the count or pagination", () => {
    const source = readFileSync("app/purchases/page.tsx", "utf8");
    // the record count and toolbar text must derive from rows.length, not a hardcoded or capped value
    expect(source).toContain("rows.length.toLocaleString");
    expect(source).not.toMatch(/rows\.slice\(0,\s*1000\)/);
  });

  it("app/page.tsx computes dashboard totals from the full fetched arrays, never a capped slice", () => {
    const source = readFileSync("app/page.tsx", "utf8");
    expect(source).not.toMatch(/\.slice\(0,\s*1000\)/);
    expect(source).toContain("setPurchases(purchaseRows)");
  });
});
