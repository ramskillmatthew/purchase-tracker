"use client";

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { formatGbp, formatGbpCompactTick, formatShortDate } from "@/lib/investments/format";
import {
  buildChartGeometry, downsampleLTTB, formatAxisDate, selectLabelIndices,
  type CashFlowEvent, type ChartPoint, type Period,
} from "@/lib/investments/chart-helpers";

export type { CashFlowEvent, ChartPoint };

// The SVG's viewBox tracks the container's REAL measured pixel size (via
// ResizeObserver, see useMeasuredSize below) rather than a fixed constant
// on either axis. A fixed viewBox scaled to fit a narrower/shorter
// container drags every font-size down with it — a 900-unit viewBox
// rendered at 600px actual width silently shrinks "11px" text to ~7px.
// Matching the viewBox to the real size keeps 1 viewBox unit == 1 CSS
// pixel, so font sizes below are true, stable pixel sizes at any size —
// and it means the chart genuinely fills whatever room .inv-hero-chart-
// region's CSS grid gives it, rather than being centred inside a taller
// wrapper at some independently-guessed height.
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 220;
const MIN_HEIGHT = 120;
const PAD_TOP = 10;
const PAD_BOTTOM = 20;
const PAD_LEFT = 4;
const PAD_RIGHT = 42;
const MIN_LABEL_GAP_PX = 65;
// A real ALL-period series now genuinely has hundreds of daily points
// (real provider history, not just transaction dates) — this caps how
// many are actually RENDERED, never how many exist. downsampleLTTB keeps
// the shape (including real spikes/dips), so the line still looks exactly
// as detailed at 500 rendered points as it would at the full count, just
// without asking the browser to draw an SVG path with thousands of
// segments the screen has no pixels to distinguish anyway.
const MAX_RENDER_POINTS = 500;

function useMeasuredSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: Math.max(MIN_HEIGHT, rect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size.width, size.height] as const;
}

/** Tooltip's own date/time line — 1D's `date` field is a full intraday timestamp (see lib/investments/intraday.ts), so it gets the complete date+time rather than formatShortDate's date-only form. */
function formatTooltipTimestamp(iso: string, period: Period): string {
  if (period !== "1D") return formatShortDate(iso);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * REGRESSION: "mixed" and "purchase_price_fallback" used to share the same
 * tooltip wording ("estimated (purchase price)"), which is factually wrong
 * for "mixed" — that quality means some holdings are genuine live/latest
 * market data and only OTHERS are held at their last known snapshot (see
 * lib/investments/intraday.ts's own dataQuality comment), never that the
 * point is a purchase-price guess. Never call a mixed-resolution point a
 * purchase-price fallback, and never call a genuine market point anything
 * other than silent (no caveat needed).
 */
function provenanceSuffix(dataQuality: ChartPoint["dataQuality"]): string {
  if (dataQuality === "purchase_price_fallback") return " · estimated (purchase price)";
  if (dataQuality === "mixed") return " · mixed resolution (live + last known)";
  return "";
}

/**
 * A focused, dependency-free SVG area chart — no charting library exists
 * anywhere in this app, and this is a single, well-scoped visualisation
 * (one smooth line + gradient fill + axis labels + hover tooltip + cash-
 * flow event markers), so a hand-built component is more appropriate than
 * a new dependency. Plots ONLY real, already-reconstructed points — never
 * generates synthetic or random data. Geometry/tick-selection/downsampling
 * logic itself lives in lib/investments/chart-helpers.ts so it's testable
 * without rendering.
 *
 * Renders the real GBP totalGbpValue series with cash-flow event markers
 * (buys/sells visibly explain a jump that isn't market movement) — the
 * ONLY mode this chart has. A separate time-weighted "Estimated return"
 * mode existed here previously and was removed at the user's explicit
 * request (it didn't represent actual profit relative to money invested,
 * which is what they wanted front and centre) — see
 * PortfolioHeroCard.tsx's own comment on the current holdings-return
 * figure that replaced it.
 */
export default function PortfolioChart({ points, period, insufficientMessage, cashFlowEvents }: {
  points: ChartPoint[];
  period: Period; insufficientMessage?: string | null; cashFlowEvents: CashFlowEvent[];
}) {
  const [wrapRef, width, HEIGHT] = useMeasuredSize<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const gradientId = useId();

  const eventDatesInRange = useMemo(() => new Set(cashFlowEvents.map(e => e.date)), [cashFlowEvents]);

  // Downsampled ONLY for what gets rendered/hovered — the real series
  // passed in is never mutated, and every rendered point is still a
  // genuine observation (LTTB picks among real points, it never
  // interpolates a new one). Cash-flow event dates are never dropped by
  // downsampling, even if LTTB judged their neighbourhood visually
  // insignificant.
  const renderPoints = useMemo(
    () => downsampleLTTB(points, MAX_RENDER_POINTS, (p: ChartPoint) => p.totalGbpValue, eventDatesInRange),
    [points, eventDatesInRange],
  );

  const valueOf = (p: ChartPoint) => p.totalGbpValue;

  const { pathD, areaD, xFor, yFor, minValue, maxValue, yTicks } = useMemo(
    () => buildChartGeometry(renderPoints, valueOf, { width, height: HEIGHT, padTop: PAD_TOP, padBottom: PAD_BOTTOM, padLeft: PAD_LEFT, padRight: PAD_RIGHT }),
    [renderPoints, width, HEIGHT],
  );

  if (renderPoints.length === 0) {
    return <div ref={wrapRef} className="inv-chart-empty">No portfolio history yet — add an investment to start tracking performance.</div>;
  }

  const hovered = hoverIndex !== null ? renderPoints[hoverIndex] : null;
  const anyFallback = renderPoints.some(p => p.dataQuality !== "market");
  const singlePoint = renderPoints.length === 1;
  const noteText = insufficientMessage ?? (singlePoint ? "Just one data point so far — the chart will build a real trend line as more prices come in." : null);

  function handleMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = ((event.clientX - rect.left) / rect.width) * width;
    let closest = 0;
    let closestDistance = Infinity;
    renderPoints.forEach((_, i) => {
      const distance = Math.abs(xFor(i) - relativeX);
      if (distance < closestDistance) { closestDistance = distance; closest = i; }
    });
    setHoverIndex(closest);
  }

  const labelIndices = selectLabelIndices(renderPoints.map((_, i) => xFor(i)), MIN_LABEL_GAP_PX);
  // Clamped, not just flipped: keeps the tooltip's LEFT edge from ever
  // sitting left of the plot, and flips it left of the point once the
  // point is far enough right that a right-growing panel would clip
  // against the card edge. Verified live at the first/middle/last
  // rendered point — see this feature's completion report.
  const hoverXPercent = hoverIndex !== null ? (xFor(hoverIndex) / width) * 100 : 0;
  const flipLeft = hoverXPercent > 65;
  const tooltipLeftPercent = flipLeft ? Math.max(hoverXPercent, 22) : Math.min(hoverXPercent, 78);

  const eventMarkerIndices = renderPoints.map((p, i) => (eventDatesInRange.has(p.date) ? i : -1)).filter(i => i >= 0);
  const eventByDate = new Map(cashFlowEvents.map(e => [e.date, e]));

  return <div className="inv-chart-wrap" ref={wrapRef}>
    <svg
      viewBox={`0 0 ${width} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" preserveAspectRatio="none"
      aria-label={`Portfolio value chart from ${formatShortDate(renderPoints[0].date)} to ${formatShortDate(renderPoints[renderPoints.length - 1].date)}, ranging from ${formatGbp(minValue)} to ${formatGbp(maxValue)}`}
      onMouseMove={handleMove} onMouseLeave={() => setHoverIndex(null)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--inv-green)" stopOpacity="0.3" />
          <stop offset="45%" stopColor="var(--inv-green)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--inv-green)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {yTicks.map((tick, i) => <g key={i}>
        <line
          x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yFor(tick)} y2={yFor(tick)}
          stroke="var(--inv-border-subtle)" strokeWidth={1} vectorEffect="non-scaling-stroke"
        />
        <text x={width - PAD_RIGHT + 8} y={yFor(tick) + 3} fill="var(--inv-muted)" fontSize={10.5}>
          {formatGbpCompactTick(tick, yTicks.length > 1 ? yTicks[1] - yTicks[0] : 0)}
        </text>
      </g>)}

      {areaD && <path d={areaD} fill={`url(#${gradientId})`} stroke="none" />}
      {!singlePoint && <path d={pathD} fill="none" stroke="var(--inv-green)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {singlePoint && <circle cx={xFor(0)} cy={yFor(valueOf(renderPoints[0]))} r={4} fill="var(--inv-green)" stroke="var(--inv-bg)" strokeWidth={2} />}

      {eventMarkerIndices.map(i => <circle key={`event-${i}`} cx={xFor(i)} cy={yFor(valueOf(renderPoints[i]))} r={3.5} fill="var(--inv-purple)" stroke="var(--inv-bg)" strokeWidth={1.5} />)}

      {renderPoints.map((p, i) => labelIndices.includes(i) && <text key={i} x={xFor(i)} y={HEIGHT - 6} fill="var(--inv-muted)" fontSize={10.5} textAnchor={i === 0 ? "start" : i === renderPoints.length - 1 ? "end" : "middle"}>
        {formatAxisDate(p.date, period)}
      </text>)}

      {hovered && <g>
        <line x1={xFor(hoverIndex!)} x2={xFor(hoverIndex!)} y1={PAD_TOP} y2={HEIGHT - PAD_BOTTOM} stroke="var(--inv-border)" strokeWidth={1} strokeDasharray="3 3" />
        <circle cx={xFor(hoverIndex!)} cy={yFor(valueOf(hovered))} r={4} fill="var(--inv-green)" stroke="var(--inv-bg)" strokeWidth={2} />
      </g>}
    </svg>

    {hovered && <div className="inv-chart-tooltip" style={{ left: `${tooltipLeftPercent}%`, top: 4, transform: flipLeft ? "translateX(-100%)" : undefined }}>
      <strong>{formatGbp(hovered.totalGbpValue)}</strong>
      <span>{formatTooltipTimestamp(hovered.date, period)}{provenanceSuffix(hovered.dataQuality)}</span>
      {eventByDate.has(hovered.date) && <span className="inv-chart-tooltip-event">
        {(eventByDate.get(hovered.date)!.amountGbp >= 0 ? "+" : "")}{formatGbp(eventByDate.get(hovered.date)!.amountGbp)} · {eventByDate.get(hovered.date)!.label}
      </span>}
    </div>}

    {noteText && <p className="inv-chart-single-note">{noteText}</p>}

    {anyFallback && <p className="sr-only">Some early portfolio values use each investment&apos;s own purchase price until genuine market history begins, and are not live market data.</p>}
  </div>;
}
