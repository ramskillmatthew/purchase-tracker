import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Return + Loss EDIT and DELETE routes — difference-based application, all
 * via the transactional RPCs (rl_apply_return_transition /
 * rl_apply_loss_transition). Mocked Supabase; the RPC bodies are validated
 * structurally elsewhere.
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

import { PATCH as editReturn, DELETE as deleteReturn } from "@/app/api/returns/[id]/route";
import { PATCH as editLoss, DELETE as deleteLoss } from "@/app/api/losses/[id]/route";
import { returnRow, lossRow } from "./returns-fixtures";

function req(method: string, body: unknown) { return new Request("http://test", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function params(id: string) { return { params: Promise.resolve({ id }) }; }
function res(body: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(body), { status }); }
function rpcBody(fn: string) {
  const call = supabaseRequest.mock.calls.find(c => c[0] === `rpc/${fn}`);
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

const RID = "22222222-2222-4222-8222-222222222222";
const LID = "55555555-5555-4555-8555-555555555555";
const P1 = "33333333-3333-4333-8333-333333333333";
const SI1 = "44444444-4444-4444-8444-444444444444";
const SALE_ITEM = { id: SI1, sales_order_id: "s1", purchase_id: P1, allocated_revenue: 69.71, allocated_platform_fee: 0, allocated_postage: 0, purchase_cost_snapshot: 49.99, profit: 14.72, is_active: true, created_at: "2026-08-28T00:00:00Z" };

beforeEach(() => {
  requireOwner.mockClear(); requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  supabaseRequest.mockReset(); supabaseRequestAll.mockReset();
});

describe("PATCH /api/returns/[id] — difference-based", () => {
  const COMPLETED = returnRow({ id: RID, sales_order_id: "s1", sale_item_ids: [SI1], workflow_status: "return_completed", outcome: "returned_safely", completed_on: "2026-09-03", completed_precision: "exact", recognition_month: "2026-09", restock_purchase_ids: [P1], reversed_movement_gen: 0, return_postage: 3.49, profit_reversed: 14.72, net_profit_impact: -18.21 });

  function mock(record = COMPLETED, extra: (path: string) => unknown[] | undefined = () => undefined) {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RID}`) && !init?.method) return res([record]);
      if (path === "rpc/rl_apply_return_transition") return res({ record: { ...record }, already_applied: false });
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      const e = extra(path); if (e) return e;
      if (path.startsWith("sale_items?id=in.")) return [SALE_ITEM];
      return [];
    });
  }

  it("23. changing ONLY return postage 3.49 → 5.20 recomputes the impact and plans NO inventory movement", async () => {
    mock();
    const response = await editReturn(req("PATCH", { returnPostage: 5.2 }), params(RID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_return_transition");
    expect(body.p_movements).toEqual([]);
    // net impact = -(profitReversed 1472) - postage 520 = -1992
    expect(body.p_updates.net_profit_impact).toBe(-19.92);
    expect(body.p_audit.map((e: { event_type: string }) => e.event_type)).toContain("amount_changed");
  });

  it("24. changing the completion date to October moves recognition_month; no inventory movement; audits recognition_month_changed", async () => {
    mock();
    const response = await editReturn(req("PATCH", { completedOn: "2026-10-04", completedPrecision: "exact" }), params(RID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_return_transition");
    expect(body.p_updates.recognition_month).toBe("2026-10");
    expect(body.p_movements).toEqual([]);
    expect(body.p_audit.map((e: { event_type: string }) => e.event_type)).toContain("recognition_month_changed");
  });

  it("25. increasing quantity requires saleItemIds and plans an apply movement only for the added unit", async () => {
    const P2 = "66666666-6666-4666-8666-666666666666"; const SI2 = "77777777-7777-4777-8777-777777777777";
    const withTwo = returnRow({ ...COMPLETED });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RID}`) && !init?.method) return res([withTwo]);
      if (path === "rpc/rl_apply_return_transition") return res({ record: withTwo, already_applied: false });
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?sales_order_id=eq.s1")) return [SALE_ITEM, { ...SALE_ITEM, id: SI2, purchase_id: P2 }];
      if (path.startsWith("sale_items?id=in.")) return path.includes(SI2) ? [SALE_ITEM, { ...SALE_ITEM, id: SI2, purchase_id: P2 }] : [SALE_ITEM];
      if (path.startsWith("return_records?owner_id")) return [{ id: RID, workflow_status: "return_completed", sale_item_ids: [SI1] }];
      if (path.startsWith("purchases?id=in.")) return [{ id: P1, stock_status: "in_stock" }];
      return [];
    });
    const response = await editReturn(req("PATCH", { quantity: 2, saleItemIds: [SI1, SI2] }), params(RID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_return_transition");
    expect(body.p_movements.filter((m: { purchase_id: string }) => m.purchase_id === P2)).toHaveLength(1);
    expect(body.p_movements.every((m: { purchase_id: string }) => m.purchase_id !== P1)).toBe(true); // p1 untouched
  });

  it("27. an edit that must reverse a unit which has since been sold again is BLOCKED (409)", async () => {
    mock(COMPLETED, (path) => (path.startsWith("purchases?id=in.") ? [{ id: P1, stock_status: "no_longer_in_stock" }] : undefined));
    const response = await editReturn(req("PATCH", { outcome: "buyer_refunded_no_return" }), params(RID));
    expect(response.status).toBe(409);
    expect((await response.json()).conflictingPurchaseIds).toEqual([P1]);
    expect(rpcBody("rl_apply_return_transition")).toBeNull(); // never called
  });

  it("an ACTIVE (not-completed) return edit recomputes net_profit_impact from the stored reversal + new costs — no inventory movement", async () => {
    const started = returnRow({
      id: RID, sales_order_id: "s1", sale_item_ids: [SI1], workflow_status: "return_started", outcome: null,
      completed_on: null, completed_precision: null, recognition_month: null,
      profit_reversed: 21.73, revenue_reversed: 25, return_postage: 0, unrecovered_costs: 0, other_costs: 0, net_profit_impact: -21.73,
    });
    mock(started);
    const response = await editReturn(req("PATCH", { returnPostage: 3.5, otherCosts: 1.2 }), params(RID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_return_transition");
    expect(body.p_updates.return_postage).toBe(3.5);
    expect(body.p_updates.other_costs).toBe(1.2);
    // -(2173) - 350 - 0 - 0 - 120 = -2643  ->  "-26.43"
    expect(Number(body.p_updates.net_profit_impact)).toBeCloseTo(-26.43, 2);
    expect(body.p_movements).toEqual([]);
    expect(body.p_audit.map((e: { event_type: string }) => e.event_type)).toContain("amount_changed");
  });

  it("an ACTIVE return whose selected units change re-derives the historical figures + impact from the new units", async () => {
    const P2 = "66666666-6666-4666-8666-666666666666"; const SI2 = "77777777-7777-4777-8777-777777777777";
    const started = returnRow({
      id: RID, sales_order_id: "s1", sale_item_ids: [SI1], workflow_status: "return_started", outcome: null,
      completed_on: null, completed_precision: null, recognition_month: null, quantity: 1,
      profit_reversed: 21.73, revenue_reversed: 25, return_postage: 0,
    });
    mock(started, (path) => {
      if (path.startsWith("sale_items?sales_order_id=eq.")) return [{ ...SALE_ITEM, id: SI1 }, { ...SALE_ITEM, id: SI2, purchase_id: P2, allocated_revenue: 40, profit: 30, purchase_cost_snapshot: 10 }];
      if (path.startsWith("sale_items?id=in.")) return [{ ...SALE_ITEM, id: SI1, allocated_revenue: 25, profit: 21.73, purchase_cost_snapshot: 3.27 }, { ...SALE_ITEM, id: SI2, purchase_id: P2, allocated_revenue: 40, profit: 30, purchase_cost_snapshot: 10 }];
      return undefined;
    });
    const response = await editReturn(req("PATCH", { quantity: 2, saleItemIds: [SI1, SI2] }), params(RID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_return_transition");
    expect(Number(body.p_updates.original_sale_profit)).toBeCloseTo(51.73, 2); // 21.73 + 30
    expect(Number(body.p_updates.profit_reversed)).toBeCloseTo(51.73, 2);
    expect(Number(body.p_updates.net_profit_impact)).toBeCloseTo(-51.73, 2);
    expect(body.p_movements).toEqual([]); // active return -> still no stock movement
  });
});

describe("DELETE /api/returns/[id] — soft delete + reversal", () => {
  const COMPLETED = returnRow({ id: RID, sales_order_id: "s1", sale_item_ids: [SI1], workflow_status: "return_completed", outcome: "returned_safely", restock_purchase_ids: [P1], reversed_movement_gen: 0, prev_process_status: "sent" });

  it("28. requires confirm:true, reverses the ledger + stock once, restores the sale status, soft-deletes (never deletes the sale)", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RID}`) && !init?.method) return res([COMPLETED]);
      if (path === "rpc/rl_apply_return_transition") return res({ record: { ...COMPLETED, deleted_at: "2026-09-10T00:00:00Z" }, already_applied: false });
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?id=in.")) return [SALE_ITEM];
      if (path.startsWith("purchases?id=in.")) return [{ id: P1, stock_status: "in_stock" }];
      return [];
    });
    const response = await deleteReturn(req("DELETE", { confirm: true }), params(RID));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.restoredSaleStatus).toBe("sent");
    const rpc = rpcBody("rl_apply_return_transition");
    expect(rpc.p_updates.deleted_at).toBeTruthy();
    expect(rpc.p_updates.reversed_movement_gen).toBe(1);
    expect(rpc.p_movements[0]).toMatchObject({ direction: "out_of_stock", reason: "return_reversed" });
    expect(rpc.p_audit.map((e: { event_type: string }) => e.event_type)).toEqual(expect.arrayContaining(["record_reversed", "record_deleted", "sales_status_changed"]));
    // the sale row is only ever touched via the RPC's process_status arg — never a direct sales_orders delete/patch here
    expect(supabaseRequest.mock.calls.some(c => typeof c[0] === "string" && c[0].startsWith("sales_orders") && (c[1] as RequestInit)?.method)).toBe(false);
  });

  it("without confirm:true → 400", async () => {
    const response = await deleteReturn(req("DELETE", {}), params(RID));
    expect(response.status).toBe(400);
  });

  it("29. blocked (409) when a restored unit has since been consumed", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RID}`) && !init?.method) return res([COMPLETED]);
      throw new Error(`RPC must not be called on conflict: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?id=in.")) return [SALE_ITEM];
      if (path.startsWith("purchases?id=in.")) return [{ id: P1, stock_status: "no_longer_in_stock" }];
      return [];
    });
    const response = await deleteReturn(req("DELETE", { confirm: true }), params(RID));
    expect(response.status).toBe(409);
  });

  it("an already-deleted return returns unchanged (idempotent)", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`return_records?id=eq.${RID}`)) return res([{ ...COMPLETED, deleted_at: "2026-09-01T00:00:00Z" }]);
      throw new Error(path);
    });
    const response = await deleteReturn(req("DELETE", { confirm: true }), params(RID));
    expect((await response.json()).alreadyDeleted).toBe(true);
  });
});

describe("PATCH /api/losses/[id]", () => {
  const LOSS = lossRow({ id: LID, loss_type: "lost_inventory", purchase_id: P1, written_off_purchase_ids: [P1], quantity: 1, unit_cost: 47, stock_value_removed: 47, event_month: "2026-08", event_date: "2026-08-20", reversed_movement_gen: 0 });

  it("37. changing the event month August → September moves the financial adjustment with NO inventory movement", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`loss_records?id=eq.${LID}`) && !init?.method) return res([LOSS]);
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { ...LOSS, event_month: "2026-09" }, already_applied: false });
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [{ id: P1, price_purchased: 47, stock_status: "no_longer_in_stock" }] : []));
    const response = await editLoss(req("PATCH", { eventDate: "2026-09-20", eventPrecision: "exact" }), params(LID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_loss_transition");
    expect(body.p_loss.event_month).toBe("2026-09");
    expect(body.p_movements).toEqual([]);
    expect(body.p_audit.map((e: { event_type: string }) => e.event_type)).toContain("recognition_month_changed");
  });

  it("lost → unsellable re-classifies without a second stock removal", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`loss_records?id=eq.${LID}`) && !init?.method) return res([LOSS]);
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { ...LOSS, loss_type: "unsellable_purchase" }, already_applied: false });
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [{ id: P1, price_purchased: 47, stock_status: "no_longer_in_stock" }] : []));
    const response = await editLoss(req("PATCH", { lossType: "unsellable_purchase" }), params(LID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_loss_transition");
    // reverse (back_in_stock) then apply with new reason (out_of_stock) — net one removal
    expect(body.p_movements.map((m: { direction: string; reason: string }) => [m.direction, m.reason])).toEqual([
      ["back_in_stock", "loss_reversed"], ["out_of_stock", "unsellable"],
    ]);
  });
});

describe("DELETE /api/losses/[id]", () => {
  const LOSS = lossRow({ id: LID, loss_type: "lost_inventory", purchase_id: P1, written_off_purchase_ids: [P1], reversed_movement_gen: 0 });

  it("38. restores every written-off unit to stock at ORIGINAL cost, once, and soft-deletes", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`loss_records?id=eq.${LID}`) && !init?.method) return res([LOSS]);
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { ...LOSS, deleted_at: "2026-09-10T00:00:00Z", applied: false }, already_applied: false });
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [{ id: P1, price_purchased: 47, stock_status: "no_longer_in_stock" }] : []));
    const response = await deleteLoss(req("DELETE", { confirm: true }), params(LID));
    expect(response.status).toBe(200);
    const body = rpcBody("rl_apply_loss_transition");
    expect(body.p_mode).toBe("reverse");
    expect(body.p_movements[0]).toMatchObject({ direction: "back_in_stock", reason: "loss_reversed", resulting_stock_status: "in_stock", unit_cost: "47.00" });
    expect(body.p_loss.deleted_at).toBeTruthy();
  });

  it("39. blocked (409) when a written-off unit is no longer where the reversal expects it", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`loss_records?id=eq.${LID}`) && !init?.method) return res([LOSS]);
      throw new Error(`RPC not called on conflict: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [{ id: P1, price_purchased: 47, stock_status: "in_stock" }] : []));
    const response = await deleteLoss(req("DELETE", { confirm: true }), params(LID));
    expect(response.status).toBe(409);
  });
});
