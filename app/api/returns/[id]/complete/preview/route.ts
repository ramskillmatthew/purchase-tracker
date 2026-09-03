import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { completeReturnInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { buildCompleteReturnPreview, sumSaleItems } from "@/lib/returns/preview";
import { findRefundNoReturnConflictForReturn } from "@/lib/returns/duplicate-guard";
import { apiError } from "@/lib/returns/route-helpers";
import type { ReturnRecordRow, LossRecordRow } from "@/lib/returns/types";
import type { SaleItem } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/returns/[id]/complete/preview — NON-MUTATING. Same validation
 * and same computeReturnReversal the real POST uses; writes nothing (no
 * ledger, no stock, no audit, no sale-status change). The final POST
 * revalidates everything, so this preview can't bypass concurrency guards.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const input = completeReturnInputSchema.parse(await request.json());

    const [record] = await (await supabaseRequest(`return_records?id=eq.${id}&owner_id=eq.${user.id}&deleted_at=is.null&select=*`)).json() as ReturnRecordRow[];
    if (!record) return apiError("not_found", "Return not found.");
    if (record.workflow_status === "return_cancelled") return apiError("conflict", "This return was cancelled and cannot be completed.");

    const items = record.sale_item_ids.length
      ? await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${record.sale_item_ids.join(",")})`)
      : [];
    if (items.length !== record.sale_item_ids.length) return apiError("conflict", "One or more of the returned sale units no longer exists.");

    if (input.outcome === "buyer_refunded_no_return") {
      const losses = await supabaseRequestAll<LossRecordRow>(`loss_records?owner_id=eq.${user.id}&deleted_at=is.null&loss_type=eq.refund_without_return&select=*`);
      const conflict = findRefundNoReturnConflictForReturn({ salesOrderId: record.sales_order_id, saleItemIds: record.sale_item_ids, losses });
      if (conflict) return apiError("conflict", conflict.reason);
    }

    const preview = buildCompleteReturnPreview({
      saleSums: sumSaleItems(items),
      quantity: record.quantity,
      outcome: input.outcome,
      completedOn: input.completedOn,
      completedPrecision: input.completedPrecision,
      refundMode: input.refundMode,
      partialRefundPounds: input.partialRefundAmount,
      returnPostagePounds: input.returnPostage,
      unrecoveredCostsPounds: input.unrecoveredCosts,
    });
    return NextResponse.json(preview);
  } catch (error) { return safeApiError(error, "Could not preview this return."); }
}
