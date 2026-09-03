import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { completeReturnInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { computeReturnReversal } from "@/lib/returns/financial";
import { poundsToPence, penceToPounds } from "@/lib/sales/money";
import { anchorDate, canonicalMonth } from "@/lib/returns/date-precision";
import { planReturnCompletion, movementsToRpcJson } from "@/lib/returns/stock-movements";
import { RETURN_COMPLETED_SALE_STATUS } from "@/lib/returns/status-sync";
import { findRefundNoReturnConflictForReturn } from "@/lib/returns/duplicate-guard";
import { apiError, auditEvent, callTransition } from "@/lib/returns/route-helpers";
import type { ReturnRecordRow, LossRecordRow } from "@/lib/returns/types";
import type { SaleItem } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/returns/[id]/complete — "What happened to the item?"
 *
 * All effects (ledger + purchases.stock_status + return record + linked-sale
 * process_status + audit) are applied in ONE transaction inside
 * rl_apply_return_transition, which locks the return row FOR UPDATE first.
 * Idempotent: `completed_applied` already true -> the stored record is
 * returned unchanged. `inventory_movements` idempotency keys mean a
 * concurrent double-submit cannot restock/write-off twice.
 *
 * Financial figures are summed from the EXACT selected sale_items (never an
 * order-level proportion). The August sale is never touched; the reversal is
 * recognised in the completion month.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const input = completeReturnInputSchema.parse(await request.json());

    const [record] = await (await supabaseRequest(`return_records?id=eq.${id}&owner_id=eq.${user.id}&deleted_at=is.null&select=*`)).json() as ReturnRecordRow[];
    if (!record) return apiError("not_found", "Return not found.");
    if (record.completed_applied) return NextResponse.json({ record, alreadyApplied: true });
    if (record.workflow_status === "return_cancelled") return apiError("conflict", "This return was cancelled and cannot be completed. Log a new return instead.");

    // sale_items are owner-scoped transitively via sales_orders (verified at
    // POST /api/returns time); re-fetch by the exact stored ids.
    const items = record.sale_item_ids.length
      ? await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${record.sale_item_ids.join(",")})`)
      : [];
    if (items.length !== record.sale_item_ids.length) return apiError("conflict", "One or more of the returned sale units no longer exists.");

    // Duplicate economic-event guard (revalidated here, not only in preview):
    // one "buyer refunded, item not returned" incident must never be recorded
    // as BOTH a completed return AND a standalone refund_without_return loss.
    if (input.outcome === "buyer_refunded_no_return") {
      const losses = await supabaseRequestAll<LossRecordRow>(`loss_records?owner_id=eq.${user.id}&deleted_at=is.null&loss_type=eq.refund_without_return&select=*`);
      const conflict = findRefundNoReturnConflictForReturn({ salesOrderId: record.sales_order_id, saleItemIds: record.sale_item_ids, losses });
      if (conflict) return apiError("conflict", conflict.reason);
    }

    const saleRevenuePence = items.reduce((s, i) => s + poundsToPence(Number(i.allocated_revenue)), 0);
    const saleFeesPence = items.reduce((s, i) => s + poundsToPence(Number(i.allocated_platform_fee)) + poundsToPence(Number(i.allocated_postage)), 0);
    const saleCostPence = items.reduce((s, i) => s + poundsToPence(Number(i.purchase_cost_snapshot)), 0);
    const saleProfitPence = items.reduce((s, i) => s + poundsToPence(Number(i.profit)), 0);

    const reversal = computeReturnReversal({
      saleRevenuePence, saleFeesPence, saleCostPence, saleProfitPence,
      saleQty: record.quantity, returnedQty: record.quantity,
      refundMode: input.refundMode,
      partialRefundPence: input.partialRefundAmount != null ? poundsToPence(input.partialRefundAmount) : undefined,
      returnPostagePence: poundsToPence(input.returnPostage), unrecoveredCostsPence: poundsToPence(input.unrecoveredCosts),
      outcome: input.outcome,
    });

    const purchaseCostByUnit: Record<string, number> = {};
    for (const item of items) if (item.purchase_id) purchaseCostByUnit[item.purchase_id] = poundsToPence(Number(item.purchase_cost_snapshot));
    const plan = planReturnCompletion({ returnId: record.id, outcome: input.outcome, purchaseUnitCostsPence: purchaseCostByUnit });

    const completedPd = input.completedPrecision === "month"
      ? { precision: "month" as const, month: input.completedOn.slice(0, 7) }
      : { precision: "exact" as const, date: input.completedOn };
    const recognitionMonth = canonicalMonth(completedPd);

    const outcome = await callTransition<{ record: ReturnRecordRow; already_applied: boolean }>("rl_apply_return_transition", {
      p_owner_id: user.id, p_return_id: record.id,
      p_updates: {
        workflow_status: "return_completed", outcome: input.outcome,
        completed_on: anchorDate(completedPd), completed_precision: input.completedPrecision,
        recognition_month: recognitionMonth,
        revenue_reversed: penceToPounds(reversal.revenueReversedPence),
        profit_reversed: penceToPounds(reversal.profitReversedPence),
        original_sale_revenue: penceToPounds(saleRevenuePence),
        original_sale_profit: penceToPounds(saleProfitPence),
        original_stock_cost: penceToPounds(saleCostPence),
        inventory_write_off: penceToPounds(reversal.inventoryWriteOffPence),
        stock_value_restored: penceToPounds(reversal.stockValueRestoredPence),
        net_profit_impact: penceToPounds(reversal.netProfitImpactPence),
        refund_amount: input.refundMode === "full" ? penceToPounds(reversal.revenueReversedPence) : (input.partialRefundAmount ?? 0),
        partial_refund_amount: input.refundMode === "partial" ? (input.partialRefundAmount ?? 0) : "",
        return_postage: input.returnPostage, unrecovered_costs: input.unrecoveredCosts, other_costs: 0,
        // The purchase units this completion's ledger movements touched — for
        // BOTH outcomes, so a later cancel/edit/delete reverses precisely
        // these and no others (restored to stock, or written-off, depending
        // on the stored outcome).
        restock_purchase_ids: plan.map(m => m.purchaseId),
        completed_applied: true,
        notes: input.notes ?? record.notes,
      },
      p_movements: movementsToRpcJson(plan, { returnRecordId: record.id }),
      p_stock_checks: [],
      p_sale_process_status: RETURN_COMPLETED_SALE_STATUS,
      p_audit: [
        auditEvent("outcome_selected", user.email ?? null, { outcome: input.outcome }),
        auditEvent(input.outcome === "returned_safely" ? "inventory_restored" : "inventory_written_off", user.email ?? null, { units: plan.length, stockValueRestoredPence: reversal.stockValueRestoredPence, inventoryWriteOffPence: reversal.inventoryWriteOffPence }),
        auditEvent("return_completed", user.email ?? null, { netProfitImpactPence: reversal.netProfitImpactPence, recognitionMonth }),
        auditEvent("sales_status_changed", user.email ?? null, { to: RETURN_COMPLETED_SALE_STATUS }),
      ],
      p_expect_not_applied: "completed",
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });
    if (outcome.data.already_applied) return NextResponse.json({ record: outcome.data.record, alreadyApplied: true });

    return NextResponse.json({ record: outcome.data.record, impact: reversal });
  } catch (error) { return safeApiError(error, "Could not complete this return."); }
}
