import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequestAll } from "@/lib/supabase";
import { createLossInputSchema } from "@/lib/validation/returns-losses";
import { poundsToPence } from "@/lib/sales/money";
import { buildLossPreview } from "@/lib/returns/preview";
import { findRefundNoReturnConflictForLoss } from "@/lib/returns/duplicate-guard";
import { validateLossQuantity } from "@/lib/returns/eligibility";
import { apiError } from "@/lib/returns/route-helpers";
import type { ReturnRecordRow } from "@/lib/returns/types";
import type { Purchase } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/losses/preview — NON-MUTATING loss/write-off impact preview.
 * Same computeLossImpact + duplicate-event guard the real POST uses.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = createLossInputSchema.parse(await request.json());

    let matched: Purchase[] = [];
    if (input.purchaseIds.length) {
      matched = await supabaseRequestAll<Purchase>(`purchases?id=in.(${input.purchaseIds.join(",")})&select=*`);
      if (matched.length !== input.purchaseIds.length) return apiError("not_found", "One or more matched purchases could not be found.");
      if (input.stockAction === "remove_from_stock") {
        const notInStock = matched.filter(p => p.stock_status !== "in_stock");
        if (notInStock.length) return apiError("conflict", `${notInStock.length} of the selected units are no longer in stock.`, { conflictingPurchaseIds: notInStock.map(p => p.id) });
        const q = validateLossQuantity({ requested: input.purchaseIds.length, remainingEligible: matched.filter(p => p.stock_status === "in_stock").length });
        if (!q.ok) return apiError("conflict", q.error);
      }
    } else if (input.lossType === "lost_inventory" || input.lossType === "unsellable_purchase") {
      return apiError("validation", "A matched purchase is required for a lost-inventory or unsellable-purchase record.");
    }

    if (input.lossType === "refund_without_return" && input.salesOrderId) {
      const returns = await supabaseRequestAll<ReturnRecordRow>(`return_records?owner_id=eq.${user.id}&deleted_at=is.null&sales_order_id=eq.${input.salesOrderId}&select=*`);
      const conflict = findRefundNoReturnConflictForLoss({ salesOrderId: input.salesOrderId, saleItemIds: input.saleItemIds, returns });
      if (conflict) return apiError("conflict", conflict.reason);
    }

    const quantity = input.purchaseIds.length || 1;
    const unitCostPence = matched.length
      ? Math.round(matched.reduce((s, p) => s + poundsToPence(Number(p.price_purchased)), 0) / matched.length)
      : 0;
    const stockRemoved = input.stockAction === "remove_from_stock" && matched.length > 0;

    return NextResponse.json(buildLossPreview({
      lossType: input.lossType, quantity, unitCostPence,
      customerRefundPounds: input.customerRefund, otherCostsPounds: input.otherCosts,
      stockRemoved, eventDate: input.eventDate, eventPrecision: input.eventPrecision,
    }));
  } catch (error) { return safeApiError(error, "Could not preview this loss."); }
}
