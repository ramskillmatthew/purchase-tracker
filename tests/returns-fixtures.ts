import type { ReturnRecordRow, LossRecordRow } from "@/lib/returns/types";

/** Shared, fully-typed row fixtures for the Returns/Losses test suite. */

export function returnRow(overrides: Partial<ReturnRecordRow> = {}): ReturnRecordRow {
  return {
    id: "ret-1", owner_id: "owner-1", reference: "RET-00001", sales_order_id: "sale-1",
    quantity: 1, sale_item_ids: ["si-1"],
    workflow_status: "return_completed", outcome: "returned_safely",
    started_on: "2026-09-01", started_precision: "exact",
    item_sent_on: null, item_sent_precision: null, delivered_on: null, delivered_precision: null,
    completed_on: "2026-09-03", completed_precision: "exact", recognition_month: "2026-09",
    revenue_reversed: 35, profit_reversed: 12.4, original_sale_revenue: 35, original_sale_profit: 12.4,
    original_stock_cost: 22.6, inventory_write_off: 0, stock_value_restored: 22.6, net_profit_impact: -15.89,
    refund_amount: 35, partial_refund_amount: null, return_postage: 3.49, unrecovered_costs: 0, other_costs: 0,
    prev_process_status: "awaiting_dispatch", restock_purchase_ids: ["p1"], reversed_movement_gen: 0,
    completed_applied: true, cancelled_applied: false, deleted_at: null, deleted_by: null,
    notes: null, created_by: "owner@example.com",
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

export function lossRow(overrides: Partial<LossRecordRow> = {}): LossRecordRow {
  return {
    id: "loss-1", owner_id: "owner-1", reference: "LOS-00001", loss_type: "lost_inventory",
    purchase_id: "p9", sales_order_id: null, quantity: 1, unit_cost: 47, stock_value_removed: 47,
    customer_refund: 0, other_costs: 0, net_profit_impact: -47,
    event_date: "2026-09-05", event_precision: "exact", event_month: "2026-09",
    logged_date: "2026-09-05", logged_precision: "exact", logged_by: "Admin",
    stock_action: "remove_from_stock", written_off_purchase_ids: ["p9"], sale_item_ids: [], reversed_movement_gen: 0,
    applied: true, idempotency_key: null, deleted_at: null, deleted_by: null,
    notes: null, created_by: "Admin", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}
