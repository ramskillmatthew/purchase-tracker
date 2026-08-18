import { formatShortMarketDate } from "./format";
import { isGenuineFailure, REFRESH_OUTCOME_LABELS, willRetryAutomatically, type RefreshOutcome } from "./refresh-classification";
import type { RefreshResultEntry } from "./refresh";

/**
 * Turns a completed refresh's typed results into the header's status line —
 * the direct fix for this feature's own two triggering complaints: a
 * genuine Friday close viewed on Sunday must read as current ("latest
 * market close Fri 14 Aug"), and only a REAL attempted-and-failed price
 * ever counts toward "N need attention" (never a manual holding, a
 * purchase-price fallback, or an unchanged/market-closed quote).
 */

export type SyncStatus = { tone: "ok" | "stale" | "error" | "muted"; label: string };

export function computeSyncStatusFromResults(results: RefreshResultEntry[]): SyncStatus {
  if (results.length === 0) return { tone: "muted", label: "Nothing to sync yet" };

  const genuineFailures = results.filter(r => isGenuineFailure(r.outcome));
  const manual = results.filter(r => r.outcome === "manual");
  const fallback = results.filter(r => r.outcome === "fallback_purchase_price");
  const automatic = results.filter(r => r.outcome === "updated" || r.outcome === "unchanged_current" || r.outcome === "market_closed_current");

  if (genuineFailures.length === results.length) return { tone: "error", label: "Refresh failed" };

  if (genuineFailures.length > 0) {
    return { tone: "stale", label: `Prices checked just now · ${genuineFailures.length} need${genuineFailures.length === 1 ? "s" : ""} attention` };
  }

  // No genuine failures. When every automatically-priced holding's latest
  // observation is simply the same closed-market carryover (the exact
  // "Friday's close, viewed Sunday" case), lead with that market date —
  // it's the single most informative, least-alarming fact available.
  if (automatic.length > 0 && automatic.every(r => r.outcome === "market_closed_current")) {
    const dates = new Set(automatic.filter(r => r.priceAt).map(r => formatShortMarketDate(r.priceAt!)));
    if (dates.size === 1) return { tone: "ok", label: `Prices checked just now · latest market close ${[...dates][0]}` };
  }

  const parts: string[] = [];
  if (automatic.length > 0) parts.push(`${automatic.length} automatic`);
  if (manual.length > 0) parts.push(`${manual.length} manual`);
  if (fallback.length > 0) parts.push(`${fallback.length} using purchase price`);
  return { tone: "ok", label: `Prices checked just now${parts.length > 0 ? " · " + parts.join(" · ") : ""}` };
}

export type OutcomeGroup = { outcome: RefreshOutcome; label: string; willRetry: boolean; entries: RefreshResultEntry[] };

/** For the refresh-details panel — one group per non-"updated" outcome actually present this run, most-actionable first. */
export function groupResultsByOutcome(results: RefreshResultEntry[]): OutcomeGroup[] {
  const priority: RefreshOutcome[] = [
    "unsupported_by_plan", "symbol_not_found", "provider_mapping_missing", "rate_limited", "provider_unavailable", "invalid_response", "no_data",
    "fallback_purchase_price", "market_closed_current", "manual", "unchanged_current", "skipped_inactive",
  ];
  const groups: OutcomeGroup[] = [];
  for (const outcome of priority) {
    const entries = results.filter(r => r.outcome === outcome);
    if (entries.length > 0) groups.push({ outcome, label: REFRESH_OUTCOME_LABELS[outcome], willRetry: willRetryAutomatically(outcome), entries });
  }
  return groups;
}
