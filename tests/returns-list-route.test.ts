import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { requireOwner, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll }));

import { GET } from "@/app/api/returns/route";
import { returnRow, lossRow } from "./returns-fixtures";

beforeEach(() => { requireOwner.mockClear(); supabaseRequestAll.mockReset(); });

// 12 completed returns recognised in September, each reversing £10 profit.
const RETURNS = Array.from({ length: 12 }, (_, i) => returnRow({
  id: `r${i}`, reference: `RET-${i}`, recognition_month: "2026-09", completed_on: "2026-09-10", profit_reversed: 10,
  return_postage: 0, unrecovered_costs: 0, other_costs: 0, revenue_reversed: 20, original_stock_cost: 5, net_profit_impact: -10,
  created_at: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
}));
const LOSSES = [lossRow({ id: "l1", reference: "LOS-1", event_month: "2026-09", event_date: "2026-09-05", stock_value_removed: 30, net_profit_impact: -30 })];

function mockData() {
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("return_records?owner_id")) return RETURNS;
    if (path.startsWith("loss_records?owner_id")) return LOSSES;
    if (path.startsWith("sales_orders?owner_id")) return []; // cohort empty -> return rate 0
    return [];
  });
}

describe("GET /api/returns — list + KPIs", () => {
  it("49. KPI totals use the FULL filtered dataset, not the paginated page", async () => {
    mockData();
    const body = await (await GET(new Request("http://test/api/returns?preset=custom&start=2026-09-01&end=2026-09-30&pageSize=5&page=1"))).json();
    expect(body.rows).toHaveLength(5); // page limited
    expect(body.total).toBe(13); // 12 returns + 1 loss
    expect(body.totalPages).toBe(3);
    // KPIs computed from all 12 returns + 1 loss regardless of the 5-row page:
    expect(body.kpis.itemsReturned).toBe(12);
    expect(body.kpis.profitLostFromReturnsPence).toBe(12 * 1000);
    expect(body.kpis.lostInventoryPence).toBe(3000);
  });

  it("27/51. return rate is 0% (not NaN/Infinity) when the cohort has no sold units", async () => {
    mockData();
    const body = await (await GET(new Request("http://test/api/returns?preset=custom&start=2026-09-01&end=2026-09-30"))).json();
    expect(body.kpis.returnRatePercent).toBe(0);
  });

  it("type=losses returns only loss rows; type=returns only return rows", async () => {
    mockData();
    const lossesOnly = await (await GET(new Request("http://test/api/returns?preset=all-time&type=losses"))).json();
    expect(lossesOnly.rows.every((r: { recordType: string }) => r.recordType === "loss")).toBe(true);
    const returnsOnly = await (await GET(new Request("http://test/api/returns?preset=all-time&type=returns"))).json();
    expect(returnsOnly.rows.every((r: { recordType: string }) => r.recordType === "return")).toBe(true);
  });

  it("52. only soft-deleted-excluded, owner-scoped rows are ever fetched", async () => {
    const seen: string[] = [];
    supabaseRequestAll.mockImplementation(async (path: string) => { seen.push(path); return []; });
    await GET(new Request("http://test/api/returns?preset=this-month"));
    expect(seen.filter(p => p.startsWith("return_records?") || p.startsWith("loss_records?")).every(p => p.includes("owner_id=eq.owner-1") && p.includes("deleted_at=is.null"))).toBe(true);
  });

  it("sort=financial_impact&direction=asc orders rows by their net_profit_impact ascending", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?owner_id")) return [
        returnRow({ id: "big", reference: "RET-BIG", recognition_month: "2026-09", completed_on: "2026-09-10", net_profit_impact: -100, created_at: "2026-09-01T00:00:00Z" }),
        returnRow({ id: "small", reference: "RET-SMALL", recognition_month: "2026-09", completed_on: "2026-09-11", net_profit_impact: -5, created_at: "2026-09-02T00:00:00Z" }),
      ];
      if (path.startsWith("loss_records?owner_id")) return [];
      return [];
    });
    const body = await (await GET(new Request("http://test/api/returns?preset=all-time&sort=financial_impact&direction=asc"))).json();
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(["big", "small"]);
  });
});
