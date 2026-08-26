"use client";

import type { UploadItemState } from "./upload-types";

// Text-first status pill — never relies on colour alone (Milestone 2 spec
// §13: "Progress text that does not rely only on colour").
const LABELS: Record<UploadItemState, string> = {
  waiting: "Waiting",
  registering: "Registering",
  uploading: "Uploading",
  confirming: "Confirming",
  uploaded: "Uploaded",
  failed: "Failed",
  rejected: "Rejected",
};

export default function UploadStatusBadge({ state, progress }: { state: UploadItemState; progress?: number }) {
  const label = state === "uploading" && typeof progress === "number" ? `Uploading ${Math.round(progress)}%` : LABELS[state];
  return <span className={`upload-status-badge upload-status-badge-${state}`} role="status">{label}</span>;
}
