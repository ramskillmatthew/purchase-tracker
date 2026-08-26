import type { Period } from "@/lib/home-report";
import type { SalesOrderListItem } from "@/lib/types";
import type { DateRangePreset } from "@/lib/sales/report-date-range";
import { effectiveSalesProcessStatus } from "@/lib/sales/process-status";

export const HOME_PERIOD_TO_SALES_PRESET: Record<Period, Exclude<DateRangePreset, "today" | "custom">> = {
  month: "this-month",
  "last-month": "last-month",
  "three-months": "last-3-months",
  year: "this-year",
  "last-year": "last-year",
  "all-time": "all-time",
};

export const HOME_PENDING_STATUSES = ["awaiting_dispatch", "sent", "delivered_awaiting_payout", "return_in_process"] as const;

export function pendingHomeSales(rows: SalesOrderListItem[]): SalesOrderListItem[] {
  return rows.filter(row => HOME_PENDING_STATUSES.includes(effectiveSalesProcessStatus(row) as typeof HOME_PENDING_STATUSES[number])).slice(0, 4);
}

export function recentHomeSales(rows: SalesOrderListItem[]): SalesOrderListItem[] {
  return [...rows].sort((a, b) => b.sale_date.localeCompare(a.sale_date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0, 5);
}

export type HomeSalesChartPoint = { key: string; label: string; revenuePence: number; profitPence: number };

export function homeSalesChart(rows: SalesOrderListItem[], maxPoints = 6): HomeSalesChartPoint[] {
  const chronological = [...rows].sort((a, b) => a.sale_date.localeCompare(b.sale_date) || a.created_at.localeCompare(b.created_at));
  if (!chronological.length) return [];
  const bucketCount = Math.min(maxPoints, chronological.length);
  const bucketSize = Math.ceil(chronological.length / bucketCount);
  const points: HomeSalesChartPoint[] = [];
  for (let index = 0; index < chronological.length; index += bucketSize) {
    const bucket = chronological.slice(index, index + bucketSize);
    const last = bucket[bucket.length - 1];
    points.push({
      key: `${bucket[0].sale_date}:${last.sale_date}`,
      label: new Date(`${last.sale_date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      revenuePence: bucket.reduce((sum, row) => sum + Math.round(Number(row.total_revenue) * 100), 0),
      profitPence: bucket.reduce((sum, row) => sum + row.profitPence, 0),
    });
  }
  return points;
}
