import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Next.js server routes touching Supabase directly — no live database in
// this test suite, checked structurally, matching the established
// convention in tests/sales-api-routes.test.ts.
const route = readFileSync("app/api/sales/reports/route.ts", "utf8");
const dataLayer = readFileSync("lib/sales/reporting-data.ts", "utf8");
const schema = readFileSync("lib/validation/sales.ts", "utf8");

describe("app/api/sales/reports/route.ts — GET", () => {
  it("requires owner authentication (also covered generically by tests/security-boundaries.test.ts's app/api/** glob)", () => {
    expect(route).toContain("await requireOwner();");
  });

  it("validates the query string with reportFilterQuerySchema", () => {
    expect(route).toContain("reportFilterQuerySchema.parse(Object.fromEntries(url.searchParams))");
  });

  it("REQUIREMENT: never uses the Sales list page's bounded 'recent 200' endpoint or its query — this is a dedicated reporting fetch", () => {
    expect(route).not.toContain("MAX_RECENT_SALES");
    expect(route).toContain("fetchCompletedSalesInRange");
  });

  it("rejects an invalid custom range with a safe 400, not a thrown/leaked error", () => {
    expect(route).toContain("if (!filterResult.ok) return NextResponse.json({ error: filterResult.error }, { status: 400 });");
  });

  it("routes unrecognized failures through the shared safeApiError helper, never leaking raw errors", () => {
    expect(route).toContain('safeApiError(error, "Could not load the sales report.")');
  });

  it("computes every response section from the same fetched orders/items — summary, chart, categories, conditions, platforms", () => {
    expect(route).toContain("computeReportSummary(orders, items)");
    expect(route).toContain('computeChartSeries(orders, items, concreteRange, "daily")');
    expect(route).toContain('computeChartSeries(orders, items, concreteRange, "monthly")');
    expect(route).toContain("computeCategoryBreakdown(items)");
    expect(route).toContain("computeConditionGroupBreakdown(items)");
    expect(route).toContain("computePlatformBreakdown(orders, items)");
  });

  it("REQUIREMENT: All Time (null/null range) still resolves a concrete start/end for the chart and range label, never passing null through to date math", () => {
    expect(route).toContain("filterResult.range.start ?? orders[0]?.sale_date ?? today");
    expect(route).toContain("filterResult.range.end ?? today");
  });

  it("only offers daily chart granularity when isDailyGranularitySensible allows it", () => {
    expect(route).toContain("isDailyGranularitySensible(concreteStart, concreteEnd)");
    expect(route).toContain("daily: dailyAvailable ? computeChartSeries(orders, items, concreteRange, \"daily\") : null");
  });
});

describe("lib/sales/reporting-data.ts — fetchCompletedSalesInRange", () => {
  it("is server-only", () => {
    expect(dataLayer).toContain('import "server-only";');
  });

  it("is owner-scoped", () => {
    expect(dataLayer).toContain("owner_id=eq.${ownerId}");
  });

  it("REQUIREMENT: only ever fetches completed sales — cancelled/refunded are excluded at the database level, not filtered client-side", () => {
    expect(dataLayer).toContain("status=eq.completed");
  });

  it("REQUIREMENT: uses supabaseRequestAll (paginates past PostgREST's own row cap) for both the orders fetch and every sale_items batch — required to correctly handle more than 1,000 sale items", () => {
    const matches = dataLayer.match(/supabaseRequestAll</g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("REQUIREMENT: batches sale_items queries by order id rather than issuing one request per order (avoids N+1) and never builds one unbounded in.() list", () => {
    expect(dataLayer).toContain("SALE_ITEMS_BATCH_SIZE");
    expect(dataLayer).toContain("for (let i = 0; i < orders.length; i += SALE_ITEMS_BATCH_SIZE)");
    expect(dataLayer).toContain("sale_items?sales_order_id=in.(${batchIds.join(\",\")})");
  });

  it("selects only the columns the aggregation functions actually use — no unnecessary raw records sent to the browser", () => {
    expect(dataLayer).toContain("select=id,sale_date,platform,custom_platform_name");
    expect(dataLayer).toContain("select=sales_order_id,category_snapshot,condition_group_snapshot,purchase_cost_snapshot,allocated_revenue,allocated_platform_fee,allocated_postage");
  });

  it("produces deterministic ordering", () => {
    expect(dataLayer).toContain("order=sale_date.asc,created_at.asc,id.asc");
  });

  it("short-circuits with no items query when there are no matching orders", () => {
    expect(dataLayer).toContain("if (orders.length === 0) return { orders: [], items: [] };");
  });
});

describe("lib/validation/sales.ts — reportFilterQuerySchema", () => {
  it("is a strict shape check over the raw query-string values", () => {
    expect(schema).toMatch(/export const reportFilterQuerySchema = z\.object\(\{[\s\S]*?\}\)\.strict\(\);/);
  });
});
