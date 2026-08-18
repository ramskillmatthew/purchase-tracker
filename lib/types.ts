export type StockStatus = "in_stock" | "no_longer_in_stock";
export type Purchase = { id: string; order_date: string; purchased_from: string; seller_name: string; sku: string; item_description: string; item_size: string; quantity: number; item_condition: string; category: string; price_purchased: number; arrived: boolean | null; stock_status: StockStatus; created_at: string };

/**
 * GET /api/purchases list-view shape — every purchase plus whether it's
 * currently protected from deletion by an active/completed sale, and if so
 * which sales_orders.id protects it (there can be at most one, since the
 * double-sell-prevention partial unique index allows only one active
 * sale_items row per purchase at a time) — annotated in ONE bounded
 * follow-up query (see app/api/purchases/route.ts), never one request per
 * row. `protectedSaleId` is a live-computed hint for the UI (disabling a
 * destructive delete button, linking to the sale); the authoritative check
 * always happens again, transactionally, inside safe_delete_purchases
 * itself at the moment of deletion.
 */
export type PurchaseListItem = Purchase & { protectedSaleId: string | null };

/** Response shape shared by every purchase-deletion path (single, bulk, Clear All) — see supabase-safe-purchase-deletion.sql's safe_delete_purchases. */
export type DeletePurchasesResult = {
  requestedCount: number;
  deletedCount: number;
  protectedCount: number;
  protectedIds: string[];
  missingCount: number;
};
export type Expense = { id: string; purchase_date: string; purchased_from: string; arrived: boolean | null; item_description: string; cost: number; created_at: string };
export type Task = { id: string; owner_id: string; title: string; notes: string | null; category: string; priority: string; due_date: string | null; completed: boolean; completed_at: string | null; created_at: string; updated_at: string };

// ============================================================================
// Sales domain (Stage 2) — see supabase-sales.sql for the underlying tables
// and the atomic create_completed_sale() RPC, and lib/sales/* for the pure
// allocation/profit/margin functions these types support.
// ============================================================================

export type SalesPlatform = "vinted" | "ebay" | "depop" | "other";
export type SalesStatus = "completed" | "refunded" | "cancelled";
export type SalesRevenueInputMode = "total" | "average" | "itemised";
/** What happened to the linked purchase units at the moment a sale was cancelled — see supabase-sales-v3.sql. Never re-derive this from a purchase's CURRENT stock_status, which can legitimately change again later. */
export type CancellationStockAction = "returned_to_stock" | "kept_out_of_stock";

/** A DB row from public.sales_orders — order-level facts only; see SaleItem for the per-purchase lines. */
export type SalesOrder = {
  id: string;
  owner_id: string;
  sale_date: string;
  platform: SalesPlatform;
  // Populated only when platform === "other"; null otherwise (enforced by a
  // DB check constraint — see supabase-sales.sql).
  custom_platform_name: string | null;
  revenue_input_mode: SalesRevenueInputMode;
  // The raw value the user typed (a total OR a per-item average, per
  // revenue_input_mode) — kept for traceability alongside the normalised
  // total_revenue below, which is what every calculation and report reads.
  revenue_input_value: number;
  total_revenue: number;
  platform_fees: number;
  postage: number;
  status: SalesStatus;
  // Both null until the order is cancelled, then set together and never
  // changed again — see supabase-sales-v3.sql's cancel_completed_sales.
  cancelled_at: string | null;
  cancellation_stock_action: CancellationStockAction | null;
  created_at: string;
  updated_at: string;
};

/**
 * A DB row from public.sale_items — one row per exact purchase UUID included
 * in a sale. The `*_snapshot` fields are captured at sale-creation time and
 * never updated afterwards, even if the source purchase is later edited —
 * see the RPC's own comment in supabase-sales.sql. `is_active` is what the
 * double-sell-prevention partial unique index is built on: true for every
 * currently-completed-and-not-refunded/cancelled sale item.
 */
export type SaleItem = {
  id: string;
  sales_order_id: string;
  // Nullable — see supabase-safe-purchase-deletion.sql's safe_delete_purchases.
  // Set to null only when the linked purchase is deleted AND every
  // sale_items row referencing it was already safely inactive on a
  // non-completed order (a cancelled/refunded sale). Every snapshot field
  // below is captured at sale-creation time and remains fully populated
  // regardless — a null purchase_id never implies missing data, only that
  // the original purchase record no longer exists. Never use purchase_id as
  // a React list key (it can repeat — null — across rows); use `id`.
  purchase_id: string | null;
  sku_snapshot: string;
  item_description_snapshot: string;
  category_snapshot: string;
  item_condition_snapshot: string;
  condition_group_snapshot: string;
  purchase_cost_snapshot: number;
  purchased_from_snapshot: string;
  allocated_revenue: number;
  allocated_platform_fee: number;
  allocated_postage: number;
  profit: number;
  is_active: boolean;
  created_at: string;
};

export type SalesOrderWithItems = SalesOrder & { items: SaleItem[] };

/** One description snapshot repeated N times in an order — see lib/sales/order-summary.ts. */
export type ItemDescriptionGroup = { description: string; quantity: number };

/**
 * GET /api/sales list-view shape — the order plus aggregates derived from
 * its sale_items in ONE bounded follow-up query (see app/api/sales/route.ts),
 * never one request per order: how many units, its exact profit (summed
 * from each sale_item's own saved `profit`, matching the sale detail page
 * exactly), and its description snapshots grouped by quantity.
 */
export type SalesOrderListItem = SalesOrder & { itemCount: number; profitPence: number; itemGroups: ItemDescriptionGroup[] };

export type SaleLineRevenue = { purchaseId: string; revenue: number };

/** POST /api/sales request body. Purchase cost/description/category/SKU/supplier are never accepted from the client — see app/api/sales/route.ts. */
export type CreateSaleInput = {
  purchaseIds: string[];
  saleDate: string;
  platform: SalesPlatform;
  customPlatformName?: string | null;
  revenueInputMode: SalesRevenueInputMode;
  revenueInputValue: number;
  // itemised mode only (Stage 4 mixed baskets) — one entry per selected
  // purchase; the server re-validates coverage and reconciliation, never
  // trusts this blindly.
  lineRevenues?: SaleLineRevenue[];
  platformFees?: number;
  postage?: number;
};

export type CreateSaleResult = { order: SalesOrder; items: SaleItem[] };

/** POST /api/sales/cancel request body — see lib/validation/sales.ts and supabase-sales-v3.sql's cancel_completed_sales. */
export type CancelSalesInput = { salesOrderIds: string[]; returnToStock: boolean };

export type CancelSalesResult = { ordersCancelled: number; unitsAffected: number };
