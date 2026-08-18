"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PortfolioHeroCard from "./PortfolioHeroCard";
import AllocationCard from "./AllocationCard";
import PerformanceInsightsCard from "./PerformanceInsightsCard";
import HoldingsTable from "./HoldingsTable";
import CollectionCards from "./CollectionCards";
import AddInvestmentModal, { type AddInvestmentPricingResult } from "./AddInvestmentModal";
import RecordTransactionModal from "./RecordTransactionModal";
import HoldingDetailDrawer from "./HoldingDetailDrawer";
import RefreshDetailsPanel from "./RefreshDetailsPanel";
import TaskToast from "@/components/TaskToast";
import { formatRelativeSync } from "@/lib/investments/format";
import { isGenuineFailure } from "@/lib/investments/refresh-classification";
import { computeSyncStatusFromResults } from "@/lib/investments/sync-status";
import type { RefreshProgress, RefreshResultEntry, RefreshRunResult } from "@/lib/investments/refresh";
import type { PortfolioViewModel } from "@/lib/investments/view-model-types";

// Saved prices older than this are treated as stale enough to trigger an
// automatic background refresh when the page opens — generous enough to
// never refresh on every single navigation within the same session, tight
// enough that the dashboard is never showing genuinely day(s)-old data
// without at least attempting to catch up.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

type RefreshResult = RefreshRunResult | { skipped: string };
type StreamLine = { type: "progress" } & RefreshProgress | { type: "done"; result?: RefreshResult; error?: string };

/**
 * Reads the refresh route's newline-delimited JSON stream, calling
 * `onProgress` as each line arrives and returning the final `done` line's
 * payload. A line can arrive split across chunks or several lines can
 * arrive in one chunk — buffered and split on "\n" rather than assumed to
 * align with chunk boundaries.
 */
async function readRefreshStream(response: Response, onProgress: (p: RefreshProgress) => void): Promise<{ result?: RefreshResult; error?: string }> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body available (older environment) — fall back to a
    // single JSON parse of the whole response, matching this route's
    // pre-streaming shape exactly.
    const result = await response.json().catch(() => undefined) as RefreshResult | undefined;
    return { result };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let final: { result?: RefreshResult; error?: string } = { error: "The refresh did not report a final result." };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as StreamLine;
      if (parsed.type === "progress") onProgress({ completed: parsed.completed, total: parsed.total });
      else final = { result: parsed.result, error: parsed.error };
    }
  }
  return final;
}

export default function InvestmentsWorkspace() {
  const [portfolio, setPortfolio] = useState<PortfolioViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastRefreshResults, setLastRefreshResults] = useState<RefreshResultEntry[] | "network_error" | null>(null);
  const [refreshBanner, setRefreshBanner] = useState<{ tone: "info" | "error"; message: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [transactionModalOpen, setTransactionModalOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const autoRefreshAttempted = useRef(false);

  const loadPortfolio = useCallback(async () => {
    try {
      const response = await fetch("/api/investments/portfolio");
      if (!response.ok) { setLoadError("Could not load your portfolio."); return; }
      const data = await response.json() as PortfolioViewModel;
      setPortfolio(data);
      setLoadError("");
    } catch {
      setLoadError("Could not load your portfolio. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);

  const runRefresh = useCallback(async (auto: boolean) => {
    setRefreshing(true);
    setRefreshProgress(null);
    setRefreshBanner(null);
    try {
      const response = await fetch("/api/investments/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: auto ? "auto_page_open" : "manual" }),
      });
      if (!response.ok) { setLastRefreshResults("network_error"); setRefreshBanner({ tone: "error", message: "Could not refresh prices." }); return; }
      const { result: body, error: streamError } = await readRefreshStream(response, setRefreshProgress);
      if (streamError || !body) { setLastRefreshResults("network_error"); setRefreshBanner({ tone: "error", message: "Could not refresh prices." }); return; }
      if ("skipped" in body) { if (!auto) setRefreshBanner({ tone: "info", message: "A refresh is already in progress." }); return; }
      setLastSyncedAt(new Date().toISOString());
      setLastRefreshResults(body.results);
      const genuineFailures = body.results.filter(r => isGenuineFailure(r.outcome));
      if (genuineFailures.length > 0 && body.results.length > 0) {
        setRefreshBanner({ tone: "error", message: `${genuineFailures.length} of ${body.results.length} price${body.results.length === 1 ? "" : "s"} could not be refreshed — the last known value is still shown.` });
      } else if (!auto) {
        setToast("Prices refreshed");
      }
      await loadPortfolio();
    } catch {
      setLastRefreshResults("network_error");
      if (!auto) setRefreshBanner({ tone: "error", message: "Network error — could not refresh prices." });
    } finally {
      setRefreshing(false);
      setRefreshProgress(null);
    }
  }, [loadPortfolio]);

  // Automatic refresh when the page opens, only if prices look stale — at
  // most once per mount. Only latches once an attempt is actually made:
  // the very first load (before any holding exists) has nothing eligible
  // to refresh, and must not permanently block a refresh attempt for a
  // priceable holding added later in the same session.
  useEffect(() => {
    if (autoRefreshAttempted.current || !portfolio) return;
    const hasRefreshableHolding = portfolio.holdings.some(h => h.pricingProvider === "twelve_data" || h.pricingProvider === "pokepulse" || h.pricingProvider === "eodhd");
    if (!hasRefreshableHolding) return;
    const mostRecentPriceAt = portfolio.holdings.map(h => h.priceAt).filter((v): v is string => Boolean(v)).sort().at(-1);
    const isStale = !mostRecentPriceAt || Date.now() - new Date(mostRecentPriceAt).getTime() > STALE_THRESHOLD_MS;
    if (isStale) {
      autoRefreshAttempted.current = true;
      runRefresh(true);
    }
  }, [portfolio, runRefresh]);

  function handleInvestmentAdded(pricing: AddInvestmentPricingResult) {
    setAddModalOpen(false);
    if (pricing === null) {
      setToast("Investment added");
    } else if (pricing.ok) {
      setToast("Investment added and priced");
    } else {
      // Saved is still a genuine success — never report the whole
      // operation as failed just because the price fetch didn't land.
      setRefreshBanner({ tone: "error", message: `Investment added, but pricing failed: ${pricing.error ?? "unknown error"}. The purchase price is shown until a refresh succeeds.` });
    }
    loadPortfolio();
  }

  function handleTransactionRecorded() {
    setTransactionModalOpen(false);
    setToast("Transaction recorded");
    loadPortfolio();
  }

  // Driven by the last refresh's own typed, per-holding outcomes — never a
  // raw "N unavailable" count derived from accumulated/stale state (the
  // exact confirmed bug this replaced: the header used to show a count
  // that didn't match the actual results of the most recent run at all).
  // See lib/investments/sync-status.ts for the full outcome→label mapping.
  const { syncTone, syncLabel } = (() => {
    if (lastRefreshResults === "network_error") return { syncTone: "error" as const, syncLabel: "Refresh failed" };
    if (lastRefreshResults) {
      const status = computeSyncStatusFromResults(lastRefreshResults);
      return { syncTone: status.tone, syncLabel: status.label };
    }
    const mostRecentPriceAt = portfolio?.holdings.map(h => h.priceAt).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
    if (mostRecentPriceAt) return { syncTone: "ok" as const, syncLabel: `Synced ${formatRelativeSync(mostRecentPriceAt)}` };
    return { syncTone: "muted" as const, syncLabel: "Not yet synced" };
  })();

  const holdingNames = new Map((portfolio?.holdings ?? []).map(h => [h.assetId, h.displayName]));
  const detailsAvailable = Array.isArray(lastRefreshResults) && lastRefreshResults.length > 0;

  return <div className="inv-root">
    <div className="inv-topline">
      <h1 className="inv-title">Investments</h1>
      <div className="inv-actions">
        <button type="button" className="inv-btn" onClick={() => setAddModalOpen(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg> Add investment
        </button>
        <button type="button" className="inv-btn inv-btn-primary" onClick={() => setTransactionModalOpen(true)} disabled={!portfolio || portfolio.holdings.length === 0 && portfolio.accounts.length === 0}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2 6.5h12" /></svg> Record transaction
        </button>
        <button type="button" className={`inv-btn${refreshing ? " inv-btn-refreshing" : ""}`} onClick={() => runRefresh(false)} disabled={refreshing}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3" /></svg>
          {refreshing ? (refreshProgress ? `Refreshing prices · ${refreshProgress.completed} of ${refreshProgress.total}` : "Refreshing…") : "Refresh prices"}
        </button>
        {detailsAvailable
          ? <button type="button" className="inv-sync-status inv-sync-status-button" onClick={() => setDetailsOpen(true)}>
              <i className={`inv-sync-dot${syncTone === "error" ? " inv-sync-dot-error" : syncTone === "stale" ? " inv-sync-dot-stale" : syncTone === "muted" ? " inv-sync-dot-muted" : ""}`} aria-hidden="true" />
              {syncLabel}
            </button>
          : <span className="inv-sync-status" role="status">
              <i className={`inv-sync-dot${syncTone === "error" ? " inv-sync-dot-error" : syncTone === "stale" ? " inv-sync-dot-stale" : syncTone === "muted" ? " inv-sync-dot-muted" : ""}`} aria-hidden="true" />
              {syncLabel}
            </span>}
      </div>
    </div>

    {/* A partial refresh failure is communicated by the amber header status
        (see syncLabel above) plus this transient toast with a Retry action —
        NOT a persistent full-width banner. The header status stays visible
        for as long as the state is genuinely true; the toast is just the
        "something just happened" notification and is fine to auto-dismiss. */}
    {loadError && <div className="inv-banner inv-banner-error" role="alert">{loadError}</div>}

    {loading && !portfolio && <InvestmentsSkeleton />}

    {portfolio && <>
      <div className="inv-grid">
        <div className="inv-main-col">
          <PortfolioHeroCard totals={portfolio.totals} chartSeries={portfolio.chartSeries} cashFlowEvents={portfolio.cashFlowEvents} fallbackHoldingsCount={portfolio.fallbackHoldingsCount} />
          <HoldingsTable holdings={portfolio.holdings} onSelectHolding={setSelectedAssetId} onAddInvestment={() => setAddModalOpen(true)} />
        </div>
        <div className="inv-side-col">
          <AllocationCard allocation={portfolio.allocation} />
          <PerformanceInsightsCard totals={portfolio.totals} bestPerformer={portfolio.bestPerformer} />
        </div>
      </div>
      <CollectionCards accounts={portfolio.accounts} onSelectAccount={() => { /* account-level filtering is a future enhancement — clicking still surfaces the account visually via the holdings table's own category tabs today */ }} />
    </>}

    {addModalOpen && <AddInvestmentModal accounts={portfolio?.accounts ?? []} onClose={() => setAddModalOpen(false)} onAdded={handleInvestmentAdded} />}
    {transactionModalOpen && <RecordTransactionModal accounts={portfolio?.accounts ?? []} holdings={portfolio?.holdings ?? []} onClose={() => setTransactionModalOpen(false)} onRecorded={handleTransactionRecorded} />}
    {selectedAssetId && <HoldingDetailDrawer assetId={selectedAssetId} onClose={() => setSelectedAssetId(null)} onChanged={loadPortfolio} />}
    {detailsOpen && Array.isArray(lastRefreshResults) && <RefreshDetailsPanel results={lastRefreshResults} holdingNames={holdingNames} onClose={() => setDetailsOpen(false)} />}

    {toast && <TaskToast message={toast} onDismiss={() => setToast(null)} position="bottom-right" />}
    {refreshBanner && <TaskToast
      message={refreshBanner.message} onDismiss={() => setRefreshBanner(null)} position="bottom-right"
      duration={refreshBanner.tone === "error" ? 12000 : 5000}
      actionLabel={refreshBanner.tone === "error" ? "Retry" : undefined}
      onAction={refreshBanner.tone === "error" ? () => runRefresh(false) : undefined}
    />}
  </div>;
}

function InvestmentsSkeleton() {
  return <div className="inv-grid">
    <div className="inv-main-col">
      <div className="inv-card inv-skeleton" style={{ height: 280 }} />
      <div className="inv-card inv-skeleton" style={{ height: 380 }} />
    </div>
    <div className="inv-side-col">
      <div className="inv-card inv-skeleton" style={{ height: 260 }} />
      <div className="inv-card inv-skeleton" style={{ height: 260 }} />
    </div>
  </div>;
}
