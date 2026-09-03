import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { editReturnInputSchema, deleteReturnInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { computeReturnReversal, returnNetProfitImpactPence } from "@/lib/returns/financial";
import { poundsToPence, penceToPounds } from "@/lib/sales/money";
import { anchorDate, canonicalMonth } from "@/lib/returns/date-precision";
import { computeReturnStructuralDiff, type EffectiveReturnUnit } from "@/lib/returns/edit-diff";
import { movementsToRpcJson, stockChecksToRpcJson, findStockConflicts } from "@/lib/returns/stock-movements";
import { selectSaleItemIdsForReturn } from "@/lib/returns/eligibility";
import { resolveRestoreSaleStatus, RETURN_IN_PROGRESS_SALE_STATUS } from "@/lib/returns/status-sync";
import { buildReturnReversal } from "@/lib/returns/reversal";
import { apiError, auditEvent, callTransition } from "@/lib/returns/route-helpers";
import type { ReturnRecordRow, ReturnLossAuditEventRow } from "@/lib/returns/types";
import type { SaleItem, Purchase } from "@/lib/types";

export const runtime = "nodejs";

async function loadReturn(ownerId: string, id: string): Promise<ReturnRecordRow | null> {
  const [row] = await (await supabaseRequest(`return_records?id=eq.${id}&owner_id=eq.${ownerId}&select=*`)).json() as ReturnRecordRow[];
  return row ?? null;
}
function costMap(items: SaleItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) if (i.purchase_id) out[i.purchase_id] = poundsToPence(Number(i.purchase_cost_snapshot));
  return out;
}
function sums(items: SaleItem[]) {
  return {
    revenue: items.reduce((s, i) => s + poundsToPence(Number(i.allocated_revenue)), 0),
    fees: items.reduce((s, i) => s + poundsToPence(Number(i.allocated_platform_fee)) + poundsToPence(Number(i.allocated_postage)), 0),
    cost: items.reduce((s, i) => s + poundsToPence(Number(i.purchase_cost_snapshot)), 0),
    profit: items.reduce((s, i) => s + poundsToPence(Number(i.profit)), 0),
  };
}

/** GET /api/returns/[id] — the detail view: the record plus its audit trail. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const record = await loadReturn(user.id, id);
    if (!record) return apiError("not_found", "Return not found.");
    const events = await supabaseRequestAll<ReturnLossAuditEventRow>(
      `return_loss_audit_events?owner_id=eq.${user.id}&return_record_id=eq.${id}&select=*&order=created_at.desc`,
    );
    return NextResponse.json({ record, events });
  } catch (error) { return safeApiError(error, "Could not load this return."); }
}

/**
 * PATCH /api/returns/[id] — difference-based edit.
 *
 * Money-only change (postage/fees/other costs/notes/refund/recognition
 * month): recompute the stored money fields; NO inventory movement.
 * Structural change (quantity / selected units / outcome / linked sale) on a
 * COMPLETED return: a set-diff of affected units — a unit no longer
 * effective is reversed (at the current movement generation), a newly
 * effective unit is applied (at the next generation) — a unit that stays
 * effective is untouched. All applied atomically. Blocked with a 409 if a
 * unit that must be reversed has changed stock state since.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const input = editReturnInputSchema.parse(await request.json());

    const record = await loadReturn(user.id, id);
    if (!record) return apiError("not_found", "Return not found.");
    if (record.deleted_at) return apiError("conflict", "This return has been deleted.");
    if (record.workflow_status === "return_cancelled") return apiError("conflict", "A cancelled return cannot be edited.");

    const completed = record.workflow_status === "return_completed";
    const newSaleId = input.salesOrderId ?? record.sales_order_id;
    const structuralRequested = input.saleItemIds !== undefined || input.salesOrderId !== undefined
      || (input.quantity !== undefined && input.quantity !== record.quantity)
      || (input.outcome !== undefined && input.outcome !== record.outcome);

    // Resolve the desired sale_item_ids.
    let newSaleItemIds = record.sale_item_ids;
    if (input.saleItemIds !== undefined || input.salesOrderId !== undefined) {
      if (!input.saleItemIds) return apiError("validation", "Provide saleItemIds when changing the quantity or linked sale.");
      newSaleItemIds = input.saleItemIds;
      const active = await supabaseRequestAll<SaleItem>(`sale_items?sales_order_id=eq.${newSaleId}&is_active=eq.true&order=created_at.asc,id.asc`);
      const others = await supabaseRequestAll<Pick<ReturnRecordRow, "id" | "workflow_status" | "sale_item_ids">>(
        `return_records?owner_id=eq.${user.id}&sales_order_id=eq.${newSaleId}&deleted_at=is.null&select=id,workflow_status,sale_item_ids`,
      );
      const claimed = others.filter(r => r.id !== record.id && ["return_started", "item_sent", "return_delivered", "return_completed"].includes(r.workflow_status)).flatMap(r => r.sale_item_ids ?? []);
      const check = selectSaleItemIdsForReturn({ allActiveSaleItemIds: [...new Set([...active.map(i => i.id), ...newSaleItemIds])], alreadyClaimedIds: claimed, quantity: newSaleItemIds.length });
      if (!check.ok) return apiError("conflict", check.error);
      if (!newSaleItemIds.every(sid => active.some(i => i.id === sid) || record.sale_item_ids.includes(sid))) {
        return apiError("validation", "One or more saleItemIds are not active units of the linked sale.");
      }
    } else if (input.quantity !== undefined && input.quantity !== record.quantity) {
      return apiError("validation", "Provide saleItemIds when changing the quantity.");
    }
    const newQuantity = newSaleItemIds.length;
    const newOutcome = input.outcome ?? record.outcome;

    // Sale-item money sums for the NEW set — needed on completion AND for an
    // active return whenever its selected units change (its stored historical
    // figures + net-profit impact must stay authoritative).
    const activeUnitsChanged = !completed && structuralRequested;
    const newItems = (completed || activeUnitsChanged)
      ? await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${newSaleItemIds.join(",")})`)
      : [];
    const updates: Record<string, unknown> = { notes: input.notes === undefined ? record.notes : input.notes };
    const audit: { event_type: string; actor: string | null; detail: Record<string, unknown> }[] = [auditEvent("record_edited", user.email ?? null, {})];

    if (input.startedOn) { updates.started_on = anchorDate(pd(input.startedOn, input.startedPrecision ?? record.started_precision)); updates.started_precision = input.startedPrecision ?? record.started_precision; }
    if (input.itemSentOn !== undefined) { updates.item_sent_on = input.itemSentOn ? anchorDate(pd(input.itemSentOn, input.itemSentPrecision ?? "exact")) : ""; updates.item_sent_precision = input.itemSentPrecision ?? record.item_sent_precision; }
    if (input.deliveredOn !== undefined) { updates.delivered_on = input.deliveredOn ? anchorDate(pd(input.deliveredOn, input.deliveredPrecision ?? "exact")) : ""; updates.delivered_precision = input.deliveredPrecision ?? record.delivered_precision; }

    let recognitionMonthChanged = false;
    let impact: ReturnType<typeof computeReturnReversal> | null = null;
    let movementsJson: Record<string, unknown>[] = [];
    let stockChecksJson: Record<string, string>[] = [];
    let movementsAdded = 0;
    let movementsReversed = 0;

    if (completed) {
      const completedOn = input.completedOn ?? record.completed_on!.slice(0, 10);
      const completedPrecision = input.completedPrecision ?? record.completed_precision!;
      const cPd = pd(completedOn, completedPrecision);
      const newRecognitionMonth = canonicalMonth(cPd);
      recognitionMonthChanged = newRecognitionMonth !== record.recognition_month;

      const s = sums(newItems);
      const refundMode = input.refundMode ?? (record.partial_refund_amount != null ? "partial" : "full");
      const partialPence = input.partialRefundAmount != null
        ? poundsToPence(input.partialRefundAmount)
        : (record.partial_refund_amount != null ? poundsToPence(Number(record.partial_refund_amount)) : undefined);
      const postagePence = poundsToPence(input.returnPostage ?? Number(record.return_postage));
      const unrecPence = poundsToPence(input.unrecoveredCosts ?? Number(record.unrecovered_costs));
      const otherPence = poundsToPence(input.otherCosts ?? Number(record.other_costs));

      impact = computeReturnReversal({
        saleRevenuePence: s.revenue, saleFeesPence: s.fees, saleCostPence: s.cost, saleProfitPence: s.profit,
        saleQty: newQuantity, returnedQty: newQuantity,
        refundMode: refundMode as "full" | "partial", partialRefundPence: partialPence,
        returnPostagePence: postagePence, unrecoveredCostsPence: unrecPence, outcome: newOutcome!,
      });
      // otherCosts is an extra return cost the formula treats like unrecovered fees.
      const netImpactPence = impact.netProfitImpactPence - otherPence;

      Object.assign(updates, {
        completed_on: anchorDate(cPd), completed_precision: completedPrecision, recognition_month: newRecognitionMonth,
        quantity: newQuantity, sale_item_ids: newSaleItemIds, sales_order_id: newSaleId, outcome: newOutcome,
        revenue_reversed: penceToPounds(impact.revenueReversedPence),
        profit_reversed: penceToPounds(impact.profitReversedPence),
        original_sale_revenue: penceToPounds(s.revenue), original_sale_profit: penceToPounds(s.profit),
        original_stock_cost: penceToPounds(s.cost),
        inventory_write_off: penceToPounds(impact.inventoryWriteOffPence),
        stock_value_restored: penceToPounds(impact.stockValueRestoredPence),
        net_profit_impact: penceToPounds(netImpactPence),
        refund_amount: refundMode === "full" ? penceToPounds(impact.revenueReversedPence) : penceToPounds(partialPence ?? 0),
        partial_refund_amount: refundMode === "partial" ? penceToPounds(partialPence ?? 0) : "",
        return_postage: penceToPounds(postagePence), unrecovered_costs: penceToPounds(unrecPence), other_costs: penceToPounds(otherPence),
      });

      if (structuralRequested) {
        const currentUnits: EffectiveReturnUnit[] = (record.restock_purchase_ids ?? []).map(pid => ({ purchaseId: pid, outcome: record.outcome! }));
        const oldItems = await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${record.sale_item_ids.join(",")})`);
        const desiredUnits: EffectiveReturnUnit[] = newItems.filter(i => i.purchase_id).map(i => ({ purchaseId: i.purchase_id!, outcome: newOutcome! }));
        const unitCosts = { ...costMap(oldItems), ...costMap(newItems) };
        const diff = computeReturnStructuralDiff({ returnId: record.id, currentUnits, desiredUnits, unitCostsPence: unitCosts, currentGen: record.reversed_movement_gen ?? 0 });

        // Stock-conflict check for the reversal side.
        const revIds = [...new Set(diff.reverseMovements.map(m => m.purchaseId))];
        const cur = revIds.length ? await supabaseRequestAll<Pick<Purchase, "id" | "stock_status">>(`purchases?id=in.(${revIds.join(",")})&select=id,stock_status`) : [];
        const curById = Object.fromEntries(cur.map(p => [p.id, p.stock_status])) as Record<string, "in_stock" | "no_longer_in_stock">;
        const conflicts = findStockConflicts(diff.reverseMovements, curById);
        if (conflicts.length) return apiError("conflict", `Cannot edit: ${conflicts.length} affected unit${conflicts.length === 1 ? " has" : "s have"} changed stock state since completion.`, { conflictingPurchaseIds: conflicts });

        const all = [...diff.reverseMovements, ...diff.applyMovements];
        movementsJson = movementsToRpcJson(all, { returnRecordId: record.id });
        stockChecksJson = stockChecksToRpcJson(diff.reverseMovements);
        movementsReversed = diff.reverseMovements.length;
        movementsAdded = diff.applyMovements.length;
        updates.restock_purchase_ids = desiredUnits.map(u => u.purchaseId);
        updates.reversed_movement_gen = diff.nextGen;
        if (movementsReversed) audit.push(auditEvent("inventory_restored", user.email ?? null, { count: movementsReversed }));
        if (movementsAdded) audit.push(auditEvent(newOutcome === "returned_safely" ? "inventory_restored" : "inventory_written_off", user.email ?? null, { count: movementsAdded }));
        if (input.quantity !== undefined || input.saleItemIds !== undefined) audit.push(auditEvent("quantity_changed", user.email ?? null, { from: record.quantity, to: newQuantity }));
        if (input.salesOrderId) audit.push(auditEvent("sale_linked", user.email ?? null, { from: record.sales_order_id, to: newSaleId }));
        if (input.outcome && input.outcome !== record.outcome) audit.push(auditEvent("outcome_selected", user.email ?? null, { from: record.outcome, to: newOutcome }));
      } else {
        audit.push(auditEvent("amount_changed", user.email ?? null, { netProfitImpactPence: netImpactPence }));
      }
      if (recognitionMonthChanged) audit.push(auditEvent("recognition_month_changed", user.email ?? null, { from: record.recognition_month, to: newRecognitionMonth }));
    } else {
      // Active (not completed) return — no inventory movement, but its stored
      // historical figures and net-profit impact stay authoritative so the
      // row / KPI strip / Home dashboard immediately reflect the edit.
      if (structuralRequested) { updates.quantity = newQuantity; updates.sale_item_ids = newSaleItemIds; updates.sales_order_id = newSaleId; }
      if (input.returnPostage !== undefined) updates.return_postage = input.returnPostage;
      if (input.unrecoveredCosts !== undefined) updates.unrecovered_costs = input.unrecoveredCosts;
      if (input.otherCosts !== undefined) updates.other_costs = input.otherCosts;

      const s = activeUnitsChanged ? sums(newItems) : null;
      const profitReversedPence = s
        ? s.profit
        : poundsToPence(Number(record.profit_reversed));
      if (s) {
        Object.assign(updates, {
          original_sale_revenue: penceToPounds(s.revenue),
          original_sale_profit: penceToPounds(s.profit),
          original_stock_cost: penceToPounds(s.cost),
          revenue_reversed: penceToPounds(s.revenue),
          profit_reversed: penceToPounds(s.profit),
        });
      }
      const postagePence = poundsToPence(input.returnPostage ?? Number(record.return_postage));
      const unrecPence = poundsToPence(input.unrecoveredCosts ?? Number(record.unrecovered_costs));
      const otherPence = poundsToPence(input.otherCosts ?? Number(record.other_costs));
      updates.net_profit_impact = penceToPounds(returnNetProfitImpactPence({
        profitReversedPence, returnPostagePence: postagePence,
        unrecoveredCostsPence: unrecPence, otherCostsPence: otherPence,
      }));
      audit.push(auditEvent("amount_changed", user.email ?? null, { netProfitImpactPence: updates.net_profit_impact }));
    }

    const outcome = await callTransition<{ record: ReturnRecordRow }>("rl_apply_return_transition", {
      p_owner_id: user.id, p_return_id: record.id,
      p_updates: updates, p_movements: movementsJson, p_stock_checks: stockChecksJson,
      p_sale_process_status: "", p_audit: audit, p_expect_not_applied: "",
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });

    return NextResponse.json({ record: outcome.data.record, impact, movementsAdded, movementsReversed });
  } catch (error) { return safeApiError(error, "Could not edit this return."); }
}

/**
 * DELETE /api/returns/[id] — soft delete (deleted_at) + full reversal.
 * Requires { confirm: true }. Reverses the ledger + stock exactly once
 * (bumping the movement generation), restores the linked sale to a
 * user-selected canonical status (or the snapshotted previous one), and
 * audits. The original SALE is never deleted. Blocked with a 409 if a
 * restored unit has changed stock state since. Idempotent: an already-
 * deleted return returns unchanged.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const input = deleteReturnInputSchema.parse(await request.json().catch(() => ({})));

    const record = await loadReturn(user.id, id);
    if (!record) return apiError("not_found", "Return not found.");
    if (record.deleted_at) return NextResponse.json({ record, alreadyDeleted: true });

    const wasActive = record.workflow_status !== "return_cancelled";
    const items = record.sale_item_ids.length ? await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${record.sale_item_ids.join(",")})`) : [];
    const affectedIds = record.workflow_status === "return_completed" ? (record.restock_purchase_ids ?? []) : [];
    const curStock: Record<string, "in_stock" | "no_longer_in_stock"> = {};
    if (affectedIds.length) {
      const cur = await supabaseRequestAll<Pick<Purchase, "id" | "stock_status">>(`purchases?id=in.(${affectedIds.join(",")})&select=id,stock_status`);
      for (const p of cur) curStock[p.id] = p.stock_status;
    }
    const reversal = buildReturnReversal({ record, purchaseCostByUnit: costMap(items), currentStockById: curStock });
    if (reversal.conflicts.length) {
      return apiError("conflict", `Cannot delete this return: ${reversal.conflicts.length} affected unit${reversal.conflicts.length === 1 ? " has" : "s have"} changed stock state since it completed. Cancel it manually and resolve the stock conflict first.`, { conflictingPurchaseIds: reversal.conflicts });
    }

    const restoredStatus = wasActive ? resolveRestoreSaleStatus(input.restoreSaleStatus, record.prev_process_status) : null;

    const outcome = await callTransition<{ record: ReturnRecordRow }>("rl_apply_return_transition", {
      p_owner_id: user.id, p_return_id: record.id,
      p_updates: {
        deleted_at: new Date().toISOString(), deleted_by: user.email ?? null,
        reversed_movement_gen: reversal.nextGen,
        ...(wasActive ? { cancelled_applied: true } : {}),
      },
      p_movements: reversal.movementsJson, p_stock_checks: reversal.stockChecksJson,
      p_sale_process_status: restoredStatus ?? "",
      p_audit: [
        ...(reversal.movements.length ? [auditEvent("inventory_restored", user.email ?? null, { reversed: reversal.movements.length })] : []),
        auditEvent("record_reversed", user.email ?? null, { reversedMovements: reversal.movements.length }),
        auditEvent("record_deleted", user.email ?? null, {}),
        ...(restoredStatus ? [auditEvent("sales_status_changed", user.email ?? null, { to: restoredStatus })] : []),
      ],
      p_expect_not_applied: "",
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });

    return NextResponse.json({ record: outcome.data.record, restoredSaleStatus: restoredStatus });
  } catch (error) { return safeApiError(error, "Could not delete this return."); }
}

function pd(dateIso: string, precision: string): { precision: "exact"; date: string } | { precision: "month"; month: string } {
  return precision === "month" ? { precision: "month", month: dateIso.slice(0, 7) } : { precision: "exact", date: dateIso };
}
