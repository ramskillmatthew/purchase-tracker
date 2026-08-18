import "server-only";
import type { HistoricalPricePoint, PriceQuote, ProviderResult } from "./types";

/**
 * Secondary stock/ETF provider — EOD Historical Data (https://eodhd.com) —
 * added specifically because Twelve Data's configured plan does not cover
 * ordinary LSE instruments (confirmed live: VWRP/V3AB/VUAG all return
 * "This symbol is available starting with the Grow or Venture plan").
 *
 * UNIT SAFETY (rewritten after a real, confirmed-dangerous design flaw was
 * caught before activation — see this feature's own completion report): a
 * prior version of this adapter guessed GBX-vs-GBP from the raw value's
 * MAGNITUDE ("divide by 100 if >= 1000, else assume already GBP"). That is
 * unsafe in general: had any of these funds' raw provider value genuinely
 * been in GBX pence in the few-hundred range (V3AB's real GBP price is
 * ~£5.88 — a genuine GBX reading for it, ~588, sits comfortably below the
 * 1000 threshold), the heuristic would have treated it as already-GBP and
 * stored a ~100x-inflated price, with no way to distinguish that from a
 * genuine ~£588 holding. This adapter now takes an EXPLICIT, asset-level
 * `quoteUnit` on every call — never infers a unit from a number.
 *
 * CONFIRMED LIVE (2026-08-17, via this feature's own read-only dry-run
 * tool, scripts/eodhd-dry-run.mjs, against real EODHD responses): for
 * VWRP/V3AB/VUAG specifically, EODHD's `/api/eod` endpoint returns these
 * three funds' prices already in WHOLE GBP POUNDS, not GBX pence — the
 * initial working hypothesis (GBX, based on standard LSE market
 * convention) was wrong for this provider and was caught by the sanity
 * guard before anything was written, then corrected to GBP after the raw
 * values matched independent references (hl.co.uk, stockanalysis.com)
 * within 0.3%. See investment_assets.provider_quote_unit
 * (supabase-investments.sql) for where the verified unit is stored per
 * asset — always confirmed against a real response, never assumed from
 * market convention alone.
 *
 * Uses ONLY the `/api/eod/{ticker}` end-of-day endpoint, and ONE combined
 * ranged request serves BOTH "current price" (its last row) and "trailing
 * history" (every row in the range) — see getEodRange()'s own comment for
 * why this matters given EODHD's free tier's low daily call ceiling.
 */

export type QuoteUnit = "GBP" | "GBX" | "USD" | "EUR";
export const QUOTE_UNITS: readonly QuoteUnit[] = ["GBP", "GBX", "USD", "EUR"];

const BASE_URL = "https://eodhd.com/api";
const REQUEST_TIMEOUT_MS = 10000;

// Only GBX needs sub-unit scaling (pence -> pounds). USD/EUR are already
// whole-currency-unit values on every real EOD feed observed — their
// cross-currency conversion to GBP is NOT this function's job; it happens
// downstream through the existing FX-rate provider (lib/investments/providers/fx-provider.ts),
// exactly the same path Twelve Data's USD stocks already use, driven by
// the `nativeCurrency` this function returns.
const SUB_UNIT_MULTIPLIER: Record<QuoteUnit, number> = { GBP: 1, GBX: 0.01, USD: 1, EUR: 1 };
const NATIVE_CURRENCY_FOR_UNIT: Record<QuoteUnit, string> = { GBP: "GBP", GBX: "GBP", USD: "USD", EUR: "EUR" };

export type NormalizedPrice = { nativeUnitPrice: number; nativeCurrency: string; multiplier: number };

/**
 * The ONLY place a provider's raw price is ever converted — deterministic,
 * driven entirely by the explicit `unit` argument, never by the
 * magnitude of `rawPrice`. Exported so quote and history normalization
 * (and every test) share this exact function; never re-implemented.
 */
export function normalizeProviderPrice(rawPrice: number, unit: QuoteUnit): ProviderResult<NormalizedPrice> {
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    return { ok: false, error: `Provider price is not a finite positive number (got: ${rawPrice}).`, retryable: false };
  }
  const multiplier = SUB_UNIT_MULTIPLIER[unit];
  return { ok: true, data: { nativeUnitPrice: rawPrice * multiplier, nativeCurrency: NATIVE_CURRENCY_FOR_UNIT[unit], multiplier } };
}

function apiKey(): string | null {
  const key = process.env.EODHD_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function isConfigured(): boolean {
  return apiKey() !== null;
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

export type EodPoint = { date: string; rawPrice: number };

/**
 * ONE ranged EOD request, used for both a "current quote" (callers take
 * the last point) and "trailing history catch-up" (callers use every
 * point) — EODHD's free tier is a low, fixed number of calls per day
 * shared across all 3 Vanguard funds; issuing a separate quote call and
 * then an immediate separate history call for the same asset would
 * silently double real usage for no benefit, since the ranged endpoint
 * already returns everything a same-day quote call would. Rows are
 * returned as RAW provider values — normalization happens in the caller,
 * which knows the asset's verified quoteUnit; this function has no
 * opinion on units at all.
 */
export async function getEodRange(ticker: string, exchangeCode: string, fromDate: string, toDate: string): Promise<ProviderResult<EodPoint[]>> {
  const key = apiKey();
  if (!key) return { ok: false, error: "LSE pricing is not configured — set EODHD_API_KEY.", retryable: false };

  const params = new URLSearchParams({ api_token: key, fmt: "json", period: "d", order: "a", from: fromDate, to: toDate });
  const url = `${BASE_URL}/eod/${encodeURIComponent(ticker)}.${encodeURIComponent(exchangeCode)}?${params.toString()}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    return { ok: false, error: `Network error reaching EODHD: ${error instanceof Error ? error.message : "unknown"}`, retryable: true };
  }

  if (response.status === 401 || response.status === 403) return { ok: false, error: "EODHD rejected the configured API key.", retryable: false };
  if (response.status === 429) return { ok: false, error: "EODHD daily/rate limit reached.", retryable: true };
  if (!response.ok) return { ok: false, error: `EODHD returned ${response.status} for ${ticker}.${exchangeCode}.`, retryable: response.status >= 500 };

  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) return { ok: false, error: `EODHD returned an unexpected response shape for ${ticker}.${exchangeCode}.`, retryable: true };

  type RawRow = { date?: unknown; close?: unknown };
  const points: EodPoint[] = (body as RawRow[])
    .filter((r): r is { date: string; close: number | string } => typeof r?.date === "string" && (typeof r?.close === "number" || typeof r?.close === "string") && Number.isFinite(Number(r.close)) && Number(r.close) > 0)
    .map(r => ({ date: r.date, rawPrice: Number(r.close) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { ok: true, data: points };
}

/** Normalizes every point in a raw EOD range through the same explicit-unit function a quote uses — quote and history can never silently drift onto different units. */
export function normalizeEodRange(points: EodPoint[], unit: QuoteUnit): ProviderResult<Array<HistoricalPricePoint & { rawPrice: number }>> {
  const normalized: Array<HistoricalPricePoint & { rawPrice: number }> = [];
  for (const p of points) {
    const result = normalizeProviderPrice(p.rawPrice, unit);
    if (!result.ok) return result;
    normalized.push({ date: p.date, nativeUnitPrice: result.data.nativeUnitPrice, rawPrice: p.rawPrice });
  }
  return { ok: true, data: normalized };
}

/** The most recent point in a normalized range, as a PriceQuote — used by refresh.ts to build the "current price" result from the same ranged fetch used for catch-up. */
export function latestQuoteFromRange(ticker: string, normalizedPoints: Array<HistoricalPricePoint & { rawPrice: number }>, unit: QuoteUnit): ProviderResult<PriceQuote & { rawPrice: number; multiplier: number }> {
  if (normalizedPoints.length === 0) return { ok: false, error: `EODHD returned no price history for ${ticker}.`, retryable: true };
  const latest = normalizedPoints[normalizedPoints.length - 1];
  return {
    ok: true,
    data: {
      nativeUnitPrice: latest.nativeUnitPrice, nativeCurrency: NATIVE_CURRENCY_FOR_UNIT[unit],
      priceAt: new Date(`${latest.date}T00:00:00.000Z`).toISOString(), provider: "eodhd",
      rawPrice: latest.rawPrice, multiplier: SUB_UNIT_MULTIPLIER[unit],
    },
  };
}

/** The deterministic multiplier for a unit, without re-running full price validation — used purely for provenance bookkeeping (see supabase-investments.sql's normalization_multiplier column). */
export function multiplierForUnit(unit: QuoteUnit): number {
  return SUB_UNIT_MULTIPLIER[unit];
}

/** The native settlement currency for a unit (GBX still settles in GBP) — used by callers that need to decide whether an FX lookup applies, without duplicating NATIVE_CURRENCY_FOR_UNIT. */
export function nativeCurrencyForUnit(unit: QuoteUnit): string {
  return NATIVE_CURRENCY_FOR_UNIT[unit];
}

export const eodhdProvider = { name: "eodhd" as const, isConfigured, getEodRange, normalizeEodRange, latestQuoteFromRange, nativeCurrencyForUnit, multiplierForUnit };
