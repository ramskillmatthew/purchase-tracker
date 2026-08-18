"use client";
import { useEffect } from "react";
import type { SalesOrderListItem } from "@/lib/types";
import { formatPenceAsGBP, poundsToPence } from "@/lib/sales/money";
import styles from "@/app/sales/sales.module.css";

/**
 * Bulk-cancellation confirmation for the Sales history's "Delete N
 * selected" action. Deliberately NOT the shared ConfirmDialog (used by
 * Purchases' own bulk delete) — that component is a fixed 2-button
 * confirm/cancel shape, but this flow needs a third, load-bearing choice
 * (what happens to the linked stock), so each of the three actions is its
 * own explicit button rather than a checkbox behind one generic "Confirm".
 * Reuses the same .dialog-backdrop overlay and button classes as the rest
 * of the app for a consistent look, styled via sales.module.css (this
 * feature's own CSS module — see that file's header comment) rather than
 * adding to globals.css.
 *
 * Never deletes anything itself — see app/sales/page.tsx's cancelSelected,
 * which is the only thing that calls POST /api/sales/cancel.
 */
export default function CancelSalesDialog({ orders, submittingAction, error, onCancel, onConfirm }: {
  orders: SalesOrderListItem[];
  // Which of the two cancel actions is currently in flight, if any — drives
  // both buttons' disabled/processing state together, so a user can never
  // fire the second action while the first is still being applied.
  submittingAction: "return" | "keep" | null;
  error: string;
  onCancel: () => void;
  onConfirm: (returnToStock: boolean) => void;
}) {
  const submitting = submittingAction !== null;
  const unitCount = orders.reduce((sum, order) => sum + order.itemCount, 0);
  const revenuePence = orders.reduce((sum, order) => sum + poundsToPence(Number(order.total_revenue)), 0);
  const profitPence = orders.reduce((sum, order) => sum + order.profitPence, 0);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !submitting) onCancel(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, submitting]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !submitting) onCancel(); }}>
    <div className={styles.cancelDialog} role="alertdialog" aria-modal="true" aria-labelledby="cancel-sales-title" aria-describedby="cancel-sales-message">
      <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close" disabled={submitting}>×</button>
      <p className={styles.cancelDialogEyebrow}>Cancel {orders.length} sale{orders.length === 1 ? "" : "s"}</p>
      <h2 id="cancel-sales-title">Cancel the selected sales?</h2>
      <p id="cancel-sales-message" className={styles.cancelDialogMessage}>
        {orders.length} sale{orders.length === 1 ? "" : "s"} covering {unitCount} exact purchase unit{unitCount === 1 ? "" : "s"} will be changed from Completed to Cancelled. The full record — revenue, fees, profit, and every line item — stays on file for audit history. Nothing is permanently deleted.
      </p>
      <div className={styles.cancelDialogStats}>
        <div><span>Sales</span><strong>{orders.length}</strong></div>
        <div><span>Units</span><strong>{unitCount}</strong></div>
        <div><span>Revenue removed from reporting</span><strong>{formatPenceAsGBP(revenuePence)}</strong></div>
        <div><span>Profit removed from reporting</span><strong className={profitPence < 0 ? styles.negative : undefined}>{formatPenceAsGBP(profitPence)}</strong></div>
      </div>
      <p className={styles.cancelDialogQuestion}>Are these items back in stock?</p>
      {error && <p className="import-select-error" role="alert">{error}</p>}
      <div className={styles.cancelDialogActions}>
        <button type="button" className="button" onClick={() => onConfirm(true)} disabled={submitting}>
          {submittingAction === "return" ? "Returning to stock…" : "Yes, return items to stock"}
        </button>
        <button type="button" className="button-secondary" onClick={() => onConfirm(false)} disabled={submitting}>
          {submittingAction === "keep" ? "Cancelling…" : "No, keep items out of stock"}
        </button>
        <button type="button" className={styles.cancelDialogDismiss} onClick={onCancel} disabled={submitting}>Cancel</button>
      </div>
    </div>
  </div>;
}
