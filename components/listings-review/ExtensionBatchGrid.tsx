"use client";

import { memo } from "react";
import { isBatchStatusTerminal } from "@/lib/listing-studio/extension-workflow-status";

// Multi-batch support — one view model per box, already fully resolved by
// the parent (ListingsReviewWorkspace.tsx) from its batchStatusById/
// visibleBatchIds/pairingCodeById state. This component is presentational
// only: it renders whatever it's given and reports clicks back via
// callbacks — it never fetches, polls, or holds its own batch state.
export type BatchBoxViewModel = {
  batchId: string;
  displayNumber: number;
  browserLabel: string | null;
  // "pending" — a box exists (the create call succeeded) but no status
  // poll has landed for it yet; shown as a brief, inert "Preparing…" card
  // rather than an empty gap in the grid.
  status: "pending" | string;
  listingCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  currentItemLabel: string | null;
  pairingCode: string | null;
  expiresAt: string | null;
  codeCopied: boolean;
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatRelativeMinutes(isoTimestamp: string): string {
  const minutes = Math.round((new Date(isoTimestamp).getTime() - Date.now()) / 60000);
  if (minutes <= 0) return "any moment now";
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function terminalSummary(box: BatchBoxViewModel): string {
  const unfinished = box.listingCount - box.completedCount - box.failedCount - box.cancelledCount;
  if (box.status === "completed") {
    if (box.failedCount === 0) return `Completed — ${pluralize(box.completedCount, "listing")} saved to Vinted drafts.`;
    return `Completed — ${box.completedCount} of ${box.listingCount} saved, ${pluralize(box.failedCount, "failed")}.`;
  }
  if (box.status === "cancelled") {
    const parts = [`${box.completedCount} completed before cancelling`];
    if (unfinished > 0) parts.push(`${unfinished} not finished`);
    return `Cancelled — ${parts.join(", ")}.`;
  }
  if (box.status === "expired") return "Expired — this batch was never claimed by the extension.";
  return `Batch ${box.status}.`;
}

function BatchBox({ box, onCancel, onDismissBox, onCopyCode }: {
  box: BatchBoxViewModel;
  onCancel: (batchId: string) => void;
  onDismissBox: (batchId: string) => void;
  onCopyCode: (batchId: string) => void;
}) {
  const isPending = box.status === "pending";
  const isTerminal = !isPending && isBatchStatusTerminal(box.status);
  const isClaimed = !isPending && (box.status === "claimed" || box.status === "in_progress");
  const isWaitingForPairing = !isPending && box.status === "pending_claim";
  const processedCount = box.completedCount + box.failedCount;

  return <div className={`lr-batch-box${isTerminal ? " lr-batch-box-terminal" : ""}`} role="group" aria-label={`Batch ${box.displayNumber}`}>
    <div className="lr-batch-box-header">
      <span className="lr-batch-box-title">
        Batch {box.displayNumber}
        {box.browserLabel && <span className="lr-batch-box-browser">{box.browserLabel}</span>}
      </span>
      {isTerminal && <button type="button" className="lr-batch-box-dismiss" aria-label={`Dismiss Batch ${box.displayNumber} box`} onClick={() => onDismissBox(box.batchId)}>×</button>}
    </div>

    {isPending && <p className="lr-batch-box-status">Preparing batch…</p>}

    {isWaitingForPairing && <div className="lr-batch-box-body">
      <p className="lr-batch-box-status">Waiting for pairing</p>
      {box.pairingCode ? <>
        <div className="lr-batch-box-pairing">
          <code className="lr-pairing-code">{box.pairingCode}</code>
          <button type="button" className="lr-pairing-copy" onClick={() => onCopyCode(box.batchId)} aria-label={`Copy pairing code for Batch ${box.displayNumber}`}>
            {box.codeCopied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="lr-batch-box-hint">Enter this code in the extension&apos;s side panel — single use</p>
      </> : <p className="lr-batch-box-hint">Waiting for the extension to claim this batch…</p>}
      {box.expiresAt && <span className="lr-pairing-expiry">Expires {formatRelativeMinutes(box.expiresAt)}</span>}
      <button type="button" className="button-danger lr-batch-box-cancel" onClick={() => onCancel(box.batchId)}>Cancel</button>
    </div>}

    {isClaimed && <div className="lr-batch-box-body">
      <p className="lr-batch-box-status">Processing — {processedCount} of {box.listingCount}</p>
      {box.currentItemLabel && <p className="lr-batch-box-current-item">{box.currentItemLabel}</p>}
      <button type="button" className="button-secondary lr-batch-box-cancel" onClick={() => onCancel(box.batchId)}>Cancel batch</button>
    </div>}

    {isTerminal && <p className="lr-batch-box-status">{terminalSummary(box)}</p>}
  </div>;
}

/**
 * Multi-batch support — replaces the old single `.lr-pairing-strip` with a
 * two-column grid of independent batch boxes (desktop; collapses to one
 * column at the same breakpoint the rest of this page already uses — see
 * app/globals.css). Every box is fully independent: cancelling or
 * dismissing one never touches another's DOM node, state, or the
 * callbacks it reports through.
 */
function ExtensionBatchGrid({ batches, onCancel, onDismissBox, onCopyCode }: {
  batches: BatchBoxViewModel[];
  onCancel: (batchId: string) => void;
  onDismissBox: (batchId: string) => void;
  onCopyCode: (batchId: string) => void;
}) {
  if (batches.length === 0) return null;
  return <div className="lr-batch-grid" role="region" aria-label="Extension batches">
    {batches.map(box => <BatchBox key={box.batchId} box={box} onCancel={onCancel} onDismissBox={onDismissBox} onCopyCode={onCopyCode} />)}
  </div>;
}

export default memo(ExtensionBatchGrid);
