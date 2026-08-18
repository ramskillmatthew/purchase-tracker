import { isInStock } from "./purchases";
import type { Purchase } from "./types";

/**
 * The single shared "can this exact purchase row be sold?" check.
 *
 * DECISION (documented per the Stage 1 spec, not silently imposed): arrival
 * is deliberately NOT part of availability. `stock_status` already answers
 * "is this still part of my inventory at all?" independently of whether it
 * has physically turned up yet (see lib/purchases.ts's own module comment on
 * why arrived/stock_status are kept independent) — a purchase that's
 * in_stock but not yet arrived (still in the post) remains sellable, exactly
 * preserving today's existing stock-status meaning. This can be revisited
 * later, but only as an explicit, separate decision.
 *
 * `hasActiveSaleLink` lets a caller that has already joined against
 * sale_items (Stage 2 — an active, i.e. non-refunded/non-cancelled, sale
 * line referencing this exact purchase UUID) fold that in too; omitting it
 * falls back to the stock-status-only check, which is also what the atomic
 * create_completed_sale() RPC (supabase-sales.sql) re-verifies itself under
 * a row lock at the moment of sale — this function is a convenience for
 * callers building a "what can I sell right now" list, never the sole
 * enforcement point.
 */
export function isPurchaseAvailableForSale(
  purchase: Pick<Purchase, "stock_status">,
  options?: { hasActiveSaleLink?: boolean },
): boolean {
  return isInStock(purchase) && !(options?.hasActiveSaleLink ?? false);
}
