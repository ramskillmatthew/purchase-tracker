/**
 * Classifies an error raised by calling rpc/create_completed_sale (see
 * supabase-sales.sql) as either a known, expected validation/availability
 * conflict, or something genuinely unexpected. Mirrors
 * lib/purchase-import/rpc-errors.ts's exact pattern for import_purchase_order.
 *
 * Only a recognized conflict should ever be reported back as a clear,
 * specific reason (e.g. "that purchase is already sold"). Anything else — a
 * missing migration/function, a database outage, a permission problem, or
 * any other programming error — must propagate so the request fails safely
 * and visibly instead of being silently absorbed.
 */
export const KNOWN_SALE_RPC_CONFLICTS: Record<string, string> = {
  INVALID_PLATFORM: "invalid_platform",
  CUSTOM_PLATFORM_NAME_REQUIRED: "custom_platform_name_required",
  CUSTOM_PLATFORM_NAME_NOT_ALLOWED: "custom_platform_name_not_allowed",
  INVALID_REVENUE_MODE: "invalid_revenue_mode",
  NEGATIVE_AMOUNT: "negative_amount",
  NO_ITEMS: "no_items",
  TOO_MANY_ITEMS: "too_many_items",
  DUPLICATE_PURCHASE_IDS: "duplicate_purchase_ids",
  PURCHASE_NOT_FOUND: "purchase_not_found",
  PURCHASE_NOT_AVAILABLE: "purchase_not_available",
  PURCHASE_ALREADY_SOLD: "purchase_already_sold",
  // Stage 4 (supabase-sales-v2.sql) — itemised-mode (mixed basket) revenue.
  ITEMISED_LINES_REQUIRED: "itemised_lines_required",
  ITEMISED_LINE_COUNT_MISMATCH: "itemised_line_count_mismatch",
  ITEMISED_LINE_PURCHASE_MISMATCH: "itemised_line_purchase_mismatch",
  ITEMISED_REVENUE_MISMATCH: "itemised_revenue_mismatch",
  ITEMISED_DATA_NOT_ALLOWED: "itemised_data_not_allowed",
  // v3 (supabase-sales-v3.sql) — bulk cancellation.
  EMPTY_SELECTION: "empty_selection",
  TOO_MANY_SALES: "too_many_sales",
  DUPLICATE_SALE_IDS: "duplicate_sale_ids",
  SALE_NOT_FOUND: "sale_not_found",
  SALE_NOT_COMPLETED: "sale_not_completed",
};

/** Returns the reason code for a known conflict, or null if the error is unrecognized (and must propagate). */
export function classifySaleRpcError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  for (const [code, reason] of Object.entries(KNOWN_SALE_RPC_CONFLICTS)) if (message.includes(code)) return reason;
  return null;
}
