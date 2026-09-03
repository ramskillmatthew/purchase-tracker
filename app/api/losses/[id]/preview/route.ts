import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { editLossInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { computeLossImpact } from "@/lib/returns/financial";
import { poundsToPence } from "@/lib/sales/money";
import { canonicalMonth } from "@/lib/returns/date-precision";
import { computeLossStructuralDiff } from "@/lib/returns/edit-diff";
import { findStockConflicts } from "@/lib/returns/stock-movements";
import { apiError } from "@/lib/returns/route-helpers";
import type { LossRecordRow, LossType } from "@/lib/returns/types";
import type { LossEditPreviewResponse } from "@/lib/returns/api-contract";
import type { Purchase } from "@/lib/types";

export const runtime = "nodejs";
const p = (v: number | string | null | undefined) => poundsToPence(Number(v ?? 0));

/** POST /api/losses/[id]/preview — NON-MUTATING loss edit preview. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid loss id.");
    const input = editLossInputSchema.parse(await request.json());

    const [record] = await (await supabaseRequest(`loss_records?id=eq.${id}&owner_id=eq.${user.id}&select=*`)).json() as LossRecordRow[];
    if (!record) return apiError("not_found", "Loss not found.");
    if (record.deleted_at) return apiError("conflict", "This loss has been deleted.");

    const newType = (input.lossType ?? record.loss_type) as LossType;
    const newStockAction = input.stockAction ?? record.stock_action;
    const currentIds = record.written_off_purchase_ids ?? [];
    const newIds = input.purchaseIds ?? currentIds;
    const allIds = [...new Set([...currentIds, ...newIds])];
    const purchases = allIds.length ? await supabaseRequestAll<Purchase>(`purchases?id=in.(${allIds.join(",")})&select=id,price_purchased,stock_status`) : [];
    const costById: Record<string, number> = Object.fromEntries(purchases.map(x => [x.id, poundsToPence(Number(x.price_purchased))]));
    const stockById = Object.fromEntries(purchases.map(x => [x.id, x.stock_status])) as Record<string, "in_stock" | "no_longer_in_stock">;

    const currentRemoved = record.stock_action === "remove_from_stock" && currentIds.length > 0;
    const desiredRemoved = newStockAction === "remove_from_stock" && newIds.length > 0;
    const diff = computeLossStructuralDiff({
      lossId: record.id, currentPurchaseIds: currentIds, currentLossType: record.loss_type, currentStockRemoved: currentRemoved,
      desiredPurchaseIds: newIds, desiredLossType: newType, desiredStockRemoved: desiredRemoved,
      unitCostsPence: costById, currentGen: record.reversed_movement_gen ?? 0,
    });
    const stockConflicts = findStockConflicts(diff.reverseMovements, stockById);

    const quantity = desiredRemoved ? newIds.length : record.quantity;
    const unitCostPence = newIds.length
      ? Math.round(newIds.reduce((s, pid) => s + (costById[pid] ?? p(record.unit_cost)), 0) / newIds.length)
      : p(record.unit_cost);
    const impact = computeLossImpact({
      lossType: newType, quantity, unitCostPence,
      customerRefundPence: poundsToPence(input.customerRefund ?? Number(record.customer_refund)),
      otherCostsPence: poundsToPence(input.otherCosts ?? Number(record.other_costs)),
      stockRemoved: desiredRemoved,
    });

    const before = { stockValueRemoved: p(record.stock_value_removed), customerRefund: p(record.customer_refund), otherCosts: p(record.other_costs), netProfitImpact: p(record.net_profit_impact) };
    const after = { stockValueRemoved: impact.stockValueRemovedPence, customerRefund: impact.customerRefundPence, otherCosts: impact.otherCostsPence, netProfitImpact: impact.netProfitImpactPence };

    const eventDate = input.eventDate ?? record.event_date.slice(0, 10);
    const eventPrecision = input.eventPrecision ?? record.event_precision;
    const ePd = eventPrecision === "month" ? { precision: "month" as const, month: eventDate.slice(0, 7) } : { precision: "exact" as const, date: eventDate };
    const newMonth = canonicalMonth(ePd);

    const lines = [
      { label: "Stock value removed", beforePence: before.stockValueRemoved, afterPence: after.stockValueRemoved },
      { label: "Customer refund", beforePence: before.customerRefund, afterPence: after.customerRefund },
      { label: "Other costs", beforePence: before.otherCosts, afterPence: after.otherCosts },
      { label: "Net profit impact", beforePence: before.netProfitImpact, afterPence: after.netProfitImpact },
    ].filter(l => l.beforePence !== l.afterPence);

    const response: LossEditPreviewResponse = {
      before, after, lines,
      netProfitImpactDeltaPence: after.netProfitImpact - before.netProfitImpact,
      recognitionMonthChange: newMonth !== record.event_month ? { from: record.event_month, to: newMonth } : null,
      movementsToApply: diff.applyMovements.length, movementsToReverse: diff.reverseMovements.length, stockConflicts,
    };
    return NextResponse.json(response);
  } catch (error) { return safeApiError(error, "Could not preview this loss edit."); }
}
