"use client";

import { useEffect, useState } from "react";

export type MergeableGroup = { id: string; title: string | null; photoCount: number };

export default function MergeGroupsDialog({ sourceTitle, groups, onClose, onMerge, loading }: {
  sourceTitle: string;
  groups: MergeableGroup[];
  onClose: () => void;
  onMerge: (targetDraftId: string) => void;
  loading: boolean;
}) {
  const [targetId, setTargetId] = useState(groups[0]?.id ?? "");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !loading) onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, loading]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !loading) onClose(); }}>
    <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby="merge-groups-title">
      <div className="task-modal-heading">
        <h2 id="merge-groups-title">Merge &ldquo;{sourceTitle}&rdquo; into another group</h2>
        <button type="button" onClick={onClose} disabled={loading} aria-label="Close">×</button>
      </div>
      <div className="task-modal-body">
        {groups.length === 0
          ? <p>There are no other groups to merge into yet.</p>
          : <label className="field">
              <span className="label">Merge into</span>
              <select className="input" value={targetId} onChange={event => setTargetId(event.target.value)}>
                {groups.map(group => <option key={group.id} value={group.id}>{group.title || "Untitled group"} ({group.photoCount} photo{group.photoCount === 1 ? "" : "s"})</option>)}
              </select>
              <span className="upload-photo-error" role="alert">All photos will move into this group, and &ldquo;{sourceTitle}&rdquo; will be deleted.</span>
            </label>}
      </div>
      <div className="task-modal-actions">
        <button type="button" className="button-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        <button type="button" className="button" disabled={loading || !targetId} onClick={() => targetId && onMerge(targetId)}>{loading ? "Merging…" : "Merge"}</button>
      </div>
    </div>
  </div>;
}
