import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { formatMarginPercent, formatPenceAsGBP, poundsToPence } from "@/lib/sales/money";
import { calculateMarginPercent } from "@/lib/sales/profit";
import type { SaleItem, SalesOrder } from "@/lib/types";
import styles from "../sales.module.css";

const PLATFORM_LABELS: Record<string, string> = { vinted: "Vinted", ebay: "eBay", depop: "Depop", other: "Other" };

function ukDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireOwner();

  const [order] = await (await supabaseRequest(`sales_orders?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}&select=*`)).json() as SalesOrder[];
  if (!order) notFound();

  const items = await supabaseRequestAll<SaleItem>(`sale_items?sales_order_id=eq.${encodeURIComponent(id)}&order=created_at.asc`);

  const revenuePence = poundsToPence(Number(order.total_revenue));
  const feesPence = poundsToPence(Number(order.platform_fees));
  const postagePence = poundsToPence(Number(order.postage));
  const stockCostPence = items.reduce((sum, item) => sum + poundsToPence(Number(item.purchase_cost_snapshot)), 0);
  const profitPence = items.reduce((sum, item) => sum + poundsToPence(Number(item.profit)), 0);
  const marginPercent = calculateMarginPercent(profitPence, revenuePence);
  const platformLabel = order.platform === "other" && order.custom_platform_name ? order.custom_platform_name : (PLATFORM_LABELS[order.platform] ?? order.platform);
  // The durable record of what happened to stock at the moment this sale
  // was cancelled — never re-derived from the linked purchases' CURRENT
  // stock_status, which can legitimately change again later (e.g. an
  // item returned to stock gets sold again in a separate, later sale).
  // See supabase-sales-v3.sql's cancel_completed_sales.
  const cancellationNote = order.status === "cancelled" && order.cancellation_stock_action
    ? (order.cancellation_stock_action === "returned_to_stock"
      ? "Cancelled — the linked purchase units were returned to stock."
      : "Cancelled — the linked purchase units were kept out of stock.")
    : null;

  return <section className="page-shell">
    <div className="title-row" style={{ marginBottom: 4 }}>
      <Link href="/sales" className="button-secondary" style={{ display: "inline-flex", minHeight: 32, padding: "0 12px", fontSize: 11 }}>← Back to Sales</Link>
    </div>
    <header className={styles.topbar}>
      <div className="title-row"><h1>Sale — {ukDate(order.sale_date)}</h1>
        <span className={`${styles.statusPill} ${order.status === "completed" ? styles.statusCompleted : order.status === "refunded" ? styles.statusRefunded : styles.statusCancelled}`}>{order.status}</span>
      </div>
    </header>

    {cancellationNote && <p className={styles.cancellationNote}><strong>{cancellationNote}</strong></p>}

    <div className={styles.detailGrid}>
      <div className={styles.detailFact}><span>Platform</span><strong>{platformLabel}</strong></div>
      <div className={styles.detailFact}><span>Units</span><strong>{items.length}</strong></div>
      <div className={styles.detailFact}><span>Revenue</span><strong>{formatPenceAsGBP(revenuePence)}</strong></div>
      <div className={styles.detailFact}><span>Stock cost</span><strong>{formatPenceAsGBP(stockCostPence)}</strong></div>
      <div className={styles.detailFact}><span>Fees</span><strong>{formatPenceAsGBP(feesPence)}</strong></div>
      <div className={styles.detailFact}><span>Postage</span><strong>{formatPenceAsGBP(postagePence)}</strong></div>
      <div className={styles.detailFact}><span>Profit</span><strong className={profitPence < 0 ? styles.negative : undefined}>{formatPenceAsGBP(profitPence)}</strong></div>
      <div className={styles.detailFact}><span>Margin</span><strong>{formatMarginPercent(marginPercent)}</strong></div>
    </div>

    <div className="data-panel">
      <div className="table-scroll">
        <table className={styles.itemsTable}>
          <thead><tr>
            <th>Description</th><th>SKU</th><th>Category</th><th>Condition</th>
            <th className={styles.numeric}>Cost</th><th className={styles.numeric}>Revenue</th><th className={styles.numeric}>Fees</th><th className={styles.numeric}>Postage</th><th className={styles.numeric}>Profit</th>
          </tr></thead>
          <tbody>
            {items.map(item => {
              const itemProfitPence = poundsToPence(Number(item.profit));
              return <tr key={item.id}>
                <td>{item.item_description_snapshot}{item.purchase_id === null && <span className={styles.deletedPurchaseNote}> · Original purchase deleted</span>}</td>
                <td>{item.sku_snapshot || "—"}</td>
                <td>{item.category_snapshot}</td>
                <td>{item.item_condition_snapshot}</td>
                <td className={styles.numeric}>{formatPenceAsGBP(poundsToPence(Number(item.purchase_cost_snapshot)))}</td>
                <td className={styles.numeric}>{formatPenceAsGBP(poundsToPence(Number(item.allocated_revenue)))}</td>
                <td className={styles.numeric}>{formatPenceAsGBP(poundsToPence(Number(item.allocated_platform_fee)))}</td>
                <td className={styles.numeric}>{formatPenceAsGBP(poundsToPence(Number(item.allocated_postage)))}</td>
                <td className={styles.numeric} style={itemProfitPence < 0 ? { color: "var(--danger)" } : undefined}>{formatPenceAsGBP(itemProfitPence)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>

    <p className={styles.readOnlyNote}>
      This sale record is read-only. Every field above (including each item&apos;s snapshot) reflects exactly what was true at the moment the sale was recorded — a later edit to a purchase never changes this history, and cancelling a sale (from the Sales list) never rewrites it either, only its status and its items&apos; active flag. Refunding a sale is planned for a later stage and is not available here yet.
    </p>
  </section>;
}
