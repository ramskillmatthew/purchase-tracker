import { Decimal, d } from "./decimal";

/**
 * Market-growth vs. currency-effect decomposition for ONE lot's return —
 * the exact formulas specified for the portfolio hero card's "Market
 * growth" / "Currency effect" split:
 *
 *   initialGbpMarketCost = purchaseNativePrice × quantity × purchaseFxRate
 *   marketComponentGbp   = (currentNativePrice − purchaseNativePrice) × quantity × purchaseFxRate
 *   currencyComponentGbp = currentNativePrice × quantity × (currentFxRate − purchaseFxRate)
 *
 * Fees are deliberately NOT part of this decomposition — they're accounted
 * for separately in total return (see lib/investments/cost-basis.ts's own
 * gbpFees handling), never folded into either component here.
 *
 * fxRate is always GBP-per-native-unit (1 for a genuinely GBP-denominated
 * asset — Pokémon, LEGO, GBP cash). With purchaseFxRate === currentFxRate
 * === 1, currencyComponentGbp collapses to
 * currentNativePrice × quantity × (1 − 1) = 0 exactly — GBP assets get
 * zero currency effect as a direct consequence of the formula, never a
 * special-cased branch that could drift out of sync with it.
 */
export type Lot = {
  quantity: Decimal.Value;
  purchaseNativePrice: Decimal.Value;
  purchaseFxRate: Decimal.Value;
  currentNativePrice: Decimal.Value;
  currentFxRate: Decimal.Value;
};

export type Decomposition = {
  initialGbpMarketCost: Decimal;
  marketComponentGbp: Decimal;
  currencyComponentGbp: Decimal;
};

export function decomposeReturn(lot: Lot): Decomposition {
  const quantity = d(lot.quantity);
  const purchaseNativePrice = d(lot.purchaseNativePrice);
  const purchaseFxRate = d(lot.purchaseFxRate);
  const currentNativePrice = d(lot.currentNativePrice);
  const currentFxRate = d(lot.currentFxRate);

  return {
    initialGbpMarketCost: purchaseNativePrice.times(quantity).times(purchaseFxRate),
    marketComponentGbp: currentNativePrice.minus(purchaseNativePrice).times(quantity).times(purchaseFxRate),
    currencyComponentGbp: currentNativePrice.times(quantity).times(currentFxRate.minus(purchaseFxRate)),
  };
}

/** Sums market/currency components across every open lot in the portfolio — the hero card's two headline decomposition figures. */
export function aggregateDecompositions(lots: Decomposition[]): { marketGrowthGbp: Decimal; currencyEffectGbp: Decimal } {
  let marketGrowthGbp = d(0);
  let currencyEffectGbp = d(0);
  for (const lot of lots) {
    marketGrowthGbp = marketGrowthGbp.plus(lot.marketComponentGbp);
    currencyEffectGbp = currencyEffectGbp.plus(lot.currencyComponentGbp);
  }
  return { marketGrowthGbp, currencyEffectGbp };
}
