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

import { GET } from "@/app/api/returns-losses/net-profit-adjustment/route";
import { netProfitWithReturnsLossesPence } from "@/lib/returns/net-profit";

beforeEach(() => { requireOwner.mockClear(); supabaseRequestAll.mockReset(); });

describe("GET /api/returns-losses/net-profit-adjustment", () => {
  it("16. reports the September reversal for a completed return recognised that month", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?")) return [{
        id: "r1", owner_id: "owner-1", workflow_status: "return_completed", recognition_month: "2026-09",
        profit_reversed: 14.72, return_postage: 3.49, unrecovered_costs: 0, outcome: "returned_safely", original_stock_cost: 49.99,
      }];
      if (path.startsWith("loss_records?")) return [];
      return [];
    });
    const response = await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-09-01&end=2026-09-30"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.adjustmentPence).toBe(-(1472 + 349));
  });

  it("15. an August range gets zero adjustment for a return recognised in September", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?")) return [{ id: "r1", owner_id: "owner-1", workflow_status: "return_completed", recognition_month: "2026-09", profit_reversed: 14.72, return_postage: 3.49, unrecovered_costs: 0, outcome: "returned_safely" }];
      return [];
    });
    const response = await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-08-01&end=2026-08-31"));
    const body = await response.json();
    expect(body.adjustmentPence).toBe(0);
  });

  it("25/52. every query is owner-scoped AND excludes soft-deleted records", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      expect(path).toContain("owner_id=eq.owner-1");
      expect(path).toContain("deleted_at=is.null");
      return [];
    });
    await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=this-month"));
    expect(supabaseRequestAll).toHaveBeenCalled();
  });

  it("44. returns a signed (<=0) adjustment PLUS a per-component breakdown that reconciles to it", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?")) return [{ id: "r1", owner_id: "owner-1", deleted_at: null, workflow_status: "return_completed", recognition_month: "2026-09", profit_reversed: 14.72, return_postage: 3.49, unrecovered_costs: 1, other_costs: 0, outcome: "buyer_refunded_no_return", original_stock_cost: 49.99 }];
      if (path.startsWith("loss_records?")) return [{ id: "l1", owner_id: "owner-1", deleted_at: null, loss_type: "lost_inventory", event_month: "2026-09", event_date: "2026-09-05", event_precision: "exact", stock_value_removed: 60, other_costs: 0, customer_refund: 0 }];
      return [];
    });
    const body = await (await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-09-01&end=2026-09-30"))).json();
    const b = body.breakdown;
    expect(b.profitReversedPence).toBe(1472);
    expect(b.returnPostagePence).toBe(349);
    expect(b.unrecoveredReturnCostsPence).toBe(100);
    expect(b.inventoryWriteOffPence).toBe(4999);
    expect(b.lostInventoryPence).toBe(6000);
    const sum = Object.values(b).reduce((s: number, v) => s + Number(v), 0);
    expect(body.adjustmentPence).toBe(-sum);
  });

  it("17/18. an ACTIVE return (return_delivered, started this month) already reverses its unit profit — the £21.73 case", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?")) return [{
        id: "r1", owner_id: "owner-1", deleted_at: null,
        workflow_status: "return_delivered", outcome: null, recognition_month: null,
        started_on: "2026-09-02", started_precision: "exact",
        profit_reversed: 21.73, return_postage: 0, unrecovered_costs: 0, other_costs: 0,
      }];
      if (path.startsWith("loss_records?")) return [];
      return [];
    });
    const body = await (await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-09-01&end=2026-09-30"))).json();
    expect(body.adjustmentPence).toBe(-2173);

    // Counted EXACTLY once: base sales profit still includes the £21.73 sale
    // (status 'completed'), the adjustment removes it, net -> £0.
    expect(netProfitWithReturnsLossesPence(2173, 0, body.adjustmentPence)).toBe(0);
  });

  it("17. an active return started in a PRIOR month contributes 0 to this month (recognised in its started month)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?")) return [{
        id: "r1", owner_id: "owner-1", deleted_at: null, workflow_status: "return_started", outcome: null,
        recognition_month: null, started_on: "2026-08-20", started_precision: "exact", profit_reversed: 21.73, return_postage: 0,
      }];
      return [];
    });
    const body = await (await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-09-01&end=2026-09-30"))).json();
    expect(body.adjustmentPence).toBe(0);
  });

  it("19. once cancelled, the active return's adjustment disappears (the sale's £21.73 is back in net profit)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?")) return [{
        id: "r1", owner_id: "owner-1", deleted_at: null, workflow_status: "return_cancelled", outcome: null,
        recognition_month: null, started_on: "2026-09-02", started_precision: "exact", profit_reversed: 21.73, return_postage: 0,
      }];
      return [];
    });
    const body = await (await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-09-01&end=2026-09-30"))).json();
    expect(body.adjustmentPence).toBe(0);
    expect(netProfitWithReturnsLossesPence(2173, 0, body.adjustmentPence)).toBe(2173);
  });

  it("16/months. a completed return recognised in Sept counts for Sept and NOT for its August started month (no double count)", async () => {
    const row = {
      id: "r1", owner_id: "owner-1", deleted_at: null, workflow_status: "return_completed", outcome: "returned_safely",
      recognition_month: "2026-09", started_on: "2026-08-28", started_precision: "exact",
      profit_reversed: 21.73, return_postage: 0, unrecovered_costs: 0, other_costs: 0, original_stock_cost: 3.27,
    };
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("return_records?") ? [row] : []));
    const aug = await (await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-08-01&end=2026-08-31"))).json();
    const sep = await (await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-09-01&end=2026-09-30"))).json();
    expect(aug.adjustmentPence).toBe(0);   // NOT recognised in the started month once completed
    expect(sep.adjustmentPence).toBe(-2173);
  });

  it("48. a soft-deleted loss / a cancelled return contributes nothing", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?")) return [{ id: "r1", owner_id: "owner-1", deleted_at: null, workflow_status: "return_cancelled", recognition_month: "2026-09", profit_reversed: 99, return_postage: 9 }];
      if (path.startsWith("loss_records?")) return [{ id: "l1", owner_id: "owner-1", deleted_at: "2026-09-10T00:00:00Z", loss_type: "lost_inventory", event_month: "2026-09", event_date: "2026-09-05", event_precision: "exact", stock_value_removed: 999, other_costs: 0, customer_refund: 0 }];
      return [];
    });
    const body = await (await GET(new Request("http://test/api/returns-losses/net-profit-adjustment?preset=custom&start=2026-09-01&end=2026-09-30"))).json();
    expect(body.adjustmentPence).toBe(0);
  });
});
