"use client";

import UploadStatusBadge from "./UploadStatusBadge";
import type { UploadItem } from "./upload-types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A single dense row (thumbnail, filename, size, status, actions) — never a tall card with a full-width button beneath it (UX refinement spec §5). */
export default function UploadPhotoCard({ item, onRetry, onRemove }: {
  item: UploadItem;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}) {
  const label = `${item.file.name}, ${item.state === "failed" ? "upload failed" : item.state}`;
  return <li className={`upload-photo-row${item.state === "failed" ? " upload-photo-row-failed" : ""}`} aria-label={label}>
    <div className="upload-photo-row-thumb">
      {item.previewUrl
        // eslint-disable-next-line @next/next/no-img-element -- browser-local blob: URL, next/image cannot fetch it
        ? <img src={item.previewUrl} alt="" />
        : <span aria-hidden="true">{item.previewAvailable ? "…" : "—"}</span>}
    </div>
    <span className="upload-photo-row-name" title={item.file.name}>{item.file.name}</span>
    <span className="upload-photo-row-size">{formatBytes(item.file.size)}</span>
    <UploadStatusBadge state={item.state} progress={item.progress} />
    <div className="upload-photo-row-actions">
      {item.state === "failed" && <button type="button" onClick={() => onRetry(item.clientId)} aria-label={`Retry ${item.file.name}`}>Retry</button>}
      <button type="button" onClick={() => onRemove(item.clientId)} aria-label={`Remove ${item.file.name}`}>Remove</button>
    </div>
    {item.state === "failed" && item.errorMessage && <span className="upload-photo-row-error" role="alert">{item.errorMessage}</span>}
  </li>;
}
