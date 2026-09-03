import type { ReturnOutcome } from "@/lib/returns/financial";
import type { ReturnWorkflowStatus } from "@/lib/returns/status-sync";
import type { DatePrecision } from "@/lib/returns/date-precision";

/** DB row shapes for the Returns, Losses & Write-offs feature (see
 * supabase-returns-losses.sql). Money fields are numeric(10,2) strings/
 * numbers from PostgREST — always `Number(...)`ed before use, like the rest
 * of this app. */

export type ReturnRecordRow = {
  id: string;
  owner_id: string;
  reference: string;
  sales_order_id: string;
  quantity: number;
  sale_item_ids: string[];
  workflow_status: ReturnWorkflowStatus;
  outcome: ReturnOutcome | null;
  started_on: string;
  started_precision: DatePrecision;
  item_sent_on: string | null;
  item_sent_precision: DatePrecision | null;
  delivered_on: string | null;
  delivered_precision: DatePrecision | null;
  completed_on: string | null;
  completed_precision: DatePrecision | null;
  recognition_month: string | null;
  revenue_reversed: number | string;
  profit_reversed: number | string;
  original_sale_revenue: number | string;
  original_sale_profit: number | string;
  original_stock_cost: number | string;
  inventory_write_off: number | string;
  stock_value_restored: number | string;
  net_profit_impact: number | string;
  refund_amount: number | string;
  partial_refund_amount: number | string | null;
  return_postage: number | string;
  unrecovered_costs: number | string;
  other_costs: number | string;
  prev_process_status: string | null;
  restock_purchase_ids: string[];
  reversed_movement_gen: number;
  completed_applied: boolean;
  cancelled_applied: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LossType = "lost_inventory" | "unsellable_purchase" | "refund_without_return" | "other_write_off";

export type LossRecordRow = {
  id: string;
  owner_id: string;
  reference: string;
  loss_type: LossType;
  purchase_id: string | null;
  sales_order_id: string | null;
  quantity: number;
  unit_cost: number | string;
  stock_value_removed: number | string;
  customer_refund: number | string;
  other_costs: number | string;
  net_profit_impact: number | string;
  event_date: string;
  event_precision: DatePrecision;
  event_month: string;
  logged_date: string;
  logged_precision: DatePrecision;
  logged_by: string | null;
  stock_action: "remove_from_stock" | "keep_in_stock";
  written_off_purchase_ids: string[];
  sale_item_ids: string[];
  reversed_movement_gen: number;
  applied: boolean;
  /** Client-supplied stable request key; de-duplicates an accidental
   * double-submit of "Log loss" via loss_records_owner_idempotency_key_uidx. */
  idempotency_key: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type InventoryMovementRow = {
  id: string;
  owner_id: string;
  purchase_id: string;
  direction: "out_of_stock" | "back_in_stock";
  reason: "lost" | "unsellable" | "refunded_no_return" | "returned_to_stock" | "loss_reversed" | "return_reversed";
  return_record_id: string | null;
  loss_record_id: string | null;
  unit_cost: number | string;
  idempotency_key: string;
  created_by: string | null;
  created_at: string;
};

export type ReturnLossAuditEventRow = {
  id: string;
  owner_id: string;
  return_record_id: string | null;
  loss_record_id: string | null;
  event_type:
    | "record_created" | "status_changed" | "sale_linked" | "purchase_linked"
    | "quantity_changed" | "amount_changed" | "inventory_restored" | "inventory_written_off"
    | "return_completed" | "outcome_selected" | "return_cancelled" | "record_edited"
    | "record_reversed" | "record_deleted" | "recognition_month_changed" | "sales_status_changed";
  detail: Record<string, unknown>;
  actor: string | null;
  created_at: string;
};

/** The "sold unit" facts the return-rate cohort needs — one entry per active
 * sale_items row (each represents one sold unit in this app's model). */
export type SoldUnitCohortEntry = {
  saleDate: string;
  saleStatus: "completed" | "refunded" | "cancelled";
};
