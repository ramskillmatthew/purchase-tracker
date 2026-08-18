import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequestAll } = vi.hoisted(() => ({ supabaseRequestAll: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll }));

import { loadPurchaseProtectionMap } from "@/lib/purchases-protection";

beforeEach(() => { supabaseRequestAll.mockReset(); });

describe("loadPurchaseProtectionMap", () => {
  it("REQUIREMENT (Rule 2): a purchase with an active sale_items row is protected, keyed by that item's sales_order_id", async () => {
    supabaseRequestAll
      .mockResolvedValueOnce([{ purchase_id: "p1", sales_order_id: "order-1", is_active: true }])
      .mockResolvedValueOnce([{ id: "order-1", status: "completed" }]);
    const map = await loadPurchaseProtectionMap();
    expect(map.get("p1")).toBe("order-1");
  });

  it("REQUIREMENT (Rule 3): a purchase whose only sale_items row is inactive on a cancelled order is NOT protected", async () => {
    supabaseRequestAll
      .mockResolvedValueOnce([{ purchase_id: "p1", sales_order_id: "order-1", is_active: false }])
      .mockResolvedValueOnce([{ id: "order-1", status: "cancelled" }]);
    const map = await loadPurchaseProtectionMap();
    expect(map.has("p1")).toBe(false);
  });

  it("REQUIREMENT (Rule 4): a purchase whose sale_items row is inactive but its order is STILL 'completed' (inconsistent data) is protected, not guessed safe", async () => {
    supabaseRequestAll
      .mockResolvedValueOnce([{ purchase_id: "p1", sales_order_id: "order-1", is_active: false }])
      .mockResolvedValueOnce([{ id: "order-1", status: "completed" }]);
    const map = await loadPurchaseProtectionMap();
    expect(map.get("p1")).toBe("order-1");
  });

  it("REQUIREMENT (Rule 1): a purchase with no sale_items row at all never appears in the map", async () => {
    supabaseRequestAll.mockResolvedValueOnce([]);
    const map = await loadPurchaseProtectionMap();
    expect(map.size).toBe(0);
    // No sale_items rows at all means the sales_orders follow-up query is
    // never even issued — nothing to look up.
    expect(supabaseRequestAll).toHaveBeenCalledTimes(1);
  });

  it("a purchase with multiple sale_items rows is protected if ANY of them is blocking, even if checked out of order", async () => {
    supabaseRequestAll
      .mockResolvedValueOnce([
        { purchase_id: "p1", sales_order_id: "order-1", is_active: false }, // safe (cancelled order)
        { purchase_id: "p1", sales_order_id: "order-2", is_active: true }, // blocking
      ])
      .mockResolvedValueOnce([
        { id: "order-1", status: "cancelled" },
        { id: "order-2", status: "completed" },
      ]);
    const map = await loadPurchaseProtectionMap();
    expect(map.get("p1")).toBe("order-2");
  });

  it("REQUIREMENT: excludes already-nulled sale_items rows from the query itself (purchase_id=not.is.null) — never crashes on a null purchase_id", async () => {
    supabaseRequestAll.mockResolvedValueOnce([]);
    await loadPurchaseProtectionMap();
    const [path] = supabaseRequestAll.mock.calls[0];
    expect(path).toContain("purchase_id=not.is.null");
  });

  it("REQUIREMENT: fetches sale_items and sales_orders in bounded follow-up queries, never one request per purchase", async () => {
    supabaseRequestAll
      .mockResolvedValueOnce([
        { purchase_id: "p1", sales_order_id: "order-1", is_active: true },
        { purchase_id: "p2", sales_order_id: "order-1", is_active: true },
        { purchase_id: "p3", sales_order_id: "order-2", is_active: true },
      ])
      .mockResolvedValueOnce([{ id: "order-1", status: "completed" }, { id: "order-2", status: "completed" }]);
    await loadPurchaseProtectionMap();
    expect(supabaseRequestAll).toHaveBeenCalledTimes(2);
  });
});
