import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { cancelReturnInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { poundsToPence } from "@/lib/sales/money";
import { resolveRestoreSaleStatus } from "@/lib/returns/status-sync";
import { buildReturnReversal } from "@/lib/returns/reversal";
import { apiError, auditEvent, callTransition } from "@/lib/returns/route-helpers";
import type { ReturnRecordRow } from "@/lib/returns/types";
import type { SaleItem, Purchase } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/returns/[id]/cancel
 *
 * One transaction (rl_apply_return_transition, row locked FOR UPDATE):
 * assert every restocked unit is still in the expected state, reverse the
 * exact movements completion applied (bumping the movement generation so
 * keys never collide), restore the linked sale to a user-selected canonical
 * status (or the snapshotted previous one), mark the return
 * 'return_cancelled', and audit — all or nothing.
 *
 * Financial reversal is by the status change alone: KPIs and the dashboard
 * only count `return_completed` + not-deleted returns, so the historical
 * money fields are never overwritten (audit of what WAS applied stays).
 *
 * Idempotent: already 'return_cancelled' -> returned unchanged.
 * Blocking: a restocked unit sold again since -> 409 with the unit ids.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const input = cancelReturnInputSchema.parse(await request.json());

    const [record] = await (await supabaseRequest(`return_records?id=eq.${id}&owner_id=eq.${user.id}&deleted_at=is.null&select=*`)).json() as ReturnRecordRow[];
    if (!record) return apiError("not_found", "Return not found.");
    if (record.workflow_status === "return_cancelled") return NextResponse.json({ record, alreadyApplied: true });

    const items = record.sale_item_ids.length
      ? await supabaseRequestAll<SaleItem>(`sale_items?id=in.(${record.sale_item_ids.join(",")})`)
      : [];
    const purchaseCostByUnit: Record<string, number> = {};
    for (const item of items) if (item.purchase_id) purchaseCostByUnit[item.purchase_id] = poundsToPence(Number(item.purchase_cost_snapshot));

    const affectedIds = record.restock_purchase_ids ?? [];
    const currentStockById: Record<string, "in_stock" | "no_longer_in_stock"> = {};
    if (affectedIds.length) {
      const current = await supabaseRequestAll<Pick<Purchase, "id" | "stock_status">>(`purchases?id=in.(${affectedIds.join(",")})&select=id,stock_status`);
      for (const p of current) currentStockById[p.id] = p.stock_status;
    }

    const reversal = buildReturnReversal({ record, purchaseCostByUnit, currentStockById });
    if (reversal.conflicts.length) {
      return apiError("conflict", `Cannot cancel this return: ${reversal.conflicts.length} affected unit${reversal.conflicts.length === 1 ? " has" : "s have"} changed stock state since it completed. Resolve the stock conflict first.`, { conflictingPurchaseIds: reversal.conflicts });
    }

    const restoredStatus = resolveRestoreSaleStatus(input.restoreSaleStatus, record.prev_process_status);

    const outcome = await callTransition<{ record: ReturnRecordRow; already_applied: boolean }>("rl_apply_return_transition", {
      p_owner_id: user.id, p_return_id: record.id,
      p_updates: { workflow_status: "return_cancelled", cancelled_applied: true, reversed_movement_gen: reversal.nextGen },
      p_movements: reversal.movementsJson,
      p_stock_checks: reversal.stockChecksJson,
      p_sale_process_status: restoredStatus,
      p_audit: [
        ...(reversal.movements.length ? [auditEvent("inventory_restored", user.email ?? null, { reversed: reversal.movements.length })] : []),
        auditEvent("return_cancelled", user.email ?? null, { reversedMovements: reversal.movements.length }),
        auditEvent("sales_status_changed", user.email ?? null, { to: restoredStatus }),
      ],
      p_expect_not_applied: "cancelled",
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message, { conflictingPurchaseIds: outcome.conflictingPurchaseIds });
    if (outcome.data.already_applied) return NextResponse.json({ record: outcome.data.record, alreadyApplied: true });

    return NextResponse.json({ record: outcome.data.record, restoredSaleStatus: restoredStatus });
  } catch (error) { return safeApiError(error, "Could not cancel this return."); }
}
