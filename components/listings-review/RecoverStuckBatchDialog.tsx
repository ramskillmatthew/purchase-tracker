"use client";

// Follow-up correction (orphaned extension batch recovery) — the one
// dialog every "Recover stuck batch" entry point (the Hidden active batch
// section, and the inline "already part of another active batch" 409
// error) opens. Presentational only: it renders whatever it's given and
// reports the two possible actions back via callbacks — it never fetches
// or mutates anything itself.

export type RecoverDialogListing = { draftId: string; title: string; sku: string | null };

export type RecoverDialogBatch = {
  batchId: string;
  displayNumber: number;
  status: string;
  isHidden: boolean;
  lastExtensionActivityAt: string | null;
  completedCount: number;
  unfinishedCount: number;
};

function shortBatchId(batchId: string): string {
  return batchId.slice(0, 8);
}

function formatLastActivity(iso: string | null): string {
  if (!iso) return "No genuine extension activity was ever recorded for this batch.";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Less than a minute ago";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export function RecoverStuckBatchDialog({
  batch, listings, stillActiveWarning, recovering, error, onKeepWaiting, onRecover,
}: {
  batch: RecoverDialogBatch;
  listings: RecoverDialogListing[];
  // Set once an ordinary (force=false) attempt was refused because the
  // batch still shows genuine recent activity — offering the explicit,
  // stronger confirmation the user must take deliberately (never implied).
  stillActiveWarning: boolean;
  recovering: boolean;
  error: string;
  onKeepWaiting: () => void;
  onRecover: (force: boolean) => void;
}) {
  return (
    <div className="lr-recover-dialog-overlay" role="presentation" onClick={onKeepWaiting}>
      <div
        className="lr-recover-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lr-recover-dialog-title"
        onClick={event => event.stopPropagation()}
      >
        <h2 id="lr-recover-dialog-title">Recover stuck batch</h2>

        <dl className="lr-recover-dialog-facts">
          <div><dt>Batch</dt><dd>#{batch.displayNumber} ({shortBatchId(batch.batchId)}…)</dd></div>
          <div><dt>Status</dt><dd>{batch.status}</dd></div>
          <div><dt>Last genuine activity</dt><dd>{formatLastActivity(batch.lastExtensionActivityAt)}</dd></div>
          <div><dt>Batch card</dt><dd>{batch.isHidden ? "Hidden from the grid" : "Visible"}</dd></div>
          <div><dt>Completed</dt><dd>{batch.completedCount}</dd></div>
          <div><dt>Unfinished</dt><dd>{batch.unfinishedCount}</dd></div>
        </dl>

        <p className="lr-recover-dialog-listings-label">Affected listings</p>
        <ul className="lr-recover-dialog-listings">
          {listings.map(listing => <li key={listing.draftId}>{listing.title || listing.sku || listing.draftId}</li>)}
        </ul>

        <p className="lr-recover-dialog-warning">
          Make sure the associated Vinted Draft Queue browser extension has stopped before recovering — recovering while it is
          genuinely still working could let it try to save a draft for an item this app no longer considers active.
        </p>

        <p className="lr-recover-dialog-confirm-text">
          Recover this stuck batch? Unfinished draft attempts will be released and can be sent again. Confirmed Vinted drafts
          will be preserved.
        </p>

        {stillActiveWarning && <p className="lr-recover-dialog-still-active" role="alert">
          This batch still shows genuine, recent extension activity — it may still be running. Confirm again below to recover it anyway.
        </p>}
        {error && <p className="lr-recover-dialog-error" role="alert">{error}</p>}

        <div className="lr-recover-dialog-actions">
          <button type="button" className="lr-recover-dialog-keep-waiting" onClick={onKeepWaiting} disabled={recovering}>
            Keep waiting
          </button>
          <button
            type="button"
            className="lr-recover-dialog-recover"
            onClick={() => onRecover(stillActiveWarning)}
            disabled={recovering}
          >
            {recovering ? "Recovering…" : stillActiveWarning ? "Recover anyway" : "Recover stuck batch"}
          </button>
        </div>
      </div>
    </div>
  );
}
