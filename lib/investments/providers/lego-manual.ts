import type { PriceQuote, ProviderResult } from "./types";

/**
 * LEGO pricing is manual-only in this version — there is no automated
 * LEGO price source. This is the one function that turns a user-entered
 * GBP price into the same PriceQuote shape every other provider produces,
 * so the price-snapshot writer (lib/investments/providers/write-snapshot.ts)
 * never needs a LEGO-specific code path.
 *
 * Automation must never call this on the asset's behalf — the refresh
 * orchestrator (lib/investments/refresh.ts) simply never includes LEGO
 * assets in its automated pass at all, so "a manual valuation is never
 * overwritten by automated refresh" holds structurally, not by a runtime
 * guard that could be bypassed by a future refactor.
 */
export function buildManualLegoQuote(gbpPrice: number, priceAt: string = new Date().toISOString(), sourceUrl?: string | null): PriceQuote {
  if (!Number.isFinite(gbpPrice) || gbpPrice <= 0) throw new Error("Manual LEGO price must be a positive number.");
  return { nativeUnitPrice: gbpPrice, nativeCurrency: "GBP", priceAt, provider: "manual", sourceUrl: sourceUrl ?? null };
}

/**
 * Extensible interface for a FUTURE automated LEGO pricing source (eBay
 * sold-data, BrickLink) — deliberately never implemented or wired up as an
 * active source in this version (per explicit product decision). Exists
 * only so a later feature can be added behind this exact shape without
 * touching the manual-entry flow, the refresh orchestrator, or any
 * calculation code.
 */
export interface LegoPricingProvider {
  readonly name: string;
  isConfigured(): boolean;
  getQuote(setNumber: string): Promise<ProviderResult<PriceQuote>>;
}
