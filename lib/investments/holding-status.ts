import { formatRelativeSync, formatShortMarketDate } from "./format";
import { isPriceCurrentForLatestSession, type ExchangeCode } from "./refresh-classification";

/**
 * The one place a holding row's price-status TEXT is decided — used by
 * HoldingsTable and HoldingDetailDrawer alike, so the two never drift.
 * Exchange-close data (twelve_data/eodhd) is described by its MARKET DATE
 * once it's genuinely current for the latest completed session — never by
 * naive relative time, which is exactly what made a real Friday close look
 * stale ("2d ago") when viewed on a weekend. Pure — no network/DB access,
 * safe to import from a client component (mirrors refresh-classification.ts's
 * own no-"server-only" convention).
 */

export type HoldingStatusInput = {
  pricingProvider: string; dataQuality: string | null; priceAt: string | null;
  /**
   * When set, this row's `priceAt` is an FX-only revision — the GBP
   * valuation instant, NOT when the exchange itself last priced the asset
   * (see refresh.ts's maybeWriteFxOnlyRevision and supabase-investments.sql's
   * native_price_observed_at migration). `nativePriceObservedAt` is when the
   * underlying exchange price was genuinely last observed; this is what
   * "Latest close" must describe — never `priceAt` alone once this is
   * populated, or a Monday FX revaluation of an unchanged Friday close
   * would misreport itself as "Latest close · Monday". Optional/undefined
   * for every ordinary snapshot (no FX-only revision involved), where
   * `priceAt` already correctly describes both concepts at once.
   */
  nativePriceObservedAt?: string | null;
};

function exchangeFor(pricingProvider: string): ExchangeCode {
  return pricingProvider === "eodhd" ? "LSE" : "US";
}

/** The date that genuinely describes "when did the market last price this" — see HoldingStatusInput's own comment on why this is never just `priceAt`. */
function marketObservationDate(h: HoldingStatusInput): string | null {
  return h.nativePriceObservedAt ?? h.priceAt;
}

/** Drives the row's live/stale status dot — "current" here means genuinely up to date for what this provider even can be, not merely "market_closed_current" being confused with a real gap. */
export function isHoldingPriceCurrent(h: HoldingStatusInput, now: Date = new Date()): boolean {
  if (h.dataQuality === "purchase_price_fallback") return false;
  if (h.pricingProvider === "manual") return h.priceAt !== null;
  const observedAt = marketObservationDate(h);
  if (!observedAt) return false;
  if (h.pricingProvider === "twelve_data" || h.pricingProvider === "eodhd") return isPriceCurrentForLatestSession(observedAt, exchangeFor(h.pricingProvider), now);
  return true;
}

export function holdingPriceStatusLabel(h: HoldingStatusInput, now: Date = new Date()): string {
  if (h.dataQuality === "purchase_price_fallback") return "Purchase-price fallback";
  if (h.pricingProvider === "manual") return h.priceAt ? `Manual valuation · ${formatShortMarketDate(h.priceAt)}` : "Manual valuation";
  if (!h.priceAt) return "Not yet priced";
  const observedAt = marketObservationDate(h) ?? h.priceAt;

  if (h.pricingProvider === "twelve_data" || h.pricingProvider === "eodhd") {
    const exchange = exchangeFor(h.pricingProvider);
    if (isPriceCurrentForLatestSession(observedAt, exchange, now)) return `Latest close · ${formatShortMarketDate(observedAt)}`;
    // A genuine gap (older than the latest completed session) — this is
    // the only case where relative time is still the honest description,
    // since it means a refresh really hasn't caught up yet. Uses the real
    // GBP-valuation instant (priceAt, not observedAt) here — an FX-only
    // revision genuinely IS a fresher sync than the stale native price, so
    // "how long ago was this synced" should reflect that, not understate it.
    return `${formatRelativeSync(h.priceAt)} · refresh to update`;
  }

  // PokePulse has no exchange-session concept — a continuously-updated
  // secondary-market valuation, so relative time IS the honest status.
  return `Updated ${formatRelativeSync(h.priceAt)}`;
}
