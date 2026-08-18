import type { SalesOrder, SalesStatus } from "@/lib/types";

/**
 * Sales history's status filter — mirrors lib/purchases.ts's StockFilter/
 * stockFilters/matchesStockFilter pattern exactly (same shape, same
 * "value"+"label" tuple list, same parse-with-safe-fallback convention) so
 * the Sales page's filter switch behaves identically to the Purchases
 * page's, not a second inconsistent implementation.
 *
 * "Completed" is the default and represents active, reportable sales.
 * "Cancelled" surfaces retained-for-audit cancelled sales — see
 * supabase-sales-v3.sql. "All" shows both. A refunded sale (a status this
 * schema already allows but no feature creates yet) is only ever shown
 * under "All" — never counted as "Completed" — so a future refund feature
 * can rely on that boundary already being correct.
 */
export type SalesStatusFilter = "completed" | "cancelled" | "all";

export const salesStatusFilters: { value: SalesStatusFilter; label: string }[] = [
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

export function parseSalesStatusFilter(value: string | null | undefined): SalesStatusFilter {
  return value === "cancelled" || value === "all" ? value : "completed";
}

export function matchesSalesStatusFilter(order: Pick<SalesOrder, "status">, filter: SalesStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "cancelled") return order.status === "cancelled";
  return order.status === "completed";
}

/** Only a currently-completed sale can ever be selected for bulk cancellation — an already-cancelled/refunded row is never selectable again. */
export function isSelectableForCancellation(order: Pick<SalesOrder, "status">): boolean {
  return order.status === ("completed" satisfies SalesStatus);
}
