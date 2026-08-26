import { Decimal, d } from "./decimal";
import { reduceLedger, type LedgerResult, type LedgerTransaction } from "./cost-basis";
import { decomposeReturn, type Decomposition } from "./currency-decomposition";

/**
 * Ties cost-basis.ts (GBP-only, verified against the spec's own worked
 * example — never modified here) and currency-decomposition.ts (a
 * single-lot formula) together for ONE asset's full current-holding
 * computation, including the market-growth/currency-effect split.
 *
 * The decomposition formula as specified operates on a single lot
 * (purchaseNativePrice/purchaseFxRate). A weighted-average-cost holding
 * built from several buys at different native prices and FX rates has no
 * single "the purchase price" any more, so this computes a WEIGHTED
 * AVERAGE native purchase price and a WEIGHTED AVERAGE purchase FX rate
 * (both weighted by native-currency spend, using the exact same
 * proportional-removal-on-sell mechanics cost-basis.ts already uses for
 * GBP) and feeds those into decomposeReturn as one synthetic lot
 * representing the entire current position. This preserves the formula's
 * own internal consistency check exactly: initialGbpMarketCost always
 * equals the real GBP cost basis for a single-buy holding, and for a
 * multi-buy holding it equals the weighted-average reconstruction of it.
 */

export type AssetTransactionInput = LedgerTransaction & {
  /** Native-currency unit price at trade time — only meaningful for buy/sell. */
  nativeUnitPrice?: number | null;
  /** GBP-per-native-unit rate at trade time — 1 (or omitted) for a GBP-denominated asset. */
  fxRateAtTrade?: number | null;
};

/**
 * CONFIRMED LIVE (2026-08-17): every recorded buy transaction in this
 * database has `fx_rate_at_trade = null` — including non-GBP (USD) ones —
 * so any fallback path that trusted that field outright either silently
 * excluded a non-GBP holding from historical reconstruction entirely (a
 * real, confirmed gap: a duplicate NVDA asset row held real quantity for 9
 * months with zero price snapshots and zero fallback contribution to the
 * chart) or silently assumed a 1:1 rate for a non-GBP holding (the other
 * confirmed instance, in the holding-detail route) — exactly the
 * "no silent FX rate of 1" failure this derivation exists to prevent, just
 * approached from two different wrong directions in two different files.
 *
 * The effective rate is always recoverable from data that IS always
 * populated: `gbp_total` and `native_unit_price × quantity` are both real,
 * recorded amounts for every transaction — dividing them back out gives
 * the exact rate that was actually used, never an invented one. Returns
 * null only when the inputs genuinely can't support a rate (zero/invalid
 * native cost) — callers must still decide what "no fallback available"
 * means for them, this never substitutes a guess.
 */
export function deriveEffectiveFxRate(nativeUnitPrice: number | null, quantity: Decimal.Value, gbpTotal: Decimal.Value): number | null {
  const qty = d(quantity);
  const gbp = d(gbpTotal);
  if (nativeUnitPrice === null || !Number.isFinite(nativeUnitPrice) || nativeUnitPrice <= 0 || qty.lte(0) || !gbp.isFinite()) return null;
  const nativeCost = d(nativeUnitPrice).times(qty);
  if (nativeCost.lte(0)) return null;
  const rate = gbp.div(nativeCost);
  return rate.gt(0) ? rate.toNumber() : null;
}

/**
 * The fallback native price/FX pair used for any date before an asset's
 * first genuine price snapshot — always derived from the SAME first-buy
 * transaction, always using the real recorded amounts, GBP-native assets
 * pinned to exactly 1 (never floating-point noise from the derivation).
 * Returns nulls when there's no buy to fall back to at all (nothing to
 * reconstruct before, correctly).
 */
export function deriveFallbackPrice(
  firstBuy: { nativeUnitPrice?: number | null; quantity: Decimal.Value; gbpTotal?: Decimal.Value | null; fxRateAtTrade?: number | null } | undefined,
  nativeCurrency: string,
): { fallbackNativePrice: number | null; fallbackFxRate: number | null } {
  if (!firstBuy) return { fallbackNativePrice: null, fallbackFxRate: null };
  const fallbackNativePrice = firstBuy.nativeUnitPrice ?? null;
  if (nativeCurrency === "GBP") return { fallbackNativePrice, fallbackFxRate: 1 };
  const derived = deriveEffectiveFxRate(fallbackNativePrice, firstBuy.quantity, firstBuy.gbpTotal ?? 0);
  return { fallbackNativePrice, fallbackFxRate: firstBuy.fxRateAtTrade ?? derived };
}

export type HoldingComputation = {
  quantity: Decimal;
  costBasisGbp: Decimal;
  currentGbpValue: Decimal;
  unrealizedGbp: Decimal;
  unrealizedPercent: Decimal | null;
  decomposition: Decomposition | null;
  realizedSales: LedgerResult["realizedSales"];
};

export function computeHolding(
  transactions: AssetTransactionInput[], currentNativePrice: number, currentFxRate: number,
): HoldingComputation {
  const { state, realizedSales } = reduceLedger(transactions);

  const sorted = [...transactions].sort((a, b) => a.tradeAt.localeCompare(b.tradeAt) || a.id.localeCompare(b.id));
  let nativeQty = d(0);
  let nativeCostBasis = d(0);
  let gbpCostBasisForFx = d(0);
  for (const tx of sorted) {
    if (tx.type === "buy" && tx.nativeUnitPrice != null) {
      const qty = d(tx.quantity);
      nativeQty = nativeQty.plus(qty);
      nativeCostBasis = nativeCostBasis.plus(d(tx.nativeUnitPrice).times(qty));
      gbpCostBasisForFx = gbpCostBasisForFx.plus(d(tx.gbpTotal ?? 0));
    } else if (tx.type === "sell" && nativeQty.gt(0)) {
      const qty = d(tx.quantity);
      const avgNative = nativeCostBasis.div(nativeQty);
      const avgGbpForFx = gbpCostBasisForFx.div(nativeQty);
      nativeCostBasis = nativeCostBasis.minus(avgNative.times(qty));
      gbpCostBasisForFx = gbpCostBasisForFx.minus(avgGbpForFx.times(qty));
      nativeQty = nativeQty.minus(qty);
    } else if (tx.type === "adjustment") {
      // Mirrors applyAdjustment: sets the absolute quantity; native cost
      // basis and its parallel GBP-for-Fx tracking are left unchanged
      // (the total spend didn't change, only the unit count).
      nativeQty = d(tx.quantity);
    }
  }

  const currentGbpValue = d(currentNativePrice).times(state.quantity).times(currentFxRate);
  const unrealizedGbp = currentGbpValue.minus(state.costBasisGbp);
  const unrealizedPercent = state.costBasisGbp.isZero() ? null : unrealizedGbp.div(state.costBasisGbp).times(100);

  let decomposition: Decomposition | null = null;
  if (state.quantity.gt(0) && nativeQty.gt(0)) {
    const avgNativePrice = nativeCostBasis.div(nativeQty);
    const avgFxRate = nativeCostBasis.isZero() ? d(1) : gbpCostBasisForFx.div(nativeCostBasis);
    decomposition = decomposeReturn({
      quantity: state.quantity, purchaseNativePrice: avgNativePrice, purchaseFxRate: avgFxRate,
      currentNativePrice, currentFxRate,
    });
  }

  return { quantity: state.quantity, costBasisGbp: state.costBasisGbp, currentGbpValue, unrealizedGbp, unrealizedPercent, decomposition, realizedSales };
}
