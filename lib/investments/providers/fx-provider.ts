import "server-only";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";

/**
 * USD/other-currency -> GBP conversion. Frankfurter (api.frankfurter.dev) —
 * confirmed live (no API key, `/v1/latest` and `/v1/{date}` both work, a
 * weekend/holiday date transparently returns the latest prior working
 * day's rate in its own response `date` field) — see this feature's own
 * completion report for the exact verification performed.
 *
 * Rates are GBP-PER-NATIVE-UNIT throughout this feature (base=native
 * currency, quote=GBP) — never the inverse — matching the direction the
 * cost-basis/currency-decomposition modules both expect.
 *
 * Cached in investment_fx_rates, keyed by (base, quote, the DATE ACTUALLY
 * REQUESTED, provider) — not by whatever trading-day date Frankfurter's
 * own response reports for a weekend/holiday request — so a second lookup
 * for the SAME requested calendar day is always a cache hit, even though
 * the underlying rate came from an earlier trading day. This is what
 * "cache rates so all US holdings reuse the same daily rate" and "do not
 * continuously request identical rates" mean in practice: one Frankfurter
 * call per (currency, calendar day) ever, shared across every asset and
 * every future page load.
 */

const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";
const REQUEST_TIMEOUT_MS = 8000;

export type FxRateResult = { rate: number; requestedDate: string; provider: "frankfurter" };

type FxRateRow = { base_currency: string; quote_currency: string; rate_at: string; rate: string; provider: string };

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * GBP-per-`nativeCurrency` rate for `date` (YYYY-MM-DD). `nativeCurrency
 * === "GBP"` always short-circuits to exactly 1 — no provider call, no
 * cache row, matching "GBP-denominated assets have zero currency effect"
 * without a single special case anywhere else in this feature.
 */
export async function getFxRate(nativeCurrency: string, date: string): Promise<FxRateResult> {
  if (nativeCurrency === "GBP") return { rate: 1, requestedDate: date, provider: "frankfurter" };

  const cached = await supabaseRequestAll<FxRateRow>(
    `investment_fx_rates?base_currency=eq.${nativeCurrency}&quote_currency=eq.GBP&rate_at=eq.${date}&provider=eq.frankfurter&select=rate`,
  );
  if (cached[0]) return { rate: Number(cached[0].rate), requestedDate: date, provider: "frankfurter" };

  const isFuture = date > todayIso();
  const path = isFuture || date === todayIso() ? "latest" : date;
  const url = `${FRANKFURTER_BASE_URL}/${path}?base=${encodeURIComponent(nativeCurrency)}&symbols=GBP`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    throw new Error(`Could not reach the FX rate provider (Frankfurter): ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new Error(`FX rate provider returned ${response.status} for ${nativeCurrency}->GBP on ${date}.`);

  const body = await response.json() as { rates?: Record<string, number> };
  const rate = body.rates?.GBP;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX rate provider returned no usable GBP rate for ${nativeCurrency} on ${date}.`);
  }

  // Best-effort cache write — a duplicate-key race (two concurrent
  // refreshes requesting the exact same currency/day) is expected and
  // harmless: the unique index rejects the loser, which simply means the
  // winner's identical rate is what's cached, not an error worth
  // surfacing to the caller who already has their answer either way.
  await supabaseRequest("investment_fx_rates", {
    method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" },
    body: JSON.stringify({ base_currency: nativeCurrency, quote_currency: "GBP", rate_at: date, rate, provider: "frankfurter" }),
  }).catch(() => {});

  return { rate, requestedDate: date, provider: "frankfurter" };
}

/**
 * Batched convenience for a refresh run touching many assets that share
 * the same native currency — fetches/caches each DISTINCT (currency, date)
 * pair at most once, never once per asset.
 */
export async function getFxRatesForDates(nativeCurrency: string, dates: string[]): Promise<Map<string, number>> {
  const uniqueDates = [...new Set(dates)];
  const results = new Map<string, number>();
  for (const date of uniqueDates) {
    const { rate } = await getFxRate(nativeCurrency, date);
    results.set(date, rate);
  }
  return results;
}

/**
 * Historical-backfill variant of the above — a genuine daily history range
 * can span hundreds of dates, and getFxRatesForDates' one-request-per-date
 * loop at that scale means hundreds of sequential round trips (confirmed
 * live to make a real multi-year backfill take minutes and, worse, tie up
 * the calling request). Frankfurter has a genuine range endpoint
 * (`/v1/{start}..{end}`, confirmed live) that returns every rate in the
 * range in ONE request — this uses that instead, and bulk-caches every
 * returned date in one insert.
 */
export async function getFxRatesForRange(nativeCurrency: string, startDate: string, endDate: string): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  if (nativeCurrency === "GBP" || startDate > endDate) return results;

  const url = `${FRANKFURTER_BASE_URL}/${startDate}..${endDate}?base=${encodeURIComponent(nativeCurrency)}&symbols=GBP`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    throw new Error(`Could not reach the FX rate provider (Frankfurter) for ${nativeCurrency} ${startDate}..${endDate}: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new Error(`FX rate provider returned ${response.status} for ${nativeCurrency}->GBP range ${startDate}..${endDate}.`);

  const body = await response.json() as { rates?: Record<string, { GBP?: number }> };
  const rows: Array<{ base_currency: string; quote_currency: string; rate_at: string; rate: number; provider: string }> = [];
  for (const [date, dayRates] of Object.entries(body.rates ?? {})) {
    const rate = dayRates?.GBP;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
    results.set(date, rate);
    rows.push({ base_currency: nativeCurrency, quote_currency: "GBP", rate_at: date, rate, provider: "frankfurter" });
  }

  if (rows.length > 0) {
    await supabaseRequest("investment_fx_rates", {
      method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" },
      body: JSON.stringify(rows),
      // A duplicate-key race against a concurrent lookup for an overlapping
      // range is expected and harmless — same reasoning as this file's
      // other best-effort cache writes.
    }).catch(() => {});
  }

  return results;
}

/**
 * Nearest available rate at or before `date` from a range map — used when
 * a specific trading date (e.g. a stock-exchange-only holiday) has no
 * exact FX rate in the fetched range. Never silently defaults to 1; falls
 * back to the nearest LATER date in the map only if nothing earlier
 * exists, and only throws if the map is genuinely empty.
 */
export function nearestRate(ratesByDate: Map<string, number>, date: string): number | null {
  if (ratesByDate.size === 0) return null;
  const dates = [...ratesByDate.keys()].sort();
  let best: string | null = null;
  for (const d of dates) {
    if (d <= date) best = d; else break;
  }
  return ratesByDate.get(best ?? dates[0]) ?? null;
}
