import "server-only";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { twelveDataProvider } from "./providers/twelve-data";
import { pokePulseProvider } from "./providers/pokepulse";
import { eodhdProvider, multiplierForUnit, type EodPoint, type QuoteUnit } from "./providers/eodhd";
import { getFxRatesForRange, nearestRate } from "./providers/fx-provider";
import { isImplausiblePriceMovement, latestCompletedTradingDate } from "./refresh-classification";
import type { HistoricalPricePoint } from "./providers/types";

/**
 * Historical-price backfill — the piece the chart was actually missing.
 * lib/investments/reconstruction.ts already builds one portfolio point per
 * DISTINCT date any asset has a real transaction OR a real price snapshot;
 * it was never the bottleneck. The bottleneck was investment_price_snapshots
 * itself only ever gaining ONE row per asset per manual "Refresh prices"
 * click (see refresh.ts) — a portfolio refreshed a handful of times has a
 * handful of distinct snapshot dates, so the chart had nothing more to
 * plot. This module calls each provider's ALREADY-IMPLEMENTED getHistory
 * (Twelve Data time_series, PokePulse timeseries — both existed, unused,
 * before this change) once per asset and writes the real results as
 * ordinary market-quality snapshots, so the existing reconstruction logic
 * picks them up with no changes of its own.
 *
 * Idempotent, not incremental: every run requests the FULL range from the
 * asset's first buy date through yesterday. An earlier incremental design
 * (only fetch the gap since the latest stored date) turned out to be
 * actively wrong here — investment_price_snapshots also gains a row every
 * time the ordinary "Refresh prices" button runs (see refresh.ts), under
 * the exact same provider value, so "latest stored date" was frequently
 * TODAY even though no real historical range had ever been backfilled,
 * making the gap look closed when it wasn't (confirmed live: every stock
 * asset that had been refreshed today came back requesting a same-day
 * start=end range, which Twelve Data correctly rejects as "no data" since
 * that day hasn't closed). Re-fetching the full range each time is more
 * provider calls, but this is a personal portfolio with a handful of
 * assets and a free-tier daily quota with real headroom — correctness
 * over micro-efficiency. Duplicate DATES across repeated runs are still
 * cheap: `resolution=ignore-duplicates` on the (asset, provider, price_at)
 * unique index means a repeat write for an already-stored date is a
 * no-op, not new row growth.
 *
 * The range stops at YESTERDAY, not today — a daily-close provider has no
 * data for a day that hasn't finished trading yet; today's own price is
 * exactly what the ordinary refresh (refresh.ts) already supplies, so
 * splitting the two by date range is deliberate, not a gap.
 *
 * Never fetches before an asset's first purchase. Excludes 'manual'/'none'
 * providers entirely (LEGO manual valuation and cash are untouched — no
 * invented eBay/BrickLink history here).
 */

export type BackfillAssetRow = {
  id: string; ticker: string | null; exchange: string | null; native_currency: string; pricing_provider: string; external_id: string | null;
  provider_quote_unit?: string | null;
};
export type BackfillResultEntry = { assetId: string; provider: string; ok: boolean; pointsWritten: number; error?: string };

const AUTOMATED_HISTORY_PROVIDERS = ["twelve_data", "pokepulse", "eodhd"];
const CONCURRENCY = 3;
const BULK_CHUNK_SIZE = 500;

function yesterdayIso(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// supabaseRequestAll() explicitly forbids a query already carrying its own
// limit= (see its own REGRESSION GUARD) — a genuinely single-row bounded
// lookup goes through supabaseRequest() directly instead.
async function earliestBuyDate(ownerId: string, assetId: string): Promise<string | null> {
  const response = await supabaseRequest(
    `investment_transactions?owner_id=eq.${ownerId}&asset_id=eq.${assetId}&transaction_type=in.(buy,deposit)&reversed_at=is.null&select=trade_at&order=trade_at.asc&limit=1`,
  );
  const rows = await response.json() as { trade_at: string }[];
  return rows[0] ? rows[0].trade_at.slice(0, 10) : null;
}

/**
 * Fixed midday timestamp per date so a repeat run's `resolution=ignore-
 * duplicates` insert genuinely collides with (and skips) an already-
 * written date instead of creating a second row a few milliseconds apart.
 * `rawProviderPrice`/`providerQuoteUnit` are optional full-provenance
 * fields (see supabase-investments.sql's Phase A columns) — populated for
 * EODHD's unit-converted points, left null for providers that never
 * needed sub-unit conversion.
 */
export async function bulkWriteSnapshots(
  ownerId: string, assetId: string, provider: string,
  points: Array<{ date: string; nativeUnitPrice: number; fxRate: number; rawProviderPrice?: number; providerQuoteUnit?: QuoteUnit; normalizationMultiplier?: number }>,
): Promise<number> {
  if (points.length === 0) return 0;
  for (let i = 0; i < points.length; i += BULK_CHUNK_SIZE) {
    const chunk = points.slice(i, i + BULK_CHUNK_SIZE).map(p => ({
      owner_id: ownerId, asset_id: assetId, native_unit_price: p.nativeUnitPrice, gbp_unit_price: p.nativeUnitPrice * p.fxRate,
      fx_rate: p.fxRate, price_at: `${p.date}T12:00:00.000Z`, provider, data_quality: "market",
      raw_provider_price: p.rawProviderPrice ?? null, provider_quote_unit: p.providerQuoteUnit ?? null, normalization_multiplier: p.normalizationMultiplier ?? null,
    }));
    await supabaseRequest("investment_price_snapshots", {
      method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" },
      body: JSON.stringify(chunk),
      // A duplicate-key race against a concurrent backfill/refresh for the
      // exact same asset/provider/date is expected and harmless — see the
      // unique index's own comment in supabase-investments.sql.
    }).catch(() => {});
  }
  return points.length;
}

/** Shared by both entry points below — fetches [startDate, endDate], converts FX, and writes. */
async function fetchAndWriteRange(ownerId: string, asset: BackfillAssetRow, startDate: string, endDate: string): Promise<BackfillResultEntry> {
  if (startDate > endDate) return { assetId: asset.id, provider: asset.pricing_provider, ok: true, pointsWritten: 0 };

  let history: HistoricalPricePoint[];
  let eodhdProvenance: { rawByDate: Map<string, number>; unit: QuoteUnit } | null = null;
  if (asset.pricing_provider === "twelve_data") {
    if (!twelveDataProvider.isConfigured()) return { assetId: asset.id, provider: "twelve_data", ok: false, pointsWritten: 0, error: "Stock pricing is not configured (missing TWELVE_DATA_API_KEY)." };
    if (!asset.ticker) return { assetId: asset.id, provider: "twelve_data", ok: false, pointsWritten: 0, error: "This investment has no ticker on record." };
    const result = await twelveDataProvider.getHistory(asset.ticker, asset.exchange, startDate, endDate);
    if (!result.ok) return { assetId: asset.id, provider: "twelve_data", ok: false, pointsWritten: 0, error: result.error };
    history = result.data;
  } else if (asset.pricing_provider === "eodhd") {
    if (!eodhdProvider.isConfigured()) return { assetId: asset.id, provider: "eodhd", ok: false, pointsWritten: 0, error: "LSE pricing is not configured (missing EODHD_API_KEY)." };
    if (!asset.ticker) return { assetId: asset.id, provider: "eodhd", ok: false, pointsWritten: 0, error: "This investment has no ticker on record." };
    // Never inferred from magnitude — see eodhd.ts's own top comment for
    // the real, confirmed-dangerous heuristic this replaced. An asset
    // without a verified unit on record is refused outright, never
    // guessed.
    const unit = asset.provider_quote_unit;
    if (unit !== "GBP" && unit !== "GBX" && unit !== "USD" && unit !== "EUR") {
      return { assetId: asset.id, provider: "eodhd", ok: false, pointsWritten: 0, error: `This investment has no verified provider_quote_unit on record (got: ${unit ?? "null"}) — refusing to guess a currency unit.` };
    }
    const rangeResult = await eodhdProvider.getEodRange(asset.ticker, asset.exchange ?? "LSE", startDate, endDate);
    if (!rangeResult.ok) return { assetId: asset.id, provider: "eodhd", ok: false, pointsWritten: 0, error: rangeResult.error };
    const normalizedResult = eodhdProvider.normalizeEodRange(rangeResult.data, unit);
    if (!normalizedResult.ok) return { assetId: asset.id, provider: "eodhd", ok: false, pointsWritten: 0, error: normalizedResult.error };
    history = normalizedResult.data.map(p => ({ date: p.date, nativeUnitPrice: p.nativeUnitPrice }));
    eodhdProvenance = { rawByDate: new Map(normalizedResult.data.map(p => [p.date, p.rawPrice])), unit };
  } else {
    if (!asset.external_id) return { assetId: asset.id, provider: "pokepulse", ok: false, pointsWritten: 0, error: "This investment has no PokePulse identity on record." };
    const result = await pokePulseProvider.getHistory(asset.external_id, startDate, endDate);
    if (!result.ok) return { assetId: asset.id, provider: "pokepulse", ok: false, pointsWritten: 0, error: result.error };
    history = result.data;
  }

  if (history.length === 0) return { assetId: asset.id, provider: asset.pricing_provider, ok: true, pointsWritten: 0 };

  let points: Array<{ date: string; nativeUnitPrice: number; fxRate: number }>;
  if (asset.pricing_provider === "pokepulse" || asset.native_currency === "GBP") {
    // PokePulse values are already GBP; a GBP-native stock has no FX
    // effect — both skip the FX lookup entirely rather than requesting a
    // same-currency rate that would always just be 1.
    points = history.map(h => ({ date: h.date, nativeUnitPrice: h.nativeUnitPrice, fxRate: 1 }));
  } else {
    // ONE range request for the whole gap, not one request per date (see
    // getFxRatesForRange's own comment — the naive per-date loop made a
    // real multi-year backfill take minutes). A trading date with no exact
    // FX match (a stock-exchange-only holiday) uses the nearest earlier
    // genuine rate — never a silent 1.
    const rateByDate = await getFxRatesForRange(asset.native_currency, startDate, endDate);
    points = history
      .map(h => ({ date: h.date, nativeUnitPrice: h.nativeUnitPrice, fxRate: nearestRate(rateByDate, h.date) }))
      .filter((p): p is { date: string; nativeUnitPrice: number; fxRate: number } => p.fxRate !== null);
  }

  const pointsWithProvenance = eodhdProvenance
    ? points.map(p => ({ ...p, rawProviderPrice: eodhdProvenance!.rawByDate.get(p.date), providerQuoteUnit: eodhdProvenance!.unit, normalizationMultiplier: multiplierForUnit(eodhdProvenance!.unit) }))
    : points;
  const written = await bulkWriteSnapshots(ownerId, asset.id, asset.pricing_provider, pointsWithProvenance);
  return { assetId: asset.id, provider: asset.pricing_provider, ok: true, pointsWritten: written };
}

/**
 * Full backfill — the asset's ENTIRE history from its first buy through
 * yesterday. Used for: the explicit maintenance route (history-backfill
 * API), and automatically once for a brand-new asset right after creation
 * (see app/api/investments/assets/route.ts) — a newly added holding is
 * never left with only today's single live-refresh point waiting for
 * someone to remember a hidden maintenance action.
 */
export async function backfillOneAsset(ownerId: string, asset: BackfillAssetRow): Promise<BackfillResultEntry> {
  if (!AUTOMATED_HISTORY_PROVIDERS.includes(asset.pricing_provider)) {
    return { assetId: asset.id, provider: asset.pricing_provider, ok: false, pointsWritten: 0, error: "No automated history provider for this investment." };
  }
  const firstBuy = await earliestBuyDate(ownerId, asset.id);
  if (!firstBuy) return { assetId: asset.id, provider: asset.pricing_provider, ok: true, pointsWritten: 0, error: "No buy transaction on record yet — nothing to backfill." };
  return fetchAndWriteRange(ownerId, asset, firstBuy, yesterdayIso());
}

const CATCH_UP_WINDOW_DAYS = 5;

/**
 * Cheap trailing-window catch-up — the ongoing part of "history stays
 * current without a manual step". Deliberately NOT a full re-backfill on
 * every refresh: this app's real refresh cadence includes an automatic
 * page-load trigger (see refresh.ts's "auto_page_open"), and a full
 * multi-year re-fetch on every single page load would be slow and wasteful.
 * A small fixed trailing window is cheap (one short request per asset,
 * same as a full backfill's ONE request, just a smaller date range) and
 * self-healing: it re-covers the last few days every time, so any gap
 * (the asset was added recently, a previous refresh failed, a provider
 * hiccup) closes within days without needing precise "how far did we
 * already get" bookkeeping — and re-writing an already-covered date is a
 * harmless no-op via the same ignore-duplicates path every write here uses.
 */
export async function catchUpOneAsset(ownerId: string, asset: BackfillAssetRow): Promise<BackfillResultEntry> {
  if (!AUTOMATED_HISTORY_PROVIDERS.includes(asset.pricing_provider)) {
    return { assetId: asset.id, provider: asset.pricing_provider, ok: false, pointsWritten: 0, error: "No automated history provider for this investment." };
  }
  const end = yesterdayIso();
  const startDate = new Date(`${end}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - CATCH_UP_WINDOW_DAYS);
  return fetchAndWriteRange(ownerId, asset, startDate.toISOString().slice(0, 10), end);
}

/** Bounded concurrency (3 assets at a time) — never one unbounded burst of provider requests. */
export async function runHistoryBackfill(ownerId: string): Promise<{ results: BackfillResultEntry[] }> {
  const assets = await supabaseRequestAll<BackfillAssetRow>(
    `investment_assets?owner_id=eq.${ownerId}&archived_at=is.null&pricing_provider=in.(twelve_data,pokepulse,eodhd)&select=id,ticker,exchange,native_currency,pricing_provider,external_id,provider_quote_unit`,
  );

  const results: BackfillResultEntry[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < assets.length) {
      const asset = assets[cursor++];
      results.push(await backfillOneAsset(ownerId, asset));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assets.length) }, worker));
  return { results };
}

/**
 * EODHD-only genuine-history backfill — deliberately separate from
 * backfillOneAsset/runHistoryBackfill above (which stay untouched, still
 * used by twelve_data/pokepulse and by the brand-new-asset auto-backfill).
 * Two reasons this needed its own path rather than reusing the generic one:
 *
 *  1. Quota discipline: the generic path re-requests the FULL range on
 *     every run, unconditionally (see its own comment — a deliberate
 *     tradeoff for those providers' more generous quotas). EODHD's free
 *     tier does not have that headroom, so this path checks existing
 *     coverage FIRST and skips the request entirely once an asset is
 *     genuinely caught up — never spending a call to reconfirm data
 *     already on record.
 *  2. Bounded end date: the generic path stops at "yesterday" for every
 *     provider. For EODHD specifically the correct boundary is the
 *     exchange's own latest COMPLETED session (latestCompletedTradingDate),
 *     computed fresh each run — never hard-coded — so a still-open
 *     session's close is never requested as if it already existed.
 *
 * Only ever touches pricing_provider = 'eodhd' assets. PokePulse and
 * Twelve Data are never imported or called from this function.
 */

export type EodhdBackfillEntry = {
  assetId: string;
  ticker: string;
  ok: boolean;
  error?: string;
  skippedAlreadyCovered: boolean;
  requestedStart: string;
  requestedEnd: string;
  returnedObservations: number;
  newRowsInserted: number;
  duplicatesSkipped: number;
  existingCountBefore: number;
  existingEarliestBefore: string | null;
  existingLatestBefore: string | null;
  finalCount: number;
  finalEarliest: string | null;
  finalLatest: string | null;
};

type SnapshotDateRow = { date: string; nativeUnitPrice: number };

async function existingEodhdSnapshotRows(ownerId: string, assetId: string): Promise<SnapshotDateRow[]> {
  const rows = await supabaseRequestAll<{ price_at: string; native_unit_price: number | string }>(
    `investment_price_snapshots?owner_id=eq.${ownerId}&asset_id=eq.${assetId}&provider=eq.eodhd&select=price_at,native_unit_price&order=price_at.asc`,
  );
  return rows.map(r => ({ date: r.price_at.slice(0, 10), nativeUnitPrice: Number(r.native_unit_price) }));
}

/** Rough business-day estimate (5/7 of calendar days) — used only to decide whether existing coverage already looks like a genuine daily series, not as an exact expectation (see runHistoryBackfill's own report — real trading-day counts vary with holidays and are never forced to match this). */
function estimateExpectedTradingDays(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  const calendarDays = Math.max(0, Math.round((end - start) / 86400000)) + 1;
  return calendarDays * (5 / 7);
}

/**
 * True only when existing stored dates already look like a genuine,
 * essentially-complete daily series spanning the requested range — allows
 * a small (7-calendar-day) slack at the start for the asset's first
 * purchase landing on a weekend/holiday, and requires the stored count to
 * be at least 90% of the rough trading-day estimate so a handful of stray
 * dates (like the 3 already on record before this backfill) never counts
 * as "already covered."
 */
function isAlreadyCovered(existingDates: string[], start: string, end: string): boolean {
  if (existingDates.length === 0) return false;
  const earliest = existingDates[0];
  const latest = existingDates[existingDates.length - 1];
  const slackDate = new Date(`${start}T00:00:00Z`);
  slackDate.setUTCDate(slackDate.getUTCDate() + 7);
  const coversStart = earliest <= slackDate.toISOString().slice(0, 10);
  const coversEnd = latest >= end;
  if (!coversStart || !coversEnd) return false;
  // Distinct dates only — a same-day price revision (see
  // lib/investments/price-revisions.ts) must never inflate this count and
  // make a range look more covered than it genuinely is.
  const withinRangeCount = new Set(existingDates.filter(dt => dt >= start && dt <= end)).size;
  return withinRangeCount >= estimateExpectedTradingDays(start, end) * 0.9;
}

function validateRawEodhdPoints(points: EodPoint[]): string | null {
  if (points.length === 0) return "EODHD returned no observations for the requested range.";
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.rawPrice) || p.rawPrice <= 0) return `EODHD returned a non-finite/non-positive close (${p.rawPrice}) for ${p.date}.`;
    if (i > 0 && points[i - 1].date >= p.date) return `EODHD returned dates out of order or duplicated (${points[i - 1].date} then ${p.date}).`;
  }
  return null;
}

/** Every consecutive pair of a normalized series must stay within the same defense-in-depth ratio used everywhere else in this app (isImplausiblePriceMovement) — catches an internal scale discontinuity within the returned range itself, not just a mismatch against an external reference. */
function findScaleDiscontinuity(points: Array<{ date: string; nativeUnitPrice: number }>): string | null {
  for (let i = 1; i < points.length; i++) {
    if (isImplausiblePriceMovement(points[i - 1].nativeUnitPrice, points[i].nativeUnitPrice)) {
      return `Implausible scale change between ${points[i - 1].date} (£${points[i - 1].nativeUnitPrice}) and ${points[i].date} (£${points[i].nativeUnitPrice}).`;
    }
  }
  return null;
}

function emptyEntry(asset: BackfillAssetRow, patch: Partial<EodhdBackfillEntry> & { ok: boolean }): EodhdBackfillEntry {
  return {
    assetId: asset.id, ticker: asset.ticker ?? "", skippedAlreadyCovered: false,
    requestedStart: "", requestedEnd: "", returnedObservations: 0, newRowsInserted: 0, duplicatesSkipped: 0,
    existingCountBefore: 0, existingEarliestBefore: null, existingLatestBefore: null,
    finalCount: 0, finalEarliest: null, finalLatest: null,
    ...patch,
  };
}

/**
 * One asset's genuine purchase-to-present EODHD backfill. AT MOST ONE
 * getEodRange call — issued only after confirming the existing stored
 * range isn't already essentially complete. Writes ONLY dates not already
 * present for this asset+provider (pre-filtered here, on top of the
 * unique-index/ignore-duplicates safety net every other write in this
 * module already relies on) — existing rows are never touched, never
 * overwritten, never deleted.
 */
export async function backfillEodhdAssetHistory(ownerId: string, asset: BackfillAssetRow): Promise<EodhdBackfillEntry> {
  if (asset.pricing_provider !== "eodhd") return emptyEntry(asset, { ok: false, error: "Not an EODHD-routed asset." });
  if (!asset.ticker) return emptyEntry(asset, { ok: false, error: "This investment has no ticker on record." });

  const rawUnit = asset.provider_quote_unit;
  if (rawUnit !== "GBP" && rawUnit !== "GBX" && rawUnit !== "USD" && rawUnit !== "EUR") {
    return emptyEntry(asset, { ok: false, error: `This investment has no verified provider_quote_unit on record (got: ${rawUnit ?? "null"}) — refusing to guess a currency unit.` });
  }
  const unit: QuoteUnit = rawUnit;

  const start = await earliestBuyDate(ownerId, asset.id);
  if (!start) return emptyEntry(asset, { ok: true, error: "No buy transaction on record yet — nothing to backfill." });

  const end = latestCompletedTradingDate("LSE");
  const existingRows = await existingEodhdSnapshotRows(ownerId, asset.id);
  const existingDates = existingRows.map(r => r.date);
  const existingCountBefore = existingRows.length;
  const existingEarliestBefore = existingDates[0] ?? null;
  const existingLatestBefore = existingDates[existingDates.length - 1] ?? null;
  const base = { assetId: asset.id, ticker: asset.ticker, requestedStart: start, requestedEnd: end, existingCountBefore, existingEarliestBefore, existingLatestBefore };

  if (start > end) {
    return emptyEntry(asset, { ...base, ok: true, finalCount: existingCountBefore, finalEarliest: existingEarliestBefore, finalLatest: existingLatestBefore, error: "First purchase date is after the latest completed LSE session — nothing to fetch yet." });
  }

  if (isAlreadyCovered(existingDates, start, end)) {
    return emptyEntry(asset, { ...base, ok: true, skippedAlreadyCovered: true, finalCount: existingCountBefore, finalEarliest: existingEarliestBefore, finalLatest: existingLatestBefore });
  }

  // The ONE bounded EODHD request for this fund.
  const rangeResult = await eodhdProvider.getEodRange(asset.ticker, asset.exchange ?? "LSE", start, end);
  if (!rangeResult.ok) {
    return emptyEntry(asset, { ...base, ok: false, error: rangeResult.error, finalCount: existingCountBefore, finalEarliest: existingEarliestBefore, finalLatest: existingLatestBefore });
  }

  const rawValidationError = validateRawEodhdPoints(rangeResult.data);
  if (rawValidationError) {
    return emptyEntry(asset, { ...base, ok: false, error: rawValidationError, finalCount: existingCountBefore, finalEarliest: existingEarliestBefore, finalLatest: existingLatestBefore });
  }

  const normalizedResult = eodhdProvider.normalizeEodRange(rangeResult.data, unit);
  if (!normalizedResult.ok) {
    return emptyEntry(asset, { ...base, ok: false, error: normalizedResult.error, finalCount: existingCountBefore, finalEarliest: existingEarliestBefore, finalLatest: existingLatestBefore });
  }

  // Defensive re-filter — getEodRange's own from/to params already restrict
  // this server-side, but a raw-price point is never written outside the
  // verified purchase-to-latest-session window regardless.
  const inRange = normalizedResult.data.filter(p => p.date >= start && p.date <= end);
  const returnedObservations = inRange.length;

  const scaleError = findScaleDiscontinuity(inRange);
  if (scaleError) {
    return emptyEntry(asset, { ...base, ok: false, error: scaleError, returnedObservations, finalCount: existingCountBefore, finalEarliest: existingEarliestBefore, finalLatest: existingLatestBefore });
  }

  const existingDateSet = new Set(existingDates);
  const newPoints = inRange.filter(p => !existingDateSet.has(p.date));
  const duplicatesSkipped = returnedObservations - newPoints.length;

  const nativeCurrency = eodhdProvider.nativeCurrencyForUnit(unit);
  let fxRate = 1;
  if (nativeCurrency !== "GBP") {
    // Only reachable for a hypothetical future USD/EUR-quoted EODHD asset —
    // every asset routed to EODHD today (VWRP/V3AB/VUAG) uses GBP/GBX, both
    // of which settle in GBP (fxRate stays 1). Mirrors the exact same
    // range-FX pattern fetchAndWriteRange already uses for twelve_data.
    const rateByDate = await getFxRatesForRange(nativeCurrency, start, end);
    const rate = nearestRate(rateByDate, end);
    if (rate !== null) fxRate = rate;
  }

  const pointsWithProvenance = newPoints.map(p => ({
    date: p.date, nativeUnitPrice: p.nativeUnitPrice, fxRate,
    rawProviderPrice: p.rawPrice, providerQuoteUnit: unit, normalizationMultiplier: multiplierForUnit(unit),
  }));
  const newRowsInserted = await bulkWriteSnapshots(ownerId, asset.id, "eodhd", pointsWithProvenance);

  const finalRows = await existingEodhdSnapshotRows(ownerId, asset.id);
  const finalDates = finalRows.map(r => r.date);

  return emptyEntry(asset, {
    ...base, ok: true, returnedObservations, newRowsInserted, duplicatesSkipped,
    finalCount: finalRows.length, finalEarliest: finalDates[0] ?? null, finalLatest: finalDates[finalDates.length - 1] ?? null,
  });
}

/** All of the owning user's EODHD-routed assets, sequentially (never more than one in-flight EODHD request at a time) — see backfillEodhdAssetHistory's own comment for why this needed a dedicated path instead of reusing runHistoryBackfill. */
export async function backfillAllEodhdHistory(ownerId: string): Promise<{ results: EodhdBackfillEntry[] }> {
  const assets = await supabaseRequestAll<BackfillAssetRow>(
    `investment_assets?owner_id=eq.${ownerId}&archived_at=is.null&pricing_provider=eq.eodhd&select=id,ticker,exchange,native_currency,pricing_provider,external_id,provider_quote_unit`,
  );
  const results: EodhdBackfillEntry[] = [];
  for (const asset of assets) {
    results.push(await backfillEodhdAssetHistory(ownerId, asset));
  }
  return { results };
}
