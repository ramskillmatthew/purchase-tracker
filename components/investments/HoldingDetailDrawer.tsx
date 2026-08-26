"use client";

import { useEffect, useState } from "react";
import { formatGbp, formatPercent, formatQuantityDisplay, formatShortDate, formatUsd } from "@/lib/investments/format";
import { holdingPriceStatusLabel } from "@/lib/investments/holding-status";

type DetailResponse = {
  asset: { id: string; category: string; displayName: string; ticker: string | null; nativeCurrency: string; pricingProvider: string; sourceUrl: string | null; imageUrl: string | null; archivedAt: string | null };
  holding: {
    quantity: string; averageCostGbp: number | null; currentNativePrice: number; currentFxRate: number; currentGbpValue: number;
    costBasisGbp: number; unrealizedGbp: number; unrealizedPercent: number | null; lastPriceAt: string | null; lastProvider: string | null; dataQuality: string | null;
  };
  realizedSales: Array<{ transactionId: string; quantity: string; proceedsGbp: number; costBasisRemoved: number; feesGbp: number; realizedPnlGbp: number }>;
  priceHistory: Array<{ priceAt: string; nativeUnitPrice: number; gbpUnitPrice: number; provider: string; dataQuality: string }>;
  transactions: Array<{ id: string; transactionType: string; tradeAt: string; quantity: string | null; nativeUnitPrice: string | null; gbpTotal: string; gbpFees: string; notes: string | null }>;
};

// Never a truth claim on its own — see HoldingsTable.tsx's identical
// comment: "Live prices" here used to sit directly above/beside "Never
// priced" for a fallback-only stock, a real confirmed contradiction.
const SOURCE_LABELS: Record<string, string> = { twelve_data: "Twelve Data", eodhd: "EODHD", pokepulse: "PokePulse", manual: "Manual", none: "—" };
const CATEGORY_LABELS: Record<string, string> = { stock: "Stock / ETF", pokemon: "Pokémon", lego: "LEGO", cash: "Cash" };

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("");
}

const HISTORY_WIDTH = 460;
const HISTORY_HEIGHT = 72;

function HistorySparkline({ points }: { points: Array<{ priceAt: string; gbpUnitPrice: number }> }) {
  if (points.length < 2) return <p className="inv-detail-history-empty">Not enough price history yet to chart — this appears once a second genuine price snapshot exists.</p>;
  const values = points.map(p => p.gbpUnitPrice);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * HISTORY_WIDTH;
    const y = HISTORY_HEIGHT - ((p.gbpUnitPrice - min) / range) * HISTORY_HEIGHT;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const trendUp = values[values.length - 1] >= values[0];
  return <svg className="inv-detail-history-chart" viewBox={`0 0 ${HISTORY_WIDTH} ${HISTORY_HEIGHT}`} width="100%" height={HISTORY_HEIGHT} role="img" aria-label={`Price history from ${formatShortDate(points[0].priceAt)} to ${formatShortDate(points[points.length - 1].priceAt)}`}>
    <polyline points={coords} fill="none" stroke={trendUp ? "var(--inv-green)" : "var(--inv-red)"} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/**
 * A compact detail drawer (a modal, not a separate route — matches this
 * app's existing dialog conventions and keeps the dashboard's own layout
 * untouched) for one holding: current position, price history, and
 * transaction history, plus an archive action.
 */
export default function HoldingDetailDrawer({ assetId, onClose, onChanged }: { assetId: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState<{ quantity: string } | null>(null);
  const [manualPrice, setManualPrice] = useState("");
  const [savingValuation, setSavingValuation] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/investments/assets/${assetId}`);
        if (!response.ok) { if (!cancelled) setError("Could not load this investment."); return; }
        const body = await response.json() as DetailResponse;
        if (!cancelled) setData(body);
      } catch { if (!cancelled) setError("Network error — could not load this investment."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [assetId]);

  async function handleRetryPrice() {
    setRetrying(true);
    setRetryError("");
    try {
      await fetch("/api/investments/refresh", { method: "POST" });
      const refreshed = await fetch(`/api/investments/assets/${assetId}`);
      if (refreshed.ok) setData(await refreshed.json());
      onChanged();
    } catch {
      setRetryError("Network error — could not refresh this price.");
    } finally {
      setRetrying(false);
    }
  }

  async function handleArchive(confirmNonZero: boolean) {
    setArchiving(true);
    try {
      const response = await fetch(`/api/investments/assets/${assetId}${confirmNonZero ? "?confirmNonZeroHolding=true" : ""}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409 && body.requiresConfirmation) { setArchiveConfirm({ quantity: body.currentQuantity }); setArchiving(false); return; }
      if (!response.ok) { setError(body.error || "Could not archive this investment."); setArchiving(false); return; }
      onChanged(); onClose();
    } catch { setError("Network error — could not archive this investment."); setArchiving(false); }
  }

  async function handleManualValuation() {
    if (!manualPrice) return;
    setSavingValuation(true);
    try {
      const response = await fetch(`/api/investments/assets/${assetId}/valuation`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gbpPrice: Number(manualPrice) }),
      });
      if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error || "Could not save this valuation."); setSavingValuation(false); return; }
      setManualPrice("");
      onChanged();
      const refreshed = await fetch(`/api/investments/assets/${assetId}`);
      if (refreshed.ok) setData(await refreshed.json());
    } catch { setError("Network error — could not save this valuation."); }
    setSavingValuation(false);
  }

  const returnTone = data ? (data.holding.unrealizedGbp > 0 ? "positive" : data.holding.unrealizedGbp < 0 ? "negative" : "neutral") : "neutral";
  const isStaleOrUnpriced = data ? (data.holding.dataQuality !== "market" || !data.holding.lastPriceAt) : false;
  const canRetry = data && (data.asset.pricingProvider === "pokepulse" || data.asset.pricingProvider === "twelve_data" || data.asset.pricingProvider === "eodhd");

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-modal investment-modal" role="dialog" aria-modal="true" aria-labelledby="holding-detail-title">
      <div className="task-modal-heading inv-detail-heading">
        {data && <span className="inv-detail-thumb" aria-hidden="true">
          {data.asset.imageUrl
            // eslint-disable-next-line @next/next/no-img-element -- external PokePulse/LEGO image URL; next/image would require an open-ended remotePatterns allowlist for arbitrary third-party hosts
            ? <img src={data.asset.imageUrl} alt="" loading="lazy" />
            : <span className="inv-detail-thumb-tile">{data.asset.ticker ? data.asset.ticker.slice(0, 4) : initials(data.asset.displayName)}</span>}
        </span>}
        <div className="inv-detail-heading-text">
          <h2 id="holding-detail-title">{data?.asset.displayName ?? "Investment"}</h2>
          {data && <span className="inv-detail-badge">{CATEGORY_LABELS[data.asset.category] ?? data.asset.category} · {SOURCE_LABELS[data.asset.pricingProvider] ?? data.asset.pricingProvider}</span>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body">
        {loading && <p>Loading…</p>}
        {error && <p className="task-modal-error">{error}</p>}
        {data && <>
          <div className="inv-detail-metrics">
            <div className="inv-detail-metric"><span className="inv-detail-metric-label">Quantity</span><span className="inv-detail-metric-value">{formatQuantityDisplay(data.holding.quantity)}</span></div>
            <div className="inv-detail-metric"><span className="inv-detail-metric-label">Average cost</span><span className="inv-detail-metric-value">{data.holding.averageCostGbp !== null ? formatGbp(data.holding.averageCostGbp) : "—"}</span></div>
            <div className="inv-detail-metric"><span className="inv-detail-metric-label">Current price</span><span className="inv-detail-metric-value">{data.asset.nativeCurrency === "USD" ? `${formatUsd(data.holding.currentNativePrice)} (${formatGbp(data.holding.currentNativePrice * data.holding.currentFxRate)})` : formatGbp(data.holding.currentNativePrice)}</span></div>
            <div className="inv-detail-metric"><span className="inv-detail-metric-label">Current value</span><span className="inv-detail-metric-value">{formatGbp(data.holding.currentGbpValue)}</span></div>
            <div className="inv-detail-metric">
              <span className="inv-detail-metric-label">Unrealised return</span>
              <span className={`inv-detail-metric-value inv-hero-delta-${returnTone}`}>{formatGbp(data.holding.unrealizedGbp, { signed: true })} {data.holding.unrealizedPercent !== null ? formatPercent(data.holding.unrealizedPercent, { signed: true }) : ""}</span>
            </div>
            <div className="inv-detail-metric"><span className="inv-detail-metric-label">Last updated</span><span className="inv-detail-metric-value">{holdingPriceStatusLabel({ pricingProvider: data.holding.lastProvider ?? data.asset.pricingProvider, dataQuality: data.holding.dataQuality, priceAt: data.holding.lastPriceAt })}</span></div>
          </div>

          <div className="inv-detail-source">
            <div className="inv-detail-source-row">
              <span>
                Source: <strong>{data.holding.lastProvider ? (SOURCE_LABELS[data.holding.lastProvider] ?? data.holding.lastProvider) : (SOURCE_LABELS[data.asset.pricingProvider] ?? data.asset.pricingProvider)}</strong>
                {data.holding.dataQuality === "purchase_price_fallback" && <span className="inv-detail-fallback-note"> · showing purchase price (fallback)</span>}
                {data.asset.sourceUrl && <> · <a href={data.asset.sourceUrl} target="_blank" rel="noopener noreferrer">View on PokePulse</a></>}
              </span>
              {canRetry && <button type="button" className="button-secondary" disabled={retrying} onClick={handleRetryPrice}>{retrying ? "Refreshing…" : isStaleOrUnpriced ? "Retry price" : "Refresh price"}</button>}
            </div>
            {retryError && <p className="task-modal-error">{retryError}</p>}
          </div>

          {data.priceHistory.length > 0 && <div className="field">
            <span className="label">Price history</span>
            <HistorySparkline points={data.priceHistory} />
          </div>}

          {data.realizedSales.length > 0 && <div className="field">
            <span className="label">Realised sales</span>
            <ul className="inv-detail-list">
              {data.realizedSales.map(sale => <li key={sale.transactionId}>
                {formatQuantityDisplay(sale.quantity)} sold for {formatGbp(sale.proceedsGbp)} — realised {formatGbp(sale.realizedPnlGbp, { signed: true })}
              </li>)}
            </ul>
          </div>}

          {data.asset.pricingProvider === "manual" && <div className="field">
            <span className="label">Record a manual valuation</span>
            <div className="task-modal-grid">
              <input className="input" type="number" min="0" step="0.01" value={manualPrice} onChange={e => setManualPrice(e.target.value)} placeholder="Current GBP price" />
              <button type="button" className="button-secondary" disabled={savingValuation || !manualPrice} onClick={handleManualValuation}>{savingValuation ? "Saving…" : "Save valuation"}</button>
            </div>
          </div>}

          <div className="field">
            <span className="label">Recent transactions</span>
            <div className="inv-detail-tx-table">
              <div className="inv-detail-tx-head">
                <span>Date</span><span>Type</span><span>Quantity</span><span>Unit price</span><span>Total</span><span>Fees</span>
              </div>
              {data.transactions.slice(0, 8).map(t => <div className="inv-detail-tx-row" key={t.id}>
                <span>{formatShortDate(t.tradeAt)}</span>
                <span className="inv-detail-tx-type">{t.transactionType}</span>
                <span>{t.quantity ? formatQuantityDisplay(t.quantity) : "—"}</span>
                <span>{t.nativeUnitPrice ? formatGbp(Number(t.nativeUnitPrice)) : "—"}</span>
                <span>{formatGbp(Number(t.gbpTotal))}</span>
                <span>{Number(t.gbpFees) > 0 ? formatGbp(Number(t.gbpFees)) : "—"}</span>
              </div>)}
            </div>
          </div>

          {archiveConfirm && <p className="task-modal-error">This investment still holds {archiveConfirm.quantity} units — archiving hides it from active totals but keeps all history. <button type="button" className="button-secondary" onClick={() => handleArchive(true)}>Archive anyway</button></p>}
        </>}
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-danger" disabled={archiving || !data || Boolean(data.asset.archivedAt)} onClick={() => handleArchive(false)}>{data?.asset.archivedAt ? "Archived" : archiving ? "Archiving…" : "Archive"}</button>
        <button type="button" className="button-secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}
