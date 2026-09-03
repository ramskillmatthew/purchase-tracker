import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { editReturnInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { computeReturnReversal, returnNetProfitImpactPence } from "@/lib/returns/financial";
import { poundsToPence } from "@/lib/sales/money";
import { canonicalMonth } from "@/lib/returns/date-precision";
import { sumSaleItems } from "@/lib/returns/preview";
import { computeReturnStructuralDiff, type EffectiveReturnUnit } from "@/lib/returns/edit-diff";
import { findStockConflicts } from "@/lib/returns/stock-movements";
import { apiError } from "@/lib/returns/route-helpers";
import type { ReturnRecordRow } from "@/lib/returns/types";
import type { ReturnEditPreviewResponse } from "@/lib/returns/api-contract";
import type { SaleItem, Purchase } from "@/lib/types";

export const runtime = "nodejs";

const p = (v: number | string | null | undefined) => poundsToPence(Number(v ?? 0));

/**
 * POST /api/returns/[id]/preview — NON-MUTATING edit preview. Shows the
 * before/after money fields, the net-profit-impact delta, whether the
 * recognition month moves, how many inventory movements would apply/reverse,
 * and any stock conflict — using the SAME domain functions PATCH uses.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const input = editReturnInputSchema.parse(await request.json());

    const [record] = await (await supabaseRequest(`return_records?id=eq.${id}&owner_id=eq.${user.id}&select=*`)).json() as ReturnRecordRow[];
    if (!record) return apiError("not_found", "Return not found.");
    if (record.deleted_at) return apiError("conflict", "This return has been deleted.");
    if (record.workflow_status === "return_cancelled") return apiError("conflict", "A cancelled return cannot be edited.");

    const completed = record.workflow_status === "return_completed";
    const before = {
      revenueReversed: p(record.revenue_reversed), profitReversed: p(record.profit_reversed),
      returnPostage: p(record.return_postage), unrecoveredCosts: p(record.unrecovered_costs), otherCosts: p(record.other_costs),
      inventoryWriteOff: p(record.inventory_write_off), stockValueRestored: p(record.stock_value_restored),
      netProfitImpact: p(record.net_profit_impact),
    };

    if (!completed) {
      // Active return: no inventory movement, but its provisional reversal +
      // net-profit impact do move when units / costs change (same formula the
      // PATCH not-completed branch applies).
      const unitsChanged = input.saleItemIds !== undefined || input.salesOrderId !== undefined
        || (input.quantity !== undefined && input.quantity !== record.quantity);
      const nextIds = input.saleItemIds ?? record.sale_item_ids;
      const s = unitsChanged && nextIds.length
        ? sumSaleItems(await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${nextIds.join(",")})`))
        : null;
      const profitReversed = s ? s.profitPence : p(record.profit_reversed);
      const revenueReversed = s ? s.revenuePence : p(record.revenue_reversed);
      const postagePence = input.returnPostage != null ? poundsToPence(input.returnPostage) : p(record.return_postage);
      const unrecPence = input.unrecoveredCosts != null ? poundsToPence(input.unrecoveredCosts) : p(record.unrecovered_costs);
      const otherPence = input.otherCosts != null ? poundsToPence(input.otherCosts) : p(record.other_costs);
      const netAfter = returnNetProfitImpactPence({
        profitReversedPence: profitReversed, returnPostagePence: postagePence,
        unrecoveredCostsPence: unrecPence, otherCostsPence: otherPence,
      });
      const after = {
        revenueReversed, profitReversed, returnPostage: postagePence, unrecoveredCosts: unrecPence,
        otherCosts: otherPence, inventoryWriteOff: 0, stockValueRestored: before.stockValueRestored,
        netProfitImpact: netAfter,
      };
      const lines = [
        { label: "Profit reversed", beforePence: before.profitReversed, afterPence: after.profitReversed },
        { label: "Return postage", beforePence: before.returnPostage, afterPence: after.returnPostage },
        { label: "Unrecovered fees", beforePence: before.unrecoveredCosts, afterPence: after.unrecoveredCosts },
        { label: "Other costs", beforePence: before.otherCosts, afterPence: after.otherCosts },
        { label: "Net profit impact", beforePence: before.netProfitImpact, afterPence: after.netProfitImpact },
      ].filter(l => l.beforePence !== l.afterPence);
      const response: ReturnEditPreviewResponse = {
        before, after, lines,
        netProfitImpactDeltaPence: after.netProfitImpact - before.netProfitImpact,
        recognitionMonthChange: null, movementsToApply: 0, movementsToReverse: 0, stockConflicts: [],
      };
      return NextResponse.json(response);
    }

    const newSaleItemIds = input.saleItemIds ?? record.sale_item_ids;
    const newOutcome = input.outcome ?? record.outcome!;
    const newItems = await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${newSaleItemIds.join(",")})`);
    const s = sumSaleItems(newItems);
    const refundMode = input.refundMode ?? (record.partial_refund_amount != null ? "partial" : "full");
    const partialPence = input.partialRefundAmount != null ? poundsToPence(input.partialRefundAmount)
      : (record.partial_refund_amount != null ? p(record.partial_refund_amount) : undefined);
    const postagePence = input.returnPostage != null ? poundsToPence(input.returnPostage) : p(record.return_postage);
    const unrecPence = input.unrecoveredCosts != null ? poundsToPence(input.unrecoveredCosts) : p(record.unrecovered_costs);
    const otherPence = input.otherCosts != null ? poundsToPence(input.otherCosts) : p(record.other_costs);

    const impact = computeReturnReversal({
      saleRevenuePence: s.revenuePence, saleFeesPence: s.feesPence, saleCostPence: s.costPence, saleProfitPence: s.profitPence,
      saleQty: newSaleItemIds.length, returnedQty: newSaleItemIds.length,
      refundMode: refundMode as "full" | "partial", partialRefundPence: partialPence,
      returnPostagePence: postagePence, unrecoveredCostsPence: unrecPence, outcome: newOutcome,
    });
    const netAfter = impact.netProfitImpactPence - otherPence;

    const after = {
      revenueReversed: impact.revenueReversedPence, profitReversed: impact.profitReversedPence,
      returnPostage: postagePence, unrecoveredCosts: unrecPence, otherCosts: otherPence,
      inventoryWriteOff: impact.inventoryWriteOffPence, stockValueRestored: impact.stockValueRestoredPence,
      netProfitImpact: netAfter,
    };

    // Structural diff (movements) + stock-conflict check.
    let movementsToApply = 0, movementsToReverse = 0, stockConflicts: string[] = [];
    const structural = input.saleItemIds !== undefined || input.salesOrderId !== undefined
      || (input.quantity !== undefined && input.quantity !== record.quantity)
      || (input.outcome !== undefined && input.outcome !== record.outcome);
    if (structural) {
      const currentUnits: EffectiveReturnUnit[] = (record.restock_purchase_ids ?? []).map(pid => ({ purchaseId: pid, outcome: record.outcome! }));
      const desiredUnits: EffectiveReturnUnit[] = newItems.filter(i => i.purchase_id).map(i => ({ purchaseId: i.purchase_id!, outcome: newOutcome }));
      const diff = computeReturnStructuralDiff({ returnId: record.id, currentUnits, desiredUnits, unitCostsPence: {}, currentGen: record.reversed_movement_gen ?? 0 });
      movementsToApply = diff.applyMovements.length;
      movementsToReverse = diff.reverseMovements.length;
      const revIds = [...new Set(diff.reverseMovements.map(m => m.purchaseId))];
      if (revIds.length) {
        const cur = await supabaseRequestAll<Pick<Purchase, "id" | "stock_status">>(`purchases?id=in.(${revIds.join(",")})&select=id,stock_status`);
        stockConflicts = findStockConflicts(diff.reverseMovements, Object.fromEntries(cur.map(x => [x.id, x.stock_status])) as Record<string, "in_stock" | "no_longer_in_stock">);
      }
    }

    const cPd = input.completedOn
      ? (input.completedPrecision === "month" ? { precision: "month" as const, month: input.completedOn.slice(0, 7) } : { precision: "exact" as const, date: input.completedOn })
      : null;
    const newMonth = cPd ? canonicalMonth(cPd) : record.recognition_month;
    const recognitionMonthChange = newMonth !== record.recognition_month ? { from: record.recognition_month, to: newMonth } : null;

    const lines = [
      { label: "Profit reversed", beforePence: before.profitReversed, afterPence: after.profitReversed },
      { label: "Return postage", beforePence: before.returnPostage, afterPence: after.returnPostage },
      { label: "Unrecovered fees", beforePence: before.unrecoveredCosts, afterPence: after.unrecoveredCosts },
      { label: "Other costs", beforePence: before.otherCosts, afterPence: after.otherCosts },
      { label: "Inventory write-off", beforePence: before.inventoryWriteOff, afterPence: after.inventoryWriteOff },
      { label: "Stock value restored", beforePence: before.stockValueRestored, afterPence: after.stockValueRestored },
      { label: "Net profit impact", beforePence: before.netProfitImpact, afterPence: after.netProfitImpact },
    ].filter(l => l.beforePence !== l.afterPence);

    const response: ReturnEditPreviewResponse = {
      before, after, lines,
      netProfitImpactDeltaPence: after.netProfitImpact - before.netProfitImpact,
      recognitionMonthChange, movementsToApply, movementsToReverse, stockConflicts,
    };
    return NextResponse.json(response);
  } catch (error) { return safeApiError(error, "Could not preview this edit."); }
}
