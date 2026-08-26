import { describe, expect, it } from "vitest";
import { holdingPriceStatusLabel, isHoldingPriceCurrent } from "@/lib/investments/holding-status";
import { computeSyncStatusFromResults, groupResultsByOutcome } from "@/lib/investments/sync-status";
import type { RefreshResultEntry } from "@/lib/investments/refresh";

const SUNDAY = new Date("2026-08-16T15:00:00Z");

describe("holdingPriceStatusLabel — the direct fix for '2d ago' on a genuine Friday close", () => {
  it("a Friday close viewed on Sunday reads as a current market close, not a stale relative time", () => {
    const label = holdingPriceStatusLabel({ pricingProvider: "twelve_data", dataQuality: "market", priceAt: "2026-08-14T20:00:00.000Z" }, SUNDAY);
    expect(label).toBe("Latest close · Fri 14 Aug");
    expect(label).not.toMatch(/ago/);
  });

  it("the same holding is reported as CURRENT (live dot), not stale", () => {
    expect(isHoldingPriceCurrent({ pricingProvider: "twelve_data", dataQuality: "market", priceAt: "2026-08-14T20:00:00.000Z" }, SUNDAY)).toBe(true);
  });

  it("a genuinely stale price (older than the latest completed session) still shows relative time, honestly", () => {
    const label = holdingPriceStatusLabel({ pricingProvider: "twelve_data", dataQuality: "market", priceAt: "2026-08-10T20:00:00.000Z" }, SUNDAY);
    expect(label).toMatch(/refresh to update/);
    expect(isHoldingPriceCurrent({ pricingProvider: "twelve_data", dataQuality: "market", priceAt: "2026-08-10T20:00:00.000Z" }, SUNDAY)).toBe(false);
  });

  it("an LSE (eodhd) fund's Friday close viewed on Sunday is ALSO current — the exact VWRP/V3AB/VUAG case", () => {
    const label = holdingPriceStatusLabel({ pricingProvider: "eodhd", dataQuality: "market", priceAt: "2026-08-14T00:00:00.000Z" }, SUNDAY);
    expect(label).toBe("Latest close · Fri 14 Aug");
  });

  it("purchase-price fallback is always labelled distinctly, regardless of date", () => {
    expect(holdingPriceStatusLabel({ pricingProvider: "eodhd", dataQuality: "purchase_price_fallback", priceAt: "2026-08-14T00:00:00.000Z" }, SUNDAY)).toBe("Purchase-price fallback");
    expect(isHoldingPriceCurrent({ pricingProvider: "eodhd", dataQuality: "purchase_price_fallback", priceAt: "2026-08-14T00:00:00.000Z" }, SUNDAY)).toBe(false);
  });

  it("a manual (LEGO) valuation is never described as stale or unavailable", () => {
    expect(holdingPriceStatusLabel({ pricingProvider: "manual", dataQuality: "manual", priceAt: "2026-01-01T00:00:00.000Z" }, SUNDAY)).toBe("Manual valuation · Thu 1 Jan");
  });

  it("PokePulse uses relative time (no exchange-session concept), prefixed 'Updated'", () => {
    // formatRelativeSync compares against the REAL current time (Date.now()),
    // not an injectable `now` — deliberately asserting the pattern here,
    // not an exact hour count, so this stays reliable regardless of how
    // long real wall-clock time elapses between authoring and running it.
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    expect(holdingPriceStatusLabel({ pricingProvider: "pokepulse", dataQuality: "market", priceAt: sixHoursAgo })).toMatch(/^Updated \d+h ago$/);
  });

  it("never priced yet is reported plainly, not as an error", () => {
    expect(holdingPriceStatusLabel({ pricingProvider: "twelve_data", dataQuality: null, priceAt: null }, SUNDAY)).toBe("Not yet priced");
  });
});

function entry(assetId: string, provider: string, outcome: RefreshResultEntry["outcome"], extra: Partial<RefreshResultEntry> = {}): RefreshResultEntry {
  return { assetId, provider, outcome, ok: outcome !== "rate_limited" && outcome !== "unsupported_by_plan" && outcome !== "no_data" && outcome !== "provider_mapping_missing" && outcome !== "symbol_not_found" && outcome !== "provider_unavailable" && outcome !== "invalid_response", ...extra };
}

describe("computeSyncStatusFromResults — the direct fix for the mismatched '10 unavailable' badge", () => {
  it("REGRESSION: a run where every automatic holding's latest observation is the same closed-market carryover reports the market date, not a failure count", () => {
    const results: RefreshResultEntry[] = [
      entry("a1", "twelve_data", "market_closed_current", { priceAt: "2026-08-14T20:00:00.000Z" }),
      entry("a2", "eodhd", "market_closed_current", { priceAt: "2026-08-14T00:00:00.000Z" }),
      entry("a3", "manual", "manual"),
    ];
    const status = computeSyncStatusFromResults(results);
    expect(status.tone).toBe("ok");
    expect(status.label).toBe("Prices checked just now · latest market close Fri 14 Aug");
  });

  it("only GENUINE failures count toward 'need attention' — manual, fallback, unchanged, and market-closed are never included", () => {
    const results: RefreshResultEntry[] = [
      entry("a1", "twelve_data", "rate_limited", { error: "rate limited" }),
      entry("a2", "eodhd", "market_closed_current"),
      entry("a3", "manual", "manual"),
      entry("a4", "pokepulse", "unchanged_current"),
      entry("a5", "eodhd", "fallback_purchase_price"),
    ];
    const status = computeSyncStatusFromResults(results);
    expect(status.tone).toBe("stale");
    expect(status.label).toBe("Prices checked just now · 1 needs attention");
  });

  it("a mixed run with no failures reports automatic/manual/fallback counts, never a misleading 'unavailable'", () => {
    const results: RefreshResultEntry[] = [
      entry("a1", "twelve_data", "updated"),
      entry("a2", "twelve_data", "updated"),
      entry("a3", "manual", "manual"),
      entry("a4", "eodhd", "fallback_purchase_price"),
    ];
    const status = computeSyncStatusFromResults(results);
    expect(status.label).toContain("2 automatic");
    expect(status.label).toContain("1 manual");
    expect(status.label).toContain("1 using purchase price");
  });

  it("every result being a genuine failure reports a plain 'Refresh failed'", () => {
    const results: RefreshResultEntry[] = [entry("a1", "twelve_data", "rate_limited"), entry("a2", "pokepulse", "no_data")];
    const status = computeSyncStatusFromResults(results);
    expect(status.tone).toBe("error");
    expect(status.label).toBe("Refresh failed");
  });
});

describe("groupResultsByOutcome — answers 'which N prices were unavailable and why'", () => {
  it("groups genuine failures separately by their real cause, never lumped into one bucket", () => {
    const results: RefreshResultEntry[] = [
      entry("a1", "twelve_data", "unsupported_by_plan", { error: "plan restriction" }),
      entry("a2", "twelve_data", "unsupported_by_plan", { error: "plan restriction" }),
      entry("a3", "pokepulse", "no_data", { error: "no market price" }),
      entry("a4", "twelve_data", "updated"),
    ];
    const groups = groupResultsByOutcome(results);
    const byOutcome = Object.fromEntries(groups.map(g => [g.outcome, g.entries.length]));
    expect(byOutcome.unsupported_by_plan).toBe(2);
    expect(byOutcome.no_data).toBe(1);
    expect(byOutcome.updated).toBeUndefined(); // 'updated' (the normal case) is never shown as a details group
  });

  it("marks rate_limited/no_data/provider_unavailable groups as auto-retrying, and plan/mapping/symbol groups as not", () => {
    const groups = groupResultsByOutcome([entry("a1", "twelve_data", "rate_limited"), entry("a2", "twelve_data", "unsupported_by_plan")]);
    expect(groups.find(g => g.outcome === "rate_limited")?.willRetry).toBe(true);
    expect(groups.find(g => g.outcome === "unsupported_by_plan")?.willRetry).toBe(false);
  });
});

describe("FX-only snapshot timestamp model (2026-08-17 forensic audit) — nativePriceObservedAt must never let an FX revaluation masquerade as a new exchange price", () => {
  // A real US stock closed Friday; over the weekend nothing traded, but a
  // genuine new FX rate was discovered Monday (see refresh.ts's
  // maybeWriteFxOnlyRevision) — the row's priceAt is Monday (the GBP
  // valuation instant), but nativePriceObservedAt correctly still points
  // at Friday (the true last exchange observation).
  const FRIDAY = "2026-08-14T20:00:00.000Z";
  const MONDAY_FX_REVISION = "2026-08-17T09:00:00.000Z";
  const MONDAY_NOON = new Date("2026-08-17T12:00:00Z");

  it("Friday's unchanged stock close, FX-revalued Monday, still reads 'Latest close · Fri 14 Aug' — never 'Latest close · Monday'", () => {
    const label = holdingPriceStatusLabel(
      { pricingProvider: "twelve_data", dataQuality: "market", priceAt: MONDAY_FX_REVISION, nativePriceObservedAt: FRIDAY },
      MONDAY_NOON,
    );
    expect(label).toBe("Latest close · Fri 14 Aug");
    expect(label).not.toMatch(/Mon/);
  });

  it("the holding is still reported as CURRENT — Friday's close is genuinely the latest completed session as of Monday, FX-revision or not", () => {
    expect(isHoldingPriceCurrent(
      { pricingProvider: "twelve_data", dataQuality: "market", priceAt: MONDAY_FX_REVISION, nativePriceObservedAt: FRIDAY },
      MONDAY_NOON,
    )).toBe(true);
  });

  it("weekend refresh (no trading day since): an FX-only revision recorded on a Saturday still correctly attributes Friday as the native observation", () => {
    const label = holdingPriceStatusLabel(
      { pricingProvider: "twelve_data", dataQuality: "market", priceAt: "2026-08-15T10:00:00.000Z", nativePriceObservedAt: FRIDAY },
      new Date("2026-08-15T12:00:00Z"),
    );
    expect(label).toBe("Latest close · Fri 14 Aug");
  });

  it("market-open refresh (a genuine new native price IS available): no nativePriceObservedAt divergence, priceAt alone already describes the real new close", () => {
    const label = holdingPriceStatusLabel(
      { pricingProvider: "twelve_data", dataQuality: "market", priceAt: MONDAY_FX_REVISION }, // no FX-only revision involved — an ordinary fresh snapshot
      MONDAY_NOON,
    );
    expect(label).toBe("Latest close · Mon 17 Aug");
  });

  it("market-closed refresh with a genuinely STALE native observation (older than the latest completed session) still shows honest relative time, using the real sync instant (priceAt), not the older native date", () => {
    const label = holdingPriceStatusLabel(
      { pricingProvider: "twelve_data", dataQuality: "market", priceAt: MONDAY_FX_REVISION, nativePriceObservedAt: "2026-08-10T20:00:00.000Z" },
      MONDAY_NOON,
    );
    expect(label).toMatch(/ago/);
    expect(label).toContain("refresh to update");
  });

  it("a holding with NO nativePriceObservedAt (every ordinary, non-FX-only snapshot) is completely unaffected — priceAt alone still drives the label exactly as before", () => {
    const label = holdingPriceStatusLabel({ pricingProvider: "twelve_data", dataQuality: "market", priceAt: FRIDAY }, new Date("2026-08-16T15:00:00Z"));
    expect(label).toBe("Latest close · Fri 14 Aug");
  });

  it("EODHD (LSE) holdings get the identical FX-timestamp treatment as twelve_data (US) — the fix is provider-generic, not twelve_data-specific", () => {
    const label = holdingPriceStatusLabel(
      { pricingProvider: "eodhd", dataQuality: "market", priceAt: MONDAY_FX_REVISION, nativePriceObservedAt: FRIDAY },
      MONDAY_NOON,
    );
    expect(label).toBe("Latest close · Fri 14 Aug");
  });

  it("PokePulse (no exchange-session concept) never even reads nativePriceObservedAt — it always shows genuine relative sync time regardless", () => {
    const label = holdingPriceStatusLabel(
      { pricingProvider: "pokepulse", dataQuality: "market", priceAt: MONDAY_FX_REVISION, nativePriceObservedAt: FRIDAY },
      MONDAY_NOON,
    );
    expect(label).toMatch(/^Updated/);
  });
});
