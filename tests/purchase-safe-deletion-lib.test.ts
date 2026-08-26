import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest } = vi.hoisted(() => ({ supabaseRequest: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import { DELETE_PURCHASES_BATCH_SIZE, isFullyProtectedResult, safeDeletePurchases, safeDeletePurchasesInBatches } from "@/lib/purchases-delete";

beforeEach(() => { supabaseRequest.mockReset(); });

function rpcResponse(row: { requested_count: number; deleted_count: number; protected_count: number; protected_ids: string[] | null; missing_count: number }) {
  return { json: async () => [row] };
}

describe("safeDeletePurchases", () => {
  it("REQUIREMENT: calls rpc/safe_delete_purchases exactly once with the exact purchase ids under p_purchase_ids", async () => {
    supabaseRequest.mockResolvedValue(rpcResponse({ requested_count: 2, deleted_count: 2, protected_count: 0, protected_ids: [], missing_count: 0 }));
    await safeDeletePurchases(["a", "b"]);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
    const [path, init] = supabaseRequest.mock.calls[0];
    expect(path).toBe("rpc/safe_delete_purchases");
    expect(JSON.parse(init.body)).toEqual({ p_purchase_ids: ["a", "b"] });
  });

  it("maps the RPC's snake_case row to the camelCase DeletePurchasesResult shape", async () => {
    supabaseRequest.mockResolvedValue(rpcResponse({ requested_count: 3, deleted_count: 2, protected_count: 1, protected_ids: ["p1"], missing_count: 0 }));
    const result = await safeDeletePurchases(["a", "b", "c"]);
    expect(result).toEqual({ requestedCount: 3, deletedCount: 2, protectedCount: 1, protectedIds: ["p1"], missingCount: 0 });
  });

  it("a null protected_ids from the RPC becomes an empty array, never null/undefined", async () => {
    supabaseRequest.mockResolvedValue(rpcResponse({ requested_count: 1, deleted_count: 1, protected_count: 0, protected_ids: null, missing_count: 0 }));
    const result = await safeDeletePurchases(["a"]);
    expect(result.protectedIds).toEqual([]);
  });
});

describe("isFullyProtectedResult", () => {
  it("REQUIREMENT: true only when nothing was deleted AND something was protected", () => {
    expect(isFullyProtectedResult({ requestedCount: 1, deletedCount: 0, protectedCount: 1, protectedIds: ["a"], missingCount: 0 })).toBe(true);
  });

  it("false when at least one purchase was deleted, even alongside protected ones", () => {
    expect(isFullyProtectedResult({ requestedCount: 2, deletedCount: 1, protectedCount: 1, protectedIds: ["a"], missingCount: 0 })).toBe(false);
  });

  it("false when nothing was protected (e.g. everything deleted, or everything missing)", () => {
    expect(isFullyProtectedResult({ requestedCount: 1, deletedCount: 0, protectedCount: 0, protectedIds: [], missingCount: 1 })).toBe(false);
  });
});

describe("safeDeletePurchasesInBatches", () => {
  it("REQUIREMENT: an empty id list makes no request at all", async () => {
    const result = await safeDeletePurchasesInBatches([]);
    expect(supabaseRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ requestedCount: 0, deletedCount: 0, protectedCount: 0, protectedIds: [], missingCount: 0 });
  });

  it("REQUIREMENT: splits a large id list into bounded batches, never one unbounded call", async () => {
    supabaseRequest.mockImplementation(async (_path: string, init: { body: string }) => {
      const ids = (JSON.parse(init.body).p_purchase_ids as string[]);
      return rpcResponse({ requested_count: ids.length, deleted_count: ids.length, protected_count: 0, protected_ids: [], missing_count: 0 });
    });
    const ids = Array.from({ length: DELETE_PURCHASES_BATCH_SIZE * 2 + 30 }, (_, i) => `id-${i}`);
    const result = await safeDeletePurchasesInBatches(ids);
    expect(supabaseRequest).toHaveBeenCalledTimes(3);
    for (const call of supabaseRequest.mock.calls) {
      const batch = JSON.parse(call[1].body).p_purchase_ids as string[];
      expect(batch.length).toBeLessThanOrEqual(DELETE_PURCHASES_BATCH_SIZE);
    }
    expect(result.requestedCount).toBe(ids.length);
    expect(result.deletedCount).toBe(ids.length);
  });

  it("REQUIREMENT: aggregates counts and protectedIds across multiple real batches (4 ids, batch size 2)", async () => {
    supabaseRequest
      .mockResolvedValueOnce(rpcResponse({ requested_count: 2, deleted_count: 1, protected_count: 1, protected_ids: ["p1"], missing_count: 0 }))
      .mockResolvedValueOnce(rpcResponse({ requested_count: 2, deleted_count: 2, protected_count: 0, protected_ids: [], missing_count: 0 }));
    const result = await safeDeletePurchasesInBatches(["a", "b", "c", "d"], 2);
    expect(supabaseRequest).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ requestedCount: 4, deletedCount: 3, protectedCount: 1, protectedIds: ["p1"], missingCount: 0 });
  });
});
