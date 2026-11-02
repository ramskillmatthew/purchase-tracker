import type { Period } from "@/lib/home-report";
import type { SalesOrderListItem } from "@/lib/types";
import type { DateRangePreset } from "@/lib/sales/report-date-range";
import type { ReportChartPoint } from "@/lib/sales/reporting";
import { PENDING_PROCESS_STATUSES, effectiveSalesProcessStatus, isPendingProcessStatus } from "@/lib/sales/process-status";

export const HOME_PERIOD_TO_SALES_PRESET: Record<Period, Exclude<DateRangePreset, "today" | "custom">> = {
  month: "this-month",
  "last-month": "last-month",
  "three-months": "last-3-months",
  year: "this-year",
  "last-year": "last-year",
  "all-time": "all-time",
};

/** @deprecated Use PENDING_PROCESS_STATUSES from lib/sales/process-status — kept as a re-export so existing importers don't break. */
export const HOME_PENDING_STATUSES = PENDING_PROCESS_STATUSES;

/**
 * The four most-recent still-pending orders for the Home "Pending Orders"
 * preview, using the same canonical pending definition as the Sales page
 * (isPendingProcessStatus). OPERATIONAL only: the caller must fetch these
 * across ALL dates (preset=all-time), never the dashboard's financial
 * Compare-period, and must take the header COUNT from the API response's own
 * pre-pagination `total` — never from this array's length, which is capped at
 * four.
 */
export function pendingHomeSales(rows: SalesOrderListItem[]): SalesOrderListItem[] {
  return rows.filter(row => isPendingProcessStatus(effectiveSalesProcessStatus(row))).slice(0, 4);
}

/**
 * The latest five sales for the Home "Recent Sales" widget, newest first by
 * canonical sale_date with a deterministic created_at-then-id tie-break.
 * OPERATIONAL only — the caller fetches across all dates and never applies the
 * Compare-period. Sale-status inclusion is left exactly as the caller supplies
 * it (currently every non-invalid sale, `status=all`); this helper does not
 * add or remove a cancelled/refunded filter.
 */
export function recentHomeSales(rows: SalesOrderListItem[]): SalesOrderListItem[] {
  return [...rows].sort((a, b) => b.sale_date.localeCompare(a.sale_date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0, 5);
}

export type HomeSalesChartPoint = { key: string; label: string; axisLabel?: string; revenuePence: number; profitPence: number };

function compactChartLabel(label: string): string {
  return label.replace(/\s+\d{4}$/, "");
}

/**
 * Condenses a complete, chronological date series into a small number of
 * contiguous TIME buckets. This deliberately buckets calendar points rather
 * than individual sales: a busy date can therefore appear only once, and a
 * long reporting period cannot collapse into several identically-labelled
 * points merely because many orders happened on one day.
 */
export function homeReportChart(rows: readonly ReportChartPoint[], maxPoints = 7): HomeSalesChartPoint[] {
  if (!rows.length) return [];
  if (rows.length <= maxPoints) return rows.map(row => ({ ...row, axisLabel: compactChartLabel(row.label) }));
  const bucketSize = Math.ceil(rows.length / maxPoints);
  const points: HomeSalesChartPoint[] = [];
  for (let index = 0; index < rows.length; index += bucketSize) {
    const bucket = rows.slice(index, index + bucketSize);
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    points.push({
      key: `${first.key}:${last.key}`,
      label: first.key === last.key ? first.label : `${first.label} – ${last.label}`,
      axisLabel: compactChartLabel(last.label),
      revenuePence: bucket.reduce((sum, row) => sum + row.revenuePence, 0),
      profitPence: bucket.reduce((sum, row) => sum + row.profitPence, 0),
    });
  }
  return points;
}

export function homeSalesChart(rows: SalesOrderListItem[], maxPoints = 6): HomeSalesChartPoint[] {
  const chronological = [...rows].sort((a, b) => a.sale_date.localeCompare(b.sale_date) || a.created_at.localeCompare(b.created_at));
  if (!chronological.length) return [];
  const daily = new Map<string, HomeSalesChartPoint>();
  for (const row of chronological) {
    const current = daily.get(row.sale_date) ?? {
      key: row.sale_date,
      label: new Date(`${row.sale_date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      revenuePence: 0,
      profitPence: 0,
    };
    current.revenuePence += Math.round(Number(row.total_revenue) * 100);
    current.profitPence += row.profitPence;
    daily.set(row.sale_date, current);
  }
  return homeReportChart([...daily.values()], maxPoints);
}
