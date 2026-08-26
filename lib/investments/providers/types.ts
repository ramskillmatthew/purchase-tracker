/**
 * Shared, pure types every asset-pricing provider (stock, PokePulse,
 * manual/LEGO) returns — the ONE shape the refresh orchestration and the
 * price-snapshot writer both consume, so a caller never needs to know
 * which concrete provider produced a quote to persist it. Provider
 * implementations live behind these interfaces (lib/investments/providers/*)
 * — nothing outside this directory ever talks to Twelve Data, PokePulse,
 * or Frankfurter directly.
 */

export type PriceQuote = {
  nativeUnitPrice: number;
  nativeCurrency: string;
  /** When this price is FOR (the market's own timestamp/date), not when it was fetched. */
  priceAt: string;
  provider: string;
  sourceUrl?: string | null;
};

export type HistoricalPricePoint = { date: string; nativeUnitPrice: number };

/** `timestamp` is a full ISO instant (not a date-only string) — this is genuinely intraday, never a daily close relabelled. */
export type IntradayPricePoint = { timestamp: string; nativeUnitPrice: number };

/**
 * Fine-grained, machine-readable failure reasons a provider adapter can
 * report directly — set by the adapter itself, from what it actually
 * observed (an explicit status code, an unrecognised field, a genuinely
 * absent price), never guessed from another provider's error text.
 * `classifyProviderError()` (lib/investments/refresh-classification.ts)
 * maps this straight into the app-wide RefreshOutcome when present,
 * skipping its string-matching fallback entirely — string-matching stays
 * the fallback for providers that don't yet populate `code` (Twelve Data,
 * EODHD), so their existing, already-tested classification is untouched.
 */
export type ProviderErrorCode =
  | "product_not_found" | "variant_not_found" | "price_field_missing" | "response_schema_unrecognised"
  | "invalid_price" | "empty_response" | "rate_limited" | "provider_unavailable"
  | "authentication_failed" | "timeout" | "malformed_response";

/**
 * Every provider call returns this instead of throwing for an ordinary
 * "this one asset failed" case — refresh orchestration needs to keep going
 * for every OTHER asset regardless (see the explicit partial-success
 * requirement). A provider function only throws for a genuine programming
 * error (bad input shape), never for "the network was down" or "the
 * ticker doesn't exist".
 */
export type ProviderResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; retryable: boolean; code?: ProviderErrorCode };

export interface StockPriceProvider {
  readonly name: string;
  isConfigured(): boolean;
  getQuote(ticker: string, exchange?: string | null): Promise<ProviderResult<PriceQuote>>;
  getHistory(ticker: string, exchange: string | null, startDate: string, endDate: string): Promise<ProviderResult<HistoricalPricePoint[]>>;
}
