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
  it("permanently deletes only owner-scoped cancelled sales", async () => {
    supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([{ id: ID, status: "cancelled" }]))).mockResolvedValueOnce(new Response(JSON.stringify([{ id: ID }])));
    const response = await DELETE(request([ID]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1 });
    expect(supabaseRequest.mock.calls[0][0]).toContain("owner_id=eq.owner-1");
    expect(supabaseRequest.mock.calls[1][0]).toContain("status=neq.completed");
    expect(supabaseRequest.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
  });

  it("rejects active sales without deleting anything", async () => {
    supabaseRequest.mockResolvedValueOnce(new Response(JSON.stringify([{ id: ID, status: "completed" }])));
    expect((await DELETE(request([ID]))).status).toBe(409);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or foreign sales without deleting anything", async () => {
    supabaseRequest.mockResolvedValueOnce(new Response("[]"));
    expect((await DELETE(request([ID]))).status).toBe(409);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid and duplicate IDs before reaching the database", async () => {
    expect((await DELETE(request([ID, ID]))).status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});
