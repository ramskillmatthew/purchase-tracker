import { describe, expect, it } from "vitest";
import { compareHistoryOrders, computeHistoryKpis, orderMargin } from "@/lib/sales/history";
import type { SalesOrderListItem } from "@/lib/types";

function order(overrides: Partial<SalesOrderListItem> = {}): SalesOrderListItem {
  return { id: "1", owner_id: "owner", sale_date: "2026-08-18", platform: "ebay", custom_platform_name: null, revenue_input_mode: "total", revenue_input_value: 100, total_revenue: 100, platform_fees: 0, postage: 0, status: "completed", cancelled_at: null, cancellation_stock_action: null, created_at: "2026-08-18T10:00:00Z", updated_at: "2026-08-18T10:00:00Z", itemCount: 1, profitPence: 2500, itemGroups: [{ description: "Item", quantity: 1 }], ...overrides };
}

describe("sales history financial aggregation", () => {
  it("uses completed order revenue once and exact saved item profit", () => {
    const result = computeHistoryKpis([order(), order({ id: "2", total_revenue: 50, profitPence: -500 }), order({ id: "3", status: "cancelled", total_revenue: 999, profitPence: 99900 })]);
    expect(result).toEqual({ completedSales: 2, revenuePence: 15000, profitPence: 2000, margin: 2000 / 150, averageOrderPence: 7500 });
  });

  it("handles zero revenue and no completed orders", () => {
    expect(orderMargin(order({ total_revenue: 0 }))).toBe(0);
    expect(computeHistoryKpis([order({ status: "cancelled" })])).toEqual({ completedSales: 0, revenuePence: 0, profitPence: 0, margin: 0, averageOrderPence: 0 });
  });

  it("sorts globally by numeric fields with stable tie breakers", () => {
    const early = order({ id: "a", profitPence: 1000, created_at: "2026-08-18T09:00:00Z" });
    const late = order({ id: "b", profitPence: 1000, created_at: "2026-08-18T11:00:00Z" });
    expect([early, late].sort((a, b) => compareHistoryOrders(a, b, "profit", "desc")).map(row => row.id)).toEqual(["b", "a"]);
  });
});
