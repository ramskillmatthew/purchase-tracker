"use client";

import { useEffect, useRef, useState } from "react";
import type { EbayPolicyOption } from "./EbayPolicySelectors";

export type BulkPolicyApplyResult = { appliedCount: number; skippedCount: number; skipped: Array<{ draftId: string; reason: string }> };

/**
 * Stage 6 (eBay draft batches) — the "Set eBay shipping policy" bulk
 * control, living in the existing selected-items action bar directly
 * beneath the final listing row (never a page-bottom sticky toolbar).
 * Opens an inline panel listing every active, currently-synced fulfilment
 * policy; applies only to selected listings that have an eBay preparation
 * and no already-CONFIRMED Seller Hub draft (see the /ebay-bulk-policy
 * route's own skip rules — deliberately never blocked by a legacy,
 * unpublished Inventory API offer, and deliberately independent of
 * whether the listing is also sitting in an active/failed Seller Hub Feed
 * batch, since assigning a policy is harmless metadata unrelated to
 * either) and reports exactly how many were applied vs. skipped and why.
 *
 * CORRECTIVE PASS (action-bar rebuild) — this used to be an absolutely-
 * positioned drop-up overlay that could cover the table row behind it.
 * It is now a normal, statically-positioned block (see globals.css's own
 * .lr-bulk-ebay-policy-panel comment for the flex-basis technique) that
 * reserves its own space below the action row instead of floating over
 * anything. The open/close/outside-click/Escape behaviour below is
 * unchanged — only its CSS positioning changed.
 *
 * CORRECTIVE PASS — the panel previously had no way to close it once open
 * other than re-clicking the trigger: no visible × control, no outside-
 * click dismissal, no Escape handling, and no focus restoration. Mirrors
 * components/listing-studio/OverflowMenu.tsx's own established close
 * conventions (outside-click via a capture-phase mousedown check against
 * the container ref, Escape closes and returns focus to the trigger) —
 * adapted for a panel with real interactive controls (a <select> and an
 * Apply button) rather than a list of menu items. Never closes while the
 * user is genuinely interacting with the <select> — a native <select>'s
 * own open listbox is OS chrome, not a DOM node a mousedown/outside-click
 * check ever sees as "outside" this panel, so choosing an option never
 * triggers an accidental close. Closes automatically once an Apply
 * actually succeeds (a failed attempt keeps the panel open so the result/
 * error stays visible and the user can retry without reopening).
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

  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const shippingPolicies = policies.filter(p => p.policyType === "FULFILLMENT" && p.available);
  const disabled = Boolean(disabledReason);

  function closePanel() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  async function handleApply() {
    if (!selected || applying) return;
    setApplying(true);
    setResult(null);
    try {
      const outcome = await onApply(selected);
      setResult(outcome);
      // Only auto-close on a real success (something was actually
      // applied) — a 0-applied/all-skipped outcome keeps the panel open
      // so the skip reasons stay visible instead of vanishing instantly.
      if (outcome.appliedCount > 0) closePanel();
    } finally {
      setApplying(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePanel();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return <div className="lr-bulk-ebay-policy" ref={containerRef}>
    <button ref={triggerRef} type="button" className="button-secondary" disabled={disabled} title={disabledReason} onClick={() => setOpen(current => !current)} aria-expanded={open} aria-haspopup="dialog">
      Set eBay shipping policy
    </button>
    {open && !disabled && <div className="lr-bulk-ebay-policy-panel" role="dialog" aria-label="Set eBay shipping policy">
      <div className="lr-bulk-ebay-policy-panel-header">
        <span className="lr-bulk-ebay-policy-panel-title">Set eBay shipping policy</span>
        <button type="button" className="lr-bulk-ebay-policy-close" aria-label="Close" onClick={closePanel}>×</button>
      </div>
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
