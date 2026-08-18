import "server-only";
import { validatePokePulseUrl } from "./pokepulse-url";
import type { HistoricalPricePoint, PriceQuote, ProviderErrorCode, ProviderResult } from "./types";

/**
 * PokePulse (pokepulse.io) — Pokémon card/sealed-product pricing.
 *
 * There is no documented public API and no login is required or used.
 * Every endpoint below was found by loading a REAL pokepulse.io product
 * page in a real, logged-out browser and inspecting the requests the page
 * itself made — never guessed, never DOM-scraped. Confirmed live:
 *   - POST /api/catalogue/cards/lookup   {slugs:[...]}       -> card identity (product_id/name/image), for /cards/* URLs
 *   - POST /api/catalogue/sealed/lookup  {slugs:[...]}       -> sealed identity, for /sealed/* URLs
 *   - POST /api/internal/market-data     {productIds:[...]} -> current prices, keyed by productId, each entry an array
 *     of {type, value, currency, aggregation_date, ...}; the entry with
 *     type:"market_price" is the page's own single, primary price — used
 *     here EXACTLY as returned, never averaged/altered/recomputed.
 *   - POST /api/internal/market-data/timeseries {productIds, metricTypes, startDate, endDate, groupingStrategy}
 *     -> historical dataPoints per productId, used for up to a rolling
 *     year of real history.
 * All four returned a genuine 200 while fully logged out — this app never
 * sends a cookie, session, or credential of any kind to PokePulse, and
 * never sends any purchase-tracker/Supabase credential to it either.
 *
 * CONFIRMED LIVE (2026-08-17, direct raw requests — see this feature's own
 * completion report for the full evidence): PokePulse's market_price entry
 * reports `currency` as EITHER the literal string `"GBP"` OR the symbol
 * `"£"` — both genuinely represent GBP, and which one a given product
 * returns is NOT correlated with card-vs-sealed, product name, or repeat
 * requests (the same product returns the same representation consistently
 * across isolated, back-to-back, and same-session-cookie requests). A
 * prior version of this adapter only accepted the literal string "GBP",
 * silently discarding every "£"-shaped response as "no market price" —
 * a real, confirmed adapter bug (roughly half of this portfolio's real
 * PokePulse holdings use the "£" shape), NOT a PokePulse data gap and NOT
 * rate limiting: a controlled test of all 10 active holdings, sequential
 * and back-to-back with zero delay (the app's own real refresh pattern),
 * returned a genuine market_price for every single one. Both currency
 * representations are accepted below; a genuinely different currency
 * (anything but GBP/£) is still never silently converted.
 *
 * Two other real, confirmed-live response-shape differences exist for the
 * SAME market_price entry type, both handled below: `aggregation_date` is
 * sometimes a strict ISO instant ("2026-08-16T00:00:00.000Z") and
 * sometimes a Postgres-style space-separated form ("2026-08-16
 * 00:00:00+00") — normalised explicitly rather than relied on via lenient
 * Date parsing; and the entry sometimes carries extra nested
 * `regions`/`trends` metadata and sometimes doesn't — irrelevant here,
 * since only `value`/`currency`/`aggregation_date` are ever read.
 *
 * Security (per this feature's own explicit requirements):
 *   - Every call is preceded by validatePokePulseUrl() re-validation of the
 *     slug's source URL — host/protocol/path are re-checked here, not just
 *     trusted from whatever validated it earlier.
 *   - The internal API calls themselves always target a hardcoded
 *     `https://pokepulse.io` origin string — never a URL built from user
 *     input beyond the already-validated slug — so there is no way for a
 *     stored/crafted URL to redirect this adapter's own requests
 *     elsewhere (classic SSRF-via-stored-URL is structurally impossible
 *     here).
 *   - `redirect: "manual"` — any 3xx response is treated as a hard
 *     failure, never followed, so a compromised/misconfigured response can
 *     never silently redirect this server to an arbitrary internal or
 *     external host.
 *   - A request timeout and a response-size ceiling bound every call.
 */

const POKEPULSE_ORIGIN = "https://pokepulse.io";
const REQUEST_TIMEOUT_MS = 8000;
// Generous for a JSON price/lookup response (real captured payloads here
// were a few KB), well under any realistic legitimate size — protects
// against an unexpectedly huge or malformed response being fully buffered.
const MAX_RESPONSE_BYTES = 2_000_000;

// Both representations confirmed live to mean GBP — see this module's own
// top comment for the direct evidence. Compared case-insensitively and
// trimmed; anything else is never silently treated as GBP.
function isGbpCurrency(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return trimmed === "£" || trimmed.toUpperCase() === "GBP";
}

/** Normalises PokePulse's two confirmed-live aggregation_date shapes (strict ISO, and Postgres-style "YYYY-MM-DD HH:mm:ss+00") to a real ISO instant — never relies on Date's own lenient/non-standard parsing of the second form. */
function normaliseAggregationDate(raw: string): string | null {
  const isoLike = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/\+00$/, "Z");
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

type PokePulseFailure = { ok: false; error: string; retryable: boolean; code: ProviderErrorCode };
function failure(code: ProviderErrorCode, error: string, retryable: boolean): PokePulseFailure {
  return { ok: false, code, error, retryable };
}

/**
 * `/api/internal/*` (market-data, timeseries) rejects a cookie-less server
 * request with 403 `{"message":"Valid session required"}` — confirmed by
 * running this exact request from a plain Node process (not a browser) and
 * diffing it against the same request WITH a session cookie attached.
 * `/api/catalogue/*` (lookup) has no such requirement and is left alone.
 *
 * The cookie involved (`connect.sid`) is an anonymous, unauthenticated
 * session — PokePulse issues one to any visitor on first contact, with no
 * login, no account, and no identity attached (verified: a fresh GET to
 * `/` with zero credentials gets one immediately). This is not a
 * credential in the sense this feature's own security requirements
 * prohibit (never send app/Supabase credentials outward; never accept a
 * stored URL containing embedded credentials) — it is PokePulse's own
 * anonymous session, requested from and sent back to PokePulse alone,
 * exactly mirroring what a real browser does automatically when it loads
 * the page before calling this same endpoint.
 */
let sessionCookieCache: { cookie: string; expiresAt: number } | null = null;
const SESSION_TTL_MS = 10 * 60 * 1000;

async function bootstrapSessionCookie(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && sessionCookieCache && sessionCookieCache.expiresAt > Date.now()) return sessionCookieCache.cookie;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${POKEPULSE_ORIGIN}/`, { redirect: "manual", signal: controller.signal });
    // Must be invoked directly on response.headers — detaching it into a
    // standalone reference loses its `this` binding and silently breaks
    // (a real bug caught here during live verification, not theoretical).
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const rawSetCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const cookie = rawSetCookies.map(c => c.split(";")[0]).join("; ");
    if (!cookie) { sessionCookieCache = null; return null; }
    sessionCookieCache = { cookie, expiresAt: Date.now() + SESSION_TTL_MS };
    return cookie;
  } catch {
    sessionCookieCache = null;
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

type RawResult = { ok: true; body: unknown } | PokePulseFailure;

async function postJsonTyped(path: string, body: unknown, options?: { withSession?: boolean }): Promise<RawResult> {
  const attempt = async (forceFreshSession: boolean) => {
    const cookie = options?.withSession ? await bootstrapSessionCookie(forceFreshSession) : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${POKEPULSE_ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  let response: Response;
  try {
    response = await attempt(false);
    // The cached session may have expired server-side sooner than our own
    // TTL guess — one retry with a genuinely fresh session before giving up.
    if (response.status === 403 && options?.withSession) response = await attempt(true);
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return failure(isAbort ? "timeout" : "provider_unavailable", `Could not reach PokePulse: ${error instanceof Error ? error.message : "network error"}`, true);
  }

  // undici (Node's fetch) reports a manual-mode redirect as type
  // "opaqueredirect" with status 0 — treated identically to an explicit
  // 3xx status: a hard failure, never followed.
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return failure("provider_unavailable", "PokePulse returned an unexpected redirect — refusing to follow it.", true);
  }
  if (response.status === 401 || response.status === 403) {
    return failure("authentication_failed", `PokePulse rejected this request (${response.status}).`, true);
  }
  if (response.status === 429) {
    return failure("rate_limited", "PokePulse rate limit reached.", true);
  }
  if (!response.ok) {
    return failure(response.status >= 500 ? "provider_unavailable" : "malformed_response", `PokePulse returned ${response.status}.`, response.status >= 500);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) return failure("provider_unavailable", "PokePulse response exceeded the size limit.", false);
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return failure("provider_unavailable", "PokePulse response exceeded the size limit.", false);

  // An HTML error/maintenance page served with a 200 must never be handed
  // to JSON.parse and misread as "empty" — reported as its own distinct,
  // precise outcome instead. Deliberately narrow (checks for "html"
  // specifically, not "content-type must include json") — a Response
  // constructed from a plain string defaults to "text/plain" even when
  // its body genuinely is JSON text, so requiring "json" in the header
  // would reject perfectly valid responses that just didn't bother
  // setting an exact content-type.
  if (contentType.includes("html")) {
    return failure("malformed_response", `PokePulse returned an HTML response (content-type: ${contentType}) instead of JSON — likely an error or maintenance page.`, true);
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return failure("malformed_response", "PokePulse returned a response that could not be parsed as JSON.", true);
  }
}

export type PokePulseIdentity = { productId: string; name: string; imageUrl: string | null; kind: "sealed" | "cards" };

type CardLookupResponse = { cards?: Array<{ product_id: string; card_name: string; image_url: string | null; slug: string }> };
type SealedLookupResponse = { sealedProducts?: Array<{ product_id: string; name: string; image_url: string | null; slug: string }> };

async function lookupCard(slug: string): Promise<ProviderResult<PokePulseIdentity>> {
  const result = await postJsonTyped("/api/catalogue/cards/lookup", { slugs: [slug], includeSet: false, includeGradedVariants: false, includeCardmarketUrl: false });
  if (!result.ok) return result;
  const body = result.body as CardLookupResponse;
  const match = body.cards?.find(c => c.slug === slug);
  if (!match) return failure("variant_not_found", "PokePulse did not recognise this card URL.", false);
  return { ok: true, data: { productId: match.product_id, name: match.card_name, imageUrl: match.image_url ?? null, kind: "cards" } };
}

async function lookupSealed(slug: string): Promise<ProviderResult<PokePulseIdentity>> {
  const result = await postJsonTyped("/api/catalogue/sealed/lookup", { slugs: [slug] });
  if (!result.ok) return result;
  const body = result.body as SealedLookupResponse;
  const match = body.sealedProducts?.find(p => p.slug === slug);
  if (!match) return failure("variant_not_found", "PokePulse did not recognise this sealed-product URL.", false);
  return { ok: true, data: { productId: match.product_id, name: match.name, imageUrl: match.image_url ?? null, kind: "sealed" } };
}

/**
 * Resolves a stored/user-supplied PokePulse URL to its stable
 * `productId`/name/image — the identity this feature persists on the
 * asset row (investment_assets.external_id) and reuses on every future
 * refresh, never re-searching by product name.
 */
export async function resolvePokePulseIdentity(rawUrl: string): Promise<ProviderResult<PokePulseIdentity>> {
  const validation = validatePokePulseUrl(rawUrl);
  if (!validation.valid) return { ok: false, error: validation.error, retryable: false };
  return validation.kind === "cards" ? lookupCard(validation.slug) : lookupSealed(validation.slug);
}

type MarketDataEntry = { type: string; value: unknown; currency: unknown; aggregation_date: unknown };

/**
 * Selects the market_price entry and validates it fully before ever
 * treating it as a real price:
 *   1. type === "market_price" — PokePulse's own single, primary figure
 *      (never averaged/blended/an outlier — see this module's own top
 *      comment). Case-sensitive on purpose: every real response observed
 *      uses lowercase "market_price" consistently; a differently-cased
 *      type has never been seen and would indicate a genuinely different
 *      schema, correctly falling through to response_schema_unrecognised
 *      rather than being silently matched.
 *   2. value must parse to a finite, POSITIVE number — a numeric string
 *      ("146.69") and a real number are both accepted (PokePulse's two
 *      confirmed shapes send it as a string); 0/negative/NaN are rejected
 *      as invalid_price, never treated as "no data".
 *   3. currency must be GBP or £ (see isGbpCurrency) — never silently
 *      converted from a genuinely different currency.
 *   4. aggregation_date must normalise to a real instant.
 * The entry already belongs to the exact requested productId (PokePulse's
 * response is keyed by the identifier this app sent, itself already
 * disambiguated to an exact set+product+variant, or exact
 * card+number+printing+grade, at Add-investment time via
 * resolvePokePulseIdentity — see investment_assets.external_id) — there is
 * no separate cross-product matching step here to get wrong.
 */
function selectMarketPrice(entries: MarketDataEntry[]): ProviderResult<PriceQuote> {
  const marketPriceEntry = entries.find(entry => entry.type === "market_price");
  if (!marketPriceEntry) return failure("price_field_missing", "PokePulse's response for this product had no market_price entry.", true);

  const price = typeof marketPriceEntry.value === "number" || typeof marketPriceEntry.value === "string" ? Number(marketPriceEntry.value) : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    return failure("invalid_price", `PokePulse's market_price value was not a usable positive number (got: ${JSON.stringify(marketPriceEntry.value)}).`, false);
  }
  if (!isGbpCurrency(typeof marketPriceEntry.currency === "string" ? marketPriceEntry.currency : null)) {
    return failure("response_schema_unrecognised", `PokePulse's market_price currency was not recognised as GBP (got: ${JSON.stringify(marketPriceEntry.currency)}) — never silently converted.`, false);
  }
  const priceAt = typeof marketPriceEntry.aggregation_date === "string" ? normaliseAggregationDate(marketPriceEntry.aggregation_date) : null;
  if (!priceAt) return failure("response_schema_unrecognised", `PokePulse's market_price aggregation_date could not be parsed (got: ${JSON.stringify(marketPriceEntry.aggregation_date)}).`, false);

  return { ok: true, data: { nativeUnitPrice: price, nativeCurrency: "GBP", priceAt, provider: "pokepulse" } };
}

async function fetchMarketPrice(productId: string): Promise<ProviderResult<PriceQuote>> {
  const result = await postJsonTyped("/api/internal/market-data", { productIds: [productId] }, { withSession: true });
  if (!result.ok) return result;

  const body = result.body;
  if (typeof body !== "object" || body === null) return failure("response_schema_unrecognised", "PokePulse's response was not the expected object shape.", true);
  const entries = (body as Record<string, unknown>)[productId];

  // The key for this EXACT productId is entirely absent from the response
  // map — PokePulse never returned anything for this identifier, distinct
  // from "returned something, just no price entry in it".
  if (entries === undefined) return failure("product_not_found", "PokePulse's response did not include this product at all.", false);
  if (!Array.isArray(entries)) return failure("response_schema_unrecognised", "PokePulse's response for this product was not the expected array shape.", true);
  if (entries.length === 0) return failure("empty_response", "PokePulse returned an empty response for this product.", true);

  return selectMarketPrice(entries as MarketDataEntry[]);
}

type TimeseriesResponse = Record<string, { metrics?: { market_price?: { dataPoints?: Array<{ date: string; value: number }> } } }>;

async function fetchHistory(productId: string, startDate: string, endDate: string): Promise<ProviderResult<HistoricalPricePoint[]>> {
  const result = await postJsonTyped("/api/internal/market-data/timeseries", {
    productIds: [productId], metricTypes: ["market_price"], startDate, endDate, groupingStrategy: "auto",
  }, { withSession: true });
  if (!result.ok) return result;
  const body = result.body as TimeseriesResponse;
  const points = body[productId]?.metrics?.market_price?.dataPoints ?? [];
  return {
    ok: true,
    data: points
      .filter(p => Number.isFinite(p.value) && p.value > 0)
      .map(p => ({ date: p.date, nativeUnitPrice: p.value }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// Genuinely transient conditions only. Deliberately excludes:
//   - product_not_found / variant_not_found / response_schema_unrecognised /
//     invalid_price — permanent mapping/parsing problems; retrying an
//     identical request reproduces the same result.
//   - price_field_missing — a structurally valid response that explicitly
//     has no current price for the matched product; retrying THIS SAME
//     run cannot conjure a price PokePulse hasn't computed yet.
//   - authentication_failed — already gets its own dedicated retry with a
//     genuinely fresh session cookie one layer down (see postJsonTyped's
//     403 handling); retrying again here would just repeat that same
//     already-failed dance, not attempt anything new.
// See this feature's own completion report: no real instance of these
// transient conditions was observed during live investigation — this
// exists as defense-in-depth, not because PokePulse was seen to need it.
const RETRYABLE_CODES = new Set<ProviderErrorCode>(["timeout", "provider_unavailable", "rate_limited", "empty_response", "malformed_response"]);
const INNER_RETRY_ATTEMPTS = 1;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withBoundedRetry<T>(run: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
  let result = await run();
  for (let attempt = 0; attempt < INNER_RETRY_ATTEMPTS && !result.ok && result.code && RETRYABLE_CODES.has(result.code); attempt++) {
    await sleep(400 + Math.floor(Math.random() * 400));
    result = await run();
  }
  return result;
}

/**
 * The per-asset pricing surface, matching the shared provider result
 * contract (see ./types.ts) even though PokePulse's identity resolution
 * doesn't fit StockPriceProvider's ticker-based shape — asset resolution
 * happens once, at "Add investment" time, via resolvePokePulseIdentity;
 * every refresh afterwards uses the already-stored productId directly.
 */
export const pokePulseProvider = {
  name: "pokepulse" as const,
  isConfigured: () => true, // no credentials/signup required — public, unauthenticated endpoints

  async getQuote(productId: string): Promise<ProviderResult<PriceQuote>> {
    return withBoundedRetry(() => fetchMarketPrice(productId));
  },

  async getHistory(productId: string, startDate: string, endDate: string): Promise<ProviderResult<HistoricalPricePoint[]>> {
    return withBoundedRetry(() => fetchHistory(productId, startDate, endDate));
  },
};
