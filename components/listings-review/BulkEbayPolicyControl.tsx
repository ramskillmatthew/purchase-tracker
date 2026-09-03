"use client";

import { useState } from "react";
import type { EbayPolicyOption } from "./EbayPolicySelectors";

export type BulkPolicyApplyResult = { appliedCount: number; skippedCount: number; skipped: Array<{ draftId: string; reason: string }> };

/**
 * Stage 6 (eBay draft batches) — the "Set eBay shipping policy" bulk
 * control, living in the existing selected-items action bar directly
 * beneath the final listing row (never a page-bottom sticky toolbar).
 * Opens a drop-up panel (this bar sits near the bottom of the viewport, so
 * a drop-up keeps the panel on-screen without needing dynamic positioning
 * logic) listing every active, currently-synced fulfilment policy; applies
 * only to selected listings that have an eBay preparation and no existing
 * draft (see the /ebay-bulk-policy route's own skip rules) and reports
 * exactly how many were applied vs. skipped and why.
 */
export default function BulkEbayPolicyControl({ eligibleCount, policies, onApply, disabledReason }: {
  eligibleCount: number;
  policies: EbayPolicyOption[];
  onApply: (ebayPolicyId: string) => Promise<BulkPolicyApplyResult>;
  // Corrective pass — set only when the eBay draft-batches migration
  // (which also adds the ebay_*_policy_id columns this control writes to)
  // hasn't been applied yet. The button stays visible but disabled, with
  // this text as its title, rather than disappearing without explanation.
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<BulkPolicyApplyResult | null>(null);

  const shippingPolicies = policies.filter(p => p.policyType === "FULFILLMENT" && p.available);
  const disabled = Boolean(disabledReason);

  async function handleApply() {
    if (!selected || applying) return;
    setApplying(true);
    setResult(null);
    try {
      const outcome = await onApply(selected);
      setResult(outcome);
    } finally {
      setApplying(false);
    }
  }

  return <div className="lr-bulk-ebay-policy">
    <button type="button" className="button-secondary" disabled={disabled} title={disabledReason} onClick={() => setOpen(current => !current)} aria-expanded={open}>
      Set eBay shipping policy
    </button>
    {open && !disabled && <div className="lr-bulk-ebay-policy-panel" role="dialog" aria-label="Set eBay shipping policy">
      <label className="field">
        <span className="label">Shipping policy</span>
        <select className="input" value={selected} onChange={event => { setSelected(event.target.value); setResult(null); }}>
          <option value="">Choose a policy…</option>
          {shippingPolicies.map(p => <option key={p.ebayPolicyId} value={p.ebayPolicyId}>{p.name}</option>)}
        </select>
      </label>
      <p className="lr-bulk-ebay-policy-count">{eligibleCount} eligible listing{eligibleCount === 1 ? "" : "s"} selected</p>
      <button type="button" className="button" disabled={!selected || applying || eligibleCount === 0} onClick={handleApply}>
        {applying ? "Applying…" : `Apply to ${eligibleCount} eligible listing${eligibleCount === 1 ? "" : "s"}`}
      </button>
      {result && <p className="lr-bulk-ebay-policy-result" role="status">
        Applied to {result.appliedCount} listing{result.appliedCount === 1 ? "" : "s"}.
        {result.skippedCount > 0 && ` ${result.skippedCount} skipped: ${[...new Set(result.skipped.map(s => s.reason))].join(", ")}.`}
      </p>}
    </div>}
  </div>;
}
