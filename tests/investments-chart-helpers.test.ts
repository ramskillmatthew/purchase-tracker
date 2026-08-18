import { describe, expect, it } from "vitest";
import {
  buildChartGeometry, computeYTicks, dedupeAndSort, deriveCashFlowEvents,
  downsampleLTTB, filterByPeriod, formatAxisDate, periodStartDate, selectLabelIndices, type ChartPoint,
} from "@/lib/investments/chart-helpers";

function point(date: string, value: number, dataQuality: ChartPoint["dataQuality"] = "market"): ChartPoint {
  return { date, totalGbpValue: value, dataQuality };
}

describe("dedupeAndSort", () => {
  it("keeps the last occurrence when two points share a date, and sorts ascending", () => {
    const result = dedupeAndSort([point("2026-01-03", 300), point("2026-01-01", 100), point("2026-01-01", 150)]);
    expect(result.map(p => p.date)).toEqual(["2026-01-01", "2026-01-03"]);
    expect(result[0].totalGbpValue).toBe(150);
  });

  it("is a no-op on an already-sorted, deduped series", () => {
    const input = [point("2026-01-01", 100), point("2026-01-02", 110)];
    expect(dedupeAndSort(input).map(p => p.totalGbpValue)).toEqual([100, 110]);
  });
});

describe("filterByPeriod", () => {
  const series = [
    point("2025-01-01", 1000), point("2025-06-01", 1200), point("2025-12-01", 1500),
    point("2026-06-01", 1800), point("2026-08-10", 2000), point("2026-08-13", 2100),
  ];

  it("ALL returns the complete real series untouched, with no insufficient-history message", () => {
    const { points, insufficientMessage } = filterByPeriod(series, "ALL");
    expect(points).toEqual(series);
    expect(insufficientMessage).toBeNull();
  });

  it("a period boundary that falls between two real points keeps the last point BEFORE the boundary as a continuity anchor", () => {
    const { points } = filterByPeriod(series, "1M");
    // cutoff = 2026-08-13 - 30 days = 2026-07-14; only 2026-08-10 and
    // 2026-08-13 are genuinely within range, but 2026-06-01 is the real
    // anchor immediately before the boundary.
    expect(points.map(p => p.date)).toEqual(["2026-06-01", "2026-08-10", "2026-08-13"]);
  });

  it("never invents a value — the anchor is a real prior observation, not an interpolated or fabricated point", () => {
    const { points } = filterByPeriod(series, "1M");
    expect(points[0]).toEqual(point("2026-06-01", 1800));
  });

  it("points remain chronologically ordered after filtering", () => {
    const { points } = filterByPeriod(series, "1Y");
    for (let i = 1; i < points.length; i++) expect(points[i].date >= points[i - 1].date).toBe(true);
  });

  it("empty series stays empty with no message (the chart's own empty state handles messaging)", () => {
    expect(filterByPeriod([], "1M")).toEqual({ points: [], insufficientMessage: null });
  });

  it("a single real point in history, for a narrow period, is reported honestly as insufficient rather than hidden", () => {
    const { points, insufficientMessage } = filterByPeriod([point("2026-08-13", 500)], "1W");
    expect(points).toEqual([point("2026-08-13", 500)]);
    expect(insufficientMessage).toBe("Not enough price history for this period");
  });

  it("1D falls back to the same daily-boundary/message behaviour as any other period when the dedicated intraday endpoint isn't used — see lib/investments/intraday.ts for the real, genuine-15-minute-bar 1D path", () => {
    const { insufficientMessage } = filterByPeriod([point("2026-08-12", 490)], "1D");
    expect(insufficientMessage).toBe("Not enough price history for this period");
  });

  it("exactly two real points within a period is enough — no insufficient message", () => {
    const { insufficientMessage } = filterByPeriod([point("2026-08-01", 500), point("2026-08-13", 520)], "1M");
    expect(insufficientMessage).toBeNull();
  });

  it("duplicate timestamps are deduplicated (last wins) before period filtering, deterministically", () => {
    const withDupe = [...series, point("2026-08-13", 9999)];
    const { points } = filterByPeriod(withDupe, "1M");
    expect(points.filter(p => p.date === "2026-08-13")).toEqual([point("2026-08-13", 9999)]);
  });

  it("drops non-finite values before filtering rather than propagating NaN/Infinity", () => {
    const dirty = [point("2026-08-01", NaN), point("2026-08-13", 500)];
    const { points } = filterByPeriod(dirty, "ALL");
    expect(points).toEqual([point("2026-08-13", 500)]);
  });
});

describe("periodStartDate — exact calendar boundaries, never a fixed day-count", () => {
  it("1W is exactly 7 calendar days back", () => {
    expect(periodStartDate("2026-08-14", "1W")).toBe("2026-08-07");
  });

  it("1M subtracts exactly one calendar month", () => {
    expect(periodStartDate("2026-08-14", "1M")).toBe("2026-07-14");
  });

  it("3M subtracts exactly three calendar months, crossing a year boundary correctly", () => {
    expect(periodStartDate("2026-02-14", "3M")).toBe("2025-11-14");
  });

  it("1Y subtracts exactly one calendar year", () => {
    expect(periodStartDate("2026-08-14", "1Y")).toBe("2025-08-14");
  });

  it("REGRESSION: a month-end date clamps to the target month's real last day, never JS Date's own roll-over (naive 31 Mar - 1 month would become 3 Mar, not 28 Feb)", () => {
    expect(periodStartDate("2026-03-31", "1M")).toBe("2026-02-28"); // 2026 is not a leap year
  });

  it("leap year: 29 Feb minus 12 months clamps to the non-leap prior year's 28 Feb", () => {
    expect(periodStartDate("2028-02-29", "1Y")).toBe("2027-02-28");
  });

  it("leap year: subtracting 1 month FROM a leap-year 29 Feb lands on 29 Jan (January has 31 days, no clamping needed)", () => {
    expect(periodStartDate("2028-02-29", "1M")).toBe("2028-01-29");
  });

  it("month-end clamp also applies going INTO a leap February (31 Mar - 1M in a leap year clamps to 29 Feb, not 28)", () => {
    expect(periodStartDate("2028-03-31", "1M")).toBe("2028-02-29");
  });

  it("ALL has no boundary at all", () => {
    expect(periodStartDate("2026-08-14", "ALL")).toBeNull();
  });

  it("1D is exactly 1 calendar day back", () => {
    expect(periodStartDate("2026-08-14", "1D")).toBe("2026-08-13");
  });
});

describe("deriveCashFlowEvents — one marker per DATE, not per transaction", () => {
  it("collapses several same-day buys into one event with a count and summed amount", () => {
    const events = deriveCashFlowEvents([
      { date: "2026-08-01", type: "buy", amountGbp: 500, assetName: "NVDA" },
      { date: "2026-08-01", type: "buy", amountGbp: 300, assetName: "AMZN" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].amountGbp).toBe(800);
    expect(events[0].count).toBe(2);
    expect(events[0].label).toBe("2 holdings");
  });

  it("a single-transaction day uses the asset's own name as the label", () => {
    const events = deriveCashFlowEvents([{ date: "2026-08-01", type: "buy", amountGbp: 500, assetName: "NVDA" }]);
    expect(events[0].label).toBe("NVDA");
  });

  it("a sell is a negative flow (a withdrawal-equivalent, reducing portfolio value)", () => {
    const events = deriveCashFlowEvents([{ date: "2026-08-01", type: "sell", amountGbp: 200, assetName: "NVDA" }]);
    expect(events[0].amountGbp).toBe(-200);
  });

  it("a buy and a sell on the same date net against each other", () => {
    const events = deriveCashFlowEvents([
      { date: "2026-08-01", type: "buy", amountGbp: 500, assetName: "NVDA" },
      { date: "2026-08-01", type: "sell", amountGbp: 200, assetName: "AMZN" },
    ]);
    expect(events[0].amountGbp).toBe(300);
  });

  it("events come back sorted chronologically", () => {
    const events = deriveCashFlowEvents([
      { date: "2026-08-05", type: "buy", amountGbp: 100, assetName: "B" },
      { date: "2026-08-01", type: "buy", amountGbp: 100, assetName: "A" },
    ]);
    expect(events.map(e => e.date)).toEqual(["2026-08-01", "2026-08-05"]);
  });
});

describe("computeYTicks — adaptive domain, NOT always-start-at-zero", () => {
  it("REGRESSION: a tight weekly-style range (£13.8K-£16.4K) does NOT force the domain down to zero", () => {
    // The old behaviour (Math.min(...values, 0)) always included zero,
    // compressing real movement in a tight range into a nearly flat line.
    const { min } = computeYTicks([13800, 14200, 15100, 16400]);
    expect(min).toBeGreaterThan(5000);
  });

  it("a range whose low end is already close to zero (relative to its span) DOES pull zero in", () => {
    const { min } = computeYTicks([100, 5000, 16400]); // low end is well within 15% of the span
    expect(min).toBe(0);
  });

  it("zero is never padded BELOW itself for an all-positive near-zero series", () => {
    // Regression for a real bug caught before shipping: pulling zero in
    // must clamp the floor to exactly 0, not extend padding past it into
    // negative territory for values that were never negative.
    const { min } = computeYTicks([0, 5000, 10000]);
    expect(min).toBe(0);
  });

  it("produces roughly 4-5 ticks (nice-number rounding can occasionally add one or two more when the padded range doesn't divide cleanly) spanning min..max with headroom above the real data", () => {
    const { ticks, max } = computeYTicks([0, 5000, 10000]);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(max).toBeGreaterThan(10000);
  });

  it("nice-rounds tick values rather than raw fractional steps", () => {
    const { ticks } = computeYTicks([0, 9137, 18274]);
    // every step between consecutive ticks should be a "nice" 1/2/5×10^n number
    for (let i = 1; i < ticks.length; i++) {
      const step = ticks[i] - ticks[i - 1];
      const exponent = Math.floor(Math.log10(step));
      const fraction = Math.round((step / 10 ** exponent) * 100) / 100;
      expect([1, 2, 5, 10]).toContain(fraction);
    }
  });

  it("a flat series (all equal values) never divides by zero / produces NaN ticks, and has a real non-zero-height span", () => {
    const { ticks, min, max } = computeYTicks([500, 500, 500]);
    expect(ticks.every(t => Number.isFinite(t))).toBe(true);
    expect(max).toBeGreaterThan(min);
  });

  it("an all-zero series stays finite with a real span", () => {
    const { ticks, min, max } = computeYTicks([0, 0, 0]);
    expect(ticks.every(t => Number.isFinite(t))).toBe(true);
    expect(max).toBeGreaterThan(min);
  });

  it("negative values (crossing zero) are handled defensively without NaN, and zero sits within the domain", () => {
    const { ticks, min, max } = computeYTicks([-500, 300]);
    expect(ticks.every(t => Number.isFinite(t))).toBe(true);
    expect(min).toBeLessThanOrEqual(0);
    expect(max).toBeGreaterThanOrEqual(0);
  });

  it("non-finite values are ignored rather than producing NaN ticks", () => {
    const { ticks } = computeYTicks([NaN, 1000, Infinity, 2000]);
    expect(ticks.every(t => Number.isFinite(t))).toBe(true);
  });
});

const VALUE_OF = (p: ChartPoint) => p.totalGbpValue;

describe("downsampleLTTB", () => {
  function series(n: number, valueAt: (i: number) => number): ChartPoint[] {
    return Array.from({ length: n }, (_, i) => point(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, valueAt(i)));
  }

  it("returns the input unchanged when it's already at or below the threshold", () => {
    const s = series(10, i => i * 100);
    expect(downsampleLTTB(s, 500, VALUE_OF)).toEqual(s);
  });

  it("always preserves the first and last real point", () => {
    const s = series(1000, i => 10000 + Math.sin(i / 10) * 500);
    const down = downsampleLTTB(s, 100, VALUE_OF);
    expect(down[0]).toEqual(s[0]);
    expect(down[down.length - 1]).toEqual(s[s.length - 1]);
  });

  it("downsamples to approximately the requested threshold", () => {
    const s = series(1000, i => 10000 + i);
    const down = downsampleLTTB(s, 200, VALUE_OF);
    expect(down.length).toBe(200);
  });

  it("preserves a genuine spike rather than averaging it away", () => {
    const s = series(300, i => 10000);
    s[150] = point("2026-06-01", 50000); // one real, sharp spike
    const down = downsampleLTTB(s, 60, VALUE_OF);
    expect(down.some(p => p.totalGbpValue === 50000)).toBe(true);
  });

  it("every returned point is a genuine point from the source series (never interpolated)", () => {
    const s = series(500, i => 10000 + i * 3.7);
    const down = downsampleLTTB(s, 80, VALUE_OF);
    for (const p of down) expect(s).toContainEqual(p);
  });

  it("a must-keep date dropped by the LTTB pass is added back in, in chronological order", () => {
    const s = series(300, () => 10000);
    const down = downsampleLTTB(s, 30, VALUE_OF, new Set(["2026-01-15"]));
    expect(down.some(p => p.date === "2026-01-15")).toBe(true);
    for (let i = 1; i < down.length; i++) expect(down[i].date >= down[i - 1].date).toBe(true);
  });
});

describe("buildChartGeometry", () => {
  const opts = { width: 640, height: 166, padTop: 10, padBottom: 20, padLeft: 4, padRight: 40 };

  it("empty series returns an empty, non-throwing shape", () => {
    const geo = buildChartGeometry([], VALUE_OF, opts);
    expect(geo.pathD).toBe("");
    expect(geo.areaD).toBe("");
    expect(geo.yTicks).toEqual([]);
  });

  it("a single point renders no line/area path (the component draws a dot instead) without NaN coordinates", () => {
    const geo = buildChartGeometry([point("2026-08-13", 1000)], VALUE_OF, opts);
    expect(geo.areaD).toBe("");
    expect(Number.isFinite(geo.xFor(0))).toBe(true);
    expect(Number.isFinite(geo.yFor(1000))).toBe(true);
  });

  it("two points produce a real M/L path with no NaN", () => {
    const geo = buildChartGeometry([point("2026-08-01", 1000), point("2026-08-13", 1200)], VALUE_OF, opts);
    expect(geo.pathD).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
    expect(geo.pathD).not.toMatch(/NaN/);
  });

  it("a flat series (identical values) produces a valid horizontal path, not a divide-by-zero NaN path", () => {
    const geo = buildChartGeometry([point("2026-08-01", 800), point("2026-08-13", 800)], VALUE_OF, opts);
    expect(geo.pathD).not.toMatch(/NaN/);
  });

  it("non-finite values in the series are excluded from the path entirely", () => {
    const geo = buildChartGeometry([point("2026-08-01", NaN), point("2026-08-13", 800)], VALUE_OF, opts);
    expect(geo.areaD).toBe("");
    expect(geo.pathD).not.toMatch(/NaN/);
  });

  it("a degenerate zero-width container never produces NaN (division guarded, not just clamped late)", () => {
    const geo = buildChartGeometry([point("2026-08-01", 100), point("2026-08-13", 200)], VALUE_OF, { ...opts, width: 20 });
    expect(geo.pathD).not.toMatch(/NaN/);
  });
});

describe("selectLabelIndices — collision-safe x-axis tick selection", () => {
  it("keeps the first index, respects the minimum gap, and always keeps the true last index", () => {
    const xPositions = [0, 10, 20, 100, 200, 300, 305];
    const kept = selectLabelIndices(xPositions, 72);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(xPositions.length - 1);
    for (let i = 1; i < kept.length; i++) expect(xPositions[kept[i]] - xPositions[kept[i - 1]]).toBeGreaterThanOrEqual(72);
  });

  it("a too-close final label REPLACES its too-close predecessor rather than both rendering (no overlap)", () => {
    // Point 4 (x=295) is within the gap of point 3 (x=250) — the final
    // real date must still win, replacing 250 rather than both showing.
    const xPositions = [0, 80, 160, 250, 295];
    const kept = selectLabelIndices(xPositions, 72);
    expect(kept).not.toContain(3);
    expect(kept).toContain(4);
  });

  it("empty input returns no labels", () => {
    expect(selectLabelIndices([], 72)).toEqual([]);
  });

  it("a single point always keeps its one label", () => {
    expect(selectLabelIndices([42], 72)).toEqual([0]);
  });
});

describe("formatAxisDate — period-aware, never fabricates intraday precision we don't have", () => {
  it("ALL/1Y use \"Mon 'YY\" form", () => {
    expect(formatAxisDate("2026-05-14", "ALL")).toBe("May '26");
    expect(formatAxisDate("2026-05-14", "1Y")).toBe("May '26");
  });

  it("1M/3M use \"D Mon\" form", () => {
    expect(formatAxisDate("2026-05-17", "1M")).toBe("17 May");
    expect(formatAxisDate("2026-05-17", "3M")).toBe("17 May");
  });

  it("1W uses a short weekday + day form", () => {
    expect(formatAxisDate("2026-08-13", "1W")).toMatch(/^\w{3} 13$/);
  });

  it("1D shows a real clock time — its points carry a genuine full intraday timestamp (see lib/investments/intraday.ts), never a relabelled daily close", () => {
    expect(formatAxisDate("2026-08-13T14:30:00", "1D")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("an invalid date string returns an empty string rather than \"Invalid Date\"", () => {
    expect(formatAxisDate("not-a-date", "ALL")).toBe("");
  });

  it("REGRESSION: a date-only string never shifts to the adjacent calendar day — parsed and formatted entirely in UTC, so a server-render (UTC) and a client hydration (any local timezone) can never disagree on which day a point falls on", () => {
    // The boundary cases most likely to flip under local-time parsing: the
    // first day of a month/year, where a negative UTC offset local
    // interpretation would roll back to the previous day.
    expect(formatAxisDate("2026-01-01", "1M")).toBe("1 Jan");
    expect(formatAxisDate("2026-03-01", "ALL")).toBe("Mar '26");
    expect(formatAxisDate("2026-12-31", "1M")).toBe("31 Dec");
  });
});
