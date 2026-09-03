import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stage 2 carry-over backend: sale-search, purchase-search, the non-mutating
 * impact previews, and duplicate economic-event protection. Mocked Supabase;
 * these exercise the real route handlers + the real domain functions.
 */

vi.mock("server-only", () => ({}));
const { requireOwner, supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(),
  supabaseRequestAll: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

import { GET as saleSearch } from "@/app/api/returns/sale-search/route";
import { GET as purchaseSearch } from "@/app/api/losses/purchase-search/route";
import { POST as completePreview } from "@/app/api/returns/[id]/complete/preview/route";
import { POST as lossPreview } from "@/app/api/losses/preview/route";
import { POST as returnEditPreview } from "@/app/api/returns/[id]/preview/route";
import { POST as completeReturn } from "@/app/api/returns/[id]/complete/route";
import { POST as createLoss } from "@/app/api/losses/route";
import { returnRow, lossRow } from "./returns-fixtures";
import { findRefundNoReturnConflictForReturn, findRefundNoReturnConflictForLoss } from "@/lib/returns/duplicate-guard";

function get(url: string) { return saleSearch(new Request(url)); }
function jreq(body: unknown) { return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function params(id: string) { return { params: Promise.resolve({ id }) }; }
function res(body: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(body), { status }); }

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const SI1 = "44444444-4444-4444-8444-444444444444";
const SI2 = "55555555-5555-4555-8555-555555555555";

const ORDER = { id: SALE_ID, owner_id: "owner-1", sale_date: "2026-08-28", platform: "ebay", custom_platform_name: null, status: "completed", process_status: "delivered_awaiting_payout", total_revenue: 139.42 };
const ITEM1 = { id: SI1, sales_order_id: SALE_ID, sku_snapshot: "1644", item_description_snapshot: "On Running Cloud 5", purchase_cost_snapshot: 22.6, allocated_revenue: 69.71, allocated_platform_fee: 0, allocated_postage: 0, profit: 12.4, is_active: true, created_at: "2026-08-28T10:00:00Z" };
const ITEM2 = { id: SI2, sales_order_id: SALE_ID, sku_snapshot: "1699", item_description_snapshot: "Pokemon ETB", purchase_cost_snapshot: 30, allocated_revenue: 69.71, allocated_platform_fee: 0, allocated_postage: 0, profit: 20, is_active: true, created_at: "2026-08-28T10:01:00Z" };

beforeEach(() => {
  requireOwner.mockClear(); requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  supabaseRequest.mockReset(); supabaseRequestAll.mockReset();
});

describe("GET /api/returns/sale-search", () => {
  function mock(returns: unknown[] = []) {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sales_orders?owner_id=eq.owner-1&status=eq.completed")) return [ORDER];
      if (path.startsWith("return_records?owner_id")) return returns;
      if (path.startsWith("sale_items?sales_order_id=in.")) return [ITEM1, ITEM2];
      return [];
    });
  }

  it("blank query returns eligible sales, paginated, with EXACT per-unit rows (mixed basket) and no photo fields", async () => {
    mock();
    const body = await (await get("http://test/api/returns/sale-search")).json();
    expect(body.total).toBe(1);
    expect(body.results[0].items.map((i: { saleItemId: string }) => i.saleItemId)).toEqual([SI1, SI2]);
    expect(body.results[0].items[0]).toEqual({ saleItemId: SI1, sku: "1644", title: "On Running Cloud 5", costPence: 2260, revenuePence: 6971, profitPence: 1240 });
    expect(JSON.stringify(body)).not.toMatch(/photo|image|thumbnail/i);
  });

  it("filters by SKU and by item title", async () => {
    mock();
    expect((await (await get("http://test/api/returns/sale-search?q=1644")).json()).results[0].items.map((i: { saleItemId: string }) => i.saleItemId)).toEqual([SI1, SI2]);
    expect((await (await get("http://test/api/returns/sale-search?q=nonexistent")).json()).total).toBe(0);
  });

  it("excludes units already claimed by an active return; a sale with none eligible drops out", async () => {
    mock([{ workflow_status: "return_started", sale_item_ids: [SI1] }]);
    const body = await (await get("http://test/api/returns/sale-search")).json();
    expect(body.results[0].items.map((i: { saleItemId: string }) => i.saleItemId)).toEqual([SI2]);
    mock([{ workflow_status: "return_completed", sale_item_ids: [SI1, SI2] }]);
    expect((await (await get("http://test/api/returns/sale-search")).json()).total).toBe(0);
  });

  it("only ever queries this owner's sales", async () => {
    const seen: string[] = [];
    supabaseRequestAll.mockImplementation(async (path: string) => { seen.push(path); return []; });
    await get("http://test/api/returns/sale-search");
    expect(seen.some(p => p.startsWith("sales_orders?"))).toBe(true);
    expect(seen.filter(p => p.startsWith("sales_orders?") || p.startsWith("return_records?")).every(p => p.includes("owner_id=eq.owner-1"))).toBe(true);
  });
});

describe("GET /api/losses/purchase-search", () => {
  it("groups eligible in-stock units by (sku + cost), lists exact ids, discloses the ownership limitation, no photos", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("purchases?stock_status=eq.in_stock")) return [
        { id: "u1", sku: "1712", item_description: "Nike Hoodie", purchased_from: "Vinted", order_date: "2026-08-01", price_purchased: 60 },
        { id: "u2", sku: "1712", item_description: "Nike Hoodie", purchased_from: "Vinted", order_date: "2026-08-02", price_purchased: 60 },
        { id: "u3", sku: "9999", item_description: "Other", purchased_from: null, order_date: "2026-07-01", price_purchased: 10 },
      ];
      if (path.startsWith("loss_records?owner_id")) return [{ written_off_purchase_ids: ["u1"] }]; // u1 already written off
      return [];
    });
    const body = await (await purchaseSearch(new Request("http://test/api/losses/purchase-search"))).json();
    const nike = body.results.find((g: { sku: string }) => g.sku === "1712");
    expect(nike.inStockUnitIds).toEqual(["u2"]); // u1 excluded
    expect(nike.eligibleQuantity).toBe(1);
    expect(nike.unitCostPence).toBe(6000);
    expect(body.ownershipNote).toMatch(/no owner_id/i);
    expect(JSON.stringify(body)).not.toMatch(/photo|image/i);
  });
});

describe("Non-mutating previews", () => {
  it("complete-return preview writes NOTHING and returns the exact ReturnReversal (mockup numbers)", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method) throw new Error(`preview must not write: ${path}`);
      if (path.startsWith(`return_records?id=eq.${RID}`)) return res([returnRow({ id: RID, sales_order_id: SALE_ID, sale_item_ids: [SI1], workflow_status: "return_delivered", outcome: null, quantity: 1, completed_on: null, completed_precision: null, recognition_month: null })]);
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("sale_items?id=in.") ? [{ ...ITEM1, allocated_revenue: 69.71, purchase_cost_snapshot: 49.99, profit: 14.72 }] : []));
    const body = await (await completePreview(jreq({ outcome: "returned_safely", completedOn: "2026-09-03", returnPostage: 3.49 }), params(RID))).json();
    expect(body.impact.revenueReversedPence).toBe(6971);
    expect(body.impact.profitReversedPence).toBe(1472);
    expect(body.impact.stockValueRestoredPence).toBe(4999);
    expect(body.impact.netProfitImpactPence).toBe(-(1472 + 349));
    expect(body.recognitionMonth).toBe("2026-09");
    expect(body.resultingSaleStatus).toBe("returned_cancelled");
    expect(body.resultingStockAction).toBe("restore_to_stock");
    // never wrote a movement/audit
    expect(supabaseRequest.mock.calls.some(c => c[0] === "inventory_movements" || c[0] === "return_loss_audit_events" || String(c[0]).startsWith("rpc/"))).toBe(false);
  });

  it("loss preview returns computeLossImpact and never writes (£84.50 + £4.00 = £88.50 mockup)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [{ id: P1, price_purchased: 84.5, stock_status: "in_stock" }] : []));
    const body = await (await lossPreview(jreq({ lossType: "lost_inventory", purchaseIds: [P1], otherCosts: 4, eventDate: "2026-08-25", eventPrecision: "month", stockAction: "remove_from_stock" }))).json();
    expect(body.impact.netProfitImpactPence).toBe(-(8450 + 400));
    expect(body.eventMonth).toBe("2026-08");
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("edit preview shows a postage-only change moves net impact by exactly the difference, no stock movement", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`return_records?id=eq.${RID}`)) return res([returnRow({ id: RID, sales_order_id: SALE_ID, sale_item_ids: [SI1], workflow_status: "return_completed", outcome: "returned_safely", quantity: 1, return_postage: 3.49, profit_reversed: 14.72, net_profit_impact: -18.21 })]);
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("sale_items?id=in.") ? [{ ...ITEM1, allocated_revenue: 69.71, purchase_cost_snapshot: 49.99, profit: 14.72 }] : []));
    const body = await (await returnEditPreview(jreq({ returnPostage: 5.2 }), params(RID))).json();
    expect(body.netProfitImpactDeltaPence).toBe(-171);
    expect(body.movementsToApply).toBe(0);
    expect(body.movementsToReverse).toBe(0);
  });
});

describe("Duplicate economic-event protection", () => {
  it("pure: a completed buyer_refunded return and a refund_without_return loss for the same sale conflict both directions", () => {
    const ret = returnRow({ reference: "RET-9", sales_order_id: SALE_ID, sale_item_ids: [SI1], workflow_status: "return_completed", outcome: "buyer_refunded_no_return" });
    const loss = lossRow({ reference: "LOS-9", loss_type: "refund_without_return", sales_order_id: SALE_ID, sale_item_ids: [SI1] });
    expect(findRefundNoReturnConflictForReturn({ salesOrderId: SALE_ID, saleItemIds: [SI1], losses: [loss] })?.conflictingReference).toBe("LOS-9");
    expect(findRefundNoReturnConflictForLoss({ salesOrderId: SALE_ID, saleItemIds: [SI1], returns: [ret] })?.conflictingReference).toBe("RET-9");
    // different sale -> no conflict
    expect(findRefundNoReturnConflictForLoss({ salesOrderId: "other", saleItemIds: [SI1], returns: [ret] })).toBeNull();
    // deleted loss -> no conflict
    expect(findRefundNoReturnConflictForReturn({ salesOrderId: SALE_ID, saleItemIds: [SI1], losses: [{ ...loss, deleted_at: "x" }] })).toBeNull();
  });

  it("the complete route BLOCKS a buyer_refunded completion when a refund_without_return loss exists (409, no RPC)", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RID}`) && !init?.method) return res([returnRow({ id: RID, sales_order_id: SALE_ID, sale_item_ids: [SI1], workflow_status: "return_delivered", outcome: null, quantity: 1, completed_applied: false, completed_on: null, completed_precision: null, recognition_month: null })]);
      if (String(path).startsWith("rpc/")) throw new Error("must not call the RPC on a duplicate-event conflict");
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?id=in.")) return [ITEM1];
      if (path.startsWith("loss_records?owner_id")) return [lossRow({ reference: "LOS-DUP", loss_type: "refund_without_return", sales_order_id: SALE_ID, sale_item_ids: [SI1] })];
      return [];
    });
    const response = await completeReturn(jreq({ outcome: "buyer_refunded_no_return", completedOn: "2026-09-03" }), params(RID));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/refund without return.*LOS-DUP/i);
  });

  it("the loss route BLOCKS a refund_without_return loss when a matching completed buyer_refunded return exists (409, no create)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("return_records?owner_id")) return [returnRow({ reference: "RET-DUP", sales_order_id: SALE_ID, sale_item_ids: [SI1], workflow_status: "return_completed", outcome: "buyer_refunded_no_return" })];
      return [];
    });
    supabaseRequest.mockImplementation(async (path: string) => { throw new Error(`must not write: ${path}`); });
    const response = await createLoss(jreq({ lossType: "refund_without_return", purchaseIds: [], salesOrderId: SALE_ID, saleItemIds: [SI1], customerRefund: 24.99, eventDate: "2026-09-04", stockAction: "keep_in_stock" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/RET-DUP/);
  });
});
