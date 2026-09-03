import { salesProcessStatuses } from "@/lib/validation/sales";
import { isSalesProcessStatus } from "@/lib/sales/process-status";
import type { SalesProcessStatus } from "@/lib/types";

/**
 * Returns, Losses & Write-offs — the ONE place the linked-sale workflow
 * status synchronisation is defined. It reuses the app's existing
 * `sales_orders.process_status` enum (salesProcessStatuses / supabase-sales-
 * v4-process-status.sql) — it never invents a parallel status or a duplicate
 * variant.
 *
 * Lifecycle:
 *   - Return created / re-activated  -> linked sale process_status becomes
 *     'return_in_process'. The sale's PREVIOUS process_status is snapshotted
 *     on the return record (prev_process_status) first.
 *   - Return completed               -> linked sale process_status becomes
 *     'returned_cancelled' (the existing "Item returned - sale cancelled"
 *     status). The sale's financial `status` is separately moved to
 *     'cancelled' by the completion path, mirroring cancel_completed_sales.
 *   - Return cancelled / deleted     -> linked sale process_status is
 *     restored to prev_process_status, OR to a status the user explicitly
 *     picks from the real existing enum (never a hard-coded disconnected
 *     list).
 */

export const RETURN_IN_PROGRESS_SALE_STATUS: SalesProcessStatus = "return_in_process";
export const RETURN_COMPLETED_SALE_STATUS: SalesProcessStatus = "returned_cancelled";

/** The five visible return workflow stages (return_records.workflow_status). */
export const RETURN_WORKFLOW_STATUSES = [
  "return_started", "item_sent", "return_delivered", "return_completed", "return_cancelled",
] as const;
export type ReturnWorkflowStatus = typeof RETURN_WORKFLOW_STATUSES[number];

export const RETURN_WORKFLOW_LABELS: Record<ReturnWorkflowStatus, string> = {
  return_started: "Return started",
  item_sent: "Item sent",
  return_delivered: "Return delivered",
  return_completed: "Return completed",
  return_cancelled: "Return cancelled",
};

const STAGE_ORDER: ReturnWorkflowStatus[] = ["return_started", "item_sent", "return_delivered", "return_completed"];

/** Whether `to` is a permitted move from `from`. Forward moves (including
 * skipping a stage, when the user explicitly picks a later one) are allowed;
 * moving backwards out of 'return_completed' is not (use Cancel instead);
 * 'return_cancelled' is reachable from any active stage. */
export function isAllowedWorkflowTransition(from: ReturnWorkflowStatus, to: ReturnWorkflowStatus): boolean {
  if (from === to) return true;
  if (to === "return_cancelled") return from !== "return_completed";
  if (from === "return_cancelled") return to === "return_started"; // re-activate
  if (from === "return_completed") return false;
  return STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from);
}

/** The linked sale's process_status for a given active return stage. */
export function saleStatusForReturnStage(stage: ReturnWorkflowStatus): SalesProcessStatus | null {
  if (stage === "return_completed") return RETURN_COMPLETED_SALE_STATUS;
  if (stage === "return_cancelled") return null; // caller restores explicitly
  return RETURN_IN_PROGRESS_SALE_STATUS;
}

/** The set of statuses a Cancel/Delete "restore linked sale to..." control
 * may offer — the genuine existing enum, minus the transient return one. */
export function restorableSaleStatuses(): SalesProcessStatus[] {
  return salesProcessStatuses.filter(s => s !== "return_in_process");
}

/** The (date, precision) column pair a workflow stage records its timestamp in. */
export function stageDateColumns(stage: ReturnWorkflowStatus): { date: string; precision: string } | null {
  switch (stage) {
    case "return_started": return { date: "started_on", precision: "started_precision" };
    case "item_sent": return { date: "item_sent_on", precision: "item_sent_precision" };
    case "return_delivered": return { date: "delivered_on", precision: "delivered_precision" };
    case "return_completed": return { date: "completed_on", precision: "completed_precision" };
    case "return_cancelled": return null; // cancellation date lives in the audit event, not a dedicated column
  }
}

/** The intermediate stages the dedicated "advance stage" endpoint owns.
 * `return_completed` goes through /complete; `return_cancelled` through
 * /cancel; both are rejected here. */
export const ADVANCEABLE_STAGES = ["item_sent", "return_delivered"] as const;
export type AdvanceableStage = typeof ADVANCEABLE_STAGES[number];

/** Validate a user-selected restore status against the real enum. Falls back
 * to the snapshotted previous status, then to 'awaiting_dispatch'. */
export function resolveRestoreSaleStatus(
  chosen: string | null | undefined,
  previous: string | null | undefined,
): SalesProcessStatus {
  if (isSalesProcessStatus(chosen) && chosen !== "return_in_process") return chosen;
  if (isSalesProcessStatus(previous) && previous !== "return_in_process") return previous;
  return "awaiting_dispatch";
}
