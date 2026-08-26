import "server-only";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { twelveDataProvider } from "./providers/twelve-data";
import { pokePulseProvider } from "./providers/pokepulse";
import { eodhdProvider, multiplierForUnit, type QuoteUnit } from "./providers/eodhd";
import { getFxRate } from "./providers/fx-provider";
import { catchUpOneAsset, bulkWriteSnapshots } from "./history-backfill";
import type { PriceQuote, ProviderErrorCode, ProviderResult, StockPriceProvider } from "./providers/types";
import {
  classifyProviderError, isExchangeCurrentlyClosed, isGenuineFailure, isImplausiblePriceMovement, latestCompletedTradingDate,
  type ExchangeCode, type RefreshOutcome,
} from "./refresh-classification";

/**
 * Refresh orchestration — the ONE place every automated pricing pass runs
 * (manual button, auto-on-page-open, cron). Explicitly excludes cash
 * (pricing_provider='none') so nothing is ever fetched for it; a manual
 * (LEGO) asset IS included in the loop below but only ever produces the
 * 'manual' outcome — never priced automatically, never overwritten.
 *
 * Partial success by design: one failing asset is caught and classified in
 * `results`, never thrown — every other asset in the same run is still
 * attempted. A provider failure never deletes or zeroes a previous
 * snapshot; the last valid price simply remains the most recent row in
 * investment_price_snapshots (this function only ever INSERTs a new one
 * when the observation genuinely changed).
 *
 * Timestamp model — deliberately reuses existing fields rather than adding
 * new columns (no schema change needed beyond the 'eodhd' provider-value
 * migration): `investment_refresh_runs.started_at`/`completed_at` ARE
 * last_refresh_attempt_at/last_refresh_success_at for the whole run;
 * `results[].outcome` + `results[].priceAt` on each entry (persisted into
 * that same run row) is the per-asset attempt record; `price_as_of` is
 * `results[].priceAt` (or the pre-existing snapshot's `price_at` for an
 * unchanged observation); `last_good_price_at` is simply the latest row in
 * investment_price_snapshots, which a failed/unchanged outcome never
 * touches. `price_provenance` is `results[].provider` combined with
 * `outcome` (e.g. eodhd+updated = genuine market price; any provider with
 * outcome='fallback_purchase_price' is never produced by this module today
 * — that fallback is written by lib/investments/reconstruction.ts, not
 * here — see that module for where 'purchase_price_fallback' snapshots
 * actually originate).
 */

export type AssetRow = {
  id: string; category: string; ticker: string | null; exchange: string | null; native_currency: string; pricing_provider: string; external_id: string | null;
  provider_quote_unit?: string | null;
};

export type RefreshResultEntry = {
  assetId: string; provider: string; outcome: RefreshOutcome; ok: boolean; error?: string; code?: ProviderErrorCode;
  nativeUnitPrice?: number; nativeCurrency?: string; priceAt?: string;
  // Honest write-path diagnostics (see writeSnapshotAndClassify) — never
  // trust "outcome: updated" alone to mean a row was actually inserted;
  // these fields prove it. providerObservationAt is the provider's own
  // reported observation instant (price_at); retrievedAt is when THIS
  // refresh fetched it (created_at) — never conflated with each other.
  snapshotWritten?: boolean; snapshotId?: string; providerObservationAt?: string; retrievedAt?: string;
  previousPrice?: number | null; returnedPrice?: number; selectedStoredPrice?: number;
};

/** Reported after each holding's FINAL result (retries already resolved) — a holding never appears "done" before its own retry finishes. */
export type RefreshProgress = { completed: number; total: number };
export type RefreshRunResult = {
  runId: string; results: RefreshResultEntry[]; status: "completed" | "partial_failure" | "failed";
  counts: Record<RefreshOutcome, number>;
  /** How many PokePulse HTTP requests this run actually issued vs. how many PokePulse holdings it priced — the gap is results reused across holdings sharing the same exact external product ID. */
  pokePulseDedup: { holdings: number; uniqueProducts: number };
};

// Twelve Data's confirmed real limit is 8 credits/minute (confirmed live —
// see this feature's own completion report for the exact error text this
// was hitting before pacing existed). Spacing calls by 8s caps this run at
// 7.5/minute — comfortably under the real ceiling with margin for a
// concurrent manual click or cron overlap that findRecentRunningRun didn't
// quite catch.
const TWELVE_DATA_MIN_INTERVAL_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mapExchangeCode(asset: AssetRow): ExchangeCode {
  return asset.exchange === "LSE" ? "LSE" : "US";
}

/**
 * A 'running' row older than this is not a legitimate in-flight refresh —
 * it's a process that was killed, a client that disconnected mid-stream
 * before the server-side write finished, or (confirmed live, run
 * 9a5e792e-dcf1-48c8-b3e1-5fa8a5f3045c on 2026-08-17) a stream write that
 * threw once the client tab was gone, propagating out of runRefresh before
 * its own finalization PATCH ever ran. Actively reclaimed (see
 * reclaimStaleRuns), not just bypassed by the concurrency guard — a stale
 * row must eventually read 'failed' in the audit trail, never sit at
 * 'running' forever.
 */
const STALE_RUN_MINUTES = 5;

/**
 * Marks any of this owner's 'running' rows older than STALE_RUN_MINUTES as
 * 'failed' with a sanitized reason — never deletes a run (preserved for
 * audit, per this table's own append-only intent). Runs BEFORE the
 * concurrency check on every call, so an abandoned row from a crashed
 * process or dead client connection can't block refreshes indefinitely, and
 * the reclaimed row itself ends up in a truthful terminal state instead of
 * silently lingering. A genuinely active run (started within the last
 * STALE_RUN_MINUTES) is never touched here.
 */
async function reclaimStaleRuns(ownerId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60 * 1000).toISOString();
  await supabaseRequest(
    `investment_refresh_runs?owner_id=eq.${ownerId}&status=eq.running&started_at=lt.${cutoff}`,
    {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "failed", completed_at: new Date().toISOString(),
        failure_reason: `Abandoned — no completion recorded within ${STALE_RUN_MINUTES} minutes of starting (client disconnect or server interruption). Reclaimed automatically by a later refresh.`,
      }),
    },
  ).catch(() => { /* best-effort reclaim — a failed PATCH here just means the row stays 'running' until the next call tries again; never blocks the current refresh */ });
}

async function findRecentRunningRun(ownerId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60 * 1000).toISOString();
  const rows = await supabaseRequestAll<{ id: string }>(
    `investment_refresh_runs?owner_id=eq.${ownerId}&status=eq.running&started_at=gte.${cutoff}&select=id`,
  );
  return rows.length > 0;
}

type SnapshotProvenance = { rawProviderPrice: number; providerQuoteUnit: QuoteUnit; normalizationMultiplier: number };

type InsertOutcome = { written: true; snapshotId: string; createdAt: string } | { written: false };

/**
 * The ONE place a price snapshot is ever inserted. `return=representation`
 * (not `return=minimal`, as this used to be) is load-bearing: it's the only
 * way to know whether `resolution=ignore-duplicates` actually inserted a
 * row or silently discarded a conflicting one — `return=minimal` gives back
 * an identical-looking success response either way, which is exactly how
 * "the run said updated but the price never changed" happened (confirmed
 * live — see supabase-investments.sql's own comment on the dedup index this
 * fix widened). A genuine network/HTTP failure now THROWS instead of being
 * swallowed, so a failed write can never be silently reported as a success
 * by a caller — see writeSnapshotAndClassify for how callers handle it.
 */
async function insertSnapshot(
  ownerId: string, assetId: string, quote: PriceQuote, fxRate: number, provenance?: SnapshotProvenance, nativePriceObservedAt?: string,
): Promise<InsertOutcome> {
  const response = await supabaseRequest("investment_price_snapshots", {
    method: "POST", headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
    body: JSON.stringify({
      owner_id: ownerId, asset_id: assetId, native_unit_price: quote.nativeUnitPrice, gbp_unit_price: quote.nativeUnitPrice * fxRate,
      fx_rate: fxRate, price_at: quote.priceAt, provider: quote.provider, source_url: quote.sourceUrl ?? null, data_quality: "market",
      raw_provider_price: provenance?.rawProviderPrice ?? null, provider_quote_unit: provenance?.providerQuoteUnit ?? null,
      normalization_multiplier: provenance?.normalizationMultiplier ?? null,
      // Only ever set by an FX-only revision (see maybeWriteFxOnlyRevision)
      // — every ordinary snapshot omits this key entirely (never sent to
      // PostgREST), meaning "the native price and this valuation were
      // observed at the same instant, see price_at" for every row that
      // isn't an FX-only revision. Requires supabase-investments.sql's
      // native_price_observed_at column (PENDING at the time this code was
      // written — see that migration's own comment): if it hasn't been
      // applied yet, an FX-only revision's insert fails with an unknown-
      // column error, which the caller already classifies gracefully as
      // `provider_unavailable` ("previous price retained") rather than
      // crashing — self-healing on the next refresh once the migration has
      // run, never silent data corruption either way.
      ...(nativePriceObservedAt ? { native_price_observed_at: nativePriceObservedAt } : {}),
    }),
  });
  const rows = await response.json().catch(() => []) as Array<{ id: string; created_at: string }>;
  if (rows.length > 0) return { written: true, snapshotId: rows[0].id, createdAt: rows[0].created_at };
  return { written: false };
}

type LastSnapshot = { id: string; nativeUnitPrice: number; gbpUnitPrice: number; priceAt: string; createdAt: string };

/**
 * Deterministic "latest" selection: among rows sharing the same provider
 * observation (`price_at`) — the exact same-day-revision case this whole
 * fix addresses — the one with the latest `created_at` wins (the most
 * recently retrieved revision), and `id` is the final stable tiebreak for
 * the vanishingly rare case of an identical instant. Every other "latest
 * snapshot" consumer in this codebase (portfolio route, holding detail,
 * intraday) uses this exact same three-key ordering — see
 * lib/investments/price-revisions.ts for the shared comparison this
 * mirrors on the read side.
 */
const LATEST_SNAPSHOT_ORDER = "price_at.desc,created_at.desc,id.desc";

/** One query, first row per asset_id kept (relies on LATEST_SNAPSHOT_ORDER putting the true latest revision first). Avoids an N+1 "latest snapshot" lookup per asset. */
async function fetchLastSnapshots(ownerId: string, assetIds: string[]): Promise<Map<string, LastSnapshot>> {
  const map = new Map<string, LastSnapshot>();
  if (assetIds.length === 0) return map;
  const rows = await supabaseRequestAll<{ asset_id: string; id: string; native_unit_price: string; gbp_unit_price: string; price_at: string; created_at: string }>(
    `investment_price_snapshots?owner_id=eq.${ownerId}&asset_id=in.(${assetIds.join(",")})&select=asset_id,id,native_unit_price,gbp_unit_price,price_at,created_at&order=asset_id.asc,${LATEST_SNAPSHOT_ORDER}`,
  );
  for (const row of rows) {
    if (!map.has(row.asset_id)) map.set(row.asset_id, { id: row.id, nativeUnitPrice: Number(row.native_unit_price), gbpUnitPrice: Number(row.gbp_unit_price), priceAt: row.price_at, createdAt: row.created_at });
  }
  return map;
}

/** Single-asset equivalent of fetchLastSnapshots — used only after an insert conflict, to find out what the database's true current winner actually is before ever reporting an outcome (see writeSnapshotAndClassify). */
// A genuinely single-row bounded lookup uses supabaseRequest() directly,
// never supabaseRequestAll() — that helper explicitly forbids a query
// already carrying its own limit= (see its own REGRESSION GUARD, and
// lib/investments/history-backfill.ts's earliestBuyDate for the same
// established pattern).
async function fetchSingleLatestSnapshot(ownerId: string, assetId: string): Promise<LastSnapshot | null> {
  const response = await supabaseRequest(
    `investment_price_snapshots?owner_id=eq.${ownerId}&asset_id=eq.${assetId}&select=id,native_unit_price,gbp_unit_price,price_at,created_at&order=${LATEST_SNAPSHOT_ORDER}&limit=1`,
  );
  const rows = await response.json() as Array<{ id: string; native_unit_price: string; gbp_unit_price: string; price_at: string; created_at: string }>;
  const row = rows[0];
  return row ? { id: row.id, nativeUnitPrice: Number(row.native_unit_price), gbpUnitPrice: Number(row.gbp_unit_price), priceAt: row.price_at, createdAt: row.created_at } : null;
}

type WriteAndClassifyResult = {
  outcome: "updated" | "unchanged_current";
  snapshotWritten: boolean; snapshotId: string | null;
  selectedStoredPrice: number; providerObservationAt: string; retrievedAt: string; previousPrice: number | null;
};

/**
 * The ONE place a fetched quote becomes either "updated" or
 * "unchanged_current" — replaces every call site that used to do
 * `await writeSnapshot(...); return finalize(..., "updated", ...)`
 * unconditionally, which is exactly how a silently-ignored insert still
 * got reported as a success (confirmed live — see supabase-investments.sql).
 * Never trusts a successful HTTP response alone: after insertSnapshot(),
 * if `written` is false (an exact duplicate already existed under the
 * widened key), this queries the database for the REAL current winner
 * before deciding anything, per the explicit requirement to never blindly
 * report "updated".
 */
async function writeSnapshotAndClassify(
  ownerId: string, assetId: string, quote: PriceQuote, fxRate: number,
  lastSnapshot: LastSnapshot | undefined, provenance?: SnapshotProvenance,
): Promise<WriteAndClassifyResult> {
  const retrievedAt = new Date().toISOString();
  const previousPrice = lastSnapshot?.nativeUnitPrice ?? null;
  const insertResult = await insertSnapshot(ownerId, assetId, quote, fxRate, provenance);

  if (insertResult.written) {
    return {
      outcome: "updated", snapshotWritten: true, snapshotId: insertResult.snapshotId,
      selectedStoredPrice: quote.nativeUnitPrice, providerObservationAt: quote.priceAt, retrievedAt, previousPrice,
    };
  }

  // The insert was ignored — an exact duplicate (asset, provider, price_at,
  // native_unit_price, gbp_unit_price) already existed. Ask the database
  // what the real current winner is rather than assuming.
  const current = await fetchSingleLatestSnapshot(ownerId, assetId);
  const matchesReturnedQuote = current !== null
    && new Date(current.priceAt).getTime() === new Date(quote.priceAt).getTime()
    && Math.abs(current.nativeUnitPrice - quote.nativeUnitPrice) < 1e-6;
  const changedFromWhatWeKnewBefore = !lastSnapshot || !current
    || new Date(current.priceAt).getTime() !== new Date(lastSnapshot.priceAt).getTime()
    || Math.abs(current.nativeUnitPrice - lastSnapshot.nativeUnitPrice) > 1e-6;

  // Only "updated" when the exact revision we tried to write is genuinely
  // now the selected price AND it differs from what this refresh started
  // with — covering the legitimate concurrent-writer race (another request
  // inserted the identical result a moment before us) without ever
  // reporting "updated" for a stale, unrelated historical duplicate.
  const outcome: "updated" | "unchanged_current" = matchesReturnedQuote && changedFromWhatWeKnewBefore ? "updated" : "unchanged_current";
  return {
    outcome, snapshotWritten: false, snapshotId: current?.id ?? null,
    selectedStoredPrice: current?.nativeUnitPrice ?? (lastSnapshot?.nativeUnitPrice ?? quote.nativeUnitPrice),
    providerObservationAt: quote.priceAt, retrievedAt, previousPrice,
  };
}

function finalize(
  assetId: string, provider: string, outcome: RefreshOutcome,
  extra: Partial<Pick<RefreshResultEntry,
    "error" | "code" | "nativeUnitPrice" | "nativeCurrency" | "priceAt" |
    "snapshotWritten" | "snapshotId" | "providerObservationAt" | "retrievedAt" | "previousPrice" | "returnedPrice" | "selectedStoredPrice"
  >> = {},
): RefreshResultEntry {
  return { assetId, provider, outcome, ok: !isGenuineFailure(outcome), ...extra };
}

/** Shared by every provider path once a quote genuinely differs from the last known observation — writes (or discovers the true already-stored) revision, then reports the honest outcome from writeSnapshotAndClassify rather than assuming success. */
function finalizeFromWrite(assetId: string, provider: string, quote: PriceQuote, write: WriteAndClassifyResult): RefreshResultEntry {
  return finalize(assetId, provider, write.outcome, {
    nativeUnitPrice: quote.nativeUnitPrice, nativeCurrency: quote.nativeCurrency, priceAt: quote.priceAt,
    snapshotWritten: write.snapshotWritten, snapshotId: write.snapshotId ?? undefined,
    providerObservationAt: write.providerObservationAt, retrievedAt: write.retrievedAt,
    previousPrice: write.previousPrice, returnedPrice: quote.nativeUnitPrice, selectedStoredPrice: write.selectedStoredPrice,
  });
}

/** Same real-world observation as last time, compared by INSTANT (not raw string — Postgres round-trips a timestamptz in a different textual format than the one it was written with, so string equality would false-negative on every genuinely-unchanged price). */
function isSameObservation(lastSnapshot: LastSnapshot | undefined, quote: PriceQuote): boolean {
  if (!lastSnapshot) return false;
  return new Date(lastSnapshot.priceAt).getTime() === new Date(quote.priceAt).getTime()
    && Math.abs(lastSnapshot.nativeUnitPrice - quote.nativeUnitPrice) < 1e-6;
}

const FX_RATE_CHANGE_EPSILON = 1e-6;

/**
 * REGRESSION FIX (confirmed live, 2026-08-17 investments-chart sign-off
 * audit): isSameObservation, above, only ever compares native price/instant
 * — when it returns true, priceViaMarketProvider used to short-circuit
 * straight to unchanged_current/market_closed_current WITHOUT EVER
 * re-fetching FX, silently dropping every genuine GBP/USD (or GBP/other)
 * movement on any day a non-GBP asset's native price happened to be flat.
 * This is exactly the gap the prior report flagged as "the FX-only
 * movement... doesn't independently trigger" — this function is the actual
 * fix, called only from that short-circuit branch.
 *
 * Fetches today's real FX rate and, only if it has genuinely moved from
 * what the last stored snapshot implies (gbp_unit_price/native_unit_price),
 * writes ONE new snapshot carrying the SAME native price forward (never a
 * fabricated market move — explicitly the representation the audit itself
 * endorsed: "Carrying forward the previous native price while applying a
 * genuine new FX observation is acceptable if clearly represented") at a
 * NEW price_at set to right now (this is a distinct real observation
 * instant — an FX rate discovered now — not a revision of the original
 * market quote, so it must not reuse that quote's stale price_at).
 *
 * Returns null (nothing written, caller falls through to its normal
 * unchanged/market-closed classification) when: the asset is GBP-native
 * (no FX to move), there's no prior snapshot to compare against, the FX
 * lookup itself failed, or FX genuinely hasn't moved beyond float noise.
 */
async function maybeWriteFxOnlyRevision(
  ownerId: string, assetId: string, quote: PriceQuote, lastSnapshot: LastSnapshot | undefined,
): Promise<WriteAndClassifyResult | null> {
  if (quote.nativeCurrency === "GBP" || !lastSnapshot || lastSnapshot.nativeUnitPrice <= 0) return null;

  const lastFxRate = lastSnapshot.gbpUnitPrice / lastSnapshot.nativeUnitPrice;
  let currentFxRate: number;
  try { currentFxRate = (await getFxRate(quote.nativeCurrency, new Date().toISOString().slice(0, 10))).rate; }
  catch { return null; } // an FX lookup failure never blocks the already-known-unchanged-price outcome
  if (!Number.isFinite(currentFxRate) || Math.abs(currentFxRate - lastFxRate) <= FX_RATE_CHANGE_EPSILON) return null;

  const retrievedAt = new Date().toISOString();
  const fxOnlyQuote: PriceQuote = { ...quote, priceAt: retrievedAt };
  // lastSnapshot.priceAt is the best available record of when the native
  // price itself was last genuinely observed. Not selected from the DB
  // fresh here (deliberately — see fetchLastSnapshots/fetchSingleLatest-
  // Snapshot's own comments on why native_price_observed_at is never added
  // to a SELECT list yet: unlike an occasional INSERT, that runs on EVERY
  // refresh and would break all of them against the still-unmigrated
  // column). This slightly under-serves the rare case of TWO consecutive
  // FX-only revisions with no real price update between them (it would
  // carry forward the first revision's synthetic instant, not the true
  // original) — a narrow, self-correcting edge case fixed by the next
  // genuine price refresh, accepted in exchange for never risking a
  // blanket refresh outage on an unmigrated database.
  const insertResult = await insertSnapshot(ownerId, assetId, fxOnlyQuote, currentFxRate, undefined, lastSnapshot.priceAt);
  if (!insertResult.written) return null; // a concurrent writer already covered this exact revision — fall through to the caller's normal unchanged path rather than risk double-reporting
  return {
    outcome: "updated", snapshotWritten: true, snapshotId: insertResult.snapshotId,
    selectedStoredPrice: quote.nativeUnitPrice, providerObservationAt: retrievedAt, retrievedAt, previousPrice: lastSnapshot.nativeUnitPrice,
  };
}

async function priceViaMarketProvider(
  ownerId: string, asset: AssetRow, provider: StockPriceProvider, providerName: string, exchange: ExchangeCode, lastSnapshot: LastSnapshot | undefined,
): Promise<RefreshResultEntry> {
  if (!provider.isConfigured()) return finalize(asset.id, providerName, "provider_mapping_missing", { error: `${providerName} is not configured — see this feature's own completion report for the required env var.` });
  if (!asset.ticker) return finalize(asset.id, providerName, "provider_mapping_missing", { error: "This investment has no ticker on record." });

  const quote = await provider.getQuote(asset.ticker, asset.exchange);
  if (!quote.ok) return finalize(asset.id, providerName, classifyProviderError(quote.error, quote.retryable, quote.code), { error: quote.error, code: quote.code });

  if (isSameObservation(lastSnapshot, quote.data)) {
    const fxOnlyWrite = await maybeWriteFxOnlyRevision(ownerId, asset.id, quote.data, lastSnapshot);
    if (fxOnlyWrite) return finalizeFromWrite(asset.id, providerName, quote.data, fxOnlyWrite);

    const outcome: RefreshOutcome = isExchangeCurrentlyClosed(exchange) ? "market_closed_current" : "unchanged_current";
    return finalize(asset.id, providerName, outcome, { nativeUnitPrice: quote.data.nativeUnitPrice, nativeCurrency: quote.data.nativeCurrency, priceAt: quote.data.priceAt });
  }

  let fxRate = 1;
  if (quote.data.nativeCurrency !== "GBP") {
    try { fxRate = (await getFxRate(quote.data.nativeCurrency, new Date().toISOString().slice(0, 10))).rate; }
    catch (error) { return finalize(asset.id, providerName, "provider_unavailable", { error: error instanceof Error ? error.message : "Could not resolve an FX rate." }); }
  }
  let write: WriteAndClassifyResult;
  try { write = await writeSnapshotAndClassify(ownerId, asset.id, quote.data, fxRate, lastSnapshot); }
  catch (error) { return finalize(asset.id, providerName, "provider_unavailable", { error: `Price fetched but could not be stored: ${error instanceof Error ? error.message : "unknown error"}. Previous price retained.` }); }
  return finalizeFromWrite(asset.id, providerName, quote.data, write);
}

const EODHD_CATCH_UP_WINDOW_DAYS = 5;

/**
 * Prices a single EODHD-routed asset (VWRP/V3AB/VUAG once Phase B routes
 * them) — deliberately NOT `priceViaMarketProvider`, because EODHD needs
 * three things that provider doesn't: an explicit, verified per-asset
 * quote unit (never inferred — see eodhd.ts's own top comment), a skip
 * when the latest completed LSE session is already stored (real quota
 * conservation, not just a display nicety), and ONE combined ranged
 * request that serves both "current quote" and "trailing history
 * catch-up" together (never two separate EODHD requests for the same
 * asset in the same run — see this feature's own completion report for
 * the exact quota-usage requirement this satisfies).
 */
async function priceViaEodhd(ownerId: string, asset: AssetRow, lastSnapshot: LastSnapshot | undefined): Promise<RefreshResultEntry> {
  if (!eodhdProvider.isConfigured()) return finalize(asset.id, "eodhd", "provider_mapping_missing", { error: "LSE pricing is not configured — set EODHD_API_KEY." });
  if (!asset.ticker) return finalize(asset.id, "eodhd", "provider_mapping_missing", { error: "This investment has no ticker on record." });

  const rawUnit = asset.provider_quote_unit;
  if (rawUnit !== "GBP" && rawUnit !== "GBX" && rawUnit !== "USD" && rawUnit !== "EUR") {
    return finalize(asset.id, "eodhd", "provider_mapping_missing", { error: `This investment has no verified provider_quote_unit on record (got: ${rawUnit ?? "null"}) — refusing to guess a currency unit.` });
  }
  const unit: QuoteUnit = rawUnit;

  const exchange: ExchangeCode = "LSE";
  const todayIso = new Date().toISOString().slice(0, 10);
  const latestSessionDate = latestCompletedTradingDate(exchange);

  // Already current for the latest completed session — skip the EODHD
  // request entirely. This is the direct fix for "repeated button clicks
  // on the same day should reuse a current successfully stored result"
  // and "do not call EODHD when the latest completed session is already
  // stored" — zero network calls, not just a cheap one.
  if (lastSnapshot && lastSnapshot.priceAt.slice(0, 10) >= latestSessionDate) {
    const outcome: RefreshOutcome = isExchangeCurrentlyClosed(exchange) ? "market_closed_current" : "unchanged_current";
    return finalize(asset.id, "eodhd", outcome, { nativeUnitPrice: lastSnapshot.nativeUnitPrice, nativeCurrency: "GBP", priceAt: lastSnapshot.priceAt });
  }

  // REGRESSION (confirmed live): a brand-new EODHD asset with no prior
  // snapshot previously requested from=today&to=today — EODHD is an
  // end-of-day provider with no settled close for a still-in-progress (or
  // very recently closed) session, so that range legitimately came back
  // empty and the asset never priced at all. A full backfill from first
  // purchase is still a separate, one-time concern (history-backfill.ts's
  // backfillOneAsset) — but even the ordinary refresh needs SOME trailing
  // window to find the most recent settled close. The anchor is the
  // last snapshot's own date when one exists (so the window always
  // reaches back far enough to close any real gap since then), or simply
  // "now" for a brand-new asset with nothing stored yet.
  const anchor = lastSnapshot ? new Date(lastSnapshot.priceAt).getTime() : Date.now();
  const fromDate = new Date(anchor - EODHD_CATCH_UP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rangeResult = await eodhdProvider.getEodRange(asset.ticker, asset.exchange ?? "LSE", fromDate, todayIso);
  if (!rangeResult.ok) return finalize(asset.id, "eodhd", classifyProviderError(rangeResult.error, rangeResult.retryable), { error: rangeResult.error });

  const normalizedResult = eodhdProvider.normalizeEodRange(rangeResult.data, unit);
  if (!normalizedResult.ok) return finalize(asset.id, "eodhd", "invalid_response", { error: normalizedResult.error });

  const quoteResult = eodhdProvider.latestQuoteFromRange(asset.ticker, normalizedResult.data, unit);
  if (!quoteResult.ok) return finalize(asset.id, "eodhd", "no_data", { error: quoteResult.error });
  const quote = quoteResult.data;

  if (isSameObservation(lastSnapshot, quote)) {
    const outcome: RefreshOutcome = isExchangeCurrentlyClosed(exchange) ? "market_closed_current" : "unchanged_current";
    return finalize(asset.id, "eodhd", outcome, { nativeUnitPrice: quote.nativeUnitPrice, nativeCurrency: quote.nativeCurrency, priceAt: quote.priceAt });
  }

  // Defense-in-depth ONLY (see isImplausiblePriceMovement's own comment) —
  // the explicit provider_quote_unit above is the real, primary
  // protection. Nothing to compare against on this asset's very first
  // EODHD price (activation itself is gated on the separate read-only dry
  // run verifying that first price against an independent reference —
  // see the dry-run tool).
  if (lastSnapshot && isImplausiblePriceMovement(lastSnapshot.nativeUnitPrice, quote.nativeUnitPrice)) {
    const ratio = quote.nativeUnitPrice / lastSnapshot.nativeUnitPrice;
    return finalize(asset.id, "eodhd", "invalid_response", {
      error: `Proposed price £${quote.nativeUnitPrice.toFixed(2)} is ${ratio.toFixed(1)}x the last known good price £${lastSnapshot.nativeUnitPrice.toFixed(2)} — refusing to write a snapshot; previous price retained.`,
    });
  }

  // GBX/GBP normalization already produces a genuine GBP value (no FX
  // effect); USD/EUR route through the SAME FX-rate provider Twelve
  // Data's USD stocks already use, driven by quote.nativeCurrency.
  let fxRate = 1;
  if (quote.nativeCurrency !== "GBP") {
    try { fxRate = (await getFxRate(quote.nativeCurrency, todayIso)).rate; }
    catch (error) { return finalize(asset.id, "eodhd", "provider_unavailable", { error: error instanceof Error ? error.message : "Could not resolve an FX rate." }); }
  }

  let write: WriteAndClassifyResult;
  try {
    write = await writeSnapshotAndClassify(ownerId, asset.id, quote, fxRate, lastSnapshot, { rawProviderPrice: quote.rawPrice, providerQuoteUnit: unit, normalizationMultiplier: multiplierForUnit(unit) });
  } catch (error) {
    return finalize(asset.id, "eodhd", "provider_unavailable", { error: `Price fetched but could not be stored: ${error instanceof Error ? error.message : "unknown error"}. Previous price retained.` });
  }

  // Every OTHER point in this same range is the trailing-history catch-up
  // — folded into this one request instead of a second, separate EODHD
  // call (see this function's own top comment).
  const historyPoints = normalizedResult.data
    .filter(p => p.date !== quote.priceAt.slice(0, 10))
    .map(p => ({ date: p.date, nativeUnitPrice: p.nativeUnitPrice, fxRate, rawProviderPrice: p.rawPrice, providerQuoteUnit: unit, normalizationMultiplier: multiplierForUnit(unit) }));
  if (historyPoints.length > 0) await bulkWriteSnapshots(ownerId, asset.id, "eodhd", historyPoints).catch(() => {});

  return finalizeFromWrite(asset.id, "eodhd", quote, write);
}

/**
 * Fetches a PokePulse quote for `productId`, sharing one in-flight/completed
 * result across every holding that maps to the exact same external product
 * ID within a single refresh run — several portfolio rows can genuinely
 * represent the same real-world product (e.g. multiple purchases of the
 * same set), and each one issuing its own identical HTTP request would be
 * pure waste. Keyed by exact string equality only — never a fuzzy/partial
 * name match, so genuinely distinct variants never accidentally share a
 * result. `cache` is optional so a single-asset caller (Add Investment)
 * behaves exactly as before: always a fresh request, no cross-call reuse.
 */
async function fetchPokePulseQuote(productId: string, cache?: Map<string, ProviderResult<PriceQuote>>): Promise<ProviderResult<PriceQuote>> {
  if (!cache) return pokePulseProvider.getQuote(productId);
  const cached = cache.get(productId);
  if (cached) return cached;
  const result = await pokePulseProvider.getQuote(productId);
  cache.set(productId, result);
  return result;
}

/**
 * Prices exactly one asset and writes its snapshot on a genuine change —
 * the single worker both runRefresh's loop and the Add Investment route's
 * immediately-after-creation pricing call share, so a brand-new PokePulse
 * or stock holding is never left permanently "never priced" waiting for a
 * future manual/auto refresh. `lastSnapshot` is optional — the Add
 * Investment call site has none yet (a brand-new asset), which correctly
 * always classifies as 'updated' rather than 'unchanged_current'.
 */
export async function refreshOneAsset(
  ownerId: string, asset: AssetRow, lastSnapshot?: LastSnapshot, pokePulseCache?: Map<string, ProviderResult<PriceQuote>>,
): Promise<RefreshResultEntry> {
  if (asset.pricing_provider === "twelve_data") return priceViaMarketProvider(ownerId, asset, twelveDataProvider, "twelve_data", mapExchangeCode(asset), lastSnapshot);
  if (asset.pricing_provider === "eodhd") return priceViaEodhd(ownerId, asset, lastSnapshot);

  if (asset.pricing_provider === "pokepulse") {
    if (!asset.external_id) return finalize(asset.id, "pokepulse", "provider_mapping_missing", { error: "This investment has no PokePulse identity on record." });
    const quote = await fetchPokePulseQuote(asset.external_id, pokePulseCache);
    if (!quote.ok) return finalize(asset.id, "pokepulse", classifyProviderError(quote.error, quote.retryable, quote.code), { error: quote.error, code: quote.code });
    // PokePulse has no exchange-session concept (a secondary-market
    // valuation, not an exchange close) — an unchanged observation is
    // always 'unchanged_current', never 'market_closed_current'.
    if (isSameObservation(lastSnapshot, quote.data)) {
      return finalize(asset.id, "pokepulse", "unchanged_current", { nativeUnitPrice: quote.data.nativeUnitPrice, nativeCurrency: quote.data.nativeCurrency, priceAt: quote.data.priceAt });
    }
    let write: WriteAndClassifyResult;
    try { write = await writeSnapshotAndClassify(ownerId, asset.id, quote.data, 1, lastSnapshot); }
    catch (error) { return finalize(asset.id, "pokepulse", "provider_unavailable", { error: `Price fetched but could not be stored: ${error instanceof Error ? error.message : "unknown error"}. Previous price retained.` }); }
    return finalizeFromWrite(asset.id, "pokepulse", quote.data, write);
  }

  if (asset.pricing_provider === "manual") return finalize(asset.id, "manual", "manual");
  return finalize(asset.id, asset.pricing_provider, "provider_mapping_missing", { error: "No automated pricing provider is configured for this investment." });
}

const ALL_OUTCOMES: RefreshOutcome[] = [
  "updated", "unchanged_current", "market_closed_current", "manual", "fallback_purchase_price",
  "unsupported_by_plan", "symbol_not_found", "provider_mapping_missing", "rate_limited",
  "provider_unavailable", "invalid_response", "no_data", "skipped_inactive",
];

export async function runRefresh(
  ownerId: string, trigger: "manual" | "auto_page_open" | "cron", onProgress?: (progress: RefreshProgress) => void,
): Promise<RefreshRunResult | { skipped: "already_running" }> {
  // Close out any abandoned 'running' row BEFORE the concurrency check —
  // a stale row must become truthfully 'failed' in the audit trail, not
  // just silently ignored by the check below forever.
  await reclaimStaleRuns(ownerId);
  if (await findRecentRunningRun(ownerId)) return { skipped: "already_running" };

  const runResponse = await supabaseRequest("investment_refresh_runs", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ owner_id: ownerId, trigger, status: "running" }),
  });
  const [run] = await runResponse.json() as { id: string }[];

  // Everything from here on is wrapped so an unexpected exception — a
  // provider throwing synchronously, a bug, a broken downstream write —
  // still finalizes this run row as 'failed' with a sanitized reason
  // before propagating, instead of leaving it stuck at 'running' forever
  // (confirmed live: run 9a5e792e-dcf1-48c8-b3e1-5fa8a5f3045c on
  // 2026-08-17 never reached this PATCH because an earlier version of the
  // NDJSON route's write() threw once the client disconnected, and that
  // throw propagated straight out of the asset loop's onProgress call with
  // nothing here to catch it).
  try {
    return await runRefreshBody(ownerId, run.id, onProgress);
  } catch (error) {
    await supabaseRequest(`investment_refresh_runs?id=eq.${run.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        completed_at: new Date().toISOString(), status: "failed",
        failure_reason: `Refresh stopped unexpectedly: ${error instanceof Error ? error.message : "unknown error"}.`,
      }),
    }).catch(() => {});
    throw error;
  }
}

async function runRefreshBody(
  ownerId: string, runId: string, onProgress?: (progress: RefreshProgress) => void,
): Promise<RefreshRunResult> {
  // Cash (pricing_provider='none') is excluded — nothing to price. Manual
  // (LEGO) assets ARE included so the run's own counts genuinely reflect
  // every priceable holding (manual just always resolves to the 'manual'
  // outcome below, no network call, never overwritten).
  const assets = await supabaseRequestAll<AssetRow>(
    `investment_assets?owner_id=eq.${ownerId}&archived_at=is.null&category=neq.cash&select=id,category,ticker,exchange,native_currency,pricing_provider,external_id,provider_quote_unit`,
  );

  const lastSnapshotByAsset = await fetchLastSnapshots(ownerId, assets.map(a => a.id));

  const results: RefreshResultEntry[] = [];
  let lastTwelveDataCallAt = 0;
  // Shared across the whole run — several holdings can genuinely map to
  // the exact same PokePulse product (see fetchPokePulseQuote's own
  // comment); this ensures each unique product is only ever requested
  // once, however many holdings reuse its result.
  const pokePulseCache = new Map<string, ProviderResult<PriceQuote>>();

  async function paceTwelveData() {
    const waitMs = TWELVE_DATA_MIN_INTERVAL_MS - (Date.now() - lastTwelveDataCallAt);
    if (waitMs > 0) await sleep(waitMs);
    lastTwelveDataCallAt = Date.now();
  }

  // Sequential, never parallel — bounded pacing above only works against a
  // single in-flight request at a time, and a personal portfolio has few
  // enough holdings that sequential processing still finishes well within
  // this route's time budget.
  for (const asset of assets) {
    if (asset.pricing_provider === "twelve_data") await paceTwelveData();
    let result = await refreshOneAsset(ownerId, asset, lastSnapshotByAsset.get(asset.id), pokePulseCache);

    // Retry ONLY genuinely transient outcomes — never a plan restriction,
    // missing mapping, or "no data"/an explicit no-price response, which
    // retrying cannot fix and would only waste another rate-limited
    // minute (see refresh-classification.ts's isPokePulseCodeRetryable
    // for the equivalent PokePulse-specific rule). One retry, with
    // jitter, is enough for a real portfolio this size; a second
    // consecutive failure is reported as-is rather than blocking the rest
    // of the run.
    if (result.outcome === "rate_limited" || result.outcome === "provider_unavailable") {
      await sleep(3000 + Math.floor(Math.random() * 2000));
      if (asset.pricing_provider === "twelve_data") await paceTwelveData();
      // A cached PokePulse failure must be evicted before retrying —
      // otherwise this "retry" would just read back the same cached
      // failure instead of making a genuinely new request.
      if (asset.pricing_provider === "pokepulse" && asset.external_id) pokePulseCache.delete(asset.external_id);
      result = await refreshOneAsset(ownerId, asset, lastSnapshotByAsset.get(asset.id), pokePulseCache);
    }

    results.push(result);
    // Cheap trailing-window history catch-up rides along only with a
    // genuinely NEW price (outcome='updated') — an unchanged/failed/manual
    // result has nothing new to extend the history with, so skipping it
    // here is what "refresh and catch-up don't independently request the
    // same current quote unnecessarily" means in practice.
    if (result.outcome === "updated" && asset.pricing_provider !== "eodhd") {
      // REGRESSION (confirmed live): catch-up's own getHistory call hits
      // Twelve Data too — without pacing it against the SAME budget as the
      // quote calls above, a run could stay under the per-quote pacing yet
      // still exceed the real per-minute limit once every successful
      // quote's immediately-following history call is counted. Both call
      // kinds now share one clock. EODHD is deliberately excluded here —
      // priceViaEodhd already folds trailing-history catch-up into its own
      // single combined request (see its own comment); calling
      // catchUpOneAsset here too would be exactly the redundant second
      // EODHD request this feature's own quota requirement forbids.
      if (asset.pricing_provider === "twelve_data") await paceTwelveData();
      await catchUpOneAsset(ownerId, asset).catch(() => {});
    }

    // Reported only after this holding's result (including any retry and
    // its catch-up) is fully final — a holding never appears "done" a
    // moment before its own retry actually finishes.
    onProgress?.({ completed: results.length, total: assets.length });
  }

  const counts = Object.fromEntries(ALL_OUTCOMES.map(o => [o, 0])) as Record<RefreshOutcome, number>;
  for (const r of results) counts[r.outcome] += 1;

  const pokePulseHoldingCount = assets.filter(a => a.pricing_provider === "pokepulse").length;

  const anyGenuineFailure = results.some(r => isGenuineFailure(r.outcome));
  const anySuccess = results.some(r => !isGenuineFailure(r.outcome));
  const status: RefreshRunResult["status"] = anyGenuineFailure && anySuccess ? "partial_failure" : anyGenuineFailure && !anySuccess && results.length > 0 ? "failed" : "completed";

  await supabaseRequest(`investment_refresh_runs?id=eq.${runId}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ completed_at: new Date().toISOString(), status, results }),
  });

  return {
    runId, results, status, counts,
    pokePulseDedup: { holdings: pokePulseHoldingCount, uniqueProducts: pokePulseCache.size },
  };
}
