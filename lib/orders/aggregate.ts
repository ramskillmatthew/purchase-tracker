import type { ReconstructedOrder } from "./model";

export type CurrencyTotal = { currency: string; total: number; orderCount: number };

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
export function aggregateRefundTotals(orders: ReconstructedOrder[]): CurrencyTotal[] {
  const totals = new Map<string, CurrencyTotal>();
  for (const order of orders) {
    if (order.refundAmount === null || order.currency === null) continue;
    const existing = totals.get(order.currency) ?? { currency: order.currency, total: 0, orderCount: 0 };
    // Round after every addition to avoid binary floating-point drift
    // accumulating across many small currency amounts.
    existing.total = Math.round((existing.total + order.refundAmount) * 100) / 100;
    existing.orderCount += 1;
    totals.set(order.currency, existing);
  }
  return [...totals.values()];
}
