"use client";

// Text-first status pill — never relies on colour alone (Milestone 2 spec
// §13: "Progress text that does not rely only on colour").
const LABELS: Record<string, string> = {
  pending: "Waiting",
  uploading: "Uploading",
  uploaded: "Uploaded",
  failed: "Failed",
};

export default function UploadStatusBadge({ state, progress }: { state: "pending" | "uploading" | "uploaded" | "failed"; progress?: number }) {
  const label = state === "uploading" && typeof progress === "number" ? `Uploading ${Math.round(progress)}%` : LABELS[state];
  return <span className={`upload-status-badge upload-status-badge-${state}`} role="status">{label}</span>;
}
