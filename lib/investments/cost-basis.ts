import { Decimal, d } from "./decimal";

/**
 * Weighted-average cost basis engine — the one place a holding's running
 * quantity/cost-basis state is ever mutated. Pure and DB-free: callers
 * (the portfolio view-model, the holding-detail route) pass in the
 * transaction ledger and get back the current state plus every realised
 * sale's own result — nothing here reads or writes Supabase.
 *
 * Example (from the product spec): buy 10 @ £50 (=£500), buy 5 @ £70
 * (=£350) -> quantity 15, cost basis £850, average cost £56.6666...
 * Selling 5 removes 5 × current average cost (£283.3333...) -> remaining
 * quantity 10, remaining cost basis ~£566.67, average cost stays ~£56.67.
 * Full precision is kept internally (Decimal, 40 significant digits) and
 * only rounded to 2dp at display time via roundGbp/toGbpNumber.
 */

export type CostBasisState = { quantity: Decimal; costBasisGbp: Decimal };

export const ZERO_COST_BASIS: CostBasisState = { quantity: d(0), costBasisGbp: d(0) };

export class OversellError extends Error {
  name = "OversellError";
  constructor(requested: Decimal, held: Decimal) {
    super(`Cannot sell ${requested.toString()} units — only ${held.toString()} are currently held.`);
  }
}

/** A buy always increases quantity and cost basis by exactly what was paid — never re-derives cost from a "current price" that has nothing to do with what this specific lot actually cost. */
export function applyBuy(state: CostBasisState, quantity: Decimal.Value, gbpCost: Decimal.Value): CostBasisState {
  const qty = d(quantity);
  if (qty.lte(0)) throw new Error("Buy quantity must be greater than zero.");
  return { quantity: state.quantity.plus(qty), costBasisGbp: state.costBasisGbp.plus(d(gbpCost)) };
}

export type SellResult = {
  state: CostBasisState;
  costBasisRemoved: Decimal;
  averageCostAtSale: Decimal;
};

/**
 * Removes `quantity` units at the CURRENT weighted-average cost (recomputed
 * fresh from whatever state is passed in — never a stale/cached average).
 * Throws OversellError rather than silently going negative — a position
 * can only go negative via an explicit, supported adjustment transaction
 * (applyAdjustment), never as a side effect of a sell.
 *
 * On a full sale (remaining quantity hits exactly zero), remaining cost
 * basis is forced to exactly zero rather than trusting a subtraction that
 * could otherwise leave a vanishingly small non-zero remainder.
 */
export function applySell(state: CostBasisState, quantity: Decimal.Value): SellResult {
  const qty = d(quantity);
  if (qty.lte(0)) throw new Error("Sell quantity must be greater than zero.");
  if (qty.gt(state.quantity)) throw new OversellError(qty, state.quantity);

  const averageCostAtSale = state.quantity.isZero() ? d(0) : state.costBasisGbp.div(state.quantity);
  const costBasisRemoved = averageCostAtSale.times(qty);
  const remainingQuantity = state.quantity.minus(qty);
  const remainingCostBasis = remainingQuantity.isZero() ? d(0) : state.costBasisGbp.minus(costBasisRemoved);

  return { state: { quantity: remainingQuantity, costBasisGbp: remainingCostBasis }, costBasisRemoved, averageCostAtSale };
}

/**
 * A stock-split-style correction: sets the ABSOLUTE post-adjustment
 * quantity directly (the transaction's own recorded `quantity`, matching
 * how the rest of this schema already represents every transaction type —
 * never a separate "split ratio" field). Total cost basis is preserved
 * unchanged through the adjustment; only the average cost per unit moves,
 * exactly as a real stock split does (more units, same total investment).
 */
export function applyAdjustment(state: CostBasisState, newQuantity: Decimal.Value): CostBasisState {
  const qty = d(newQuantity);
  if (qty.lt(0)) throw new Error("Adjusted quantity cannot be negative.");
  return { quantity: qty, costBasisGbp: qty.isZero() ? d(0) : state.costBasisGbp };
}

export type RealizedSale = {
  quantity: Decimal;
  proceedsGbp: Decimal;
  costBasisRemoved: Decimal;
  feesGbp: Decimal;
  realizedPnlGbp: Decimal;
};

/** Sells `quantity` and computes the realised result in one step — proceeds and fees are both real, supplied GBP amounts (never derived from a "current price" the caller didn't actually receive). */
export function computeRealizedSale(
  state: CostBasisState, quantity: Decimal.Value, proceedsGbp: Decimal.Value, feesGbp: Decimal.Value = 0,
): { sellResult: SellResult; realized: RealizedSale } {
  const sellResult = applySell(state, quantity);
  const proceeds = d(proceedsGbp);
  const fees = d(feesGbp);
  const realizedPnlGbp = proceeds.minus(sellResult.costBasisRemoved).minus(fees);
  return {
    sellResult,
    realized: { quantity: d(quantity), proceedsGbp: proceeds, costBasisRemoved: sellResult.costBasisRemoved, feesGbp: fees, realizedPnlGbp },
  };
}

export type LedgerTransaction = {
  id: string;
  type: "buy" | "sell" | "adjustment";
  tradeAt: string;
  quantity: Decimal.Value;
  /** buy: total GBP cost. sell: total GBP proceeds. adjustment: ignored (quantity is the new absolute total). */
  gbpTotal?: Decimal.Value;
  gbpFees?: Decimal.Value;
};

export type LedgerResult = {
  state: CostBasisState;
  realizedSales: Array<RealizedSale & { transactionId: string }>;
};

/**
 * Walks a full, chronologically-sorted transaction ledger for ONE asset and
 * produces the final holding state plus every realised sale along the way
 * — the single function the portfolio view-model, the holding-detail
 * route, and historical reconstruction all call, so "how do buys/sells/
 * adjustments combine" is defined in exactly one place. Transactions are
 * re-sorted by tradeAt here (never trusted to already be in order), so a
 * caller can pass rows straight from a `select * order by trade_at` query
 * OR an unordered spreadsheet-import batch with identical results.
 */
export function reduceLedger(transactions: LedgerTransaction[]): LedgerResult {
  const sorted = [...transactions].sort((a, b) => a.tradeAt.localeCompare(b.tradeAt) || a.id.localeCompare(b.id));
  let state: CostBasisState = ZERO_COST_BASIS;
  const realizedSales: LedgerResult["realizedSales"] = [];

  for (const tx of sorted) {
    if (tx.type === "buy") {
      state = applyBuy(state, tx.quantity, tx.gbpTotal ?? 0);
    } else if (tx.type === "sell") {
      const { sellResult, realized } = computeRealizedSale(state, tx.quantity, tx.gbpTotal ?? 0, tx.gbpFees ?? 0);
      state = sellResult.state;
      realizedSales.push({ ...realized, transactionId: tx.id });
    } else {
      state = applyAdjustment(state, tx.quantity);
    }
  }

  return { state, realizedSales };
}
