import "server-only";
import type { HistoricalPricePoint, IntradayPricePoint, PriceQuote, ProviderResult, StockPriceProvider } from "./types";

/**
 * Stock/ETF price provider — Twelve Data (https://twelvedata.com).
 *
 * SELECTED PROVIDER RATIONALE (documented per this feature's own
 * requirement): every genuinely free, no-signup stock-data source was
 * checked live before choosing this. Yahoo/Google-style unofficial
 * scraping endpoints and Stooq's CSV endpoints are both explicitly out —
 * this feature must never scrape a search engine or an endpoint that
 * doesn't permit the intended use, and Stooq's own CSV endpoint now sits
 * behind a JS proof-of-work bot challenge that cannot be solved server-
 * side without impersonating a browser, which this app will not do.
 * Twelve Data has a real, documented REST API, a genuine free ("Basic")
 * tier (800 requests/day, real-time US equities & ETFs — comfortably
 * enough for a personal portfolio refreshed a few times a day), and
 * historical daily time series. It DOES require a free API key, which
 * only the account owner can create — see this module's own
 * isConfigured() and the feature's completion report for the exact
 * blocker this represents until TWELVE_DATA_API_KEY is set.
 *
 * Response shapes below were confirmed against Twelve Data's own public
 * documentation (https://twelvedata.com/docs) before writing this adapter
 * — not guessed.
 */

const BASE_URL = "https://api.twelvedata.com";
const REQUEST_TIMEOUT_MS = 10000;

type QuoteResponse = { symbol: string; currency: string; datetime: string; close: string } | { code: number; message: string; status: "error" };
type TimeSeriesResponse =
  | { meta: { symbol: string; currency: string }; values: Array<{ datetime: string; close: string }>; status: "ok" }
  | { code: number; message: string; status: "error" };

function isErrorResponse(body: unknown): body is { code: number; message: string; status: "error" } {
  return typeof body === "object" && body !== null && (body as { status?: string }).status === "error";
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function apiKey(): string | null {
  const key = process.env.TWELVE_DATA_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function symbolParam(ticker: string, exchange?: string | null): string {
  return exchange ? `${ticker}&exchange=${encodeURIComponent(exchange)}` : ticker;
}

export const twelveDataProvider: StockPriceProvider & {
  getIntradaySeries(ticker: string, exchange: string | null, barsRequested?: number): Promise<ProviderResult<IntradayPricePoint[]>>;
} = {
  name: "twelve_data",

  isConfigured(): boolean {
    return apiKey() !== null;
  },

  async getQuote(ticker: string, exchange?: string | null): Promise<ProviderResult<PriceQuote>> {
    const key = apiKey();
    if (!key) return { ok: false, error: "Stock pricing is not configured — set TWELVE_DATA_API_KEY.", retryable: false };

    const url = `${BASE_URL}/quote?symbol=${symbolParam(ticker, exchange)}&apikey=${key}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url);
    } catch (error) {
      return { ok: false, error: `Network error reaching Twelve Data: ${error instanceof Error ? error.message : "unknown"}`, retryable: true };
    }

    const body = await response.json().catch(() => null) as QuoteResponse | null;
    // Twelve Data returns a genuine, truthful JSON error body — including
    // "this symbol needs a paid plan" — even on a non-2xx HTTP status.
    // Checking !response.ok first (as this used to) discards that real
    // message in favour of a generic "returned 404", which is exactly the
    // confirmed bug behind VUAG showing an unhelpful, non-actionable error
    // instead of the true "free plan doesn't cover this instrument" reason.
    if (body && isErrorResponse(body)) return { ok: false, error: body.message, retryable: body.code === 429 };
    if (!response.ok || !body) return { ok: false, error: `Twelve Data returned ${response.status} for ${ticker}.`, retryable: response.status >= 500 || response.status === 429 };

    const price = Number(body.close);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, error: `Twelve Data returned no usable price for ${ticker}.`, retryable: true };

    return {
      ok: true,
      data: { nativeUnitPrice: price, nativeCurrency: body.currency, priceAt: new Date(body.datetime).toISOString(), provider: "twelve_data" },
    };
  },

  async getHistory(ticker: string, exchange: string | null, startDate: string, endDate: string): Promise<ProviderResult<HistoricalPricePoint[]>> {
    const key = apiKey();
    if (!key) return { ok: false, error: "Stock pricing is not configured — set TWELVE_DATA_API_KEY.", retryable: false };

    const url = `${BASE_URL}/time_series?symbol=${symbolParam(ticker, exchange)}&interval=1day&start_date=${startDate}&end_date=${endDate}&outputsize=5000&apikey=${key}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url);
    } catch (error) {
      return { ok: false, error: `Network error reaching Twelve Data: ${error instanceof Error ? error.message : "unknown"}`, retryable: true };
    }

    const body = await response.json().catch(() => null) as TimeSeriesResponse | null;
    if (body && isErrorResponse(body)) return { ok: false, error: body.message, retryable: body.code === 429 };
    if (!response.ok || !body) return { ok: false, error: `Twelve Data returned ${response.status} for ${ticker} history.`, retryable: response.status >= 500 || response.status === 429 };

    const points: HistoricalPricePoint[] = body.values
      .map(v => ({ date: v.datetime.slice(0, 10), nativeUnitPrice: Number(v.close) }))
      .filter(p => Number.isFinite(p.nativeUnitPrice) && p.nativeUnitPrice > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    return { ok: true, data: points };
  },

  /**
   * Genuine intraday bars for the current/most recent trading session —
   * confirmed live against this account's real API key before this was
   * written (`interval=15min` returns real, distinct OHLC bars, not a
   * daily close repeated). Not part of the shared StockPriceProvider
   * interface (PokePulse/manual assets have no intraday concept at all —
   * see lib/investments/intraday.ts for how those are held constant
   * instead), so this is a Twelve-Data-specific extra, called directly
   * only from the intraday reconstruction path.
   */
  async getIntradaySeries(ticker: string, exchange: string | null, barsRequested = 32): Promise<ProviderResult<IntradayPricePoint[]>> {
    const key = apiKey();
    if (!key) return { ok: false, error: "Stock pricing is not configured — set TWELVE_DATA_API_KEY.", retryable: false };

    const url = `${BASE_URL}/time_series?symbol=${symbolParam(ticker, exchange)}&interval=15min&outputsize=${barsRequested}&apikey=${key}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url);
    } catch (error) {
      return { ok: false, error: `Network error reaching Twelve Data: ${error instanceof Error ? error.message : "unknown"}`, retryable: true };
    }

    const body = await response.json().catch(() => null) as TimeSeriesResponse | null;
    if (body && isErrorResponse(body)) return { ok: false, error: body.message, retryable: body.code === 429 };
    if (!response.ok || !body) return { ok: false, error: `Twelve Data returned ${response.status} for ${ticker} intraday.`, retryable: response.status >= 500 || response.status === 429 };

    // Twelve Data's intraday datetime is "YYYY-MM-DD HH:mm:ss" in the
    // EXCHANGE's own local timezone (confirmed live — meta.exchange_timezone
    // reports it), not UTC and not Europe/London. Parsed as a literal wall-
    // clock instant here (no timezone conversion attempted) — this feature
    // only needs correct RELATIVE ordering within one session for the 1D
    // chart, never a cross-timezone absolute comparison, so mislabelling it
    // as UTC would be worse than leaving it exchange-local and undecorated.
    const points: IntradayPricePoint[] = body.values
      .map(v => ({ timestamp: v.datetime.replace(" ", "T"), nativeUnitPrice: Number(v.close) }))
      .filter(p => Number.isFinite(p.nativeUnitPrice) && p.nativeUnitPrice > 0)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return { ok: true, data: points };
  },
};
