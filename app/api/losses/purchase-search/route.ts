import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { poundsToPence } from "@/lib/sales/money";
import { apiError } from "@/lib/returns/route-helpers";
import type { PurchaseMatchResult } from "@/lib/returns/api-contract";
import type { LossRecordRow } from "@/lib/returns/types";
import type { Purchase } from "@/lib/types";

export const runtime = "nodejs";

const OWNERSHIP_NOTE =
  "The purchases table predates owner scoping and has no owner_id column (a documented Stage 1 limitation). This endpoint still requires authentication and only lists CURRENTLY-in-stock units.";

/**
 * GET /api/losses/purchase-search — read-only. Powers "Match purchase" in the
 * Log-loss workflow.
 *
 * - `q` searches SKU / item description / supplier / purchase id (blank `q`
 *   lists every eligible unit group, paginated).
 * - Eligible = `purchases.stock_status = 'in_stock'` AND not already in any
 *   active (non-deleted) loss's `written_off_purchase_ids`. Sold / lost /
 *   written-off / restocked-then-resold units are all excluded because their
 *   stock_status is not `in_stock`.
 * - Results are grouped by (SKU + unit cost) — each group lists the EXACT
 *   in-stock purchases-row ids so the caller selects precise units for a
 *   given quantity (never a synthetic aggregate).
 * - No product photographs.
 * - Auth-gated; purchases have no owner_id (limitation disclosed in the
 *   response `ownershipNote`).
 */
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") ?? 20) || 20));

    const [inStock, activeLosses] = await Promise.all([
      supabaseRequestAll<Pick<Purchase, "id" | "sku" | "item_description" | "purchased_from" | "order_date" | "price_purchased">>(
        `purchases?stock_status=eq.in_stock&select=id,sku,item_description,purchased_from,order_date,price_purchased&order=order_date.desc,id.desc`,
      ),
      supabaseRequestAll<Pick<LossRecordRow, "written_off_purchase_ids">>(
        `loss_records?owner_id=eq.${user.id}&deleted_at=is.null&select=written_off_purchase_ids`,
      ),
    ]);
    const claimed = new Set(activeLosses.flatMap(l => l.written_off_purchase_ids ?? []));
    const eligible = inStock.filter(p => !claimed.has(p.id));

    const groups = new Map<string, PurchaseMatchResult>();
    for (const p of eligible) {
      const costPence = poundsToPence(Number(p.price_purchased));
      const key = `${p.sku}::${costPence}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          groupKey: key, sku: p.sku, itemTitle: p.item_description, supplier: p.purchased_from || null,
          purchaseDate: p.order_date, unitCostPence: costPence, inStockUnitIds: [], eligibleQuantity: 0,
        };
        groups.set(key, g);
      }
      g.inStockUnitIds.push(p.id);
      g.eligibleQuantity += 1;
      if (p.order_date > (g.purchaseDate ?? "")) g.purchaseDate = p.order_date;
    }

    let results = [...groups.values()];
    if (q) {
      results = results.filter(g =>
        g.sku.toLowerCase().includes(q) ||
        g.itemTitle.toLowerCase().includes(q) ||
        (g.supplier ?? "").toLowerCase().includes(q) ||
        g.inStockUnitIds.some(id => id.toLowerCase().includes(q)),
      );
    }
    results.sort((a, b) => (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? "") || a.sku.localeCompare(b.sku));

    const total = results.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clampedPage = Math.min(page, totalPages);
    return NextResponse.json({
      results: results.slice((clampedPage - 1) * pageSize, clampedPage * pageSize),
      page: clampedPage, pageSize, total, totalPages, ownershipNote: OWNERSHIP_NOTE,
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && (error as Error & { status: number }).status === 401) return apiError("auth", "Authentication required.");
    return safeApiError(error, "Could not search purchases.");
  }
}
