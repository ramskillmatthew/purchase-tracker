"use client";
import { useEffect } from "react";
import Link from "next/link";

/**
 * Shown instead of the destructive delete confirmation when a purchase is
 * currently protected by a completed sale — never a destructive confirm
 * button here, only an explanation and a route to the sale that's blocking
 * it (see app/purchases/page.tsx, safe_delete_purchases in
 * supabase-safe-purchase-deletion.sql). Purely informational: closing this
 * makes no request and changes nothing.
 */
export default function PurchaseProtectedDialog({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="purchase-protected-title" aria-describedby="purchase-protected-message">
      <button className="dialog-close" type="button" onClick={onClose} aria-label="Close">×</button>
      <div className="dialog-copy">
        <p className="dialog-eyebrow">Protected</p>
        <h2 id="purchase-protected-title">This purchase can&apos;t be deleted yet</h2>
        <p id="purchase-protected-message">This purchase belongs to a completed sale. Cancel the sale before deleting the purchase.</p>
      </div>
      <div className="dialog-actions dialog-actions-single">
        <Link href={`/sales/${saleId}`} className="dialog-cancel" style={{ display: "grid", placeItems: "center", textDecoration: "none" }}>View the sale</Link>
      </div>
    </div>
  </div>;
}
