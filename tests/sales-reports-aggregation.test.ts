import { describe, expect, it } from "vitest";
import {
  computeCategoryBreakdown,
  computeChartSeries,
  computeConditionGroupBreakdown,
  computePlatformBreakdown,
  computeReportSummary,
  isDailyGranularitySensible,
  MAX_DAILY_SPAN_DAYS,
  type ReportableSaleItem,
  type ReportableSalesOrder,
} from "@/lib/sales/reporting";

function order(id: string, saleDate: string, platform: ReportableSalesOrder["platform"] = "vinted", customPlatformName: string | null = null): ReportableSalesOrder {
  return { id, sale_date: saleDate, platform, custom_platform_name: customPlatformName };
}

function item(overrides: Partial<ReportableSaleItem> & { sales_order_id: string }): ReportableSaleItem {
  return {
    category_snapshot: "Pokémon",
    condition_group_snapshot: "new",
    purchase_cost_snapshot: 5,
    allocated_revenue: 10,
    allocated_platform_fee: 1,
    allocated_postage: 0.5,
    ...overrides,
  };
}

describe("computeReportSummary", () => {
  it("zero orders / zero items resolves every average to null, not NaN or a fabricated 0", () => {
    const summary = computeReportSummary([], []);
    expect(summary).toEqual({
      revenuePence: 0, profitPence: 0, stockCostPence: 0, feesPence: 0, postagePence: 0,
      orders: 0, units: 0, averageOrderValuePence: null, averageProfitPerUnitPence: null, marginPercent: null,
    });
  });

  it("an order with no items yet still reports the order count, with every money figure at zero", () => {
    const summary = computeReportSummary([order("o1", "2026-08-01")], []);
    expect(summary.orders).toBe(1);
    expect(summary.revenuePence).toBe(0);
    expect(summary.units).toBe(0);
  });

  it("REQUIREMENT: profit = revenue - stock cost - fees - postage, in integer pence", () => {
    const orders = [order("o1", "2026-08-01")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 20, purchase_cost_snapshot: 8, allocated_platform_fee: 2, allocated_postage: 1 })];
    const summary = computeReportSummary(orders, items);
    expect(summary.revenuePence).toBe(2000);
    expect(summary.stockCostPence).toBe(800);
    expect(summary.feesPence).toBe(200);
    expect(summary.postagePence).toBe(100);
    expect(summary.profitPence).toBe(2000 - 800 - 200 - 100);
  });

  it("REQUIREMENT: negative profit (a loss) is preserved, never clamped to zero", () => {
    const orders = [order("o1", "2026-08-01")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 5, purchase_cost_snapshot: 20, allocated_platform_fee: 0, allocated_postage: 0 })];
    const summary = computeReportSummary(orders, items);
    expect(summary.profitPence).toBe(500 - 2000);
    expect(summary.profitPence).toBeLessThan(0);
  });

  it("units = number of sale_items, independent of order count (multiple units per order)", () => {
    const orders = [order("o1", "2026-08-01")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 10 }),
      item({ sales_order_id: "o1", allocated_revenue: 10 }),
      item({ sales_order_id: "o1", allocated_revenue: 10 }),
    ];
    const summary = computeReportSummary(orders, items);
    expect(summary.units).toBe(3);
    expect(summary.orders).toBe(1);
    expect(summary.revenuePence).toBe(3000); // REQUIREMENT: order totals are not multiplied by joining one order to 3 items — this is 3x item revenue, not 3x an order-level total.
  });

  it("averageOrderValuePence = revenue / orders (not revenue / units)", () => {
    const orders = [order("o1", "2026-08-01"), order("o2", "2026-08-02")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 10 }),
      item({ sales_order_id: "o1", allocated_revenue: 10 }),
      item({ sales_order_id: "o2", allocated_revenue: 10 }),
    ];
    const summary = computeReportSummary(orders, items);
    expect(summary.revenuePence).toBe(3000);
    expect(summary.averageOrderValuePence).toBe(1500); // 3000 / 2 orders
  });

  it("averageProfitPerUnitPence = profit / units", () => {
    const orders = [order("o1", "2026-08-01")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 10, purchase_cost_snapshot: 4, allocated_platform_fee: 0, allocated_postage: 0 }),
      item({ sales_order_id: "o1", allocated_revenue: 10, purchase_cost_snapshot: 2, allocated_platform_fee: 0, allocated_postage: 0 }),
    ];
    const summary = computeReportSummary(orders, items);
    expect(summary.profitPence).toBe(600 + 800);
    expect(summary.averageProfitPerUnitPence).toBe(700);
  });

  it("marginPercent is null when revenue is zero, never a fabricated 0% or Infinity", () => {
    const orders = [order("o1", "2026-08-01")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 0, purchase_cost_snapshot: 0, allocated_platform_fee: 0, allocated_postage: 0 })];
    const summary = computeReportSummary(orders, items);
    expect(summary.marginPercent).toBeNull();
  });

  it("handles more than 1,000 sale items without error, and every total is the exact sum", () => {
    const orders = Array.from({ length: 300 }, (_, i) => order(`o${i}`, "2026-08-01"));
    const items: ReportableSaleItem[] = [];
    for (let i = 0; i < 1200; i++) {
      items.push(item({ sales_order_id: `o${i % 300}`, allocated_revenue: 10, purchase_cost_snapshot: 4, allocated_platform_fee: 1, allocated_postage: 0.5 }));
    }
    const summary = computeReportSummary(orders, items);
    expect(summary.units).toBe(1200);
    expect(summary.revenuePence).toBe(1200 * 1000);
    expect(summary.stockCostPence).toBe(1200 * 400);
    expect(summary.feesPence).toBe(1200 * 100);
    expect(summary.postagePence).toBe(1200 * 50);
    expect(summary.profitPence).toBe(1200 * (1000 - 400 - 100 - 50));
  });
});

describe("computeChartSeries — zero-filled buckets, daily and monthly", () => {
  it("REQUIREMENT: every day in the range appears, including days with no sales (zero, not omitted)", () => {
    const orders = [order("o1", "2026-08-02")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 10, purchase_cost_snapshot: 4, allocated_platform_fee: 0, allocated_postage: 0 })];
    const series = computeChartSeries(orders, items, { start: "2026-08-01", end: "2026-08-04" }, "daily");
    expect(series.map(point => point.key)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);
    expect(series[0]).toMatchObject({ revenuePence: 0, profitPence: 0 });
    expect(series[1]).toMatchObject({ revenuePence: 1000, profitPence: 600 });
    expect(series[2]).toMatchObject({ revenuePence: 0, profitPence: 0 });
  });

  it("REQUIREMENT: every month in the range appears, including months with no sales", () => {
    const orders = [order("o1", "2026-06-15")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 20 })];
    const series = computeChartSeries(orders, items, { start: "2026-06-01", end: "2026-08-18" }, "monthly");
    expect(series.map(point => point.key)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(series[1].revenuePence).toBe(0);
  });

  it("multiple items on the same day are summed into one bucket", () => {
    const orders = [order("o1", "2026-08-02"), order("o2", "2026-08-02")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 10, purchase_cost_snapshot: 0, allocated_platform_fee: 0, allocated_postage: 0 }),
      item({ sales_order_id: "o2", allocated_revenue: 5, purchase_cost_snapshot: 0, allocated_platform_fee: 0, allocated_postage: 0 }),
    ];
    const series = computeChartSeries(orders, items, { start: "2026-08-02", end: "2026-08-02" }, "daily");
    expect(series).toEqual([{ key: "2026-08-02", label: "2 Aug 2026", revenuePence: 1500, profitPence: 1500 }]);
  });

  it("REQUIREMENT: chart totals reconcile exactly to the overall summary for the same range", () => {
    const orders = [order("o1", "2026-08-01"), order("o2", "2026-08-15"), order("o3", "2026-08-20")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 12, purchase_cost_snapshot: 5, allocated_platform_fee: 1, allocated_postage: 0.5 }),
      item({ sales_order_id: "o2", allocated_revenue: 8, purchase_cost_snapshot: 3, allocated_platform_fee: 0.5, allocated_postage: 0.25 }),
      item({ sales_order_id: "o3", allocated_revenue: 30, purchase_cost_snapshot: 40, allocated_platform_fee: 2, allocated_postage: 1 }), // a loss
    ];
    const range = { start: "2026-08-01", end: "2026-08-31" };
    const summary = computeReportSummary(orders, items);
    const daily = computeChartSeries(orders, items, range, "daily");
    const monthly = computeChartSeries(orders, items, range, "monthly");
    expect(daily.reduce((sum, point) => sum + point.revenuePence, 0)).toBe(summary.revenuePence);
    expect(daily.reduce((sum, point) => sum + point.profitPence, 0)).toBe(summary.profitPence);
    expect(monthly.reduce((sum, point) => sum + point.revenuePence, 0)).toBe(summary.revenuePence);
    expect(monthly.reduce((sum, point) => sum + point.profitPence, 0)).toBe(summary.profitPence);
  });

  it("REQUIREMENT: negative profit is visible in the series, never clamped", () => {
    const orders = [order("o1", "2026-08-01")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 5, purchase_cost_snapshot: 30, allocated_platform_fee: 0, allocated_postage: 0 })];
    const series = computeChartSeries(orders, items, { start: "2026-08-01", end: "2026-08-01" }, "daily");
    expect(series[0].profitPence).toBeLessThan(0);
  });
});

describe("isDailyGranularitySensible", () => {
  it(`allows daily grouping up to and including ${MAX_DAILY_SPAN_DAYS} days`, () => {
    expect(isDailyGranularitySensible("2026-01-01", "2026-04-02")).toBe(true); // exactly 92 days
  });

  it("disallows daily grouping beyond the threshold", () => {
    expect(isDailyGranularitySensible("2026-01-01", "2026-04-03")).toBe(false); // 93 days
  });

  it("a single day is always daily-sensible", () => {
    expect(isDailyGranularitySensible("2026-08-18", "2026-08-18")).toBe(true);
  });
});

describe("computeCategoryBreakdown", () => {
  it("groups by category_snapshot, never the purchase's current (possibly since-edited) category", () => {
    const items = [
      item({ sales_order_id: "o1", category_snapshot: "Pokémon", allocated_revenue: 10, purchase_cost_snapshot: 4, allocated_platform_fee: 0, allocated_postage: 0 }),
      item({ sales_order_id: "o2", category_snapshot: "Clothing", allocated_revenue: 30, purchase_cost_snapshot: 10, allocated_platform_fee: 0, allocated_postage: 0 }),
      item({ sales_order_id: "o3", category_snapshot: "Pokémon", allocated_revenue: 5, purchase_cost_snapshot: 1, allocated_platform_fee: 0, allocated_postage: 0 }),
    ];
    const rows = computeCategoryBreakdown(items);
    const byCategory = Object.fromEntries(rows.map(row => [row.category, row]));
    expect(byCategory["Pokémon"].units).toBe(2);
    expect(byCategory["Pokémon"].revenuePence).toBe(1500);
    expect(byCategory["Clothing"].units).toBe(1);
    expect(byCategory["Clothing"].revenuePence).toBe(3000);
  });

  it("sorts by revenue descending by default", () => {
    const items = [
      item({ sales_order_id: "o1", category_snapshot: "Footwear", allocated_revenue: 5 }),
      item({ sales_order_id: "o2", category_snapshot: "Clothing", allocated_revenue: 50 }),
    ];
    const rows = computeCategoryBreakdown(items);
    expect(rows.map(row => row.category)).toEqual(["Clothing", "Footwear"]);
  });

  it("REQUIREMENT: category revenue totals reconcile exactly to the overall revenue total", () => {
    const items = [
      item({ sales_order_id: "o1", category_snapshot: "Pokémon", allocated_revenue: 12.34 }),
      item({ sales_order_id: "o2", category_snapshot: "Clothing", allocated_revenue: 7.89 }),
      item({ sales_order_id: "o3", category_snapshot: "Footwear", allocated_revenue: 100 }),
    ];
    const rows = computeCategoryBreakdown(items);
    const overall = computeReportSummary([order("o1", "2026-08-01"), order("o2", "2026-08-01"), order("o3", "2026-08-01")], items);
    expect(rows.reduce((sum, row) => sum + row.revenuePence, 0)).toBe(overall.revenuePence);
  });

  it("REQUIREMENT: category profit totals reconcile exactly to the overall profit total", () => {
    const items = [
      item({ sales_order_id: "o1", category_snapshot: "Pokémon", allocated_revenue: 12, purchase_cost_snapshot: 5, allocated_platform_fee: 1, allocated_postage: 0.5 }),
      item({ sales_order_id: "o2", category_snapshot: "Clothing", allocated_revenue: 7, purchase_cost_snapshot: 20, allocated_platform_fee: 0, allocated_postage: 0 }), // a loss
    ];
    const rows = computeCategoryBreakdown(items);
    const overall = computeReportSummary([order("o1", "2026-08-01"), order("o2", "2026-08-01")], items);
    expect(rows.reduce((sum, row) => sum + row.profitPence, 0)).toBe(overall.profitPence);
  });

  it("units across every category row sum to total units sold", () => {
    const items = [
      item({ sales_order_id: "o1", category_snapshot: "Pokémon" }),
      item({ sales_order_id: "o1", category_snapshot: "Pokémon" }),
      item({ sales_order_id: "o2", category_snapshot: "Other" }),
    ];
    const rows = computeCategoryBreakdown(items);
    expect(rows.reduce((sum, row) => sum + row.units, 0)).toBe(3);
  });

  it("revenueSharePercent sums to (approximately) 100 across all categories", () => {
    const items = [
      item({ sales_order_id: "o1", category_snapshot: "Pokémon", allocated_revenue: 25 }),
      item({ sales_order_id: "o2", category_snapshot: "Clothing", allocated_revenue: 75 }),
    ];
    const rows = computeCategoryBreakdown(items);
    const totalShare = rows.reduce((sum, row) => sum + row.revenueSharePercent, 0);
    expect(totalShare).toBeCloseTo(100, 1);
    const pokemon = rows.find(row => row.category === "Pokémon")!;
    expect(pokemon.revenueSharePercent).toBeCloseTo(25, 1);
  });

  it("revenueSharePercent is 0 (not NaN) for an empty item list", () => {
    expect(computeCategoryBreakdown([])).toEqual([]);
  });
});

describe("computeConditionGroupBreakdown", () => {
  it("REQUIREMENT: always returns all three groups (new/used/unknown), even at zero", () => {
    const rows = computeConditionGroupBreakdown([]);
    expect(rows.map(row => row.conditionGroup)).toEqual(["new", "used", "unknown"]);
    expect(rows.every(row => row.units === 0 && row.revenuePence === 0)).toBe(true);
  });

  it("REQUIREMENT: an unrecognized/legacy condition_group_snapshot value falls into 'unknown', never silently dropped", () => {
    const items = [item({ sales_order_id: "o1", condition_group_snapshot: "some-legacy-value", allocated_revenue: 10 })];
    const rows = computeConditionGroupBreakdown(items);
    const unknown = rows.find(row => row.conditionGroup === "unknown")!;
    expect(unknown.units).toBe(1);
    expect(unknown.revenuePence).toBe(1000);
  });

  it("groups new vs used correctly and computes average profit per unit", () => {
    const items = [
      item({ sales_order_id: "o1", condition_group_snapshot: "new", allocated_revenue: 20, purchase_cost_snapshot: 8, allocated_platform_fee: 0, allocated_postage: 0 }),
      item({ sales_order_id: "o1", condition_group_snapshot: "new", allocated_revenue: 10, purchase_cost_snapshot: 2, allocated_platform_fee: 0, allocated_postage: 0 }),
      item({ sales_order_id: "o2", condition_group_snapshot: "used", allocated_revenue: 5, purchase_cost_snapshot: 3, allocated_platform_fee: 0, allocated_postage: 0 }),
    ];
    const rows = computeConditionGroupBreakdown(items);
    const byGroup = Object.fromEntries(rows.map(row => [row.conditionGroup, row]));
    expect(byGroup.new.units).toBe(2);
    expect(byGroup.new.profitPence).toBe(1200 + 800);
    expect(byGroup.new.averageProfitPerUnitPence).toBe(1000);
    expect(byGroup.used.units).toBe(1);
  });

  it("REQUIREMENT: condition-group revenue totals reconcile exactly to the overall revenue total", () => {
    const items = [
      item({ sales_order_id: "o1", condition_group_snapshot: "new", allocated_revenue: 12.5 }),
      item({ sales_order_id: "o2", condition_group_snapshot: "used", allocated_revenue: 4.25 }),
      item({ sales_order_id: "o3", condition_group_snapshot: "weird", allocated_revenue: 1 }),
    ];
    const rows = computeConditionGroupBreakdown(items);
    const overall = computeReportSummary([order("o1", "2026-08-01"), order("o2", "2026-08-01"), order("o3", "2026-08-01")], items);
    expect(rows.reduce((sum, row) => sum + row.revenuePence, 0)).toBe(overall.revenuePence);
  });
});

describe("computePlatformBreakdown", () => {
  it("one row per canonical platform", () => {
    const orders = [order("o1", "2026-08-01", "vinted"), order("o2", "2026-08-01", "ebay")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 10 }),
      item({ sales_order_id: "o2", allocated_revenue: 20 }),
    ];
    const rows = computePlatformBreakdown(orders, items);
    const byLabel = Object.fromEntries(rows.map(row => [row.label, row]));
    expect(byLabel.Vinted.revenuePence).toBe(1000);
    expect(byLabel.eBay.revenuePence).toBe(2000);
  });

  it("REQUIREMENT: distinct custom platform names under Other appear as separate rows", () => {
    const orders = [order("o1", "2026-08-01", "other", "Facebook"), order("o2", "2026-08-01", "other", "Local shop")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 10 }), item({ sales_order_id: "o2", allocated_revenue: 20 })];
    const rows = computePlatformBreakdown(orders, items);
    const labels = rows.map(row => row.label);
    expect(labels).toContain("Facebook");
    expect(labels).toContain("Local shop");
  });

  it("REQUIREMENT: a combined 'Other (all)' row sums every custom platform together", () => {
    const orders = [order("o1", "2026-08-01", "other", "Facebook"), order("o2", "2026-08-01", "other", "Local shop")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 10 }), item({ sales_order_id: "o2", allocated_revenue: 20 })];
    const rows = computePlatformBreakdown(orders, items);
    const combined = rows.find(row => row.label === "Other (all)")!;
    expect(combined.revenuePence).toBe(3000);
    expect(combined.orders).toBe(2);
  });

  it("custom platform names are case/whitespace-insensitively grouped together", () => {
    const orders = [order("o1", "2026-08-01", "other", "Facebook"), order("o2", "2026-08-01", "other", " facebook  ")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 10 }), item({ sales_order_id: "o2", allocated_revenue: 5 })];
    const rows = computePlatformBreakdown(orders, items);
    const facebookRows = rows.filter(row => row.label.toLowerCase() === "facebook");
    expect(facebookRows.length).toBe(1);
    expect(facebookRows[0].revenuePence).toBe(1500);
  });

  it("orders = distinct order count, not item count (multiple units in one order count as one order)", () => {
    const orders = [order("o1", "2026-08-01", "vinted")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 10 }), item({ sales_order_id: "o1", allocated_revenue: 10 })];
    const rows = computePlatformBreakdown(orders, items);
    const vinted = rows.find(row => row.label === "Vinted")!;
    expect(vinted.orders).toBe(1);
    expect(vinted.units).toBe(2);
  });

  it("REQUIREMENT: fees/postage are summed from each item's own allocated share, never the order's own column (would double-count)", () => {
    const orders = [order("o1", "2026-08-01", "vinted")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 10, allocated_platform_fee: 1, allocated_postage: 0.5 }),
      item({ sales_order_id: "o1", allocated_revenue: 10, allocated_platform_fee: 1, allocated_postage: 0.5 }),
    ];
    const rows = computePlatformBreakdown(orders, items);
    const vinted = rows.find(row => row.label === "Vinted")!;
    expect(vinted.feesPence).toBe(200);
    expect(vinted.postagePence).toBe(100);
  });

  it("REQUIREMENT: platform revenue totals reconcile exactly to the overall revenue total (excluding the synthetic combined row, which would double-count)", () => {
    const orders = [order("o1", "2026-08-01", "vinted"), order("o2", "2026-08-01", "ebay"), order("o3", "2026-08-01", "other", "Facebook")];
    const items = [
      item({ sales_order_id: "o1", allocated_revenue: 12.34 }),
      item({ sales_order_id: "o2", allocated_revenue: 5.67 }),
      item({ sales_order_id: "o3", allocated_revenue: 8.99 }),
    ];
    const rows = computePlatformBreakdown(orders, items);
    const withoutCombined = rows.filter(row => row.key !== "other:__all__");
    const overall = computeReportSummary(orders, items);
    expect(withoutCombined.reduce((sum, row) => sum + row.revenuePence, 0)).toBe(overall.revenuePence);
  });

  it("sorts by revenue descending", () => {
    const orders = [order("o1", "2026-08-01", "vinted"), order("o2", "2026-08-01", "ebay")];
    const items = [item({ sales_order_id: "o1", allocated_revenue: 5 }), item({ sales_order_id: "o2", allocated_revenue: 50 })];
    const rows = computePlatformBreakdown(orders, items);
    expect(rows[0].label).toBe("eBay");
  });
});
