import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { editLossInputSchema, deleteLossInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { computeLossImpact } from "@/lib/returns/financial";
import { poundsToPence, penceToPounds } from "@/lib/sales/money";
import { anchorDate, canonicalMonth } from "@/lib/returns/date-precision";
import { computeLossStructuralDiff } from "@/lib/returns/edit-diff";
import { movementsToRpcJson, stockChecksToRpcJson, findStockConflicts } from "@/lib/returns/stock-movements";
import { buildLossReversal } from "@/lib/returns/reversal";
import { apiError, auditEvent, callTransition } from "@/lib/returns/route-helpers";
import type { LossRecordRow, LossType, ReturnLossAuditEventRow } from "@/lib/returns/types";
import type { Purchase } from "@/lib/types";

export const runtime = "nodejs";

async function loadLoss(ownerId: string, id: string): Promise<LossRecordRow | null> {
  const [row] = await (await supabaseRequest(`loss_records?id=eq.${id}&owner_id=eq.${ownerId}&select=*`)).json() as LossRecordRow[];
  return row ?? null;
}
function pd(dateIso: string, precision: string): { precision: "exact"; date: string } | { precision: "month"; month: string } {
  return precision === "month" ? { precision: "month", month: dateIso.slice(0, 7) } : { precision: "exact", date: dateIso };
}

/** GET /api/losses/[id] — detail + audit trail. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid loss id.");
    const record = await loadLoss(user.id, id);
    if (!record) return apiError("not_found", "Loss not found.");
    const events = await supabaseRequestAll<ReturnLossAuditEventRow>(`return_loss_audit_events?owner_id=eq.${user.id}&loss_record_id=eq.${id}&select=*&order=created_at.desc`);
    return NextResponse.json({ record, events });
  } catch (error) { return safeApiError(error, "Could not load this loss."); }
}

/**
 * PATCH /api/losses/[id] — difference-based edit.
 * Quantity/unit change: reverse the removed units, apply the added units.
 * lost <-> unsellable: re-classify (reverse + re-apply the same units with
 * the new reason — never a second stock removal). Date/month change: move
 * the financial recognition only, no stock movement. Blocked with 409 when a
 * unit that must be reversed has changed stock state since.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid loss id.");
    const input = editLossInputSchema.parse(await request.json());

    const record = await loadLoss(user.id, id);
    if (!record) return apiError("not_found", "Loss not found.");
    if (record.deleted_at) return apiError("conflict", "This loss has been deleted.");

    const newType = (input.lossType ?? record.loss_type) as LossType;
    const newStockAction = input.stockAction ?? record.stock_action;
    const currentPurchaseIds = record.written_off_purchase_ids ?? [];
    const newPurchaseIds = input.purchaseIds ?? currentPurchaseIds;
    if ((newType === "lost_inventory" || newType === "unsellable_purchase") && newStockAction === "remove_from_stock" && newPurchaseIds.length === 0) {
      return apiError("validation", "A matched purchase is required for a lost-inventory or unsellable-purchase record.");
    }

    // Fetch cost/current-stock for every purchase involved on either side.
    const allIds = [...new Set([...currentPurchaseIds, ...newPurchaseIds])];
    const purchases = allIds.length ? await supabaseRequestAll<Purchase>(`purchases?id=in.(${allIds.join(",")})&select=id,price_purchased,stock_status`) : [];
    const costById: Record<string, number> = Object.fromEntries(purchases.map(p => [p.id, poundsToPence(Number(p.price_purchased))]));
    const stockById = Object.fromEntries(purchases.map(p => [p.id, p.stock_status])) as Record<string, "in_stock" | "no_longer_in_stock">;

    const currentStockRemoved = record.stock_action === "remove_from_stock" && (record.written_off_purchase_ids?.length ?? 0) > 0;
    const desiredStockRemoved = newStockAction === "remove_from_stock" && newPurchaseIds.length > 0;

    // Added units must currently be in stock (not already written off / sold).
    const addedIds = newPurchaseIds.filter(pid => !currentPurchaseIds.includes(pid));
    const addedNotInStock = desiredStockRemoved ? addedIds.filter(pid => stockById[pid] !== "in_stock") : [];
    if (addedNotInStock.length) return apiError("conflict", `${addedNotInStock.length} newly-selected unit(s) are not in stock.`, { conflictingPurchaseIds: addedNotInStock });

    const diff = computeLossStructuralDiff({
      lossId: record.id, currentPurchaseIds, currentLossType: record.loss_type, currentStockRemoved,
      desiredPurchaseIds: newPurchaseIds, desiredLossType: newType, desiredStockRemoved,
      unitCostsPence: costById, currentGen: record.reversed_movement_gen ?? 0,
    });
    const conflicts = findStockConflicts(diff.reverseMovements, stockById);
    if (conflicts.length) return apiError("conflict", `Cannot edit: ${conflicts.length} unit(s) have changed stock state since this loss was recorded.`, { conflictingPurchaseIds: conflicts });

    const quantity = desiredStockRemoved ? newPurchaseIds.length : record.quantity;
    const unitCostPence = newPurchaseIds.length
      ? Math.round(newPurchaseIds.reduce((s, pid) => s + (costById[pid] ?? poundsToPence(Number(record.unit_cost))), 0) / newPurchaseIds.length)
      : poundsToPence(Number(record.unit_cost));
    const impact = computeLossImpact({
      lossType: newType, quantity, unitCostPence,
      customerRefundPence: poundsToPence(input.customerRefund ?? Number(record.customer_refund)),
      otherCostsPence: poundsToPence(input.otherCosts ?? Number(record.other_costs)),
      stockRemoved: desiredStockRemoved,
    });

    const eventDate = input.eventDate ?? record.event_date.slice(0, 10);
    const eventPrecision = input.eventPrecision ?? record.event_precision;
    const ePd = pd(eventDate, eventPrecision);
    const newMonth = canonicalMonth(ePd);
    const monthChanged = newMonth !== record.event_month;

    const all = [...diff.reverseMovements, ...diff.applyMovements];
    const audit = [auditEvent("record_edited", user.email ?? null, {})];
    if (diff.reverseMovements.length) audit.push(auditEvent("inventory_restored", user.email ?? null, { count: diff.reverseMovements.length }));
    if (diff.applyMovements.length) audit.push(auditEvent("inventory_written_off", user.email ?? null, { count: diff.applyMovements.length }));
    if (input.purchaseIds) audit.push(auditEvent("purchase_linked", user.email ?? null, { from: currentPurchaseIds, to: newPurchaseIds }));
    if (input.lossType && input.lossType !== record.loss_type) audit.push(auditEvent("status_changed", user.email ?? null, { from: record.loss_type, to: newType }));
    if (monthChanged) audit.push(auditEvent("recognition_month_changed", user.email ?? null, { from: record.event_month, to: newMonth }));
    audit.push(auditEvent("amount_changed", user.email ?? null, { netProfitImpactPence: impact.netProfitImpactPence }));

    const outcome = await callTransition<{ record: LossRecordRow }>("rl_apply_loss_transition", {
      p_owner_id: user.id, p_loss_id: record.id, p_mode: "edit",
      p_loss: {
        loss_type: newType, stock_action: newStockAction,
        purchase_id: newPurchaseIds[0] ?? (record.purchase_id ?? ""),
        sales_order_id: input.salesOrderId === undefined ? (record.sales_order_id ?? "") : (input.salesOrderId ?? ""),
        quantity, unit_cost: penceToPounds(unitCostPence),
        stock_value_removed: penceToPounds(impact.stockValueRemovedPence),
        customer_refund: penceToPounds(impact.customerRefundPence), other_costs: penceToPounds(impact.otherCostsPence),
        net_profit_impact: penceToPounds(impact.netProfitImpactPence),
        event_date: anchorDate(ePd), event_precision: eventPrecision, event_month: newMonth,
        logged_date: input.loggedDate ? anchorDate(pd(input.loggedDate, input.loggedPrecision ?? "exact")) : record.logged_date.slice(0, 10),
        logged_precision: input.loggedPrecision ?? record.logged_precision,
        written_off_purchase_ids: diff.effectivePurchaseIds,
        reversed_movement_gen: diff.nextGen,
        notes: input.notes === undefined ? record.notes : input.notes,
      },
      p_movements: movementsToRpcJson(all, { lossRecordId: record.id }),
      p_stock_checks: stockChecksToRpcJson(diff.reverseMovements),
      p_audit: audit,
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });

    return NextResponse.json({ record: outcome.data.record, impact, movementsAdded: diff.applyMovements.length, movementsReversed: diff.reverseMovements.length });
  } catch (error) { return safeApiError(error, "Could not edit this loss."); }
}

/**
 * DELETE /api/losses/[id] — soft delete + reverse. Requires { confirm: true }.
 * Restores every written-off unit to `in_stock` at its original purchase
 * cost, once (movement generation bumped). Blocked with 409 if a unit has
 * since been sold/otherwise consumed. Idempotent for an already-deleted loss.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid loss id.");
    deleteLossInputSchema.parse(await request.json().catch(() => ({})));

    const record = await loadLoss(user.id, id);
    if (!record) return apiError("not_found", "Loss not found.");
    if (record.deleted_at) return NextResponse.json({ record, alreadyDeleted: true });

    const affected = record.written_off_purchase_ids ?? [];
    const purchases = affected.length ? await supabaseRequestAll<Purchase>(`purchases?id=in.(${affected.join(",")})&select=id,price_purchased,stock_status`) : [];
    const costById = Object.fromEntries(purchases.map(p => [p.id, poundsToPence(Number(p.price_purchased))]));
    const stockById = Object.fromEntries(purchases.map(p => [p.id, p.stock_status])) as Record<string, "in_stock" | "no_longer_in_stock">;

    const reversal = buildLossReversal({ record, purchaseCostByUnit: costById, currentStockById: stockById });
    if (reversal.conflicts.length) {
      return apiError("conflict", `Cannot delete this loss: ${reversal.conflicts.length} written-off unit(s) have changed stock state since. Resolve the conflict first.`, { conflictingPurchaseIds: reversal.conflicts });
    }

    const outcome = await callTransition<{ record: LossRecordRow }>("rl_apply_loss_transition", {
      p_owner_id: user.id, p_loss_id: record.id, p_mode: "reverse",
      p_loss: { deleted_at: new Date().toISOString(), deleted_by: user.email ?? null, applied: false, reversed_movement_gen: reversal.nextGen },
      p_movements: reversal.movementsJson,
      p_stock_checks: reversal.stockChecksJson,
      p_audit: [
        ...(reversal.movements.length ? [auditEvent("inventory_restored", user.email ?? null, { reversed: reversal.movements.length })] : []),
        auditEvent("record_reversed", user.email ?? null, { reversedMovements: reversal.movements.length }),
        auditEvent("record_deleted", user.email ?? null, {}),
      ],
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });

    return NextResponse.json({ record: outcome.data.record });
  } catch (error) { return safeApiError(error, "Could not delete this loss."); }
}
