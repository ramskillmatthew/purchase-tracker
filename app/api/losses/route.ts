import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { createLossInputSchema, returnsLossesListQuerySchema } from "@/lib/validation/returns-losses";
import { parseDateRangePreset, resolveDateFilter } from "@/lib/sales/report-date-range";
import { computeReturnsLossesKpis, type ResolvedRange } from "@/lib/returns/kpi";
import { computeLossImpact } from "@/lib/returns/financial";
import { poundsToPence, penceToPounds } from "@/lib/sales/money";
import { anchorDate, canonicalMonth } from "@/lib/returns/date-precision";
import { planLossApplication, movementsToRpcJson } from "@/lib/returns/stock-movements";
import { validateLossQuantity } from "@/lib/returns/eligibility";
import { findRefundNoReturnConflictForLoss } from "@/lib/returns/duplicate-guard";
import { apiError, auditEvent, callTransition, nextReference } from "@/lib/returns/route-helpers";
import type { LossRecordRow, ReturnRecordRow } from "@/lib/returns/types";
import type { Purchase } from "@/lib/types";

export const runtime = "nodejs";

/** GET — losses + KPIs for a period. (The unified page list lives on
 * GET /api/returns; this is the losses-only convenience subset.) */
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const url = new URL(request.url);
    const query = returnsLossesListQuerySchema.parse(Object.fromEntries(url.searchParams));
    const preset = parseDateRangePreset(query.preset);
    const filterResult = resolveDateFilter({ preset, customStart: query.start, customEnd: query.end });
    if (!filterResult.ok) return apiError("validation", filterResult.error);
    const range: ResolvedRange = filterResult.range;

    const [losses, returns] = await Promise.all([
      supabaseRequestAll<LossRecordRow>(`loss_records?owner_id=eq.${user.id}&deleted_at=is.null&select=*&order=created_at.desc`),
      supabaseRequestAll<ReturnRecordRow>(`return_records?owner_id=eq.${user.id}&deleted_at=is.null&select=*&order=created_at.desc`),
    ]);
    const kpis = computeReturnsLossesKpis({ returns, losses, soldUnitCohort: [], range });
    return NextResponse.json({ losses, kpis, range });
  } catch (error) { return safeApiError(error, "Could not load losses and write-offs."); }
}

/**
 * POST — "Record loss or write-off". For lost_inventory / unsellable_purchase
 * a purchase match is mandatory and `purchaseIds` are the EXACT currently-in-
 * stock unit rows (a unit already out of stock, or claimed by another
 * loss/return, is rejected — "written off twice" is structurally impossible).
 * Create + ledger + purchases.stock_status + audit are ONE transaction
 * (rl_apply_loss_transition mode 'create').
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = createLossInputSchema.parse(await request.json());

    // Duplicate economic-event guard: a refund_without_return loss must not
    // duplicate a return already completed as buyer_refunded_no_return for
    // the same sale/units.
    if (input.lossType === "refund_without_return" && input.salesOrderId) {
      const returns = await supabaseRequestAll<ReturnRecordRow>(`return_records?owner_id=eq.${user.id}&deleted_at=is.null&sales_order_id=eq.${input.salesOrderId}&select=*`);
      const conflict = findRefundNoReturnConflictForLoss({ salesOrderId: input.salesOrderId, saleItemIds: input.saleItemIds, returns });
      if (conflict) return apiError("conflict", conflict.reason);
    }

    let matched: Purchase[] = [];
    if (input.purchaseIds.length) {
      matched = await supabaseRequestAll<Purchase>(`purchases?id=in.(${input.purchaseIds.join(",")})&select=*`);
      if (matched.length !== input.purchaseIds.length) return apiError("not_found", "One or more matched purchases could not be found.");
      const removing = input.stockAction === "remove_from_stock";
      const notInStock = removing ? matched.filter(p => p.stock_status !== "in_stock") : [];
      if (notInStock.length) return apiError("conflict", `${notInStock.length} of the selected units are no longer in stock and cannot be written off again.`, { conflictingPurchaseIds: notInStock.map(p => p.id) });
      const q = validateLossQuantity({ requested: input.purchaseIds.length, remainingEligible: removing ? matched.filter(p => p.stock_status === "in_stock").length : input.purchaseIds.length });
      if (!q.ok) return apiError("conflict", q.error);
    } else if (input.lossType === "lost_inventory" || input.lossType === "unsellable_purchase") {
      return apiError("validation", "A matched purchase is required for a lost-inventory or unsellable-purchase record.");
    }

    const quantity = input.purchaseIds.length || 1;
    const unitCostPence = matched.length
      ? Math.round(matched.reduce((s, p) => s + poundsToPence(Number(p.price_purchased)), 0) / matched.length)
      : 0;
    const stockRemoved = input.stockAction === "remove_from_stock" && matched.length > 0;
    const impact = computeLossImpact({
      lossType: input.lossType, quantity, unitCostPence,
      customerRefundPence: poundsToPence(input.customerRefund), otherCostsPence: poundsToPence(input.otherCosts), stockRemoved,
    });

    const reference = await nextReference(user.id, "loss");
    const eventPd = input.eventPrecision === "month" ? { precision: "month" as const, month: input.eventDate.slice(0, 7) } : { precision: "exact" as const, date: input.eventDate };
    const loggedRaw = input.loggedDate ?? new Date().toISOString().slice(0, 10);
    const loggedPd = input.loggedPrecision === "month" ? { precision: "month" as const, month: loggedRaw.slice(0, 7) } : { precision: "exact" as const, date: loggedRaw };

    // Pre-generate the loss id so the movements can reference it inside the
    // same transaction — rl_apply_loss_transition uses it if provided.
    const lossId = crypto.randomUUID();
    const purchaseCostByUnit = Object.fromEntries(matched.map(p => [p.id, poundsToPence(Number(p.price_purchased))]));
    const plan = planLossApplication({ lossId, lossType: input.lossType, purchaseUnitCostsPence: purchaseCostByUnit, stockRemoved });

    const outcome = await callTransition<{ record: LossRecordRow; already_applied?: boolean }>("rl_apply_loss_transition", {
      p_owner_id: user.id, p_loss_id: lossId,
      p_loss: {
        id: lossId, reference, idempotency_key: input.idempotencyKey ?? "", loss_type: input.lossType,
        purchase_id: matched[0]?.id ?? "", sales_order_id: input.salesOrderId ?? "",
        quantity, unit_cost: penceToPounds(unitCostPence),
        stock_value_removed: penceToPounds(impact.stockValueRemovedPence),
        customer_refund: penceToPounds(impact.customerRefundPence), other_costs: penceToPounds(impact.otherCostsPence),
        net_profit_impact: penceToPounds(impact.netProfitImpactPence),
        event_date: anchorDate(eventPd), event_precision: input.eventPrecision, event_month: canonicalMonth(eventPd),
        logged_date: anchorDate(loggedPd), logged_precision: input.loggedPrecision, logged_by: user.email ?? null,
        stock_action: input.stockAction,
        written_off_purchase_ids: plan.map(m => m.purchaseId),
        sale_item_ids: input.lossType === "refund_without_return" ? input.saleItemIds : [],
        applied: true, notes: input.notes ?? null, created_by: user.email ?? null,
      },
      p_movements: movementsToRpcJson(plan, { lossRecordId: lossId }),
      p_stock_checks: [],
      p_audit: [
        auditEvent("record_created", user.email ?? null, { lossType: input.lossType, quantity }),
        ...(matched.length ? [auditEvent("purchase_linked", user.email ?? null, { purchaseIds: input.purchaseIds })] : []),
        ...(input.salesOrderId ? [auditEvent("sale_linked", user.email ?? null, { salesOrderId: input.salesOrderId })] : []),
        ...(stockRemoved ? [auditEvent("inventory_written_off", user.email ?? null, { units: plan.length })] : []),
        auditEvent("amount_changed", user.email ?? null, { netProfitImpactPence: impact.netProfitImpactPence }),
      ],
      p_mode: "create",
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });

    // already_applied === a retry that carried the same idempotencyKey; the
    // first call created the row + applied its movements/audit. Return it as a
    // success (200, not 201) so a double-submit is a no-op, never a duplicate.
    const alreadyApplied = outcome.data.already_applied === true;
    return NextResponse.json(
      { record: outcome.data.record, impact, ...(alreadyApplied ? { alreadyApplied: true } : {}) },
      { status: alreadyApplied ? 200 : 201 },
    );
  } catch (error) { return safeApiError(error, "Could not record this loss."); }
}
