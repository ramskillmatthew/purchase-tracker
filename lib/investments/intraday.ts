import type { IntradayPricePoint } from "./providers/types";

/**
 * Genuine 1D reconstruction — pure and DB-free, mirroring reconstruction.ts's
 * own shape. Two kinds of asset input, matched to what's actually
 * achievable per provider (confirmed live before this was written — Twelve
 * Data's configured plan genuinely returns real, distinct 15-minute bars
 * for US-listed stocks; PokePulse/manual/plan-restricted holdings have no
 * intraday concept at all):
 *
 *   - "intraday": real provider bars, used as-is (most recent bar at or
 *     before each timestamp — never interpolated, never fabricated).
 *   - "constant": held flat at the latest known value for the whole
 *     session (a real number — the most recent genuine snapshot — just not
 *     one that updates intraday). This is exactly "Option 1" from this
 *     feature's own spec: mixed-resolution rather than an all-or-nothing
 *     1D chart, and never disguised as a live intraday tick.
 *
 * `quantity` is TODAY's held quantity, constant across the whole session —
 * this feature does not attempt intraday transaction timing (a same-day
 * buy/sell is already rare, and this app's real data has never recorded
 * same-day intraday-timed transactions at all).
 */
export type IntradayAssetInput =
  | { assetId: string; quantity: number; fxRateToday: number; kind: "intraday"; points: IntradayPricePoint[] }
  | { assetId: string; quantity: number; fxRateToday: number; kind: "constant"; nativeUnitPrice: number | null };

export type IntradayPortfolioPoint = { timestamp: string; totalGbpValue: number; dataQuality: "market" | "mixed" | "purchase_price_fallback" };

/**
 * One point per DISTINCT real intraday timestamp across every intraday-
 * capable asset (never a fabricated fixed interval) — if there are no
 * intraday-capable assets at all, this returns an empty series and the
 * caller reports 1D as genuinely unavailable rather than rendering an
 * all-constant, misleadingly-flat "intraday" line.
 *
 * `dataQuality` reuses the existing market/mixed/purchase_price_fallback
 * vocabulary from reconstruction.ts (rather than inventing a fourth
 * intraday-specific value) — a timestamp where every contributing asset is
 * a genuine intraday tick is "market"; one where a constant-carried-
 * forward asset also contributes is "mixed"/"purchase_price_fallback",
 * exactly mirroring what those labels already mean elsewhere in this
 * feature: "not every component of this number just moved".
 */
export function reconstructIntradaySeries(assets: IntradayAssetInput[], cashGbp: number): IntradayPortfolioPoint[] {
  const timestamps = new Set<string>();
  for (const asset of assets) if (asset.kind === "intraday") for (const p of asset.points) timestamps.add(p.timestamp);
  if (timestamps.size === 0) return [];

  const sorted = [...timestamps].sort();

  return sorted.map(timestamp => {
    let total = cashGbp;
    let anyFallback = false;
    let anyReal = false;

    for (const asset of assets) {
      if (asset.quantity <= 0) continue;

      if (asset.kind === "intraday") {
        let best: IntradayPricePoint | null = null;
        for (const point of asset.points) {
          if (point.timestamp > timestamp) continue;
          if (!best || point.timestamp > best.timestamp) best = point;
        }
        if (!best) continue;
        total += asset.quantity * best.nativeUnitPrice * asset.fxRateToday;
        anyReal = true;
      } else {
        if (asset.nativeUnitPrice === null) continue;
        total += asset.quantity * asset.nativeUnitPrice * asset.fxRateToday;
        anyFallback = true;
      }
    }

    const dataQuality: IntradayPortfolioPoint["dataQuality"] = anyFallback && anyReal ? "mixed" : anyFallback ? "purchase_price_fallback" : "market";
    return { timestamp, totalGbpValue: Math.round(total * 100) / 100, dataQuality };
  });
}
