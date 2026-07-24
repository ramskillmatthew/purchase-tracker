export type CurrencyTotal = { currency: string; total: number; orderCount: number };

// Structural, minimal shapes rather than the full ReconstructedOrder/
// PublicOrder types — these functions are reused unchanged both server-side
// (over ReconstructedOrder, which has more fields) and client-side (over
// PublicOrder, the browser-facing DTO), and both satisfy this shape.
type HasRefund = { refundAmount: number | null; currency: string | null };
type HasPurchase = { purchaseAmount: number | null; currency: string | null };

function aggregateAmounts<T>(orders: T[], amountOf: (order: T) => number | null, currencyOf: (order: T) => string | null): CurrencyTotal[] {
  const totals = new Map<string, CurrencyTotal>();
  for (const order of orders) {
    const amount = amountOf(order);
    const currency = currencyOf(order);
    if (amount === null || currency === null) continue;
    const existing = totals.get(currency) ?? { currency, total: 0, orderCount: 0 };
    // Round after every addition to avoid binary floating-point drift
    // accumulating across many small currency amounts.
    existing.total = Math.round((existing.total + amount) * 100) / 100;
    existing.orderCount += 1;
    totals.set(currency, existing);
  }
  return [...totals.values()];
}

/**
 * Deterministically sums each order's refundAmount, grouped by currency —
 * amounts in different currencies are never combined into one total.
 * Orders with a null refundAmount or null currency are ignored. Each
 * ReconstructedOrder already represents one deduplicated real-world
 * purchase (see reconstruct.ts's timeline dedup and reference/merchant
 * grouping), so summing across orders cannot double-count a refund that
 * happened to arrive as more than one source email.
 *
 * Computed here — not left for Claude to add up from the rendered evidence
 * — because free-text arithmetic over several displayed values is
 * unreliable; see lib/orders/render.ts, which presents this as already-
 * computed evidence for synthesis to report rather than recalculate.
 */
export function aggregateRefundTotals(orders: HasRefund[]): CurrencyTotal[] {
  return aggregateAmounts(orders, order => order.refundAmount, order => order.currency);
}

/** Same principle as aggregateRefundTotals, over purchaseAmount instead —
 * used by the order-summary panel's "Total purchase value." */
export function aggregatePurchaseTotals(orders: HasPurchase[]): CurrencyTotal[] {
  return aggregateAmounts(orders, order => order.purchaseAmount, order => order.currency);
}
