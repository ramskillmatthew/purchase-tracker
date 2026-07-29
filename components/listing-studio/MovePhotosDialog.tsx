"use client";

import { useEffect, useState } from "react";

export type MovableGroup = { id: string; title: string | null; photoCount: number };

/**
 * Handles both "Move selected photos" (an existing group, or a brand-new
 * automatically-named one) and "Split selected into new group" (always a
 * new group — splitting into an existing group would just be a move, so
 * that choice is hidden entirely in split mode). New groups are never
 * manually named here: see lib/listing-studio/group-naming.ts — the server
 * assigns the next "Product N" placeholder, and the user renames it later
 * if they want to.
 */
export default function MovePhotosDialog({ action, groups, selectedCount, onClose, onMove, onCreateAndMove, loading }: {
  action: "move" | "split";
  groups: MovableGroup[];
  selectedCount: number;
  onClose: () => void;
  onMove: (targetDraftId: string) => void;
  onCreateAndMove: () => void;
  loading: boolean;
}) {
  const showExistingOption = action === "move" && groups.length > 0;
  const [mode, setMode] = useState<"existing" | "new">(showExistingOption ? "existing" : "new");
  const [targetId, setTargetId] = useState(groups[0]?.id ?? "");

  function confirm() {
    if (loading) return;
    if (mode === "existing" && targetId) onMove(targetId);
    else if (mode === "new") onCreateAndMove();
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { if (!loading) onClose(); return; }
      // Only "New group" has nothing left to fill in — Enter there means
      // "go"; in "Existing group" mode Enter is left to the native <select>.
      if (event.key === "Enter" && mode === "new" && !loading) { event.preventDefault(); confirm(); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- confirm reads mode/targetId/loading fresh each render
  }, [onClose, loading, mode, targetId]);

  const canConfirm = !loading && (mode === "existing" ? Boolean(targetId) : true);
  const heading = action === "split"
    ? `Split ${selectedCount} photo${selectedCount === 1 ? "" : "s"} into a new group`
    : `Move ${selectedCount} photo${selectedCount === 1 ? "" : "s"}`;
  const confirmLabel = mode === "existing" ? "Move photos" : action === "split" ? "Create group & split photos" : "Create group & move photos";
  const confirmLabelLoading = mode === "existing" ? "Moving…" : "Creating…";

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !loading) onClose(); }}>
    <div className="task-modal listing-move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-photos-title">
      <div className="task-modal-heading">
        <h2 id="move-photos-title">{heading}</h2>
        <button type="button" onClick={onClose} disabled={loading} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body listing-move-dialog-body">
        {showExistingOption && <label className="field">
          <span className="label">Destination</span>
          <div className="listing-move-mode" role="radiogroup" aria-label="Destination type">
            <button type="button" className={mode === "existing" ? "listing-move-mode-active" : ""} onClick={() => setMode("existing")}>Existing group</button>
            <button type="button" className={mode === "new" ? "listing-move-mode-active" : ""} onClick={() => setMode("new")}>New group</button>
          </div>
        </label>}
        {mode === "existing" && showExistingOption && <label className="field">
          <span className="label">Group</span>
          <select className="input" value={targetId} onChange={event => setTargetId(event.target.value)} autoFocus>
            {groups.map(group => <option key={group.id} value={group.id}>{group.title || "Untitled group"} ({group.photoCount} photo{group.photoCount === 1 ? "" : "s"})</option>)}
          </select>
        </label>}
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        <button type="button" className="button" onClick={confirm} disabled={!canConfirm}>{loading ? confirmLabelLoading : confirmLabel}</button>
      </div>
    </div>
  </div>;
}
