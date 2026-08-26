"use client";

import { useMemo, useState } from "react";
import Sparkline from "./Sparkline";
import { formatGbp, formatPercent, formatQuantityDisplay, formatUsd } from "@/lib/investments/format";
import { holdingPriceStatusLabel, isHoldingPriceCurrent } from "@/lib/investments/holding-status";
import { sortHoldings, type SortKey } from "@/lib/investments/holdings-table-sort";
import type { HoldingResponse } from "@/lib/investments/view-model-types";

const TABS = [
  { value: "all", label: "All" }, { value: "stock", label: "Stocks" }, { value: "pokemon", label: "Pokémon" }, { value: "lego", label: "LEGO" },
] as const;
type TabValue = typeof TABS[number]["value"];

// Never a truth claim on its own — "twelve_data" used to be labelled "Live
// prices" here, which then sat directly above a "Purchase price" status
// for any stock still on fallback, an exact confirmed contradiction. The
// provider name is neutral; the dot + status text below it is the ONLY
// place that says whether it's actually live right now.
const SOURCE_LABELS: Record<string, string> = { twelve_data: "Twelve Data", eodhd: "EODHD", pokepulse: "PokePulse", manual: "Manual", none: "—" };

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("");
}

export default function HoldingsTable({ holdings, onSelectHolding, onAddInvestment }: {
  holdings: HoldingResponse[];
  onSelectHolding: (assetId: string) => void;
  onAddInvestment: () => void;
}) {
  const [tab, setTab] = useState<TabValue>("all");
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDesc, setSortDesc] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => holdings.filter(h => tab === "all" || h.category === tab), [holdings, tab]);
  const sorted = useMemo(() => sortHoldings(filtered, sortKey, sortDesc), [filtered, sortKey, sortDesc]);
  const DEFAULT_ROW_COUNT = 5;
  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_ROW_COUNT);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDesc(current => !current); else { setSortKey(key); setSortDesc(true); }
  }

  return <section className="inv-card inv-holdings" aria-label="Holdings">
    <div className="inv-holdings-header">
      <h2 className="inv-card-title">Holdings</h2>
      <div className="inv-tabs" role="tablist" aria-label="Filter holdings by category">
        {TABS.map(t => <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={`inv-tab${tab === t.value ? " inv-tab-active" : ""}`} onClick={() => setTab(t.value)}>{t.label}</button>)}
      </div>
    </div>

    {holdings.length === 0
      ? <div className="inv-table-empty">
          <strong>No investments yet</strong>
          <p>Add your first stock, Pokémon card, sealed product, or LEGO set to start tracking your portfolio.</p>
          <div className="inv-table-empty-actions">
            <button type="button" className="inv-btn inv-btn-primary" onClick={onAddInvestment}>Add investment</button>
          </div>
        </div>
      : <>
        <div className="inv-table-scroll">
          <table className="inv-table">
            <colgroup>
              <col style={{ width: "26%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "28px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Native price</th>
                <th><button type="button" onClick={() => toggleSort("value")}>GBP value {sortKey === "value" ? (sortDesc ? "↓" : "↑") : ""}</button></th>
                <th><button type="button" onClick={() => toggleSort("return")}>Return {sortKey === "return" ? (sortDesc ? "↓" : "↑") : ""}</button></th>
                <th><button type="button" onClick={() => toggleSort("allocation")}>Allocation {sortKey === "allocation" ? (sortDesc ? "↓" : "↑") : ""}</button></th>
                <th>Source</th>
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {visible.map(h => {
                const returnTone = h.unrealizedGbp > 0 ? "positive" : h.unrealizedGbp < 0 ? "negative" : "neutral";
                const isUsd = h.nativeCurrency === "USD";
                return <tr key={h.assetId} tabIndex={0} role="button" aria-label={`View ${h.displayName}`} onClick={() => onSelectHolding(h.assetId)} onKeyDown={e => { if (e.key === "Enter") onSelectHolding(h.assetId); }}>
                  <td>
                    <div className="inv-asset-cell">
                      {h.imageUrl
                        // eslint-disable-next-line @next/next/no-img-element -- external PokePulse/LEGO image URL; next/image would require an open-ended remotePatterns allowlist for arbitrary third-party hosts
                        ? <img className="inv-asset-image" src={h.imageUrl} alt="" loading="lazy" />
                        : <span className="inv-asset-tile" aria-hidden="true">{h.ticker ? h.ticker.slice(0, 4) : initials(h.displayName)}</span>}
                      <div>
                        <div className="inv-asset-name" title={h.displayName}>{h.displayName}</div>
                        <div className="inv-asset-sub">{h.ticker ?? formatQuantityDisplay(h.quantity) + (h.category === "cash" ? "" : " held")}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {h.currentNativePrice !== null
                      ? <div className="inv-price-native-cell">
                        <div>
                          <span className="inv-price-native">{isUsd ? formatUsd(h.currentNativePrice) : formatGbp(h.currentNativePrice)}</span>
                          {/* currentGbpValue / quantity, NOT currentNativePrice — the native price is
                              in USD; formatGbp on the raw USD number would just relabel dollars as
                              pounds at a 1:1 "rate". currentGbpValue is already the real FX-converted
                              total, so dividing by quantity gives the true converted per-share price
                              without needing a separate FX-rate field on the API. */}
                          {isUsd && Number(h.quantity) > 0 && <span className="inv-price-gbp">{formatGbp(h.currentGbpValue / Number(h.quantity))} per share</span>}
                        </div>
                        <Sparkline values={h.sparkline} />
                      </div>
                      : <span className="inv-price-native">—</span>}
                  </td>
                  <td>
                    {formatGbp(h.currentGbpValue)}
                  </td>
                  <td>
                    <span className={`inv-return-${returnTone}`}>{formatGbp(h.unrealizedGbp, { signed: true })}</span>
                    {h.unrealizedPercent !== null && <span className={`inv-return-percent inv-return-${returnTone}`}>{formatPercent(h.unrealizedPercent, { signed: true })}</span>}
                  </td>
                  <td className="inv-allocation-cell">
                    {h.allocationPercent.toFixed(1)}%
                    <div className="inv-allocation-track"><div className="inv-allocation-fill" style={{ width: `${Math.min(100, h.allocationPercent)}%` }} /></div>
                  </td>
                  <td className="inv-source-cell">
                    {SOURCE_LABELS[h.pricingProvider] ?? h.pricingProvider}
                    <div className="inv-source-status">
                      <i className={isHoldingPriceCurrent(h) ? "inv-live-dot" : "inv-stale-dot"} aria-hidden="true" />
                      {holdingPriceStatusLabel(h)}
                    </div>
                  </td>
                  <td className="inv-row-chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 11 8l-5 4.5" /></svg></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        {sorted.length > DEFAULT_ROW_COUNT && <button type="button" className="inv-view-all" onClick={() => setShowAll(current => !current)}>{showAll ? "Show fewer holdings" : `View all ${sorted.length} holdings`}</button>}
      </>}
  </section>;
}
