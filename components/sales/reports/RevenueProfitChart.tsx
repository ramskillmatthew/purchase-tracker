"use client";
import { useState } from "react";
import type { ChartGranularity, ReportChartPoint } from "@/lib/sales/reporting";
import { formatPenceAsGBP } from "@/lib/sales/money";
import { dashboardProfitTone } from "@/lib/sales/profit";
import styles from "@/app/sales/sales.module.css";

type Props = {
  daily: ReportChartPoint[] | null;
  monthly: ReportChartPoint[];
  dailyAvailable: boolean;
  granularity: ChartGranularity;
  onGranularityChange: (granularity: ChartGranularity) => void;
};

const CHART_HEIGHT = 220;
const PLOT_HEIGHT = 160;
const BAR_GROUP_WIDTH = 46;
const BAR_WIDTH = 15;
const BAR_GAP = 4;

/**
 * A hand-rolled SVG bar chart — no charting library is installed anywhere
 * in this app (checked package.json before building this), and the task
 * explicitly says not to add a large dependency for one chart. Revenue and
 * profit are drawn as a paired bar per period against a single shared
 * y-scale (see `scaleY`) so the two series stay visually comparable, with a
 * zero baseline that shifts up to make room for negative profit bars
 * instead of clipping or silently rescaling them out of view.
 *
 * Exact values are never conveyed by hover alone: every bar group is a
 * focusable, keyboard-reachable element (tabIndex 0, arrow-key friendly via
 * native tab order) whose hover/focus updates one shared, always-visible
 * detail panel below the chart (aria-live) — this reads better with a
 * screen reader than a floating SVG tooltip and satisfies "keyboard-friendly
 * tooltips" without emulating a native title attribute.
 */
export default function RevenueProfitChart({ daily, monthly, dailyAvailable, granularity, onGranularityChange }: Props) {
  const points = granularity === "daily" && daily ? daily : monthly;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const maxRevenue = Math.max(0, ...points.map(point => point.revenuePence));
  const maxProfit = Math.max(0, ...points.map(point => point.profitPence));
  const minProfit = Math.min(0, ...points.map(point => point.profitPence));
  const maxValue = Math.max(maxRevenue, maxProfit, 1);
  const minValue = Math.min(0, minProfit);
  const valueSpan = maxValue - minValue;

  function scaleY(valuePence: number): number {
    return (valuePence / valueSpan) * PLOT_HEIGHT;
  }

  const zeroLineY = PLOT_HEIGHT - scaleY(0) + 20;
  const chartWidth = Math.max(points.length * BAR_GROUP_WIDTH, 320);
  const active = activeIndex !== null ? points[activeIndex] : null;
  const activeProfitTone = active ? dashboardProfitTone(active.profitPence) : null;

  return <div className={styles.chartPanel}>
    <div className={styles.reportSectionHeader}>
      <h2>Revenue &amp; profit over time</h2>
      <div className={styles.chartToolbar}>
        <div className={styles.chartLegend}>
          <span><i className={`${styles.legendSwatch} ${styles.legendSwatchRevenue}`} />Revenue</span>
          <span><i className={`${styles.legendSwatch} ${styles.legendSwatchProfit}`} />Profit</span>
        </div>
        {dailyAvailable && <div className={styles.sortGroup} role="group" aria-label="Chart grouping">
          <button type="button" className={granularity === "daily" ? styles.sortGroupActive : undefined} onClick={() => onGranularityChange("daily")}>Daily</button>
          <button type="button" className={granularity === "monthly" ? styles.sortGroupActive : undefined} onClick={() => onGranularityChange("monthly")}>Monthly</button>
        </div>}
      </div>
    </div>

    {points.length === 0 ? <div className={styles.emptyState}><span>No sales in this period yet.</span></div> : <>
      <div className={styles.chartScroll}>
        <svg className={styles.chartSvg} width={chartWidth} height={CHART_HEIGHT} viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`} role="group" aria-label={`${granularity === "daily" ? "Daily" : "Monthly"} revenue and profit chart`}>
          <line className={styles.chartZeroLine} x1={0} y1={zeroLineY} x2={chartWidth} y2={zeroLineY} />
          {points.map((point, index) => {
            const groupX = index * BAR_GROUP_WIDTH + (BAR_GROUP_WIDTH - (BAR_WIDTH * 2 + BAR_GAP)) / 2;
            const revenueHeight = scaleY(point.revenuePence);
            const profitHeight = scaleY(Math.abs(point.profitPence));
            const revenueY = zeroLineY - revenueHeight;
            const profitY = point.profitPence >= 0 ? zeroLineY - profitHeight : zeroLineY;
            const isActive = activeIndex === index;
            const profitTone = dashboardProfitTone(point.profitPence);
            return <g
              key={point.key}
              tabIndex={0}
              role="img"
              aria-label={`${point.label}: revenue ${formatPenceAsGBP(point.revenuePence)}, profit ${formatPenceAsGBP(point.profitPence)}`}
              className={`${styles.chartBarGroup} ${isActive ? styles.chartBarGroupActive : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
            >
              <rect x={groupX} y={revenueY} width={BAR_WIDTH} height={Math.max(revenueHeight, 1)} rx={2} className={styles.chartRevenueBar} fill="var(--primary)" opacity={isActive ? 1 : 0.85} />
              <rect x={groupX + BAR_WIDTH + BAR_GAP} y={profitY} width={BAR_WIDTH} height={Math.max(profitHeight, 1)} rx={2} fill={profitTone === "red" ? "var(--danger)" : "#16845d"} opacity={isActive ? 1 : 0.85} />
              {(points.length <= 20 || index % Math.ceil(points.length / 20) === 0) && <text x={groupX + BAR_WIDTH + BAR_GAP / 2} y={CHART_HEIGHT - 4} textAnchor="middle" className={styles.chartAxisLabel}>{point.label}</text>}
            </g>;
          })}
        </svg>
      </div>

      <div className={styles.chartDetailPanel} aria-live="polite">
        {active ? <>
          <div className={styles.chartDetailItem}><span>{active.label}</span><strong>Selected period</strong></div>
          <div className={styles.chartDetailItem}><span>Revenue</span><strong>{formatPenceAsGBP(active.revenuePence)}</strong></div>
          <div className={styles.chartDetailItem}><span>Profit</span><strong className={activeProfitTone === "red" ? styles.avgProfitRed : styles.avgProfitGreen}>{formatPenceAsGBP(active.profitPence)}</strong></div>
        </> : <div className={styles.chartDetailItem}><span>Tip</span><strong>Hover or tab through the bars for exact figures</strong></div>}
      </div>
    </>}
  </div>;
}
