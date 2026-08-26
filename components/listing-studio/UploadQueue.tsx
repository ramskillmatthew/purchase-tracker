"use client";

import { useState } from "react";
import UploadPhotoCard from "./UploadPhotoCard";
import { UPLOAD_ACTIVE_STATES, type UploadItem } from "./upload-types";

// Large-queue presentation: successful/waiting items beyond this count are
// collapsed behind "Show all N" — active and failed/rejected items are
// ALWAYS shown in full regardless of this cap (failures must never become
// invisible, and "what's happening right now" must always be visible).
const DEFAULT_VISIBLE_RESOLVED = 24;

/**
 * Collapsed by default once every file has resolved; forced open (no way
 * to hide it) while anything is still active/failed/rejected (UX
 * refinement spec §5) — the manual toggle only appears once nothing needs
 * attention, so a failure can never be hidden by accident.
 */
export default function UploadQueue({ items, onRetry, onRemove, onRetryAllFailed, onRemoveAllFailed, globalError }: {
  items: UploadItem[];
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
  onRetryAllFailed: () => void;
  onRemoveAllFailed: () => void;
  globalError: string | null;
}) {
  const [manualExpanded, setManualExpanded] = useState(false);
  const [showAllResolved, setShowAllResolved] = useState(false);
  if (!items.length) return null;

  const activeItems = items.filter(item => UPLOAD_ACTIVE_STATES.has(item.state));
  const failedItems = items.filter(item => item.state === "failed");
  const rejectedItems = items.filter(item => item.state === "rejected");
  const resolvedItems = items.filter(item => item.state === "uploaded"); // collapsible

  const hasActiveOrFailed = activeItems.length > 0 || failedItems.length > 0 || rejectedItems.length > 0;
  const expanded = hasActiveOrFailed || manualExpanded;

  const uploadedCount = resolvedItems.length;
  const waitingCount = items.filter(item => item.state === "waiting").length;
  const inFlightCount = activeItems.length - waitingCount;
  const failedCount = failedItems.length;
  const rejectedCount = rejectedItems.length;
  const percent = items.length ? Math.round((uploadedCount / items.length) * 100) : 0;

  const summary = uploadedCount === items.length
    ? `${items.length} photo${items.length === 1 ? "" : "s"} uploaded`
    : `${uploadedCount} of ${items.length} uploaded`;
  const countsLine = [
    inFlightCount > 0 ? `${inFlightCount} uploading` : null,
    waitingCount > 0 ? `${waitingCount} waiting` : null,
    failedCount > 0 ? `${failedCount} failed` : null,
    rejectedCount > 0 ? `${rejectedCount} rejected` : null,
  ].filter(Boolean).join(" · ");

  const visibleResolved = showAllResolved ? resolvedItems : resolvedItems.slice(0, DEFAULT_VISIBLE_RESOLVED);
  const hiddenResolvedCount = resolvedItems.length - visibleResolved.length;
  // Active first (what's happening right now), then failures/rejections
  // (must always stay visible), then successful items last, collapsible.
  const visibleQueueItems = [...activeItems, ...failedItems, ...rejectedItems, ...visibleResolved];

  return <section className="upload-queue" aria-label="Upload progress">
    <div className="upload-queue-summary">
      <div className="upload-queue-summary-main">
        <strong role="status">{summary}</strong>
        {items.length > 0 && <div className="upload-queue-progress-track" aria-hidden="true"><div className="upload-queue-progress-fill" style={{ width: `${percent}%` }} /></div>}
        {countsLine && <span className="upload-queue-summary-counts">{countsLine}</span>}
      </div>
      <div className="upload-queue-summary-actions">
        {failedCount > 1 && <button type="button" className="button-secondary" onClick={onRetryAllFailed}>Retry all failed</button>}
        {failedCount > 0 && <button type="button" className="button-secondary" onClick={onRemoveAllFailed}>Remove failed</button>}
        {!hasActiveOrFailed && <button type="button" className="button-secondary" onClick={() => setManualExpanded(current => !current)} aria-expanded={expanded}>
          {expanded ? "Hide uploads" : "View uploads"}
        </button>}
      </div>
    </div>

    {globalError && <div className="upload-queue-global-error" role="alert">{globalError}</div>}

    {expanded && <>
      <ul className="upload-queue-list">
        {visibleQueueItems.map(item => <UploadPhotoCard key={item.clientId} item={item} onRetry={onRetry} onRemove={onRemove} />)}
      </ul>
      {hiddenResolvedCount > 0 && <button type="button" className="button-secondary upload-queue-show-toggle" onClick={() => setShowAllResolved(true)}>Show all {items.length}</button>}
      {showAllResolved && resolvedItems.length > DEFAULT_VISIBLE_RESOLVED && <button type="button" className="button-secondary upload-queue-show-toggle" onClick={() => setShowAllResolved(false)}>Show fewer</button>}
    </>}
  </section>;
}
