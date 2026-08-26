import { d } from "./decimal";
import { reduceLedger, type LedgerTransaction } from "./cost-basis";

/**
 * Historical portfolio-value reconstruction — pure and DB-free (callers
 * fetch every asset's transactions + real price history first; this only
 * combines them). Never invents a market movement: before an asset's
 * first genuine market data point, its value on any earlier date uses its
 * OWN purchase price (native price + FX rate from its first buy),
 * explicitly flagged `purchase_price_fallback` — a chart consumer can
 * always tell which portion of the line is real market history and which
 * is the fallback.
 *
 * Efficient by construction: value is piecewise-constant between events
 * (a transaction changing quantity, or a new price point), so this only
 * ever computes one point per DISTINCT date that actually matters across
 * every asset — never one point per calendar day.
 */

export type AssetHistoryPoint = { date: string; nativeUnitPrice: number; fxRate: number; dataQuality: "market" | "manual" | "purchase_price_fallback" };

export type AssetHistoryInput = {
  assetId: string;
  transactions: Array<LedgerTransaction & { nativeUnitPrice?: number | null; fxRateAtTrade?: number | null }>;
  /** Real, genuine market/manual price snapshots for this asset — never fabricated. */
  priceHistory: AssetHistoryPoint[];
  /** The asset's own purchase price/FX rate — used ONLY for a date earlier than priceHistory's first real point. Null if the asset has never been bought (nothing to fall back to). */
  fallbackNativePrice: number | null;
  fallbackFxRate: number | null;
};

export type PortfolioValuePoint = { date: string; totalGbpValue: number; dataQuality: "market" | "mixed" | "purchase_price_fallback" };

function quantityAsOf(transactions: LedgerTransaction[], date: string): ReturnType<typeof d> {
  const upToDate = transactions.filter(tx => tx.tradeAt.slice(0, 10) <= date);
  return reduceLedger(upToDate).state.quantity;
}

function priceAsOf(input: AssetHistoryInput, date: string): { nativePrice: number; fxRate: number; quality: AssetHistoryPoint["dataQuality"] } | null {
  let best: AssetHistoryPoint | null = null;
  for (const point of input.priceHistory) {
    if (point.date > date) continue;
    if (!best || point.date > best.date) best = point;
  }
  if (best) return { nativePrice: best.nativeUnitPrice, fxRate: best.fxRate, quality: best.dataQuality };
  if (input.fallbackNativePrice !== null && input.fallbackFxRate !== null) {
    return { nativePrice: input.fallbackNativePrice, fxRate: input.fallbackFxRate, quality: "purchase_price_fallback" };
  }
  return null;
}

export function reconstructPortfolioValue(assets: AssetHistoryInput[]): PortfolioValuePoint[] {
  const allDates = new Set<string>();
  for (const asset of assets) {
    for (const tx of asset.transactions) allDates.add(tx.tradeAt.slice(0, 10));
    for (const point of asset.priceHistory) allDates.add(point.date);
  }
  if (allDates.size === 0) return [];
  const sortedDates = [...allDates].sort();

  return sortedDates.map(date => {
    let total = d(0);
    let anyFallback = false;
    let anyReal = false;
    for (const asset of assets) {
      const qty = quantityAsOf(asset.transactions, date);
      if (qty.lte(0)) continue;
      const price = priceAsOf(asset, date);
      if (!price) continue;
      total = total.plus(qty.times(price.nativePrice).times(price.fxRate));
      if (price.quality === "purchase_price_fallback") anyFallback = true; else anyReal = true;
    }
    const dataQuality: PortfolioValuePoint["dataQuality"] = anyFallback && anyReal ? "mixed" : anyFallback ? "purchase_price_fallback" : "market";
    return { date, totalGbpValue: total.toDecimalPlaces(2).toNumber(), dataQuality };
  });
}
