/**
 * Pure, dependency-free helpers behind PortfolioChart/PortfolioHeroCard —
 * extracted so period filtering, tick selection, and path geometry are
 * independently testable as real functions rather than only reachable
 * through a rendered component.
 */

export type ChartPoint = { date: string; totalGbpValue: number; dataQuality: "market" | "mixed" | "purchase_price_fallback" };

export const PERIODS = ["1D", "1W", "1M", "3M", "1Y", "ALL"] as const;
export type Period = typeof PERIODS[number];

/** Later duplicate wins (most-recently-computed snapshot for that date), then re-sorted ascending — never assumes the input arrived pre-sorted or pre-deduped. */
export function dedupeAndSort(points: ChartPoint[]): ChartPoint[] {
  const byDate = new Map<string, ChartPoint>();
  for (const p of points) byDate.set(p.date, p);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Subtracts N calendar months from a date, clamped to the last valid day
 * of the target month rather than JS Date's own roll-over behaviour
 * (`new Date(2026,2,31)` minus 1 month naively becomes 3 Mar, not 28 Feb —
 * setDate(1) first avoids that entirely, then the day-of-month is
 * re-applied clamped to whatever the target month actually has).
 */
function subtractCalendarMonths(iso: string, months: number): string {
  const original = new Date(`${iso}T00:00:00Z`);
  const day = original.getUTCDate();
  const firstOfMonth = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth(), 1));
  firstOfMonth.setUTCMonth(firstOfMonth.getUTCMonth() - months);
  const daysInTargetMonth = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() + 1, 0)).getUTCDate();
  firstOfMonth.setUTCDate(Math.min(day, daysInTargetMonth));
  return firstOfMonth.toISOString().slice(0, 10);
}

/**
 * Exact calendar-boundary start date for a period, anchored on the latest
 * real date in the series — never a fixed day-count (30/90/365) standing
 * in for "1 month"/"3 months"/"1 year". Handles leap years and DST-affected
 * dates correctly because it operates on UTC calendar fields (year/month/
 * day), never wall-clock hours that a DST transition could shift.
 */
export function periodStartDate(latestDate: string, period: Period): string | null {
  switch (period) {
    case "ALL": return null;
    case "1D": {
      const d = new Date(`${latestDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    case "1W": {
      const d = new Date(`${latestDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 7);
      return d.toISOString().slice(0, 10);
    }
    case "1M": return subtractCalendarMonths(latestDate, 1);
    case "3M": return subtractCalendarMonths(latestDate, 3);
    case "1Y": return subtractCalendarMonths(latestDate, 12);
  }
}

// Shown when the dedicated genuine-intraday endpoint (lib/investments/
// intraday.ts) reports it has no real 15-minute bars available right now
// (market closed, no intraday-capable holding, or a provider failure) —
// the UI falls back to this daily-boundary filterByPeriod path and says
// so honestly, rather than silently presenting daily closes as if they
// were live intraday movement.
export const INTRADAY_UNAVAILABLE_MESSAGE = "Live intraday data isn't available right now — showing the most recent daily close instead.";

/**
 * Filters the real series to a period using an EXACT calendar boundary
 * (see periodStartDate) — never a fixed day-count, and never "just take
 * the last N points". When the boundary falls strictly between two real
 * points, the last point BEFORE the boundary is kept as a continuity
 * anchor so the line doesn't appear to start mid-air — no value is
 * invented, it's a genuine prior observation.
 */
export function filterByPeriod(points: ChartPoint[], period: Period): { points: ChartPoint[]; insufficientMessage: string | null } {
  const clean = dedupeAndSort(points.filter(p => Number.isFinite(p.totalGbpValue)));
  if (clean.length === 0) return { points: [], insufficientMessage: null };

  const cutoffIso = periodStartDate(clean[clean.length - 1].date, period);
  if (cutoffIso === null) return { points: clean, insufficientMessage: null };

  const firstInRangeIndex = clean.findIndex(p => p.date >= cutoffIso);
  const withinRange = firstInRangeIndex === -1 ? [] : clean.slice(firstInRangeIndex);
  const anchor = firstInRangeIndex > 0 ? clean[firstInRangeIndex - 1] : null;
  const filtered = anchor ? [anchor, ...withinRange] : withinRange;

  if (filtered.length < 2) {
    return { points: filtered.length > 0 ? filtered : clean.slice(-1), insufficientMessage: "Not enough price history for this period" };
  }
  return { points: filtered, insufficientMessage: null };
}

/** Classic "nice number" rounding (Heckbert) — 1/2/5/10 × a power of ten, the values a human would actually choose for an axis tick or step. */
function niceNumber(value: number, round: boolean): number {
  if (value === 0) return 0;
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  const exponent = Math.floor(Math.log10(abs));
  const fraction = abs / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return sign * niceFraction * 10 ** exponent;
}

/**
 * Adaptive Y-domain — this is deliberately NOT "always start at zero".
 * Forcing zero into a ~£13.8K-£16.4K weekly range would compress the only
 * movement that range actually has into a nearly flat line; a real
 * financial chart zooms to where the data lives instead. Zero is only
 * pulled in when the series genuinely crosses it, or the padded floor
 * would otherwise land close enough to zero (within 15% of the span) that
 * excluding it would look like an arbitrary cut rather than a deliberate
 * zoom.
 */
export function computeYTicks(values: number[], tickCount = 4): { min: number; max: number; ticks: number[] } {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { min: 0, max: 1, ticks: [0, 1] };

  const rawMin = Math.min(...finite);
  const rawMax = Math.max(...finite);

  // Flat series (including a single distinct value repeated): a small
  // symmetric domain around it — never a zero-height range that would
  // divide by zero downstream.
  if (rawMin === rawMax) {
    const padding = Math.max(Math.abs(rawMin) * 0.1, 1);
    const step = niceNumber((padding * 2) / tickCount, true) || 1;
    const niceMin = Math.floor((rawMin - padding) / step) * step;
    const ticks = Array.from({ length: tickCount + 1 }, (_, i) => niceMin + i * step);
    return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
  }

  const span = rawMax - rawMin;
  const padding = span * 0.1;
  let paddedMin = rawMin - padding;
  const paddedMax = rawMax + padding;

  // nearZero data is already >=0 — pulling zero in means the floor
  // becomes exactly 0, never padding FURTHER below into negative
  // territory for a value set that was never negative. crossesZero data
  // is already genuinely negative at the low end, so its own padding
  // below rawMin is left as-is (no clamping needed either way).
  const crossesZero = rawMin < 0 && rawMax > 0;
  const nearZero = rawMin >= 0 && rawMin < span * 0.15;
  if (nearZero) paddedMin = 0;

  const niceStep = niceNumber((paddedMax - paddedMin) / tickCount, true) || 1;
  const niceMin = Math.floor(paddedMin / niceStep) * niceStep;
  const niceMax = Math.ceil(paddedMax / niceStep) * niceStep;

  const ticks: number[] = [];
  for (let t = niceMin; t <= niceMax + niceStep * 0.5; t += niceStep) ticks.push(Math.round(t * 1e6) / 1e6);

  return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}

export type CashFlowEvent = { date: string; amountGbp: number; label: string; count: number };

/**
 * Groups raw buy/sell transactions into one cash-flow event per DATE (not
 * one marker per transaction) — several same-day purchases collapse into
 * one event with a count, matching "use compact markers... where multiple
 * events occur on the same date" rather than cluttering the chart.
 */
export function deriveCashFlowEvents(transactions: Array<{ date: string; type: "buy" | "sell"; amountGbp: number; assetName: string }>): CashFlowEvent[] {
  const byDate = new Map<string, { amountGbp: number; names: string[] }>();
  for (const tx of transactions) {
    const signedAmount = tx.type === "buy" ? tx.amountGbp : -tx.amountGbp;
    const existing = byDate.get(tx.date);
    if (existing) { existing.amountGbp += signedAmount; existing.names.push(tx.assetName); }
    else byDate.set(tx.date, { amountGbp: signedAmount, names: [tx.assetName] });
  }
  return [...byDate.entries()]
    .map(([date, { amountGbp, names }]) => ({
      date, amountGbp: Math.round(amountGbp * 100) / 100, count: names.length,
      label: names.length === 1 ? names[0] : `${names.length} holdings`,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Largest-Triangle-Three-Buckets downsampling — shape-preserving, keeps
 * the first and last point always, and picks whichever point in each
 * bucket forms the largest triangle with the previous kept point and the
 * next bucket's average (i.e. the point that matters most for the
 * silhouette), so a genuine spike or dip survives even if most of its
 * neighbours get dropped. Only ever reduces which points are RENDERED —
 * the source series passed in is never mutated or truncated for anything
 * other than this one downsampled copy.
 */
/**
 * `valueOf` makes this reusable for both the GBP value series and the
 * percent-return series (same shape-preserving guarantee either way).
 * `mustKeepDates` (e.g. cash-flow event dates) are appended back in after
 * the LTTB pass if it happened to drop them — a real contribution/
 * withdrawal marker must never silently vanish from the rendered line
 * just because it fell in a bucket LTTB judged less visually significant.
 */
export function downsampleLTTB<T extends { date: string }>(
  points: T[], threshold: number, valueOf: (p: T) => number, mustKeepDates?: Set<string>,
): T[] {
  const n = points.length;
  if (threshold >= n || threshold <= 2) return points;

  const sampled: T[] = [points[0]];
  const bucketSize = (n - 2) / (threshold - 2);
  let aIndex = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor(i * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, n - 1);

    const nextBucketStart = bucketEnd;
    const nextBucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

    let avgX = 0, avgY = 0, avgCount = 0;
    for (let j = nextBucketStart; j < nextBucketEnd; j++) {
      avgX += j;
      avgY += valueOf(points[j]);
      avgCount++;
    }
    if (avgCount > 0) { avgX /= avgCount; avgY /= avgCount; } else { avgX = n - 1; avgY = valueOf(points[n - 1]); }

    const pointAX = aIndex;
    const pointAY = valueOf(points[aIndex]);

    let maxArea = -1;
    let maxAreaIndex = bucketStart;
    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs((pointAX - avgX) * (valueOf(points[j]) - pointAY) - (pointAX - j) * (avgY - pointAY)) * 0.5;
      if (area > maxArea) { maxArea = area; maxAreaIndex = j; }
    }
    sampled.push(points[maxAreaIndex]);
    aIndex = maxAreaIndex;
  }

  sampled.push(points[n - 1]);

  if (mustKeepDates && mustKeepDates.size > 0) {
    const keptDates = new Set(sampled.map(p => p.date));
    const mustAdd = points.filter(p => mustKeepDates.has(p.date) && !keptDates.has(p.date));
    if (mustAdd.length > 0) return [...sampled, ...mustAdd].sort((a, b) => a.date.localeCompare(b.date));
  }

  return sampled;
}

export type ChartGeometry = {
  pathD: string; areaD: string; xFor: (index: number) => number; yFor: (value: number) => number;
  minValue: number; maxValue: number; yTicks: number[];
};

/** `valueOf` makes this reusable for both the GBP value series (Portfolio value mode) and the percent-return series (Return mode) — same geometry, same adaptive-domain guarantees, different unit. */
export function buildChartGeometry<T extends { date: string }>(
  points: T[], valueOf: (p: T) => number,
  opts: { width: number; height: number; padTop: number; padBottom: number; padLeft: number; padRight: number },
): ChartGeometry {
  const safePoints = points.filter(p => Number.isFinite(valueOf(p)));
  if (safePoints.length === 0) {
    return { pathD: "", areaD: "", xFor: () => 0, yFor: () => 0, minValue: 0, maxValue: 0, yTicks: [] };
  }
  const { width, height, padTop, padBottom, padLeft, padRight } = opts;
  const values = safePoints.map(valueOf);
  const { min, max, ticks } = computeYTicks(values);
  const range = max - min || 1;
  const innerWidth = Math.max(0, width - padLeft - padRight);
  const innerHeight = Math.max(0, height - padTop - padBottom);

  const xFor = (index: number) => padLeft + (safePoints.length === 1 ? innerWidth / 2 : (index / (safePoints.length - 1)) * innerWidth);
  const yFor = (value: number) => padTop + innerHeight - ((value - min) / range) * innerHeight;

  const line = safePoints.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(2)} ${yFor(valueOf(p)).toFixed(2)}`).join(" ");
  const area = safePoints.length > 1
    ? `${line} L ${xFor(safePoints.length - 1).toFixed(2)} ${(padTop + innerHeight).toFixed(2)} L ${xFor(0).toFixed(2)} ${(padTop + innerHeight).toFixed(2)} Z`
    : "";

  return { pathD: line, areaD: area, xFor, yFor, minValue: min, maxValue: Math.max(...values), yTicks: ticks };
}

/**
 * Collision-safe x-axis label selection. Always keeps the first index;
 * keeps each later index only once it clears minGapPx from the last KEPT
 * label; the true final index always wins over a too-close predecessor
 * (replacing it) rather than being dropped, so the most recent date is
 * never hidden.
 */
export function selectLabelIndices(xPositions: number[], minGapPx: number): number[] {
  const n = xPositions.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const kept: number[] = [0];
  for (let i = 1; i < n; i++) {
    const prev = kept[kept.length - 1];
    if (xPositions[i] - xPositions[prev] >= minGapPx) {
      kept.push(i);
    } else if (i === n - 1) {
      kept[kept.length - 1] = i;
    }
  }
  return kept;
}

/**
 * Period-aware axis date formatting. 1D falls back to the same day+month
 * shape as 1M/3M rather than fabricating clock times — the underlying
 * snapshots are daily (date-only), never real intraday timestamps.
 */
export function formatAxisDate(iso: string, period: Period): string {
  // 1D's points carry a full intraday timestamp (see lib/investments/
  // intraday.ts), not a date-only string — the axis shows a clock time,
  // never a date, matching genuinely intraday data with a genuinely
  // time-based label.
  if (period === "1D") {
    const intraday = new Date(iso);
    if (Number.isNaN(intraday.getTime())) return "";
    return intraday.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  // 'Z'-suffixed — parsed as UTC, never the browser's local timezone. A
  // date-only ISO string parsed WITHOUT the suffix is local time; that only
  // happened to render correctly because parsing and formatting both ran
  // in the same execution context — but a server-rendered pass (Vercel,
  // UTC) and a client hydration pass (the visitor's own timezone) do NOT
  // share a context, so an unsuffixed parse there really can flip the
  // displayed calendar day. Never let the calendar date depend on where
  // the code happens to run.
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  if (period === "ALL" || period === "1Y") {
    const month = date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
    const yy = String(date.getUTCFullYear()).slice(-2);
    return `${month} '${yy}`;
  }
  if (period === "1W") {
    return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
  }
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
