"use client";

import { useEffect, useState } from "react";

export type DeleteGroupMode = "move_to_unsorted" | "delete_photos";

/**
 * Shown only when the group being deleted still has photos — an empty
 * group deletes immediately with no dialog. "Move to Unsorted" is the
 * pre-selected, safer default; choosing "Delete permanently" visibly
 * switches the confirm button to a danger style and its own explicit
 * label, so the destructive path is never one accidental click away.
 */
export default function DeleteGroupDialog({ groupTitle, photoCount, onClose, onConfirm, loading }: {
  groupTitle: string;
  photoCount: number;
  onClose: () => void;
  onConfirm: (mode: DeleteGroupMode) => void;
  loading: boolean;
}) {
  const [mode, setMode] = useState<DeleteGroupMode>("move_to_unsorted");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !loading) onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, loading]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !loading) onClose(); }}>
    <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby="delete-group-title" aria-describedby="delete-group-desc">
      <div className="task-modal-heading">
        <h2 id="delete-group-title">Delete &ldquo;{groupTitle}&rdquo;</h2>
        <button type="button" onClick={onClose} disabled={loading} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body">
        <p id="delete-group-desc">This group contains {photoCount} photo{photoCount === 1 ? "" : "s"}. Choose what should happen to them.</p>

        <label className="delete-group-option">
          <input type="radio" name="delete-group-mode" checked={mode === "move_to_unsorted"} onChange={() => setMode("move_to_unsorted")} />
          <span><strong>Move photos to Unsorted and delete group</strong><small>Your photos are kept, moved into the Unsorted group.</small></span>
        </label>
        <label className="delete-group-option delete-group-option-danger">
          <input type="radio" name="delete-group-mode" checked={mode === "delete_photos"} onChange={() => setMode("delete_photos")} />
          <span><strong>Delete group and remove all photos</strong><small>Permanently deletes {photoCount} photo{photoCount === 1 ? "" : "s"}. You&rsquo;ll have a few seconds to undo before this takes effect.</small></span>
        </label>
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        <button type="button" className={mode === "delete_photos" ? "button-danger" : "button"} disabled={loading} onClick={() => onConfirm(mode)}>
          {loading ? "Working…" : mode === "delete_photos" ? `Delete ${photoCount} photo${photoCount === 1 ? "" : "s"} permanently` : "Move photos and delete group"}
        </button>
      </div>
    </div>
  </div>;
}
