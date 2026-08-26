import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/auth/server")>()), requireOwner }));
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import { PATCH } from "@/app/api/sales/[id]/process-status/route";
import { AuthError } from "@/lib/auth/server";

const ID = "11111111-1111-4111-8111-111111111111";
const baseOrder = { id: ID, owner_id: "owner-1", status: "completed", process_status: "completed" };
const ctx = { params: Promise.resolve({ id: ID }) };
function request(processStatus: unknown) {
  return new Request(`http://test/api/sales/${ID}/process-status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processStatus }) });
}

beforeEach(() => {
  requireOwner.mockReset(); requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  supabaseRequest.mockReset();
  supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([baseOrder]), { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
});

describe("PATCH /api/sales/[id]/process-status", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    expect((await PATCH(request("sent"), ctx)).status).toBe(401);
  });

  it("rejects every invalid status without writing", async () => {
    const response = await PATCH(request("shipped-ish"), ctx);
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it.each(["awaiting_dispatch", "sent", "delivered_awaiting_payout", "completed", "return_in_process"])("persists active status %s with owner scoping", async processStatus => {
    const response = await PATCH(request(processStatus), ctx);
    expect(response.status).toBe(200);
    const patch = supabaseRequest.mock.calls[1];
    expect(patch[0]).toBe(`sales_orders?id=eq.${ID}&owner_id=eq.owner-1`);
    expect(JSON.parse(patch[1].body)).toMatchObject({ process_status: processStatus });
    expect(JSON.parse(patch[1].body)).not.toHaveProperty("status");
    expect(JSON.parse(patch[1].body)).not.toHaveProperty("total_revenue");
  });

  it("does not expose another owner's sale", async () => {
    supabaseRequest.mockReset(); supabaseRequest.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    expect((await PATCH(request("sent"), ctx)).status).toBe(404);
  });

  it.each(["cancelled", "returned_cancelled"])("requires the atomic cancellation workflow before terminal status %s", async processStatus => {
    expect((await PATCH(request(processStatus), ctx)).status).toBe(409);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "returned_cancelled"])("allows terminal status %s on a financially cancelled sale", async processStatus => {
    supabaseRequest.mockReset();
    supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([{ ...baseOrder, status: "cancelled" }]), { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await PATCH(request(processStatus), ctx)).status).toBe(200);
  });

  it("rejects active fulfilment states on a financially cancelled sale", async () => {
    supabaseRequest.mockReset();
    supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([{ ...baseOrder, status: "cancelled" }]), { status: 200 }));
    expect((await PATCH(request("sent"), ctx)).status).toBe(409);
  });
});
