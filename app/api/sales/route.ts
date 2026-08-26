import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { createSaleInputSchema } from "@/lib/validation/sales";
import { classifySaleRpcError } from "@/lib/sales/rpc-errors";
import { groupItemDescriptions } from "@/lib/sales/order-summary";
import { poundsToPence } from "@/lib/sales/money";
import { computeHistoryKpis, compareHistoryOrders, HISTORY_PAGE_SIZES, itemGroupsText, type HistoryDirection, type HistorySort, type SalesHistoryResponse } from "@/lib/sales/history";
import { londonToday, parseDateRangePreset, resolveDateFilter } from "@/lib/sales/report-date-range";
import { effectiveSalesProcessStatus } from "@/lib/sales/process-status";
import type { SaleItem, SalesOrder, SalesOrderListItem } from "@/lib/types";

/** How many of the most recent sales the list view shows — a bounded "recent sales" list, not a full paginated sales history browser (that belongs to a later reporting stage). */
const SALE_ITEM_BATCH_SIZE = 200;

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
 * Hydrates an owner-scoped Sales History result with item count, exact
 * profit, category snapshots, and grouped description snapshots. Item
 * rows are fetched in fixed-size batches, never one request per order.
 * Profit is
 * summed from each sale_item's own saved `profit` (not recalculated), so
 * this list agrees exactly with the sale detail page (see
 * app/sales/[id]/page.tsx). Descriptions are the immutable
 * item_description_snapshot values, never the current (possibly since-
 * edited) purchase description.
 */
async function hydrateOrders(orders: SalesOrder[]): Promise<SalesOrderListItem[]> {
  if (!orders.length) return [];
  const items: { sales_order_id: string; item_description_snapshot: string; category_snapshot: string; profit: number }[] = [];
  for (let index = 0; index < orders.length; index += SALE_ITEM_BATCH_SIZE) {
    const ids = orders.slice(index, index + SALE_ITEM_BATCH_SIZE).map(order => order.id);
    items.push(...await supabaseRequestAll<{ sales_order_id: string; item_description_snapshot: string; category_snapshot: string; profit: number }>(
      `sale_items?sales_order_id=in.(${ids.join(",")})&select=sales_order_id,item_description_snapshot,category_snapshot,profit&order=sales_order_id.asc,created_at.asc`,
    ));
  }
  const byOrder = new Map<string, typeof items>();
  for (const item of items) byOrder.set(item.sales_order_id, [...(byOrder.get(item.sales_order_id) ?? []), item]);
  return orders.map(order => {
    const orderItems = byOrder.get(order.id) ?? [];
    return {
      ...order,
      itemCount: orderItems.length,
      profitPence: orderItems.reduce((sum, item) => sum + poundsToPence(Number(item.profit)), 0),
      itemGroups: groupItemDescriptions(orderItems.map(item => item.item_description_snapshot)),
      categorySnapshots: [...new Set(orderItems.map(item => item.category_snapshot))],
    } as SalesOrderListItem & { categorySnapshots: string[] };
  });
}

function categoryMatches(categories: string[], selected: string): boolean {
  if (!selected) return true;
  const normalised = categories.map(value => value.trim().toLowerCase());
  if (selected === "pokemon") return normalised.some(value => value.includes("pokémon") || value.includes("pokemon"));
  if (selected === "non-pokemon-tcg") return normalised.some(value => (value.includes("tcg") || value.includes("trading card")) && !value.includes("pokémon") && !value.includes("pokemon"));
  if (selected === "clothing") return normalised.some(value => value.includes("cloth") || value.includes("apparel"));
  if (selected === "footwear") return normalised.some(value => value.includes("footwear") || value.includes("shoe") || value.includes("trainer"));
  return normalised.some(value => !value.includes("pokémon") && !value.includes("pokemon") && !value.includes("tcg") && !value.includes("trading card") && !value.includes("cloth") && !value.includes("apparel") && !value.includes("footwear") && !value.includes("shoe") && !value.includes("trainer"));
}

export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const status = ["pending", "completed", "cancelled", "all"].includes(url.searchParams.get("status") ?? "") ? url.searchParams.get("status")! : "completed";
    const preset = parseDateRangePreset(url.searchParams.get("preset") ?? "all-time");
    const rangeResult = resolveDateFilter({ preset, customStart: url.searchParams.get("start"), customEnd: url.searchParams.get("end") });
    if (!rangeResult.ok) return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? 10);
    const pageSize = HISTORY_PAGE_SIZES.includes(pageSizeRaw as typeof HISTORY_PAGE_SIZES[number]) ? pageSizeRaw : 10;
    const requestedPage = Math.max(1, Math.trunc(Number(url.searchParams.get("page") ?? 1) || 1));
    const sort = (["date", "revenue", "profit", "margin", "units"].includes(url.searchParams.get("sort") ?? "") ? url.searchParams.get("sort") : "date") as HistorySort;
    const direction = (url.searchParams.get("direction") === "asc" ? "asc" : "desc") as HistoryDirection;
    const platform = (url.searchParams.get("platform") ?? "").trim().toLowerCase();
    const category = (url.searchParams.get("category") ?? "").trim().toLowerCase();
    const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();

    const filters = [`owner_id=eq.${user.id}`, "select=*", "order=sale_date.desc,created_at.desc,id.desc"];
    if (status === "pending" || status === "completed") filters.push("status=eq.completed");
    else if (status === "cancelled") filters.push("status=eq.cancelled");
    if (rangeResult.range.start) filters.push(`sale_date=gte.${rangeResult.range.start}`);
    if (rangeResult.range.end) filters.push(`sale_date=lte.${rangeResult.range.end}`);
    const baseOrders = await supabaseRequestAll<SalesOrder>(`sales_orders?${filters.join("&")}`);
    let filtered = await hydrateOrders(baseOrders) as (SalesOrderListItem & { categorySnapshots: string[] })[];
    filtered = filtered.filter(order => {
      const processStatus = effectiveSalesProcessStatus(order);
      if (status === "pending" && !["awaiting_dispatch", "sent", "delivered_awaiting_payout", "return_in_process"].includes(processStatus ?? "")) return false;
      if (status === "completed" && processStatus !== "completed") return false;
      const label = order.platform === "other" && order.custom_platform_name ? order.custom_platform_name : order.platform;
      if (platform && label.toLowerCase() !== platform && order.platform !== platform) return false;
      if (!categoryMatches(order.categorySnapshots, category)) return false;
      return !search || `${itemGroupsText(order.itemGroups)} ${label} ${order.platform} ${order.status}`.toLowerCase().includes(search);
    });
    filtered.sort((a, b) => compareHistoryOrders(a, b, sort, direction));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map(({ categorySnapshots: _categories, ...order }) => order);

    const today = londonToday();
    const todayOrders = await hydrateOrders(await supabaseRequestAll<SalesOrder>(`sales_orders?owner_id=eq.${user.id}&status=eq.completed&sale_date=eq.${today}&select=*&order=sale_date.desc,created_at.desc,id.desc`));
    const recentResponse = await supabaseRequest(`sales_orders?owner_id=eq.${user.id}&select=*&order=updated_at.desc,id.desc`, { headers: { Range: "0-4" } });
    const recentActivity = await hydrateOrders(await recentResponse.json() as SalesOrder[]);
    const allPlatformResponse = await supabaseRequestAll<Pick<SalesOrder, "platform" | "custom_platform_name">>(`sales_orders?owner_id=eq.${user.id}&select=platform,custom_platform_name&order=created_at.asc`);
    const platforms = [...new Set(allPlatformResponse.map(order => order.platform === "other" && order.custom_platform_name ? order.custom_platform_name : order.platform))].sort((a, b) => a.localeCompare(b));
    const todayKpis = computeHistoryKpis(todayOrders);
    const response: SalesHistoryResponse = {
      rows, page, pageSize, total, totalPages, kpis: computeHistoryKpis(filtered),
      today: { orders: todayKpis.completedSales, revenuePence: todayKpis.revenuePence, profitPence: todayKpis.profitPence },
      recentActivity, platforms,
    };
    return NextResponse.json(response);
  } catch (error) { return safeApiError(error, "Could not load sales."); }
}
