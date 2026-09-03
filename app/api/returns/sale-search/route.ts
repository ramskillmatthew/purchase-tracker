import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { poundsToPence } from "@/lib/sales/money";
import { apiError } from "@/lib/returns/route-helpers";
import type { SaleMatchResult } from "@/lib/returns/api-contract";
import type { ReturnRecordRow } from "@/lib/returns/types";
import type { SaleItem, SalesOrder } from "@/lib/types";

export const runtime = "nodejs";

const BATCH = 200;

/**
 * GET /api/returns/sale-search — read-only, owner-scoped. Powers "Match sale"
 * in the Log-return workflow.
 *
 * - `q` searches SKU snapshot / item description snapshot / sale id / platform
 *   (case-insensitive substring). Blank `q` returns every eligible sale,
 *   paginated (`page`/`pageSize`), so the user can browse.
 * - Eligible = financial `status = 'completed'` AND at least one active
 *   `sale_items` unit not already claimed by another active/completed
 *   (non-deleted) return. Mixed-basket orders are represented accurately —
 *   each eligible unit is listed with its own SKU / title / cost / revenue /
 *   profit so the caller picks EXACT unit ids (never "first N").
 * - No product photographs anywhere.
 */
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") ?? 20) || 20));

    const orders = await supabaseRequestAll<SalesOrder>(
      `sales_orders?owner_id=eq.${user.id}&status=eq.completed&select=*&order=sale_date.desc,created_at.desc,id.desc`,
    );
    if (!orders.length) return NextResponse.json({ results: [], page: 1, pageSize, total: 0, totalPages: 1 });

    const existingReturns = await supabaseRequestAll<Pick<ReturnRecordRow, "workflow_status" | "sale_item_ids">>(
      `return_records?owner_id=eq.${user.id}&deleted_at=is.null&select=workflow_status,sale_item_ids`,
    );
    const CONSUMING = new Set(["return_started", "item_sent", "return_delivered", "return_completed"]);
    const claimed = new Set(existingReturns.filter(r => CONSUMING.has(r.workflow_status)).flatMap(r => r.sale_item_ids ?? []));

    const itemsByOrder = new Map<string, SaleItem[]>();
    for (let i = 0; i < orders.length; i += BATCH) {
      const ids = orders.slice(i, i + BATCH).map(o => o.id);
      const items = await supabaseRequestAll<SaleItem>(
        `sale_items?sales_order_id=in.(${ids.join(",")})&is_active=eq.true&select=id,sales_order_id,sku_snapshot,item_description_snapshot,purchase_cost_snapshot,allocated_revenue,profit&order=created_at.asc,id.asc`,
      );
      for (const it of items) itemsByOrder.set(it.sales_order_id, [...(itemsByOrder.get(it.sales_order_id) ?? []), it]);
    }

    let results: SaleMatchResult[] = orders.map(order => {
      const all = itemsByOrder.get(order.id) ?? [];
      const eligible = all.filter(it => !claimed.has(it.id));
      const platform = order.platform === "other" && order.custom_platform_name ? order.custom_platform_name : order.platform;
      return {
        salesOrderId: order.id,
        saleReference: order.id,
        saleDate: order.sale_date,
        platform,
        status: order.status,
        processStatus: order.process_status ?? null,
        revenuePence: poundsToPence(Number(order.total_revenue)),
        profitPence: all.reduce((s, it) => s + poundsToPence(Number(it.profit)), 0),
        soldUnitCount: all.length,
        eligibleReturnQuantity: eligible.length,
        items: eligible.map(it => ({
          saleItemId: it.id,
          sku: it.sku_snapshot,
          title: it.item_description_snapshot,
          costPence: poundsToPence(Number(it.purchase_cost_snapshot)),
          revenuePence: poundsToPence(Number(it.allocated_revenue)),
          profitPence: poundsToPence(Number(it.profit)),
        })),
      };
    }).filter(r => r.eligibleReturnQuantity > 0);

    if (q) {
      results = results.filter(r =>
        r.salesOrderId.toLowerCase().includes(q) ||
        r.platform.toLowerCase().includes(q) ||
        r.items.some(it => it.sku.toLowerCase().includes(q) || it.title.toLowerCase().includes(q)),
      );
    }

    const total = results.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clampedPage = Math.min(page, totalPages);
    return NextResponse.json({
      results: results.slice((clampedPage - 1) * pageSize, clampedPage * pageSize),
      page: clampedPage, pageSize, total, totalPages,
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && (error as Error & { status: number }).status === 401) return apiError("auth", "Authentication required.");
    return safeApiError(error, "Could not search sales.");
  }
}
