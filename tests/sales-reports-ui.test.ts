import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// "use client" pages with no React test harness in this project (see
// tests/purchases-selection-ui.test.ts's own comment on this established
// convention) — wiring is asserted structurally against the source text;
// the pure logic each depends on (date-range resolution, aggregation) is
// covered directly and behaviourally in tests/sales-reports-date-range.test.ts
// and tests/sales-reports-aggregation.test.ts.
const page = readFileSync("app/sales/reports/page.tsx", "utf8");
const salesPage = readFileSync("app/sales/page.tsx", "utf8");
const filterBar = readFileSync("components/sales/reports/DateRangeFilterBar.tsx", "utf8");
const summaryCards = readFileSync("components/sales/reports/ReportSummaryCards.tsx", "utf8");
const chart = readFileSync("components/sales/reports/RevenueProfitChart.tsx", "utf8");
const breakdownTable = readFileSync("components/sales/reports/BreakdownTable.tsx", "utf8");

describe("app/sales/reports/page.tsx — page shell", () => {
  it("is wrapped in Suspense (reads useSearchParams), matching app/purchases/page.tsx's own established pattern", () => {
    expect(page).toContain("useSearchParams");
    expect(page).toContain("<Suspense fallback={null}><SalesReportsPageInner /></Suspense>");
  });

  it("REQUIREMENT: filter state (preset + custom start/end) is kept in the URL query string so refresh/back/forward works", () => {
    expect(page).toContain('params.set("preset", preset);');
    expect(page).toContain('params.set("start", customStartIso);');
    expect(page).toContain('params.set("end", customEndIso);');
    expect(page).toContain("router.replace(`/sales/reports?${next}`");
  });

  it("initializes filter state FROM the URL on first render, not just writing to it", () => {
    expect(page).toContain('parseDateRangePreset(searchParams.get("preset"))');
    expect(page).toContain('searchParams.get("start")');
    expect(page).toContain('searchParams.get("end")');
  });

  it("REQUIREMENT: reuses resolveCustomRange (the same validator the API route itself calls) for custom-range validation, never a second date parser", () => {
    expect(page).toContain("resolveCustomRange(customStartText, customEndText)");
  });

  it("shows a loading skeleton before the first successful response", () => {
    expect(page).toContain("loading && !report");
    expect(page).toContain("styles.skeletonRow");
  });

  it("shows an error state with a retry action that re-fetches", () => {
    expect(page).toContain("styles.errorState");
    expect(page).toContain("onClick={loadReport}");
  });

  it("REQUIREMENT: changing filters refreshes every card, chart, and comparison together — all four sections read from the single `report` state object populated by one fetch", () => {
    expect(page).toContain("<ReportSummaryCards summary={report.summary} />");
    expect(page).toContain("<RevenueProfitChart");
    expect(page).toContain('title="By category"');
    expect(page).toContain('title="New vs used"');
    expect(page).toContain('title="By platform"');
  });

  it("falls back the chart to Monthly when the resolved range no longer supports Daily", () => {
    expect(page).toContain("!report.chart.dailyAvailable && granularity === \"daily\"");
    expect(page).toContain('setGranularity("monthly")');
  });

  it("category comparison is sortable by Revenue/Profit/Units, per the explicit requirement", () => {
    const block = page.slice(page.indexOf("categorySortOptions"));
    expect(block).toContain('key: "revenue"');
    expect(block).toContain('key: "profit"');
    expect(block).toContain('key: "units"');
  });

  it("uses sale_items.category_snapshot (via the CategoryReportRow.category field) for the category comparison, never the purchase's live category", () => {
    expect(page).toContain("rowLabel={row => row.category}");
  });

  it("condition comparison labels New/Used/Unknown explicitly, keeping Unknown visible rather than discarding it", () => {
    expect(page).toContain('const CONDITION_LABELS: Record<string, string> = { new: "New", used: "Used", unknown: "Unknown" };');
  });
});

describe("app/sales/page.tsx — Reports entry point", () => {
  it("REQUIREMENT: adds a Reports button/tab to the existing Sales page topbar", () => {
    expect(salesPage).toContain('onClick={() => router.push("/sales/reports")}>Reports</button>');
  });

  it("does not add reporting fields/columns to the main Sales history table itself (kept uncrowded)", () => {
    expect(salesPage).not.toContain("marginPercent");
    expect(salesPage).not.toContain("category_snapshot");
  });
});

describe("components/sales/reports/DateRangeFilterBar.tsx", () => {
  it("renders every required preset as a labelled, clickable button", () => {
    expect(filterBar).toContain("dateRangePresets.map(option =>");
    expect(filterBar).toContain("aria-pressed={preset === option.value}");
  });

  it("clearly shows the active filter via aria-pressed and an active class", () => {
    expect(filterBar).toContain("styles.presetButtonActive");
  });

  it("displays the resolved date range", () => {
    expect(filterBar).toContain("rangeLabel &&");
  });

  it("only shows custom-range inputs when the Custom Range preset is active", () => {
    expect(filterBar).toContain('preset === "custom" && <div className={styles.customRangeRow}>');
  });

  it("surfaces a validation error inline as an alert", () => {
    expect(filterBar).toContain('role="alert"');
  });
});

describe("components/sales/reports/ReportSummaryCards.tsx", () => {
  it("shows every required summary figure", () => {
    for (const label of ["Total revenue", "Total profit", "Stock cost", "Platform fees", "Postage", "Orders completed", "Units sold", "Average order value", "Average profit per unit", "Profit margin"]) {
      expect(summaryCards).toContain(label);
    }
  });

  it("REQUIREMENT: Revenue and Profit get the larger 'hero' card treatment, distinct from the other eight figures", () => {
    expect(summaryCards).toContain("styles.heroCardsGrid");
    expect(summaryCards).toContain("styles.cardsGrid");
  });

  it("REQUIREMENT: uses the binary dashboardProfitTone (not the per-sale profitBadgeTone) for the large Total profit figure", () => {
    expect(summaryCards).toContain("dashboardProfitTone(summary.profitPence)");
  });

  it("REQUIREMENT: Average profit per unit uses the per-sale-scale profitBadgeTone, deliberately not the binary dashboard rule", () => {
    expect(summaryCards).toContain("profitBadgeTone(summary.averageProfitPerUnitPence)");
  });

  it("uses formatPenceAsGBP / formatMarginPercent for consistent GBP formatting, never ad-hoc string interpolation", () => {
    expect(summaryCards).toContain("formatPenceAsGBP");
    expect(summaryCards).toContain("formatMarginPercent(summary.marginPercent)");
  });
});

describe("components/sales/reports/RevenueProfitChart.tsx", () => {
  it("does not import any charting library — hand-rolled SVG, per the explicit 'no large dependency' requirement", () => {
    expect(chart).not.toMatch(/from ["'](recharts|chart\.js|d3|victory|visx|nivo)/);
  });

  it("distinguishes Revenue and Profit visually via a legend", () => {
    expect(chart).toContain("styles.chartLegend");
    expect(chart).toContain(">Revenue</span>");
    expect(chart).toContain(">Profit</span>");
  });

  it("REQUIREMENT: only offers the Daily/Monthly toggle when dailyAvailable is true", () => {
    expect(chart).toContain("dailyAvailable && <div className={styles.sortGroup}");
  });

  it("REQUIREMENT: every bar group is keyboard-focusable and carries an accessible label with exact values, not just a hover-only title", () => {
    expect(chart).toContain("tabIndex={0}");
    expect(chart).toContain("aria-label={`${point.label}: revenue ${formatPenceAsGBP(point.revenuePence)}, profit ${formatPenceAsGBP(point.profitPence)}`}");
  });

  it("REQUIREMENT: exact values are shown via an aria-live detail panel on hover/focus, not floating-tooltip-only", () => {
    expect(chart).toContain('aria-live="polite"');
    expect(chart).toContain("onMouseEnter={() => setActiveIndex(index)}");
    expect(chart).toContain("onFocus={() => setActiveIndex(index)}");
  });

  it("negative profit renders visibly (a distinct fill, not clipped to the zero line)", () => {
    expect(chart).toContain('profitTone === "red" ? "var(--danger)" : "#16845d"');
  });

  it("uses formatReportDate/formatReportMonth (British date labels) via each point's own pre-formatted label, not a second date formatter", () => {
    expect(chart).toContain("point.label");
  });

  it("is horizontally scrollable rather than squeezing bars illegibly narrow when there are many periods", () => {
    expect(chart).toContain("styles.chartScroll");
  });
});

describe("components/sales/reports/BreakdownTable.tsx", () => {
  it("sorting is entirely client-side over already-fetched rows — no re-fetch on sort change", () => {
    expect(breakdownTable).not.toContain("fetch(");
  });

  it("renders a revenue-proportional horizontal bar next to each row's label", () => {
    expect(breakdownTable).toContain("styles.comparisonBarTrack");
    expect(breakdownTable).toContain("width: `${widthPercent}%`");
  });

  it("a negative bar value (a loss) renders with a distinct negative-bar style, not the same colour as a positive value", () => {
    expect(breakdownTable).toContain("styles.comparisonBarFillNegative");
  });

  it("shows an explicit empty state rather than an empty table when there are no rows", () => {
    expect(breakdownTable).toContain("rows.length === 0");
    expect(breakdownTable).toContain("emptyMessage");
  });

  it("hides the sort control entirely when there's nothing meaningful to sort by (a single fixed order)", () => {
    expect(breakdownTable).toContain("sortOptions.length > 1 &&");
  });
});
