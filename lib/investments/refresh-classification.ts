import type { ProviderErrorCode } from "./providers/types";

/**
 * Pure helpers behind the refresh system's outcome reporting and "is this
 * price current" status — no DB/network access, fully testable in
 * isolation. Extracted so a Friday close viewed on Sunday, a rate-limited
 * request, and a genuine plan restriction never collapse into one
 * ambiguous "unavailable" bucket again.
 */

/**
 * Every holding refresh ends in exactly ONE of these — typed, not derived
 * from fragments of provider error text at display time (classification
 * happens once, here, from the real provider result).
 */
export type RefreshOutcome =
  | "updated" | "unchanged_current" | "market_closed_current" | "manual" | "fallback_purchase_price"
  | "unsupported_by_plan" | "symbol_not_found" | "provider_mapping_missing" | "rate_limited"
  | "provider_unavailable" | "invalid_response" | "no_data" | "skipped_inactive";

/** Human labels — one place, reused by the sync-status line and the details panel alike. */
export const REFRESH_OUTCOME_LABELS: Record<RefreshOutcome, string> = {
  updated: "Updated", unchanged_current: "Up to date", market_closed_current: "Up to date · market closed",
  manual: "Manual valuation", fallback_purchase_price: "Purchase-price fallback",
  unsupported_by_plan: "Not covered by current plan", symbol_not_found: "Symbol not found",
  provider_mapping_missing: "Provider mapping missing", rate_limited: "Rate limited", provider_unavailable: "Provider unavailable",
  invalid_response: "Unexpected provider response", no_data: "No current price available", skipped_inactive: "Inactive",
};

/** Whether this outcome represents a genuine attempted-and-failed price fetch — the only thing the top-level "N need attention" count should ever include. */
export function isGenuineFailure(outcome: RefreshOutcome): boolean {
  return outcome === "unsupported_by_plan" || outcome === "symbol_not_found" || outcome === "provider_mapping_missing"
    || outcome === "rate_limited" || outcome === "provider_unavailable" || outcome === "invalid_response" || outcome === "no_data";
}

/** Whether an automatic retry could plausibly succeed later without any user/config action. */
export function willRetryAutomatically(outcome: RefreshOutcome): boolean {
  return outcome === "rate_limited" || outcome === "provider_unavailable" || outcome === "no_data";
}

// A provider adapter that KNOWS its own precise failure reason (currently:
// PokePulse — see lib/investments/providers/pokepulse.ts) sets `code`
// directly from what it actually observed, skipping string-matching
// entirely. Twelve Data and EODHD don't populate `code` yet, so they fall
// through to the string-matching table below unchanged — this mapping
// exists purely to avoid re-deriving PokePulse's already-typed outcome
// from fragments of its own error text.
const CODE_TO_OUTCOME: Record<ProviderErrorCode, RefreshOutcome> = {
  product_not_found: "symbol_not_found",
  variant_not_found: "symbol_not_found",
  price_field_missing: "no_data",
  response_schema_unrecognised: "invalid_response",
  invalid_price: "invalid_response",
  empty_response: "no_data",
  rate_limited: "rate_limited",
  provider_unavailable: "provider_unavailable",
  authentication_failed: "provider_unavailable",
  timeout: "provider_unavailable",
  malformed_response: "invalid_response",
};

/**
 * Classifies a provider failure into one of the typed outcomes above.
 * Prefers the adapter's own explicit `code` when present (see
 * CODE_TO_OUTCOME); otherwise falls back to matching real, confirmed-live
 * error text (Twelve Data's plan-restriction and rate-limit messages, this
 * project's own history of confirming exact error bodies live before
 * writing detection for them) — never guessed.
 */
export function classifyProviderError(error: string, retryable: boolean, code?: ProviderErrorCode): RefreshOutcome {
  if (code) return CODE_TO_OUTCOME[code];

  const lower = error.toLowerCase();
  // Checked FIRST and deliberately narrow — Twelve Data's own rate-limit
  // message ends with "...consider switching to a higher tier plan",
  // which a looser plan-restriction match (matched second, below) would
  // otherwise misclassify as unsupported_by_plan instead of rate_limited
  // (a real bug caught by this module's own tests, not theoretical).
  if (lower.includes("run out of api credits") || lower.includes("rate limit") || lower.includes("429") || lower.includes("daily/rate limit")) return "rate_limited";
  if (lower.includes("grow or venture plan") || /\bupgrad(e|ing)\b/.test(lower)) return "unsupported_by_plan";
  if (lower.includes("no ticker on record") || lower.includes("no pokepulse identity") || lower.includes("not configured")) return "provider_mapping_missing";
  if (lower.includes("no market price") || lower.includes("no usable price") || lower.includes("no price history") || lower.includes("no data")) return "no_data";
  if (lower.includes("rejected the configured api key")) return "provider_mapping_missing";
  if (lower.includes("symbol") && (lower.includes("invalid") || lower.includes("missing") || lower.includes("not found"))) return "symbol_not_found";
  if (retryable) return "provider_unavailable";
  return "invalid_response";
}

/**
 * Concise, accurate UI wording for a PokePulse-specific failure code —
 * distinct from the raw adapter `error` string (which stays precise for
 * server-side diagnostics/logs). Never claims "no market price" unless
 * the code is genuinely `price_field_missing`/`empty_response` (the
 * response explicitly had no current price for the matched product) —
 * every other code describes a REQUEST or MATCHING problem, not a proven
 * absence of a price.
 */
export const POKEPULSE_UI_MESSAGES: Record<ProviderErrorCode, string> = {
  product_not_found: "No product was returned for this identifier.",
  variant_not_found: "Could not match the requested product variant.",
  price_field_missing: "No current price was supplied for the matched product; previous price retained.",
  empty_response: "No current price was supplied for the matched product; previous price retained.",
  response_schema_unrecognised: "Product response received, but its price format was not recognised.",
  invalid_price: "Product response received, but its price format was not recognised.",
  rate_limited: "PokePulse request temporarily failed; previous price retained.",
  provider_unavailable: "PokePulse request temporarily failed; previous price retained.",
  authentication_failed: "PokePulse request temporarily failed; previous price retained.",
  timeout: "PokePulse request timed out; previous price retained.",
  malformed_response: "PokePulse request temporarily failed; previous price retained.",
};

/** Whether THIS SPECIFIC failure reason is worth auto-retrying on the next scheduled refresh — distinct from isGenuineFailure/willRetryAutomatically, which operate on the coarser app-wide RefreshOutcome. A permanent mapping problem (product/variant not found, unrecognised schema, invalid value) never resolves itself by waiting. */
export function isPokePulseCodeRetryable(code: ProviderErrorCode): boolean {
  return code !== "product_not_found" && code !== "variant_not_found" && code !== "response_schema_unrecognised" && code !== "invalid_price";
}

export type ExchangeCode = "US" | "LSE";

const EXCHANGE_TIMEZONE: Record<ExchangeCode, string> = { US: "America/New_York", LSE: "Europe/London" };
// 16:00 ET (US primary close) and 16:30 London (LSE primary close),
// expressed as a decimal hour in the exchange's OWN local time.
const EXCHANGE_CLOSE_HOUR: Record<ExchangeCode, number> = { US: 16, LSE: 16.5 };

function exchangeLocalNow(exchange: ExchangeCode, now: Date): { dateIso: string; hourDecimal: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: EXCHANGE_TIMEZONE[exchange], year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateIso: `${get("year")}-${get("month")}-${get("day")}`,
    hourDecimal: Number(get("hour")) + Number(get("minute")) / 60,
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

/**
 * The most recent trading date that has genuinely FINISHED for this
 * exchange, as of `now` — weekends are skipped entirely; a weekday whose
 * close time hasn't passed yet in the exchange's own local time rolls
 * back to the previous completed session. Does NOT account for exchange
 * bank holidays (a real, disclosed gap — no holiday-calendar data source
 * is wired up) — a holiday will be treated as if the exchange were open,
 * which only ever makes this function MORE conservative (it will expect
 * a price that genuinely won't exist yet), never falsely claim staleness
 * is fine.
 */
export function latestCompletedTradingDate(exchange: ExchangeCode, now: Date = new Date()): string {
  const local = exchangeLocalNow(exchange, now);
  const d = new Date(`${local.dateIso}T00:00:00Z`);
  const isWeekday = local.weekday >= 1 && local.weekday <= 5;
  const todaysSessionClosed = isWeekday && local.hourDecimal >= EXCHANGE_CLOSE_HOUR[exchange];
  if (!todaysSessionClosed) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** True when a stored price's date is at least as recent as the latest genuinely completed session — the direct fix for "Friday's close displayed as stale on Sunday". */
export function isPriceCurrentForLatestSession(priceAtDate: string, exchange: ExchangeCode, now: Date = new Date()): boolean {
  return priceAtDate.slice(0, 10) >= latestCompletedTradingDate(exchange, now);
}

// Regular trading hours' open, in the exchange's own local time — 9:30 ET
// (US) / 8:00 London (LSE). Combined with EXCHANGE_CLOSE_HOUR above to
// decide whether the exchange is trading RIGHT NOW, distinct from whether
// its latest session has finished (that's latestCompletedTradingDate).
const EXCHANGE_OPEN_HOUR: Record<ExchangeCode, number> = { US: 9.5, LSE: 8 };

/** Weekend, or a weekday outside regular trading hours in the exchange's own local time. Does not account for bank holidays — see latestCompletedTradingDate's own comment on that gap. */
export function isExchangeCurrentlyClosed(exchange: ExchangeCode, now: Date = new Date()): boolean {
  const local = exchangeLocalNow(exchange, now);
  const isWeekday = local.weekday >= 1 && local.weekday <= 5;
  if (!isWeekday) return true;
  return local.hourDecimal < EXCHANGE_OPEN_HOUR[exchange] || local.hourDecimal >= EXCHANGE_CLOSE_HOUR[exchange];
}

// A genuine single-session EOD move for an index-tracking equity ETF is
// never remotely close to this — this threshold exists purely to catch a
// CONFIGURATION mistake (the exact GBX/GBP ~100x class of error this
// feature's own dry-run process is designed to prevent), not real market
// volatility. Deliberately a wide margin below the ~100x scale a genuine
// unit mismatch produces, so it never second-guesses a real, if unusually
// large, price move.
const IMPLAUSIBLE_PRICE_RATIO = 10;

/**
 * Defense-in-depth ONLY — never the primary unit detector (that's the
 * asset's explicit, independently-verified `provider_quote_unit`; see
 * lib/investments/providers/eodhd.ts). Flags a proposed normalized price
 * that differs from a known-good reference by roughly 10x or more in
 * either direction — exactly the shape a GBX-vs-GBP mismatch produces,
 * comfortably below the ~100x an actual such mismatch would cause, so a
 * real bug is caught with wide margin while genuine market moves are
 * never blocked.
 */
export function isImplausiblePriceMovement(referencePrice: number, proposedPrice: number): boolean {
  if (!Number.isFinite(referencePrice) || !Number.isFinite(proposedPrice) || referencePrice <= 0 || proposedPrice <= 0) return true;
  const ratio = proposedPrice / referencePrice;
  return ratio >= IMPLAUSIBLE_PRICE_RATIO || ratio <= 1 / IMPLAUSIBLE_PRICE_RATIO;
}
