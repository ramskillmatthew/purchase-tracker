import { Decimal, d, roundGbp } from "./decimal";
import { computeHolding, type AssetTransactionInput } from "./holding-aggregate";

/**
 * The ONE portfolio aggregation function the dashboard's API route calls —
 * every total, allocation slice, and "best performer" figure the UI shows
 * is computed exactly once, here, from real per-asset holdings (via
 * holding-aggregate.ts). No component recomputes a total independently.
 */

export type AssetForPortfolio = {
  id: string;
  category: "stock" | "pokemon" | "lego" | "cash";
  displayName: string;
  ticker: string | null;
  transactions: AssetTransactionInput[];
  /** Latest known native price — null if this asset has never been priced at all. */
  currentNativePrice: number | null;
  currentFxRate: number;
  /**
   * REGRESSION FIX (confirmed live, same day as introduced): the
   * archived-asset-inclusion fix for historical reconstruction
   * (app/api/investments/portfolio/route.ts no longer filters assetRows by
   * archived_at) means an archived asset whose transaction has NOT been
   * reversed — e.g. an unresolved erroneous duplicate still carrying a
   * real, non-zero quantity, exactly the live NVDA/APP case — would
   * otherwise pass the quantity>0 check below and double-count itself into
   * CURRENT totals/holdings a second time. Zero-quantity exclusion alone
   * only ever protected a genuinely SOLD position; it was never a
   * safeguard against an unresolved duplicate. `archived` is a second,
   * independent gate: current totals/holdings require BOTH a real
   * quantity AND a non-archived asset — archiving is exactly what "hide
   * from current" means, unconditionally, regardless of quantity.
   * Historical reconstruction (reconstruction.ts) is unaffected — it never
   * consults this flag at all, only per-date quantity, which is correct.
   */
  archived: boolean;
};

export type HoldingViewModel = {
  assetId: string; category: string; displayName: string; ticker: string | null;
  quantity: string; costBasisGbp: number; currentGbpValue: number; unrealizedGbp: number; unrealizedPercent: number | null;
  allocationPercent: number;
};

export type PortfolioTotals = {
  totalGbpValue: number;
  totalInvestedGbp: number;
  allTimeReturnGbp: number;
  allTimeReturnPercent: number | null;
  marketGrowthGbp: number;
  currencyEffectGbp: number;
  cashGbp: number;
  bestPerformer: { assetId: string; displayName: string; ticker: string | null; percent: number } | null;
  allocation: Array<{ category: string; gbpValue: number; percent: number }>;
  holdings: HoldingViewModel[];
};

/**
 * `todaysChangeGbp`/`todaysChangePercent` are deliberately NOT computed
 * here — they come from the PER-ASSET computeTodaysChange below (built
 * from each asset's own real price history), not from this function's
 * totals, since a same-day new purchase must inflate totalGbpValue (it's
 * genuinely part of the portfolio now) without inflating Today's change
 * (it isn't a market move). See computeTodaysChange's own comment.
 */
export function computePortfolio(assets: AssetForPortfolio[]): PortfolioTotals {
  const holdings: HoldingViewModel[] = [];
  let totalGbpValue = d(0);
  let totalInvestedGbp = d(0);
  let marketGrowthGbp = d(0);
  let currencyEffectGbp = d(0);
  let cashGbp = d(0);
  const categoryTotals = new Map<string, Decimal>();
  let bestPerformer: PortfolioTotals["bestPerformer"] = null;
  let bestPercent = -Infinity;

  for (const asset of assets) {
    if (asset.archived) continue; // hidden from current totals/holdings unconditionally — see AssetForPortfolio's own comment on why quantity alone is not a safe enough gate
    const nativePrice = asset.currentNativePrice ?? 0;
    const holding = computeHolding(asset.transactions, nativePrice, asset.currentFxRate);
    // Sold-out or never-bought — never a current holding, never counted in
    // any total (this is what makes "total invested excludes sold units"
    // true: costBasisGbp for a zero-quantity position is always exactly
    // zero, per cost-basis.ts's own full-sale rule).
    if (holding.quantity.lte(0)) continue;

    totalGbpValue = totalGbpValue.plus(holding.currentGbpValue);
    totalInvestedGbp = totalInvestedGbp.plus(holding.costBasisGbp);
    if (holding.decomposition) {
      marketGrowthGbp = marketGrowthGbp.plus(holding.decomposition.marketComponentGbp);
      currencyEffectGbp = currencyEffectGbp.plus(holding.decomposition.currencyComponentGbp);
    }
    if (asset.category === "cash") cashGbp = cashGbp.plus(holding.currentGbpValue);

    categoryTotals.set(asset.category, (categoryTotals.get(asset.category) ?? d(0)).plus(holding.currentGbpValue));

    const percent = holding.unrealizedPercent ? holding.unrealizedPercent.toNumber() : null;
    if (percent !== null && percent > bestPercent && asset.category !== "cash") {
      bestPercent = percent;
      bestPerformer = { assetId: asset.id, displayName: asset.displayName, ticker: asset.ticker, percent: Math.round(percent * 10) / 10 };
    }

    holdings.push({
      assetId: asset.id, category: asset.category, displayName: asset.displayName, ticker: asset.ticker,
      quantity: holding.quantity.toString(), costBasisGbp: roundGbp(holding.costBasisGbp).toNumber(),
      currentGbpValue: roundGbp(holding.currentGbpValue).toNumber(), unrealizedGbp: roundGbp(holding.unrealizedGbp).toNumber(),
      unrealizedPercent: percent !== null ? Math.round(percent * 10) / 10 : null, allocationPercent: 0,
    });
  }

  for (const holding of holdings) {
    holding.allocationPercent = totalGbpValue.gt(0)
      ? new Decimal(holding.currentGbpValue).div(totalGbpValue).times(100).toDecimalPlaces(1).toNumber() : 0;
  }

  const allocation = [...categoryTotals.entries()].map(([category, gbpValue]) => ({
    category, gbpValue: roundGbp(gbpValue).toNumber(),
    percent: totalGbpValue.gt(0) ? gbpValue.div(totalGbpValue).times(100).toDecimalPlaces(1).toNumber() : 0,
  }));

  const allTimeReturnGbp = totalGbpValue.minus(totalInvestedGbp);
  const allTimeReturnPercent = totalInvestedGbp.gt(0) ? allTimeReturnGbp.div(totalInvestedGbp).times(100).toNumber() : null;

  return {
    totalGbpValue: roundGbp(totalGbpValue).toNumber(), totalInvestedGbp: roundGbp(totalInvestedGbp).toNumber(),
    allTimeReturnGbp: roundGbp(allTimeReturnGbp).toNumber(),
    allTimeReturnPercent: allTimeReturnPercent !== null ? Math.round(allTimeReturnPercent * 10) / 10 : null,
    marketGrowthGbp: roundGbp(marketGrowthGbp).toNumber(), currencyEffectGbp: roundGbp(currencyEffectGbp).toNumber(),
    cashGbp: roundGbp(cashGbp).toNumber(), bestPerformer, allocation, holdings,
  };
}

export type TodaysChangeAssetInput = {
  /** Today's held quantity — 0/sold-out assets are skipped. */
  currentQuantity: Decimal | number | string;
  /** The most recent GENUINE (non-fallback) market/manual price point, or null if this asset has never had one. */
  latestReal: { nativePrice: number; fxRate: number } | null;
  /** The genuine price point immediately before `latestReal`, or null if `latestReal` is this asset's first-ever real price. */
  previousReal: { nativePrice: number; fxRate: number } | null;
};

/**
 * Today's change — computed PER ASSET, not by diffing whole-portfolio
 * totals across two dates. That whole-portfolio-diff approach was a real,
 * confirmed bug: adding several new holdings on the same day made their
 * entire value look like a single day's market gain (a portfolio that
 * genuinely went from ~£5,200 to ~£16,300 because of new purchases showed
 * as "+41% today"). Per asset:
 *
 *   change = currentQuantity × (latestReal.price − previousReal.price)
 *
 * using TODAY's quantity on both sides of the diff, so a same-day buy/sell
 * cannot distort the figure — it isolates pure price movement. An asset is
 * excluded entirely (never treated as a £0 contributor, per the reference
 * requirement) whenever it lacks two genuine price points to compare:
 * a brand-new asset, an asset priced for the first time today, or an
 * asset still on purchase-price fallback. Cash is excluded upstream by
 * the caller (cash has no price history at all).
 */
export function computeTodaysChange(assets: TodaysChangeAssetInput[]): { todaysChangeGbp: number; todaysChangePercent: number | null } {
  let changeGbp = d(0);
  let baseGbp = d(0);
  for (const asset of assets) {
    const qty = d(asset.currentQuantity);
    if (qty.lte(0)) continue;
    if (!asset.latestReal || !asset.previousReal) continue;
    const currentValue = qty.times(asset.latestReal.nativePrice).times(asset.latestReal.fxRate);
    const previousValue = qty.times(asset.previousReal.nativePrice).times(asset.previousReal.fxRate);
    changeGbp = changeGbp.plus(currentValue.minus(previousValue));
    baseGbp = baseGbp.plus(previousValue);
  }
  const percent = baseGbp.gt(0) ? changeGbp.div(baseGbp).times(100).toNumber() : null;
  return { todaysChangeGbp: roundGbp(changeGbp).toNumber(), todaysChangePercent: percent !== null ? Math.round(percent * 10) / 10 : null };
}
