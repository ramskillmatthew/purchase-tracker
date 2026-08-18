"use client";

import { formatGbp, formatPercent } from "@/lib/investments/format";
import type { BestPerformerResponse, PortfolioTotalsResponse } from "@/lib/investments/view-model-types";

/**
 * Exactly three rows — best performer, current holdings return, today's
 * change — per this feature's own explicit requirement. "Current holdings
 * return" (not "Total"/"Lifetime"/"All-time") because it only covers
 * positions still open right now (currentGbpValue − costBasisGbp, summed
 * over open holdings) — it doesn't yet include realised P/L from a fully
 * sold position, which needs a genuine multi-lot ledger, a separate future
 * task. Deliberately no projected value and no dividend figure anywhere in
 * this component. A metric with no real data shows "—" and an explanatory
 * tooltip, never a fabricated number.
 */
export default function PerformanceInsightsCard({ totals, bestPerformer }: { totals: PortfolioTotalsResponse; bestPerformer: BestPerformerResponse }) {
  const totalReturnTone = totals.allTimeReturnGbp > 0 ? "positive" : totals.allTimeReturnGbp < 0 ? "negative" : "neutral";
  const bestPerformerTone = bestPerformer ? (bestPerformer.percent > 0 ? "positive" : bestPerformer.percent < 0 ? "negative" : "neutral") : "neutral";

  return <section className="inv-card inv-insights" aria-label="Performance insights">
    <div className="inv-card-header"><h2 className="inv-card-title">Performance insights</h2></div>

    <div className="inv-insight-row">
      <span className="inv-insight-icon inv-insight-icon-amber" aria-hidden="true"><svg viewBox="0 0 17 17"><path d="M8.5 2l1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6L8.5 2Z" /></svg></span>
      <div className="inv-insight-body">
        <p className="inv-insight-label">Best performer</p>
        {bestPerformer
          ? <p className="inv-insight-name" title={bestPerformer.displayName}>{bestPerformer.displayName}{bestPerformer.ticker ? ` (${bestPerformer.ticker})` : ""}</p>
          : <p className="inv-insight-empty" title="Shown once you have at least one open holding with a return.">—</p>}
      </div>
      {bestPerformer && <div className="inv-insight-values"><span className={`inv-insight-percent inv-hero-delta-${bestPerformerTone}`}>{formatPercent(bestPerformer.percent, { signed: true })}</span></div>}
    </div>

    <div className="inv-insight-row">
      <span className="inv-insight-icon inv-insight-icon-purple" aria-hidden="true"><svg viewBox="0 0 17 17"><path d="M2 9l3.5-4L9 9l5-6" /><path d="M11 3h3v3" /></svg></span>
      <div className="inv-insight-body"><p className="inv-insight-label">Current holdings return</p></div>
      <div className="inv-insight-values">
        <div className={`inv-insight-gbp inv-hero-delta-${totalReturnTone}`}>{formatGbp(totals.allTimeReturnGbp, { signed: true })}</div>
        <div className={`inv-insight-percent inv-hero-delta-${totalReturnTone}`}>{totals.allTimeReturnPercent !== null ? formatPercent(totals.allTimeReturnPercent, { signed: true }) : "—"}</div>
      </div>
    </div>

    <div className="inv-insight-row">
      <span className="inv-insight-icon inv-insight-icon-blue" aria-hidden="true"><svg viewBox="0 0 17 17"><circle cx="8.5" cy="8.5" r="6.5" /><path d="M8.5 5v3.5l2.5 1.5" /></svg></span>
      <div className="inv-insight-body"><p className="inv-insight-label">Today&apos;s change</p></div>
      <div className="inv-insight-values">
        <div className={`inv-insight-gbp inv-hero-delta-${totals.todaysChangeGbp > 0 ? "positive" : totals.todaysChangeGbp < 0 ? "negative" : "neutral"}`}>{formatGbp(totals.todaysChangeGbp, { signed: true })}</div>
        <div className={`inv-insight-percent inv-hero-delta-${totals.todaysChangeGbp > 0 ? "positive" : totals.todaysChangeGbp < 0 ? "negative" : "neutral"}`}>{totals.todaysChangePercent !== null ? formatPercent(totals.todaysChangePercent, { signed: true }) : "—"}</div>
      </div>
    </div>
  </section>;
}
