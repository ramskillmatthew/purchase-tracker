import { describe, expect, it } from "vitest";
import { HOME_PERIOD_TO_SALES_PRESET, homeSalesChart, pendingHomeSales, recentHomeSales } from "@/lib/home-sales";
import type { SalesOrderListItem } from "@/lib/types";

function order(id: string, date: string, processStatus: SalesOrderListItem["process_status"], revenue: number, profitPence: number): SalesOrderListItem {
  return {
    id, owner_id: "owner", sale_date: date, platform: "vinted", custom_platform_name: null,
    revenue_input_mode: "total", revenue_input_value: revenue, total_revenue: revenue,
    platform_fees: 0, postage: 0, status: processStatus === "cancelled" || processStatus === "returned_cancelled" ? "cancelled" : "completed",
    process_status: processStatus, cancelled_at: null, cancellation_stock_action: null,
    created_at: `${date}T10:00:00Z`, updated_at: `${date}T10:00:00Z`, itemCount: 1, profitPence,
    itemGroups: [{ description: id, quantity: 1 }],
  };
}

describe("Home sales dashboard helpers", () => {
  it("maps every Home period to the matching Sales API preset", () => {
    expect(HOME_PERIOD_TO_SALES_PRESET).toEqual({ month: "this-month", "last-month": "last-month", "three-months": "last-3-months", year: "this-year", "last-year": "last-year", "all-time": "all-time" });
  });

  it("shows only the four active workflow states in Pending Orders", () => {
    const rows = [order("dispatch", "2026-08-01", "awaiting_dispatch", 10, 100), order("sent", "2026-08-02", "sent", 10, 100), order("payout", "2026-08-03", "delivered_awaiting_payout", 10, 100), order("return", "2026-08-04", "return_in_process", 10, 100), order("done", "2026-08-05", "completed", 10, 100), order("cancelled", "2026-08-06", "cancelled", 10, 100)];
    expect(pendingHomeSales(rows).map(row => row.id)).toEqual(["dispatch", "sent", "payout", "return"]);
  });

  it("orders Recent Sales newest first and caps it at five", () => {
    const rows = Array.from({ length: 7 }, (_, index) => order(String(index), `2026-08-0${index + 1}`, "completed", 10, 100));
    expect(recentHomeSales(rows).map(row => row.id)).toEqual(["6", "5", "4", "3", "2"]);
  });

  it("aggregates real revenue and profit into chronological chart buckets", () => {
    const points = homeSalesChart([order("b", "2026-08-02", "completed", 20, -50), order("a", "2026-08-01", "completed", 10, 300)], 2);
    expect(points.map(point => [point.label, point.revenuePence, point.profitPence])).toEqual([["1 Aug", 1000, 300], ["2 Aug", 2000, -50]]);
  });
});
