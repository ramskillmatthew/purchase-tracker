import "server-only";
import { supabaseRequestAll } from "@/lib/supabase";
import type { ReportableSaleItem, ReportableSalesOrder } from "./reporting";
import type { ResolvedDateRange } from "./report-date-range";

// Mirrors lib/purchases-delete.ts's own batch-size precedent — keeps every
// sale_items `sales_order_id=in.(...)` filter a safely bounded URL length
// regardless of how many orders fall in the selected range, rather than
// building one arbitrarily long `in.()` list. Each batch is still fetched
// via supabaseRequestAll, so a batch with more than 1,000 sale_items rows
// (PostgREST's own per-request cap) is still paginated through correctly.
const SALE_ITEMS_BATCH_SIZE = 200;

/**
 * Fetches every COMPLETED sale (and its sale_items) for one owner within an
 * inclusive date range, in exactly two query "shapes" — one bounded,
 * paginated fetch for sales_orders, then one bounded, paginated fetch per
 * batch of order ids for sale_items — never one request per order (which
 * would be N+1) and never an unbounded single request that silently caps
 * out at PostgREST's row limit. Only the columns the reporting aggregation
 * functions actually use are selected, so nothing unnecessary is pulled
 * out of the database in the first place.
 *
 * A null `start`/`end` in `range` means unbounded on that side ("All
 * Time"). Cancelled/refunded sales are excluded by the `status=eq.completed`
 * filter itself — the database never even returns them, rather than
 * fetching and filtering them out in application code.
 */
export async function fetchCompletedSalesInRange(ownerId: string, range: ResolvedDateRange): Promise<{ orders: ReportableSalesOrder[]; items: ReportableSaleItem[] }> {
  const filters = [`owner_id=eq.${ownerId}`, "status=eq.completed", "select=id,sale_date,platform,custom_platform_name"];
  if (range.start) filters.push(`sale_date=gte.${range.start}`);
  if (range.end) filters.push(`sale_date=lte.${range.end}`);
  filters.push("order=sale_date.asc,created_at.asc,id.asc");

  const orders = await supabaseRequestAll<ReportableSalesOrder>(`sales_orders?${filters.join("&")}`);
  if (orders.length === 0) return { orders: [], items: [] };

  const items: ReportableSaleItem[] = [];
  for (let i = 0; i < orders.length; i += SALE_ITEMS_BATCH_SIZE) {
    const batchIds = orders.slice(i, i + SALE_ITEMS_BATCH_SIZE).map(order => order.id);
    const batchItems = await supabaseRequestAll<ReportableSaleItem>(
      `sale_items?sales_order_id=in.(${batchIds.join(",")})&select=sales_order_id,category_snapshot,condition_group_snapshot,purchase_cost_snapshot,allocated_revenue,allocated_platform_fee,allocated_postage`,
    );
    items.push(...batchItems);
  }
  return { orders, items };
}
