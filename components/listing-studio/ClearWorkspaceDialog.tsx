"use client";

import { useEffect } from "react";

/**
 * A dedicated, bespoke dialog (not the shared components/ConfirmDialog.tsx,
 * which is also used by Purchases/Expenses/Tasks and has a hardcoded
 * "Keep records" cancel label and no loading state) — matches the same
 * task-modal pattern as DeleteGroupDialog/MergeGroupsDialog instead.
 */
export default function ClearWorkspaceDialog({ onClose, onConfirm, loading }: {
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !loading) onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, loading]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !loading) onClose(); }}>
    <div className="task-modal" role="alertdialog" aria-modal="true" aria-labelledby="clear-workspace-title" aria-describedby="clear-workspace-desc">
      <div className="task-modal-heading">
        <h2 id="clear-workspace-title">Clear all photos and groups?</h2>
        <button type="button" onClick={onClose} disabled={loading} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body">
        <p id="clear-workspace-desc">This will permanently delete every uploaded photo and product group in Listing Studio. This action cannot be undone.</p>
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        <button type="button" className="button-danger" disabled={loading} onClick={onConfirm}>{loading ? "Clearing…" : "Clear everything"}</button>
      </div>
    </div>
  </div>;
}
