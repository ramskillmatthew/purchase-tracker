import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { createSaleInputSchema } from "@/lib/validation/sales";
import { classifySaleRpcError } from "@/lib/sales/rpc-errors";
import { groupItemDescriptions } from "@/lib/sales/order-summary";
import { poundsToPence } from "@/lib/sales/money";
import type { SaleItem, SalesOrder, SalesOrderListItem } from "@/lib/types";

/** How many of the most recent sales the list view shows — a bounded "recent sales" list, not a full paginated sales history browser (that belongs to a later reporting stage). */
const MAX_RECENT_SALES = 200;

const RPC_ERROR_MESSAGES: Record<string, string> = {
  invalid_platform: "Choose a valid platform.",
  custom_platform_name_required: "Enter a custom platform name for Other.",
  custom_platform_name_not_allowed: "Custom platform name must be left blank unless the platform is Other.",
  invalid_revenue_mode: "Choose a valid revenue entry method.",
  negative_amount: "Revenue, fees, and postage cannot be negative.",
  no_items: "Select at least one purchase to sell.",
  too_many_items: "Select fewer purchases — there is a maximum per sale.",
  duplicate_purchase_ids: "The same purchase was selected more than once.",
  purchase_not_found: "One of the selected purchases could not be found.",
  purchase_not_available: "One of the selected purchases is no longer in stock.",
  purchase_already_sold: "One of the selected purchases has already been sold.",
  itemised_lines_required: "Enter a revenue amount for every selected item.",
  itemised_line_count_mismatch: "The itemised revenue list doesn't match the number of selected items.",
  itemised_line_purchase_mismatch: "The itemised revenue list must cover exactly the selected items.",
  itemised_revenue_mismatch: "The itemised revenue lines don't add up to the order total.",
  itemised_data_not_allowed: "Itemised revenue can only be used with itemised revenue mode.",
};

/**
 * Creates one completed sale, atomically, via rpc/create_completed_sale
 * (see supabase-sales.sql + supabase-sales-v2.sql) — a single database
 * transaction that validates every purchase, snapshots its fields fresh,
 * allocates revenue/fees/postage itself, inserts the order + line items,
 * and flips every sold purchase to no_longer_in_stock. Never a sequence of
 * separate client-side requests. Purchase cost/description/category/SKU/
 * supplier are never accepted here — the RPC re-derives them from the
 * database. `lineRevenues` (itemised mode only — Stage 4 mixed baskets) is
 * passed through as-is; the RPC re-validates it covers exactly the selected
 * purchases and reconciles to the declared total, never trusting it blindly.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = createSaleInputSchema.parse(await request.json());
    try {
      const rpcResponse = await supabaseRequest("rpc/create_completed_sale", {
        method: "POST",
        body: JSON.stringify({
          p_owner_id: user.id,
          p_sale_date: input.saleDate,
          p_platform: input.platform,
          p_custom_platform_name: input.customPlatformName ?? null,
          p_revenue_input_mode: input.revenueInputMode,
          p_revenue_input_value: input.revenueInputValue,
          p_platform_fees: input.platformFees,
          p_postage: input.postage,
          p_purchase_ids: input.purchaseIds,
          p_line_revenues: input.lineRevenues
            ? input.lineRevenues.map(line => ({ purchase_id: line.purchaseId, revenue: line.revenue }))
            : null,
        }),
      });
      const [row] = await rpcResponse.json() as { sales_order_id: string }[];
      const [order] = await (await supabaseRequest(`sales_orders?id=eq.${row.sales_order_id}&owner_id=eq.${user.id}&select=*`)).json() as SalesOrder[];
      const items = await supabaseRequestAll<SaleItem>(`sale_items?sales_order_id=eq.${row.sales_order_id}&order=created_at.asc`);
      return NextResponse.json({ order, items }, { status: 201 });
    } catch (error) {
      // Only a recognized RPC-raised conflict is ever reported as a clear,
      // specific reason — anything else (missing migration/function,
      // database outage, permission problem) must propagate to safeApiError
      // below rather than being silently absorbed.
      const reason = classifySaleRpcError(error);
      if (!reason) throw error;
      return NextResponse.json({ error: RPC_ERROR_MESSAGES[reason] ?? "Could not create the sale.", reason }, { status: 409 });
    }
  } catch (error) { return safeApiError(error, "Could not create the sale."); }
}

/**
 * Lists this owner's most recent sales (bounded — a "recent sales" list, not
 * a full paginated sales-history browser, which belongs to a later
 * reporting stage), in a stable, most-recent-first order, each annotated
 * with its item count, exact profit, and grouped description snapshots — a
 * SINGLE bounded follow-up query against sale_items covering every listed
 * order, aggregated client-side here, never one query per order. Profit is
 * summed from each sale_item's own saved `profit` (not recalculated), so
 * this list agrees exactly with the sale detail page (see
 * app/sales/[id]/page.tsx). Descriptions are the immutable
 * item_description_snapshot values, never the current (possibly since-
 * edited) purchase description.
 */
export async function GET() {
  try {
    const user = await requireOwner();
    const response = await supabaseRequest(`sales_orders?owner_id=eq.${user.id}&select=*&order=sale_date.desc,created_at.desc`, {
      headers: { Range: `0-${MAX_RECENT_SALES - 1}` },
    });
    const orders = await response.json() as SalesOrder[];
    if (!orders.length) return NextResponse.json([] satisfies SalesOrderListItem[]);

    const ids = orders.map(order => order.id);
    const items = await supabaseRequestAll<{ sales_order_id: string; item_description_snapshot: string; profit: number }>(
      `sale_items?sales_order_id=in.(${ids.join(",")})&select=sales_order_id,item_description_snapshot,profit`,
    );
    const counts = new Map<string, number>();
    const profitPenceByOrder = new Map<string, number>();
    const descriptionsByOrder = new Map<string, string[]>();
    for (const item of items) {
      counts.set(item.sales_order_id, (counts.get(item.sales_order_id) ?? 0) + 1);
      profitPenceByOrder.set(item.sales_order_id, (profitPenceByOrder.get(item.sales_order_id) ?? 0) + poundsToPence(Number(item.profit)));
      const descriptions = descriptionsByOrder.get(item.sales_order_id);
      if (descriptions) descriptions.push(item.item_description_snapshot);
      else descriptionsByOrder.set(item.sales_order_id, [item.item_description_snapshot]);
    }

    const withAggregates: SalesOrderListItem[] = orders.map(order => ({
      ...order,
      itemCount: counts.get(order.id) ?? 0,
      profitPence: profitPenceByOrder.get(order.id) ?? 0,
      itemGroups: groupItemDescriptions(descriptionsByOrder.get(order.id) ?? []),
    }));
    return NextResponse.json(withAggregates);
  } catch (error) { return safeApiError(error, "Could not load sales."); }
}
