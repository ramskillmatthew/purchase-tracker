import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real data-path tests for the Returns/Losses API routes — mocked Supabase
 * (no live DB in this suite; see tests/sales-api-routes.test.ts's own
 * convention). Every multi-table mutation now goes through ONE transactional
 * RPC (rl_create_return / rl_apply_return_transition / rl_apply_loss_
 * transition), so these assert the route computes the right plan + calls the
 * right RPC + classifies its result. The migration + RPC bodies themselves
 * are validated structurally (tests/returns-losses-migration.test.ts) — they
 * are NOT executed here.
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

import { POST as createReturn } from "@/app/api/returns/route";
import { POST as completeReturn } from "@/app/api/returns/[id]/complete/route";
import { POST as cancelReturn } from "@/app/api/returns/[id]/cancel/route";
import { POST as advanceStage } from "@/app/api/returns/[id]/status/route";
import { POST as createLoss } from "@/app/api/losses/route";

function jsonRequest(body: unknown) { return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function params(id: string) { return { params: Promise.resolve({ id }) }; }
function res(body: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(body), { status }); }

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const RETURN_ID = "22222222-2222-4222-8222-222222222222";
const PURCHASE_ID = "33333333-3333-4333-8333-333333333333";
const SALE_ITEM_ID = "44444444-4444-4444-8444-444444444444";

const SALE_ORDER = {
  id: SALE_ID, owner_id: "owner-1", sale_date: "2026-08-28", platform: "ebay", custom_platform_name: null,
  status: "completed", process_status: "awaiting_dispatch", total_revenue: 69.71, platform_fees: 0, postage: 0,
  created_at: "2026-08-28T10:00:00Z", updated_at: "2026-08-28T10:00:00Z",
};
const SALE_ITEM = {
  id: SALE_ITEM_ID, sales_order_id: SALE_ID, purchase_id: PURCHASE_ID, sku_snapshot: "1644",
  item_description_snapshot: "On Running Cloud 5", category_snapshot: "Footwear", item_condition_snapshot: "Used",
  condition_group_snapshot: "used", purchase_cost_snapshot: 49.99, purchased_from_snapshot: "Vinted",
  allocated_revenue: 69.71, allocated_platform_fee: 0, allocated_postage: 0, profit: 14.72, is_active: true,
  created_at: "2026-08-28T10:00:00Z",
};
const ACTIVE_RETURN = {
  id: RETURN_ID, owner_id: "owner-1", reference: "RET-00042", sales_order_id: SALE_ID, quantity: 1,
  sale_item_ids: [SALE_ITEM_ID], workflow_status: "return_started", outcome: null,
  completed_on: null, completed_precision: null, recognition_month: null,
  prev_process_status: "awaiting_dispatch", restock_purchase_ids: [], reversed_movement_gen: 0,
  completed_applied: false, cancelled_applied: false, deleted_at: null,
  return_postage: 0, unrecovered_costs: 0, other_costs: 0, partial_refund_amount: null, notes: null,
};

beforeEach(() => {
  requireOwner.mockClear();
  requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
});

/** Every RPC call captured, keyed by function name, with the body it received. */
function rpcCalls(fn: string) {
  return supabaseRequest.mock.calls
    .filter(c => typeof c[0] === "string" && c[0] === `rpc/${fn}`)
    .map(c => JSON.parse((c[1] as RequestInit).body as string));
}

describe("POST /api/returns — create (transactional)", () => {
  it("1/5/9. links the sale, stores the EXACT sale_item ids, and calls rl_create_return moving the sale to return_in_process", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`sales_orders?id=eq.${SALE_ID}`)) return res([SALE_ORDER]);
      if (path === "rpc/next_return_loss_reference") return res("RET-00042");
      if (path === "rpc/rl_create_return") return res({ record: { ...ACTIVE_RETURN } });
      throw new Error(`unexpected supabaseRequest ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith(`sale_items?sales_order_id=eq.${SALE_ID}`)) return [SALE_ITEM];
      if (path.startsWith("return_records?")) return [];
      return [];
    });

    const response = await createReturn(jsonRequest({ salesOrderId: SALE_ID, quantity: 1, startedOn: "2026-09-01", startedPrecision: "exact" }));
    expect(response.status).toBe(201);
    const [call] = rpcCalls("rl_create_return");
    expect(call.p_return.sale_item_ids).toEqual([SALE_ITEM_ID]);
    expect(call.p_sale_process_status).toBe("return_in_process");
    expect(call.p_audit.map((e: { event_type: string }) => e.event_type)).toEqual(["record_created", "sale_linked", "sales_status_changed"]);
  });

  it("active-return accounting: create stores original_sale_* + a provisional full reversal + net_profit_impact = -(unit profit)", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`sales_orders?id=eq.${SALE_ID}`)) return res([SALE_ORDER]);
      if (path === "rpc/next_return_loss_reference") return res("RET-1");
      if (path === "rpc/rl_create_return") return res({ record: { ...ACTIVE_RETURN } });
      throw new Error(`unexpected ${path}`);
    });
    // Single unit: £25.00 revenue, £21.73 profit, £3.27 cost (the live-test figures).
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith(`sale_items?sales_order_id=eq.${SALE_ID}`)) {
        return [{ ...SALE_ITEM, allocated_revenue: 25, profit: 21.73, purchase_cost_snapshot: 3.27 }];
      }
      if (path.startsWith("return_records?")) return [];
      return [];
    });
    const response = await createReturn(jsonRequest({ salesOrderId: SALE_ID, quantity: 1, startedOn: "2026-09-02", startedPrecision: "exact" }));
    expect(response.status).toBe(201);
    const [call] = rpcCalls("rl_create_return");
    expect(Number(call.p_return.original_sale_revenue)).toBeCloseTo(25, 2);
    expect(Number(call.p_return.original_sale_profit)).toBeCloseTo(21.73, 2);
    expect(Number(call.p_return.original_stock_cost)).toBeCloseTo(3.27, 2);
    expect(Number(call.p_return.revenue_reversed)).toBeCloseTo(25, 2);
    expect(Number(call.p_return.profit_reversed)).toBeCloseTo(21.73, 2);
    expect(Number(call.p_return.net_profit_impact)).toBeCloseTo(-21.73, 2); // NOT £0, NOT -£25 (revenue)
  });

  it("active-return accounting: a £25 profit sale produces -£25; a loss-making (-£5) sale produces +£5", async () => {
    async function impactFor(profit: number) {
      supabaseRequest.mockImplementation(async (path: string) => {
        if (path.startsWith(`sales_orders?id=eq.${SALE_ID}`)) return res([SALE_ORDER]);
        if (path === "rpc/next_return_loss_reference") return res("RET-x");
        if (path === "rpc/rl_create_return") return res({ record: { ...ACTIVE_RETURN } });
        throw new Error(path);
      });
      supabaseRequestAll.mockImplementation(async (path: string) => {
        if (path.startsWith(`sale_items?sales_order_id=eq.${SALE_ID}`)) return [{ ...SALE_ITEM, allocated_revenue: 25, profit, purchase_cost_snapshot: 5 }];
        if (path.startsWith("return_records?")) return [];
        return [];
      });
      await createReturn(jsonRequest({ salesOrderId: SALE_ID, quantity: 1, startedOn: "2026-09-02" }));
      return Number(rpcCalls("rl_create_return").at(-1)!.p_return.net_profit_impact);
    }
    expect(await impactFor(25)).toBeCloseTo(-25, 2);
    expect(await impactFor(-5)).toBeCloseTo(5, 2);
  });

  it("active-return accounting: a partial multi-unit return reverses only the SELECTED units' profit", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`sales_orders?id=eq.${SALE_ID}`)) return res([SALE_ORDER]);
      if (path === "rpc/next_return_loss_reference") return res("RET-p");
      if (path === "rpc/rl_create_return") return res({ record: { ...ACTIVE_RETURN } });
      throw new Error(path);
    });
    // 3 sold units; return quantity 1 -> selectSaleItemIdsForReturn takes the FIRST eligible.
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith(`sale_items?sales_order_id=eq.${SALE_ID}`)) return [
        { ...SALE_ITEM, id: "u1", allocated_revenue: 10, profit: 8, purchase_cost_snapshot: 2 },
        { ...SALE_ITEM, id: "u2", allocated_revenue: 20, profit: 15, purchase_cost_snapshot: 5 },
        { ...SALE_ITEM, id: "u3", allocated_revenue: 30, profit: 25, purchase_cost_snapshot: 5 },
      ];
      if (path.startsWith("return_records?")) return [];
      return [];
    });
    await createReturn(jsonRequest({ salesOrderId: SALE_ID, quantity: 1, startedOn: "2026-09-02" }));
    const [call] = rpcCalls("rl_create_return");
    expect(call.p_return.sale_item_ids).toEqual(["u1"]);
    expect(Number(call.p_return.profit_reversed)).toBeCloseTo(8, 2); // only u1, never 8+15+25
    expect(Number(call.p_return.net_profit_impact)).toBeCloseTo(-8, 2);
  });

  it("7. rejects when every unit of the sale is already tied to an active return", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`sales_orders?id=eq.${SALE_ID}`)) return res([SALE_ORDER]);
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith(`sale_items?sales_order_id=eq.${SALE_ID}`)) return [SALE_ITEM];
      if (path.startsWith("return_records?")) return [{ workflow_status: "return_started", sale_item_ids: [SALE_ITEM_ID] }];
      return [];
    });
    const response = await createReturn(jsonRequest({ salesOrderId: SALE_ID, quantity: 1, startedOn: "2026-09-01" }));
    expect(response.status).toBe(409);
    expect((await response.json()).kind).toBe("conflict");
  });

  it("8/52. a sale belonging to another owner is never found (owner_id filter) → 404", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      expect(path).toContain("owner_id=eq.owner-1");
      if (path.startsWith("sales_orders?")) return res([]);
      throw new Error(`unexpected ${path}`);
    });
    const response = await createReturn(jsonRequest({ salesOrderId: SALE_ID, quantity: 1, startedOn: "2026-09-01" }));
    expect(response.status).toBe(404);
  });
});

describe("POST /api/returns/[id]/status — advance stage", () => {
  function mockStage(current: string) {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`return_records?id=eq.${RETURN_ID}`)) return res([{ ...ACTIVE_RETURN, workflow_status: current }]);
      if (path === "rpc/rl_apply_return_transition") return res({ record: { ...ACTIVE_RETURN, workflow_status: "item_sent" }, already_applied: false });
      throw new Error(`unexpected ${path}`);
    });
  }

  it("2. return_started → item_sent succeeds, records item_sent_on + precision, keeps the sale at return_in_process", async () => {
    mockStage("return_started");
    const response = await advanceStage(jsonRequest({ stage: "item_sent", date: "2026-09-02", precision: "exact" }), params(RETURN_ID));
    expect(response.status).toBe(200);
    const [call] = rpcCalls("rl_apply_return_transition");
    expect(call.p_updates).toMatchObject({ workflow_status: "item_sent", item_sent_on: "2026-09-02", item_sent_precision: "exact" });
    expect(call.p_sale_process_status).toBe("return_in_process");
  });

  it("3. an invalid backward transition (return_delivered → item_sent) is rejected 409", async () => {
    mockStage("return_delivered");
    const response = await advanceStage(jsonRequest({ stage: "item_sent", date: "2026-09-02" }), params(RETURN_ID));
    expect(response.status).toBe(409);
  });

  it("3. a completed return cannot change stage", async () => {
    mockStage("return_completed");
    const response = await advanceStage(jsonRequest({ stage: "item_sent", date: "2026-09-02" }), params(RETURN_ID));
    expect(response.status).toBe(409);
  });

  it("4. setting the stage it is already at is an idempotent no-op (no RPC call)", async () => {
    mockStage("item_sent");
    const response = await advanceStage(jsonRequest({ stage: "item_sent", date: "2026-09-02" }), params(RETURN_ID));
    const body = await response.json();
    expect(body.alreadyApplied).toBe(true);
    expect(rpcCalls("rl_apply_return_transition")).toHaveLength(0);
  });
});

describe("POST /api/returns/[id]/complete — transactional", () => {
  function mockComplete(recordOverrides: Record<string, unknown> = {}, rpc: (body: unknown) => Response = () => res({ record: { ...ACTIVE_RETURN, workflow_status: "return_completed", completed_applied: true }, already_applied: false })) {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RETURN_ID}`) && !init?.method) return res([{ ...ACTIVE_RETURN, ...recordOverrides }]);
      if (path === "rpc/rl_apply_return_transition") return rpc(JSON.parse((init as RequestInit).body as string));
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("sale_items?id=in.") ? [SALE_ITEM] : []));
  }

  it("3/6/12/13. returned_safely: reverses profit + postage, restores stock at ORIGINAL cost (49.99, not 69.71), sets sale to returned_cancelled", async () => {
    mockComplete();
    const response = await completeReturn(jsonRequest({ outcome: "returned_safely", completedOn: "2026-09-03", returnPostage: 3.49 }), params(RETURN_ID));
    const body = await response.json();
    expect(body.impact.stockValueRestoredPence).toBe(4999);
    expect(body.impact.profitReversedPence).toBe(1472);
    expect(body.impact.netProfitImpactPence).toBe(-(1472 + 349)); // -£18.21
    const [call] = rpcCalls("rl_apply_return_transition");
    expect(call.p_sale_process_status).toBe("returned_cancelled");
    expect(call.p_updates.recognition_month).toBe("2026-09");
    expect(call.p_movements[0]).toMatchObject({ direction: "back_in_stock", reason: "returned_to_stock", resulting_stock_status: "in_stock", unit_cost: "49.99" });
    expect(call.p_expect_not_applied).toBe("completed");
  });

  it("14/15. buyer_refunded_no_return: does NOT restock, writes the unit off once, adds the inventory write-off to the impact", async () => {
    mockComplete();
    const response = await completeReturn(jsonRequest({ outcome: "buyer_refunded_no_return", completedOn: "2026-09-03", returnPostage: 3.49 }), params(RETURN_ID));
    const body = await response.json();
    expect(body.impact.stockValueRestoredPence).toBe(0);
    expect(body.impact.inventoryWriteOffPence).toBe(4999);
    expect(body.impact.netProfitImpactPence).toBe(-(1472 + 349 + 4999));
    const [call] = rpcCalls("rl_apply_return_transition");
    expect(call.p_movements[0]).toMatchObject({ direction: "out_of_stock", reason: "refunded_no_return", resulting_stock_status: "no_longer_in_stock" });
  });

  it("17. partial refund reverses the ACTUAL refunded amount, not a proportional revenue share", async () => {
    mockComplete();
    const response = await completeReturn(jsonRequest({ outcome: "returned_safely", completedOn: "2026-09-03", refundMode: "partial", partialRefundAmount: 20 }), params(RETURN_ID));
    const body = await response.json();
    expect(body.impact.revenueReversedPence).toBe(2000);
  });

  it("23. repeated completion is idempotent — completed_applied already true short-circuits with no RPC call", async () => {
    mockComplete({ completed_applied: true, workflow_status: "return_completed" });
    const response = await completeReturn(jsonRequest({ outcome: "returned_safely", completedOn: "2026-09-03" }), params(RETURN_ID));
    expect((await response.json()).alreadyApplied).toBe(true);
    expect(rpcCalls("rl_apply_return_transition")).toHaveLength(0);
  });

  it("21. the linked August sale row is NEVER written by completion (only its process_status via the RPC arg)", async () => {
    mockComplete();
    await completeReturn(jsonRequest({ outcome: "returned_safely", completedOn: "2026-09-03" }), params(RETURN_ID));
    // no direct PATCH to sales_orders — the RPC does it, and it only ever touches process_status/updated_at
    expect(supabaseRequest.mock.calls.some(c => typeof c[0] === "string" && c[0].startsWith("sales_orders?") && (c[1] as RequestInit)?.method === "PATCH")).toBe(false);
  });
});

describe("POST /api/returns/[id]/cancel — transactional", () => {
  const COMPLETED = { ...ACTIVE_RETURN, workflow_status: "return_completed", outcome: "returned_safely", restock_purchase_ids: [PURCHASE_ID], completed_applied: true };

  it("7/20/21. reverses the restock, restores the sale to the snapshotted status, marks return_cancelled, bumps the movement generation", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RETURN_ID}`) && !init?.method) return res([COMPLETED]);
      if (path === "rpc/rl_apply_return_transition") return res({ record: { ...COMPLETED, workflow_status: "return_cancelled" }, already_applied: false });
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?id=in.")) return [SALE_ITEM];
      if (path.startsWith("purchases?id=in.")) return [{ id: PURCHASE_ID, stock_status: "in_stock" }];
      return [];
    });
    const response = await cancelReturn(jsonRequest({}), params(RETURN_ID));
    const body = await response.json();
    expect(body.restoredSaleStatus).toBe("awaiting_dispatch");
    const [call] = rpcCalls("rl_apply_return_transition");
    expect(call.p_updates).toMatchObject({ workflow_status: "return_cancelled", cancelled_applied: true, reversed_movement_gen: 1 });
    expect(call.p_movements[0]).toMatchObject({ direction: "out_of_stock", reason: "return_reversed" });
    expect(call.p_stock_checks[0]).toEqual({ purchase_id: PURCHASE_ID, expected: "in_stock" });
  });

  it("20. blocked with 409 + conflictingPurchaseIds when a restocked unit was sold again since", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RETURN_ID}`) && !init?.method) return res([COMPLETED]);
      throw new Error(`must not call the RPC on a conflict: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?id=in.")) return [SALE_ITEM];
      if (path.startsWith("purchases?id=in.")) return [{ id: PURCHASE_ID, stock_status: "no_longer_in_stock" }];
      return [];
    });
    const response = await cancelReturn(jsonRequest({}), params(RETURN_ID));
    expect(response.status).toBe(409);
    expect((await response.json()).conflictingPurchaseIds).toEqual([PURCHASE_ID]);
  });

  it("24. repeated cancellation is idempotent", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`return_records?id=eq.${RETURN_ID}`)) return res([{ ...COMPLETED, workflow_status: "return_cancelled" }]);
      throw new Error(`unexpected ${path}`);
    });
    const response = await cancelReturn(jsonRequest({}), params(RETURN_ID));
    expect((await response.json()).alreadyApplied).toBe(true);
  });

  it("audit-fix regression 1: cancelling a COMPLETED return retains outcome / recognition_month / completed_on — p_updates never nulls them, so the one-directional completed_shape constraint is not violated", async () => {
    const COMPLETED_WITH_HISTORY = {
      ...COMPLETED, recognition_month: "2026-09", completed_on: "2026-09-03", completed_precision: "exact",
    };
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`return_records?id=eq.${RETURN_ID}`) && !init?.method) return res([COMPLETED_WITH_HISTORY]);
      if (path === "rpc/rl_apply_return_transition") {
        return res({ record: { ...COMPLETED_WITH_HISTORY, workflow_status: "return_cancelled" }, already_applied: false });
      }
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("sale_items?id=in.")) return [SALE_ITEM];
      if (path.startsWith("purchases?id=in.")) return [{ id: PURCHASE_ID, stock_status: "in_stock" }];
      return [];
    });

    const response = await cancelReturn(jsonRequest({}), params(RETURN_ID));
    expect(response.status).toBe(200);
    const [call] = rpcCalls("rl_apply_return_transition");
    // Moves the workflow status, reverses movements — but does NOT touch the
    // historical completion fields (their keys are simply absent from p_updates,
    // so the RPC's `case when p_updates ? 'x'` leaves the stored values).
    expect(call.p_updates.workflow_status).toBe("return_cancelled");
    expect(call.p_updates).not.toHaveProperty("outcome");
    expect(call.p_updates).not.toHaveProperty("recognition_month");
    expect(call.p_updates).not.toHaveProperty("completed_on");
    // and the returned record still carries them
    const body = await response.json();
    expect(body.record.outcome).toBe("returned_safely");
    expect(body.record.recognition_month).toBe("2026-09");
    expect(body.record.completed_on).toBe("2026-09-03");
  });
});

describe("POST /api/losses — create (transactional)", () => {
  const IN_STOCK = { id: PURCHASE_ID, price_purchased: 47, stock_status: "in_stock", sku: "1712", item_description: "Nike Tech Fleece", purchased_from: "Vinted", order_date: "2026-08-01" };

  it("30/31/32/34/35. lost_inventory: requires the purchase, marks it out of stock via a 'lost' movement at the ORIGINAL cost", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [IN_STOCK] : []));
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/next_return_loss_reference") return res("LOS-00001");
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { id: "loss-1", stock_value_removed: 47, written_off_purchase_ids: [PURCHASE_ID], applied: true }, already_applied: false });
      throw new Error(`unexpected ${path}`);
    });
    const response = await createLoss(jsonRequest({ lossType: "lost_inventory", purchaseIds: [PURCHASE_ID], eventDate: "2026-09-05", eventPrecision: "exact", stockAction: "remove_from_stock" }));
    expect(response.status).toBe(201);
    expect((await response.json()).impact.stockValueRemovedPence).toBe(4700);
    const [call] = rpcCalls("rl_apply_loss_transition");
    expect(call.p_mode).toBe("create");
    expect(call.p_movements[0]).toMatchObject({ reason: "lost", direction: "out_of_stock", resulting_stock_status: "no_longer_in_stock", unit_cost: "47.00" });
    expect(call.p_loss.event_month).toBe("2026-09");
  });

  it("30. a lost_inventory record with no purchaseIds is rejected (400) before any write", async () => {
    const response = await createLoss(jsonRequest({ lossType: "lost_inventory", purchaseIds: [], eventDate: "2026-09-05" }));
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("a unit already out of stock cannot be written off again (409)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [{ ...IN_STOCK, stock_status: "no_longer_in_stock" }] : []));
    const response = await createLoss(jsonRequest({ lossType: "lost_inventory", purchaseIds: [PURCHASE_ID], eventDate: "2026-09-05", stockAction: "remove_from_stock" }));
    expect(response.status).toBe(409);
  });

  it("34. unsellable_purchase uses a distinct 'unsellable' movement reason", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("purchases?id=in.") ? [IN_STOCK] : []));
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/next_return_loss_reference") return res("LOS-00002");
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { id: "loss-2" }, already_applied: false });
      throw new Error(path);
    });
    await createLoss(jsonRequest({ lossType: "unsellable_purchase", purchaseIds: [PURCHASE_ID], eventDate: "2026-09-05", stockAction: "remove_from_stock" }));
    expect(rpcCalls("rl_apply_loss_transition")[0].p_movements[0].reason).toBe("unsellable");
  });

  it("other_write_off with keep-in-stock plans no movement and no stock removal", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/next_return_loss_reference") return res("LOS-00003");
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { id: "loss-3" }, already_applied: false });
      throw new Error(path);
    });
    await createLoss(jsonRequest({ lossType: "other_write_off", purchaseIds: [], otherCosts: 12, eventDate: "2026-09-05", stockAction: "keep_in_stock", notes: "adjustment" }));
    const [call] = rpcCalls("rl_apply_loss_transition");
    expect(call.p_movements).toEqual([]);
    expect(Number(call.p_loss.stock_value_removed)).toBe(0);
  });
});

describe("POST /api/losses — creation idempotency (audit-fix Defect 5)", () => {
  const KEY = "9b7c1e2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d";

  it("8. two submits carrying the SAME idempotencyKey record ONE loss — the second gets the existing row back (already_applied), no duplicate", async () => {
    const existing = { id: "loss-1", reference: "LOS-00001", loss_type: "other_write_off", idempotency_key: KEY, applied: true };
    let calls = 0;
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/next_return_loss_reference") return res("LOS-00001");
      if (path === "rpc/rl_apply_loss_transition") {
        calls += 1;
        // 1st call inserts; 2nd hits `on conflict ... do nothing` and the RPC
        // returns the already-created row.
        return res({ record: existing, already_applied: calls > 1 });
      }
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async () => []);

    const first = await createLoss(jsonRequest({ lossType: "other_write_off", purchaseIds: [], otherCosts: 5, eventDate: "2026-09-05", stockAction: "keep_in_stock", idempotencyKey: KEY }));
    const second = await createLoss(jsonRequest({ lossType: "other_write_off", purchaseIds: [], otherCosts: 5, eventDate: "2026-09-05", stockAction: "keep_in_stock", idempotencyKey: KEY }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).alreadyApplied).toBe(true);
    // both RPC calls carried the same key so the DB partial-unique index dedups
    for (const c of rpcCalls("rl_apply_loss_transition")) expect(c.p_loss.idempotency_key).toBe(KEY);
    expect(rpcCalls("rl_apply_loss_transition")).toHaveLength(2);
  });

  it("8. refund_without_return (no purchase) also threads the key — the vector the audit called out", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/next_return_loss_reference") return res("LOS-00002");
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { id: "loss-2", idempotency_key: KEY }, already_applied: false });
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async () => []); // no matching return -> no cross-table conflict
    await createLoss(jsonRequest({ lossType: "refund_without_return", purchaseIds: [], saleItemIds: [], customerRefund: 20, eventDate: "2026-09-05", stockAction: "keep_in_stock", idempotencyKey: KEY }));
    expect(rpcCalls("rl_apply_loss_transition")[0].p_loss.idempotency_key).toBe(KEY);
  });

  it("9. two DIFFERENT idempotencyKeys record TWO distinct losses (legitimate separate events are never blocked)", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/next_return_loss_reference") return res("LOS-0000x");
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { id: "loss-x" }, already_applied: false });
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async () => []);
    const a = await createLoss(jsonRequest({ lossType: "other_write_off", purchaseIds: [], otherCosts: 5, eventDate: "2026-09-05", stockAction: "keep_in_stock", idempotencyKey: "11111111-1111-4111-8111-111111111111" }));
    const b = await createLoss(jsonRequest({ lossType: "other_write_off", purchaseIds: [], otherCosts: 9, eventDate: "2026-09-06", stockAction: "keep_in_stock", idempotencyKey: "22222222-2222-4222-8222-222222222222" }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const keys = rpcCalls("rl_apply_loss_transition").map(c => c.p_loss.idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });

  it("9. omitting idempotencyKey stays valid (backward compatible) — the key is passed through as empty, DB treats it as NULL / unconstrained", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/next_return_loss_reference") return res("LOS-00009");
      if (path === "rpc/rl_apply_loss_transition") return res({ record: { id: "loss-9" }, already_applied: false });
      throw new Error(`unexpected ${path}`);
    });
    supabaseRequestAll.mockImplementation(async () => []);
    const r = await createLoss(jsonRequest({ lossType: "other_write_off", purchaseIds: [], otherCosts: 1, eventDate: "2026-09-05", stockAction: "keep_in_stock" }));
    expect(r.status).toBe(201);
    expect(rpcCalls("rl_apply_loss_transition")[0].p_loss.idempotency_key).toBe("");
  });

  it("10. a non-UUID idempotencyKey is rejected (400) before any write — no unsafe keys reach the DB", async () => {
    const r = await createLoss(jsonRequest({ lossType: "other_write_off", purchaseIds: [], eventDate: "2026-09-05", stockAction: "keep_in_stock", idempotencyKey: "not-a-uuid" }));
    expect(r.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});

describe("54. public errors never leak DB detail", () => {
  it("an opaque RPC failure surfaces the route's safe fallback message, not the raw error", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith(`sales_orders?id=eq.${SALE_ID}`)) return res([SALE_ORDER]);
      if (path === "rpc/next_return_loss_reference") return res("RET-1");
      if (path === "rpc/rl_create_return") { const e = new Error('duplicate key value violates unique constraint "return_records_pkey"') as Error & { status: number }; e.status = 409; throw e; }
      throw new Error(path);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("sale_items") ? [SALE_ITEM] : []));
    const response = await createReturn(jsonRequest({ salesOrderId: SALE_ID, quantity: 1, startedOn: "2026-09-01" }));
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/constraint|duplicate key|pkey/i);
  });
});
