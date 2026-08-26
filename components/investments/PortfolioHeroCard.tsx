"use client";

import { useEffect, useMemo, useState } from "react";
import PortfolioChart from "./PortfolioChart";
import { INTRADAY_UNAVAILABLE_MESSAGE, PERIODS, filterByPeriod, type ChartPoint, type Period } from "@/lib/investments/chart-helpers";
import { formatGbp, formatPercent } from "@/lib/investments/format";
import type { CashFlowEventResponse, PortfolioTotalsResponse } from "@/lib/investments/view-model-types";

type IntradayFetchState =
  | { status: "idle" | "loading" }
  | { status: "ready"; points: ChartPoint[] }
  | { status: "unavailable"; reason: string };

/** GET /api/investments/portfolio/intraday's real shape — a genuine 15-minute-bar series for intraday-capable holdings, held-flat elsewhere. Never fetched for any period but 1D. */
type IntradayResponse = { available: boolean; reason: string | null; points: Array<{ timestamp: string; totalGbpValue: number; dataQuality: ChartPoint["dataQuality"] }> };

/**
 * `totals.allTimeReturnGbp`/`allTimeReturnPercent` (from portfolio-view.ts:
 * currentGbpValue − costBasisGbp, summed over currently-open holdings) is
 * the ONE return figure this card shows — displayed as "Current holdings
 * return", not "Lifetime"/"All-time", at the user's explicit instruction:
 * it only covers positions still open right now, and does not yet include
 * realised gains/losses from a fully sold position (e.g. a historical
 * Duolingo loss) — that requires a genuine multi-lot ledger with realised
 * P/L tracking, a separate future task, not something this label should
 * imply it already does.
 *
 * A previous version of this card also had a "Portfolio value / Estimated
 * return" mode toggle, rendering a second, time-weighted (unitized-index)
 * return figure and chart — removed at the user's explicit request: it
 * didn't represent actual profit relative to money invested (currently
 * ~+243% vs. the real ~+17.8%), which is confusing rather than useful for
 * a personal portfolio tracker. This card now has exactly one mode.
 */
export default function PortfolioHeroCard({ totals, chartSeries, cashFlowEvents, fallbackHoldingsCount }: {
  totals: PortfolioTotalsResponse; chartSeries: ChartPoint[]; cashFlowEvents: CashFlowEventResponse[]; fallbackHoldingsCount: number;
}) {
  const [period, setPeriod] = useState<Period>("ALL");
  const [intraday, setIntraday] = useState<IntradayFetchState>({ status: "idle" });
  const { points: dailyVisiblePoints, insufficientMessage: dailyInsufficientMessage } = useMemo(() => filterByPeriod(chartSeries, period), [chartSeries, period]);

  // 1D is the one period that never comes from the daily chartSeries —
  // see lib/investments/intraday.ts for why a daily-close series can never
  // honestly represent "today". Fetched only when 1D is actually selected.
  useEffect(() => {
    if (period !== "1D") return;
    let cancelled = false;
    setIntraday({ status: "loading" });
    fetch("/api/investments/portfolio/intraday")
      .then(res => res.json() as Promise<IntradayResponse>)
      .then(body => {
        if (cancelled) return;
        if (body.available) {
          setIntraday({ status: "ready", points: body.points.map(p => ({ date: p.timestamp, totalGbpValue: p.totalGbpValue, dataQuality: p.dataQuality })) });
        } else {
          setIntraday({ status: "unavailable", reason: body.reason ?? INTRADAY_UNAVAILABLE_MESSAGE });
        }
      })
      .catch(() => { if (!cancelled) setIntraday({ status: "unavailable", reason: INTRADAY_UNAVAILABLE_MESSAGE }); });
    return () => { cancelled = true; };
  }, [period]);

  const isIntradayPeriod = period === "1D";
  const usingGenuineIntraday = isIntradayPeriod && intraday.status === "ready";
  const visiblePoints = isIntradayPeriod ? (usingGenuineIntraday ? intraday.points : dailyVisiblePoints) : dailyVisiblePoints;
  const insufficientMessage = isIntradayPeriod
    ? (intraday.status === "unavailable" ? intraday.reason : intraday.status === "loading" ? null : null)
    : dailyInsufficientMessage;
  // When 1D falls back to the daily series (genuine intraday unavailable),
  // its points are date-only — formatAxisDate's "1D" branch expects a full
  // timestamp and would render every one of them as the same midnight-UTC
  // clock time. "1W"'s day+weekday form is the right shape for a couple of
  // daily points regardless of the actual selected period in that case.
  const chartPeriodForFormatting = isIntradayPeriod && !usingGenuineIntraday ? "1W" : period;

  const returnTone = totals.allTimeReturnGbp > 0 ? "positive" : totals.allTimeReturnGbp < 0 ? "negative" : "neutral";
  const marketGrowthTone = totals.marketGrowthGbp > 0 ? "positive" : totals.marketGrowthGbp < 0 ? "negative" : "neutral";
  const currencyEffectTone = totals.currencyEffectGbp > 0 ? "positive" : totals.currencyEffectGbp < 0 ? "negative" : "neutral";
  const todaysChangeTone = totals.todaysChangeGbp > 0 ? "positive" : totals.todaysChangeGbp < 0 ? "negative" : "neutral";

  return <section className="inv-card inv-hero" aria-label="Portfolio value and performance">
    <div className="inv-hero-grid">
      <div className="inv-hero-summary">
        <div className="inv-hero-headline">
          <p className="inv-hero-label">Total portfolio value</p>
          <p className="inv-hero-value">{formatGbp(totals.totalGbpValue)}</p>
          <p className={`inv-hero-delta inv-hero-delta-${returnTone}`}>
            {formatGbp(totals.allTimeReturnGbp, { signed: true })} {totals.allTimeReturnPercent !== null ? formatPercent(totals.allTimeReturnPercent, { signed: true }) : "—"} current holdings return
          </p>
        </div>

        <div className="inv-decomposition">
          <div className="inv-decomp-item">
            <span className="inv-decomp-label">Market growth</span>
            <span className={`inv-decomp-value inv-hero-delta-${marketGrowthTone}`}>{formatGbp(totals.marketGrowthGbp, { signed: true })} {formatPercent(totals.totalInvestedGbp > 0 ? (totals.marketGrowthGbp / totals.totalInvestedGbp) * 100 : 0, { signed: true })}</span>
          </div>
          <div className="inv-decomp-item">
            <span className="inv-decomp-label">Currency effect</span>
            <span className={`inv-decomp-value inv-hero-delta-${currencyEffectTone}`}>{formatGbp(totals.currencyEffectGbp, { signed: true })} {formatPercent(totals.totalInvestedGbp > 0 ? (totals.currencyEffectGbp / totals.totalInvestedGbp) * 100 : 0, { signed: true })}</span>
          </div>
        </div>

        <div className="inv-summary-stack">
          <div className="inv-summary-row">
            <span className="inv-summary-icon inv-summary-icon-green" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 12V6M8 12V3M13 12V8" /></svg></span>
            <span className="inv-summary-label">Total invested</span>
            <span className="inv-summary-value">{formatGbp(totals.totalInvestedGbp)}</span>
          </div>
          <div className="inv-summary-row">
            <span className="inv-summary-icon inv-summary-icon-green" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2 9l3.5-4L9 9l5-6" /></svg></span>
            <span className="inv-summary-label">Today&apos;s change</span>
            <span className={`inv-summary-value inv-hero-delta-${todaysChangeTone}`}>
              {formatGbp(totals.todaysChangeGbp, { signed: true })} {totals.todaysChangePercent !== null ? formatPercent(totals.todaysChangePercent, { signed: true }) : ""}
            </span>
          </div>
          <div className="inv-summary-row">
            <span className="inv-summary-icon inv-summary-icon-purple" aria-hidden="true"><svg viewBox="0 0 16 16"><rect x="2" y="5" width="12" height="8" rx="1.5" /><path d="M2 8h12" /></svg></span>
            <span className="inv-summary-label">Cash</span>
            <span className="inv-summary-value">{formatGbp(totals.cashGbp)}</span>
          </div>
        </div>
      </div>

      <div className="inv-hero-chart-region">
        <div className="inv-chart-toolbar-row">
          <div className="inv-period-tabs" role="tablist" aria-label="Chart period">
            {PERIODS.map(p => <button key={p} type="button" role="tab" aria-selected={period === p} className={`inv-period-tab${period === p ? " inv-period-tab-active" : ""}`} onClick={() => setPeriod(p)}>{p}</button>)}
          </div>
        </div>

        <PortfolioChart points={visiblePoints} period={chartPeriodForFormatting} insufficientMessage={insufficientMessage} cashFlowEvents={isIntradayPeriod ? [] : cashFlowEvents} />

        {fallbackHoldingsCount > 0 && <p className="inv-chart-provenance">
          Includes {fallbackHoldingsCount} holding{fallbackHoldingsCount === 1 ? "" : "s"} using fallback values
        </p>}
      </div>
    </div>
  </section>;
}
