import { poundsToPence } from "./allocate";

/**
 * The order-total invariant: the reviewer-confirmed prices of every row
 * being imported for one order must sum to EXACTLY the candidate's own
 * stored order_total_paid — compared in integer pence, never floating
 * point, so no fractional-penny rounding artefact can pass. A null
 * orderTotalPounds (the order total was never confidently extracted) is
 * not enforced — true is returned, matching "not blocked by this rule",
 * governed instead by the existing review-time rules.
 *
 * Mirrors rpc/import_purchase_order's Pass 1.5 check in
 * supabase-purchase-import-v2.sql exactly, so the app route can fail fast
 * with the same answer the database would authoritatively give — this
 * function is the single source of truth for that comparison on the app
 * side, never a place that rebalances or alters the submitted prices.
 */
export function matchesOrderTotal(submittedPricesPounds: number[], orderTotalPounds: number | null): boolean {
  if (orderTotalPounds === null) return true;
  const submittedPence = submittedPricesPounds.reduce((sum, price) => sum + poundsToPence(price), 0);
  return submittedPence === poundsToPence(orderTotalPounds);
}

/**
 * order_total_paid is meant to be duplicated identically across every
 * sibling candidate row of one order. Picking any single row's value (e.g.
 * via SQL max()) would silently accept the group if the siblings ever
 * disagreed — a parser bug, a partially-applied backfill, a corrupted
 * edit — since one arbitrary value could then coincidentally match (or
 * mismatch) the submitted allocation. This checks the FULL set of every
 * sibling's own order_total_paid at once: true only if every non-null
 * value is identical (an all-null set is also consistent — the null-total
 * behaviour in matchesOrderTotal governs that case instead).
 *
 * Mirrors rpc/import_purchase_order's Pass 1.5 count(distinct ...) check
 * exactly.
 */
export function hasConsistentOrderTotal(siblingTotalsPounds: (number | null)[]): boolean {
  const distinctNonNull = new Set(siblingTotalsPounds.filter((value): value is number => value !== null));
  return distinctNonNull.size <= 1;
}

/** The single non-null total shared by every sibling, or null if none/inconsistent (call hasConsistentOrderTotal first). */
export function sharedOrderTotal(siblingTotalsPounds: (number | null)[]): number | null {
  const distinctNonNull = [...new Set(siblingTotalsPounds.filter((value): value is number => value !== null))];
  return distinctNonNull.length === 1 ? distinctNonNull[0] : null;
}
