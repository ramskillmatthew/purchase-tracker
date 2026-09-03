import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { supabaseRequest } from "@/lib/supabase";
import { advanceReturnStageInputSchema, uuidSchema } from "@/lib/validation/returns-losses";
import { anchorDate } from "@/lib/returns/date-precision";
import { isAllowedWorkflowTransition, stageDateColumns, RETURN_IN_PROGRESS_SALE_STATUS } from "@/lib/returns/status-sync";
import { apiError, auditEvent, callTransition } from "@/lib/returns/route-helpers";
import type { ReturnRecordRow } from "@/lib/returns/types";

export const runtime = "nodejs";

/**
 * POST /api/returns/[id]/status — advance a return through its intermediate
 * workflow stages ONLY (item_sent, return_delivered). Completion goes
 * through /complete, cancellation through /cancel.
 *
 * - Owner-scoped; validates the transition (no backward moves, no skipping
 *   past a stage that has effects, not from a completed/cancelled return).
 * - Records the stage's own date + precision without erasing earlier stage
 *   dates.
 * - Keeps the linked sale at 'return_in_process' (idempotent PATCH).
 * - Atomic (rl_apply_return_transition, row locked).
 * - Idempotent: setting the stage it is already at returns unchanged.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOwner();
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return apiError("validation", "Invalid return id.");
    const input = advanceReturnStageInputSchema.parse(await request.json());

    const [record] = await (await supabaseRequest(`return_records?id=eq.${id}&owner_id=eq.${user.id}&deleted_at=is.null&select=*`)).json() as ReturnRecordRow[];
    if (!record) return apiError("not_found", "Return not found.");

    if (record.workflow_status === input.stage) {
      return NextResponse.json({ record, alreadyApplied: true }); // idempotent no-op
    }
    if (record.workflow_status === "return_completed" || record.workflow_status === "return_cancelled") {
      return apiError("conflict", `A ${record.workflow_status.replace("return_", "").replace("_", " ")} return cannot change stage.`);
    }
    if (!isAllowedWorkflowTransition(record.workflow_status, input.stage)) {
      return apiError("conflict", `Cannot move a return from "${record.workflow_status}" to "${input.stage}".`);
    }

    const pd = input.precision === "month"
      ? { precision: "month" as const, month: input.date.slice(0, 7) }
      : { precision: "exact" as const, date: input.date };
    const cols = stageDateColumns(input.stage);

    const outcome = await callTransition<{ record: ReturnRecordRow }>("rl_apply_return_transition", {
      p_owner_id: user.id, p_return_id: record.id,
      p_updates: {
        workflow_status: input.stage,
        ...(cols ? { [cols.date]: anchorDate(pd), [cols.precision]: input.precision } : {}),
      },
      p_movements: [], p_stock_checks: [],
      p_sale_process_status: RETURN_IN_PROGRESS_SALE_STATUS,
      p_audit: [auditEvent("status_changed", user.email ?? null, { from: record.workflow_status, to: input.stage, on: anchorDate(pd), precision: input.precision })],
      p_expect_not_applied: "",
    });
    if (!outcome.ok) return apiError(outcome.kind, outcome.message);

    return NextResponse.json({ record: outcome.data.record });
  } catch (error) { return safeApiError(error, "Could not update this return's stage."); }
}
