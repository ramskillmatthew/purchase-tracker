"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import DateRangeFilterBar from "@/components/sales/reports/DateRangeFilterBar";
import ReportSummaryCards from "@/components/sales/reports/ReportSummaryCards";
import RevenueProfitChart from "@/components/sales/reports/RevenueProfitChart";
import BreakdownTable, { type BreakdownColumn, type BreakdownSortOption } from "@/components/sales/reports/BreakdownTable";
import { parseDateRangePreset, resolveCustomRange, type DateRangePreset } from "@/lib/sales/report-date-range";
import { formatUkDate, parseUkDate } from "@/lib/validation/uk-date";
import { formatMarginPercent, formatPenceAsGBP } from "@/lib/sales/money";
import type { CategoryReportRow, ChartGranularity, ConditionReportRow, PlatformReportRow, SalesReportResponse } from "@/lib/sales/reporting";
import styles from "@/app/sales/sales.module.css";

const CONDITION_LABELS: Record<string, string> = { new: "New", used: "Used", unknown: "Unknown" };

function isoToUkDisplay(iso: string | null): string {
  if (!iso) return "";
  const result = parseUkDate(iso);
  return result.ok ? formatUkDate(result.iso) : "";
}

// Wrapped in Suspense because it reads useSearchParams — matches the exact
// pattern already established in app/purchases/page.tsx for the same
// Next.js requirement.
export default function SalesReportsPage() {
  return <Suspense fallback={null}><SalesReportsPageInner /></Suspense>;
}

function SalesReportsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [preset, setPreset] = useState<DateRangePreset>(() => parseDateRangePreset(searchParams.get("preset")));
  const [customStartIso, setCustomStartIso] = useState<string | null>(searchParams.get("start"));
  const [customEndIso, setCustomEndIso] = useState<string | null>(searchParams.get("end"));
  const [customStartText, setCustomStartText] = useState(() => isoToUkDisplay(searchParams.get("start")));
  const [customEndText, setCustomEndText] = useState(() => isoToUkDisplay(searchParams.get("end")));
  const [customRangeError, setCustomRangeError] = useState<string | null>(null);

  const [report, setReport] = useState<SalesReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");

  function changePreset(next: DateRangePreset) {
    setPreset(next);
    if (next !== "custom") { setCustomRangeError(null); return; }
    // Entering Custom Range for the first time with nothing typed yet must
    // not immediately show a validation error — only once the user has
    // actually typed something (see the debounced validation effect below).
    if (!customStartText.trim() && !customEndText.trim()) setCustomRangeError(null);
  }

  // Debounced custom-range validation — reuses resolveCustomRange (the same
  // function the API route itself calls) so the inline error the user sees
  // while typing is guaranteed to agree with what the server would say,
  // never a second, drifting client-side date parser.
  useEffect(() => {
    if (preset !== "custom") return;
    if (!customStartText.trim() && !customEndText.trim()) { setCustomRangeError(null); return; }
    const timer = window.setTimeout(() => {
      const result = resolveCustomRange(customStartText, customEndText);
      if (result.ok) {
        setCustomRangeError(null);
        setCustomStartIso(result.range.start);
        setCustomEndIso(result.range.end);
      } else {
        setCustomRangeError(result.error);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [customStartText, customEndText, preset]);

  // URL is the single source of truth for "what filter is applied" on
  // refresh/back/forward — rebuilt fresh from current state every time
  // (never patched), so preset and custom dates can never drift apart in
  // the query string.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set("preset", preset);
    if (preset === "custom" && customStartIso && customEndIso) {
      params.set("start", customStartIso);
      params.set("end", customEndIso);
    }
    const next = params.toString();
    if (next !== searchParams.toString()) router.replace(`/sales/reports?${next}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes router/searchParams, matching app/purchases/page.tsx's own URL-sync effect: including them would restart on this effect's own replace() call.
  }, [preset, customStartIso, customEndIso]);

  // A custom range with no valid resolved dates yet (nothing typed, or a
  // currently-invalid entry) simply doesn't fetch — the existing report
  // (if any) stays on screen rather than being blanked out by a request
  // that can't succeed, and the filter bar's own inline error explains why.
  const canFetch = preset !== "custom" || (customStartIso !== null && customEndIso !== null && !customRangeError);

  function loadReport() {
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ preset });
    if (preset === "custom" && customStartIso && customEndIso) {
      params.set("start", customStartIso);
      params.set("end", customEndIso);
    }
    fetch(`/api/sales/reports?${params.toString()}`)
      .then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "Could not load the sales report.");
        return body as SalesReportResponse;
      })
      .then(data => { setReport(data); setLoading(false); })
      .catch(error => { setLoadError(error instanceof Error ? error.message : "Could not load the sales report."); setLoading(false); });
  }

  useEffect(() => {
    if (!canFetch) return;
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the resolved filter (preset + settled custom ISO dates) only, never on the raw text fields typed on every keystroke.
  }, [preset, customStartIso, customEndIso, canFetch]);

  // Daily grouping can stop being offered when a range grows past
  // MAX_DAILY_SPAN_DAYS (e.g. switching from "This Month" to "All Time") —
  // falls back to Monthly automatically rather than showing an empty chart
  // for a granularity the API no longer computed. A user's own explicit
  // choice of Monthly is left alone.
  useEffect(() => {
    if (report && !report.chart.dailyAvailable && granularity === "daily") setGranularity("monthly");
  }, [report, granularity]);

  const categoryColumns: BreakdownColumn<CategoryReportRow>[] = [
    { key: "revenue", label: "Revenue", align: "right", render: row => formatPenceAsGBP(row.revenuePence) },
    { key: "profit", label: "Profit", align: "right", render: row => formatPenceAsGBP(row.profitPence) },
    { key: "units", label: "Units", align: "right", render: row => row.units.toLocaleString("en-GB") },
    { key: "margin", label: "Margin", align: "right", render: row => formatMarginPercent(row.marginPercent) },
    { key: "share", label: "% of revenue", align: "right", render: row => `${row.revenueSharePercent.toFixed(2)}%` },
  ];
  const categorySortOptions: BreakdownSortOption<CategoryReportRow>[] = [
    { key: "revenue", label: "Revenue", compare: (a, b) => b.revenuePence - a.revenuePence },
    { key: "profit", label: "Profit", compare: (a, b) => b.profitPence - a.profitPence },
    { key: "units", label: "Units", compare: (a, b) => b.units - a.units },
  ];

  const conditionColumns: BreakdownColumn<ConditionReportRow>[] = [
    { key: "revenue", label: "Revenue", align: "right", render: row => formatPenceAsGBP(row.revenuePence) },
    { key: "profit", label: "Profit", align: "right", render: row => formatPenceAsGBP(row.profitPence) },
    { key: "units", label: "Units", align: "right", render: row => row.units.toLocaleString("en-GB") },
    { key: "avgProfit", label: "Avg profit / unit", align: "right", render: row => formatPenceAsGBP(row.averageProfitPerUnitPence) },
    { key: "margin", label: "Margin", align: "right", render: row => formatMarginPercent(row.marginPercent) },
  ];

  const platformColumns: BreakdownColumn<PlatformReportRow>[] = [
    { key: "orders", label: "Orders", align: "right", render: row => row.orders.toLocaleString("en-GB") },
    { key: "units", label: "Units", align: "right", render: row => row.units.toLocaleString("en-GB") },
    { key: "revenue", label: "Revenue", align: "right", render: row => formatPenceAsGBP(row.revenuePence) },
    { key: "profit", label: "Profit", align: "right", render: row => formatPenceAsGBP(row.profitPence) },
    { key: "fees", label: "Fees", align: "right", render: row => formatPenceAsGBP(row.feesPence) },
    { key: "postage", label: "Postage", align: "right", render: row => formatPenceAsGBP(row.postagePence) },
    { key: "aov", label: "Avg order value", align: "right", render: row => formatPenceAsGBP(row.averageOrderValuePence) },
    { key: "margin", label: "Margin", align: "right", render: row => formatMarginPercent(row.marginPercent) },
  ];
  const platformSortOptions: BreakdownSortOption<PlatformReportRow>[] = [
    { key: "revenue", label: "Revenue", compare: (a, b) => b.revenuePence - a.revenuePence },
    { key: "profit", label: "Profit", compare: (a, b) => b.profitPence - a.profitPence },
    { key: "units", label: "Units", compare: (a, b) => b.units - a.units },
  ];

  return <section className="page-shell">
    <Link href="/sales" className={styles.reportBackLink}>&larr; Back to Sales</Link>
    <header className={styles.topbar}>
      <div className="title-row"><h1>Sales Reports</h1></div>
    </header>

    <DateRangeFilterBar
      preset={preset}
      customStart={customStartText}
      customEnd={customEndText}
      rangeLabel={report?.range.label ?? null}
      validationError={customRangeError}
      onPresetChange={changePreset}
      onCustomStartChange={setCustomStartText}
      onCustomEndChange={setCustomEndText}
    />

    {loading && !report && <div className={styles.loadingState}>
      <div className={styles.skeletonRow} style={{ width: "60%" }} />
      <div className={styles.skeletonRow} style={{ width: "80%" }} />
      <div className={styles.skeletonRow} style={{ width: "45%" }} />
    </div>}

    {loadError && <div className={styles.errorState}>
      <strong>Could not load the sales report</strong>
      <span>{loadError}</span>
      <button type="button" className="button-secondary" onClick={loadReport}>Try again</button>
    </div>}

    {report && !loadError && <>
      <ReportSummaryCards summary={report.summary} />

      <RevenueProfitChart
        daily={report.chart.daily}
        monthly={report.chart.monthly}
        dailyAvailable={report.chart.dailyAvailable}
        granularity={granularity}
        onGranularityChange={setGranularity}
      />

      <BreakdownTable
        title="By category"
        rows={report.categories}
        rowKey={row => row.category}
        rowLabel={row => row.category}
        columns={categoryColumns}
        sortOptions={categorySortOptions}
        barValue={row => row.revenuePence}
        emptyMessage="No completed sales in this period yet."
      />

      <BreakdownTable
        title="New vs used"
        rows={report.conditions}
        rowKey={row => row.conditionGroup}
        rowLabel={row => CONDITION_LABELS[row.conditionGroup] ?? row.conditionGroup}
        columns={conditionColumns}
        sortOptions={[{ key: "order", label: "Order", compare: () => 0 }]}
        barValue={row => row.revenuePence}
        emptyMessage="No completed sales in this period yet."
      />

      <BreakdownTable
        title="By platform"
        rows={report.platforms}
        rowKey={row => row.key}
        rowLabel={row => row.label}
        columns={platformColumns}
        sortOptions={platformSortOptions}
        barValue={row => row.revenuePence}
        emptyMessage="No completed sales in this period yet."
      />
    </>}
  </section>;
}
