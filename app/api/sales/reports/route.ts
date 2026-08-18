import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { reportFilterQuerySchema } from "@/lib/validation/sales";
import { describeDateRange, londonToday, parseDateRangePreset, resolveDateFilter } from "@/lib/sales/report-date-range";
import { fetchCompletedSalesInRange } from "@/lib/sales/reporting-data";
import {
  computeCategoryBreakdown,
  computeChartSeries,
  computeConditionGroupBreakdown,
  computePlatformBreakdown,
  computeReportSummary,
  isDailyGranularitySensible,
  type SalesReportResponse,
} from "@/lib/sales/reporting";

/**
 * The Sales Reporting dashboard's dedicated data source — never the Sales
 * list page's own bounded "recent 200" endpoint (see app/api/sales/route.ts's
 * own header comment on that ceiling). Only completed sales ever reach this
 * route's aggregation (the database query itself excludes cancelled/refunded
 * — see fetchCompletedSalesInRange), and every figure is computed from
 * sale_items' immutable snapshots, never a live join back to purchases.
 */
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const query = reportFilterQuerySchema.parse(Object.fromEntries(url.searchParams));
    const preset = parseDateRangePreset(query.preset);

    const filterResult = resolveDateFilter({ preset, customStart: query.start, customEnd: query.end });
    if (!filterResult.ok) return NextResponse.json({ error: filterResult.error }, { status: 400 });

    const { orders, items } = await fetchCompletedSalesInRange(user.id, filterResult.range);

    // "All Time" resolves to {start: null, end: null} — the chart (and the
    // "resolved range" display) need a CONCRETE span. The earliest fetched
    // order's own sale_date is exactly that boundary (orders are already
    // fetched sorted sale_date ascending — see fetchCompletedSalesInRange),
    // falling back to today when there's no completed sale at all yet.
    const today = londonToday();
    const concreteStart = filterResult.range.start ?? orders[0]?.sale_date ?? today;
    const concreteEnd = filterResult.range.end ?? today;
    const concreteRange = { start: concreteStart, end: concreteEnd };

    const dailyAvailable = isDailyGranularitySensible(concreteStart, concreteEnd);

    const response: SalesReportResponse = {
      preset,
      range: { ...concreteRange, label: describeDateRange(concreteRange) },
      summary: computeReportSummary(orders, items),
      chart: {
        dailyAvailable,
        daily: dailyAvailable ? computeChartSeries(orders, items, concreteRange, "daily") : null,
        monthly: computeChartSeries(orders, items, concreteRange, "monthly"),
      },
      categories: computeCategoryBreakdown(items),
      conditions: computeConditionGroupBreakdown(items),
      platforms: computePlatformBreakdown(orders, items),
    };
    return NextResponse.json(response);
  } catch (error) { return safeApiError(error, "Could not load the sales report."); }
}
