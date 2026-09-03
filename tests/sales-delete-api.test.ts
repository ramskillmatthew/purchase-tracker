import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { requireOwner, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1" })),
  supabaseRequest: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/auth/server")>()), requireOwner }));
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import { DELETE } from "@/app/api/sales/delete/route";

const ID = "11111111-1111-4111-8111-111111111111";
function request(ids: unknown) {
  return new Request("http://test/api/sales/delete", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ salesOrderIds: ids }) });
}

beforeEach(() => {
  requireOwner.mockReset(); requireOwner.mockResolvedValue({ id: "owner-1" });
  supabaseRequest.mockReset();
});

describe("DELETE /api/sales/delete", () => {
  it("purges an owner-scoped cancelled sale + its inactive return history via rpc/rl_purge_deletable_sale", async () => {
    supabaseRequest
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: ID, status: "cancelled" }])))          // pre-check select
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted_sales: 1, deleted_returns: 1, detached_losses: 0 }))); // the RPC
    const response = await DELETE(request([ID]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1, deletedReturns: 1, detachedLosses: 0 });
    expect(supabaseRequest.mock.calls[0][0]).toContain("owner_id=eq.owner-1");
    expect(supabaseRequest.mock.calls[1][0]).toBe("rpc/rl_purge_deletable_sale");
    expect(JSON.parse((supabaseRequest.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      p_owner_id: "owner-1", p_sales_order_ids: [ID],
    });
  });

  it("rejects a still-completed sale before calling the RPC", async () => {
    supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([{ id: ID, status: "completed" }])));
    expect((await DELETE(request([ID]))).status).toBe(409);
    expect(supabaseRequest).toHaveBeenCalledTimes(1); // no RPC
  });

  it("rejects missing or foreign sales without calling the RPC", async () => {
    supabaseRequest.mockResolvedValueOnce(new Response("[]"));
    expect((await DELETE(request([ID]))).status).toBe(409);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
  });

  it("surfaces the RPC's 'active return blocks delete' as a clear 409", async () => {
    supabaseRequest
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: ID, status: "cancelled" }])))
      .mockRejectedValueOnce(new Error('… raised: active_return_blocks_delete …'));
    const response = await DELETE(request([ID]));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.reason).toBe("active_return_blocks_delete");
    expect(body.error).toMatch(/active return/i);
  });

  it("propagates an unrecognised RPC failure as a safe 500 (never a false 409)", async () => {
    supabaseRequest
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: ID, status: "cancelled" }])))
      .mockRejectedValueOnce(new Error("connection reset"));
    expect((await DELETE(request([ID]))).status).toBe(500);
  });

  it("rejects invalid and duplicate IDs before reaching the database", async () => {
    expect((await DELETE(request([ID, ID]))).status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});
