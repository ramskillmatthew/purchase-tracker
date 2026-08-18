import "server-only";
import { supabaseRequestAll } from "@/lib/supabase";

/** purchase_id -> the sales_orders.id currently protecting it from deletion. */
export type PurchaseProtectionMap = Map<string, string>;

/**
 * Computes which purchases are currently protected from deletion, and by
 * which sale, via bounded follow-up queries — never one request per
 * purchase (mirrors GET /api/sales's own itemCount/profitPence annotation
 * pattern). Mirrors safe_delete_purchases' own protection rule exactly
 * (supabase-safe-purchase-deletion.sql): a purchase is protected the moment
 * any sale_items row referencing it is still active, or is inactive but its
 * order is still 'completed' (inconsistent data — treated as protected
 * rather than guessed past). This is a live UI hint only; the RPC itself is
 * what actually enforces this, transactionally, at the moment of deletion.
 */
export async function loadPurchaseProtectionMap(): Promise<PurchaseProtectionMap> {
  const items = await supabaseRequestAll<{ purchase_id: string | null; sales_order_id: string; is_active: boolean }>(
    "sale_items?purchase_id=not.is.null&select=purchase_id,sales_order_id,is_active&order=created_at.asc",
  );
  if (!items.length) return new Map();

  const orderIds = Array.from(new Set(items.map(item => item.sales_order_id)));
  const orders = await supabaseRequestAll<{ id: string; status: string }>(
    `sales_orders?id=in.(${orderIds.join(",")})&select=id,status`,
  );
  const statusByOrderId = new Map(orders.map(order => [order.id, order.status]));

  const protection: PurchaseProtectionMap = new Map();
  for (const item of items) {
    if (!item.purchase_id || protection.has(item.purchase_id)) continue;
    const orderStatus = statusByOrderId.get(item.sales_order_id);
    if (item.is_active || orderStatus === "completed") protection.set(item.purchase_id, item.sales_order_id);
  }
  return protection;
}
