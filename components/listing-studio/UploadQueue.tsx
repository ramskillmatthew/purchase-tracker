"use client";

import { useState } from "react";
import UploadPhotoCard from "./UploadPhotoCard";
import type { UploadItem } from "./upload-types";

/**
 * Collapsed by default once every file has resolved; forced open (no way
 * to hide it) while anything is still pending/uploading or has failed
 * (UX refinement spec §5) — the manual toggle only appears once nothing
 * needs attention, so a failure can never be hidden by accident.
 */
export default function UploadQueue({ items, onRetry, onRemove }: {
  items: UploadItem[];
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}) {
  const [manualExpanded, setManualExpanded] = useState(false);
  if (!items.length) return null;

  const hasActiveOrFailed = items.some(item => item.state === "pending" || item.state === "uploading" || item.state === "failed");
  const expanded = hasActiveOrFailed || manualExpanded;
  const uploadedCount = items.filter(item => item.state === "uploaded").length;
  const failedCount = items.filter(item => item.state === "failed").length;
  const summary = uploadedCount === items.length
    ? `${items.length} photo${items.length === 1 ? "" : "s"} uploaded`
    : `${uploadedCount}/${items.length} uploaded${failedCount ? `, ${failedCount} failed` : ""}`;

  return <section className="upload-queue" aria-label="Upload progress">
    <div className="upload-queue-summary">
      <strong role="status">{summary}</strong>
      {!hasActiveOrFailed && <button type="button" className="button-secondary" onClick={() => setManualExpanded(current => !current)} aria-expanded={expanded}>
        {expanded ? "Hide uploads" : "View uploads"}
      </button>}
    </div>
    {expanded && <ul className="upload-queue-list">
      {items.map(item => <UploadPhotoCard key={item.clientId} item={item} onRetry={onRetry} onRemove={onRemove} />)}
    </ul>}
  </section>;
}
