"use client";

import { memo, useEffect, useRef, useState } from "react";
import SortablePhotoGrid, { type PhotoTileData } from "./SortablePhotoGrid";
import OverflowMenu from "./OverflowMenu";

export type GroupSummary = { id: string; title: string | null; status: string };

// Milestone 4 (AI listing generation) — present only once this group has a
// generated listing. `generatedTitle`/`generatedDescription` are the
// application-derived marketplace listing text (never the same thing as
// `GroupSummary.title` above, which stays this group's own editable
// display name). Structured fields are shown read-only here; "Edit
// fields" is the only way to change them.
export type GeneratedListingSummary = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  // Milestone 6 (Vinted-aware colours/materials): up to 2 exact Vinted
  // colour-list values (never free text) plus a single exact Vinted
  // material-list value or null.
  colours: string[];
  material: string | null;
  ukSize: string | null;
  sku: string | null;
  generatedTitle: string;
  generatedDescription: string;
};

// Matches the exact title app/api/listing-studio/uploads/route.ts uses for
// the auto-created catch-all inbox group — used only to decide whether to
// show the "Inbox" badge, never trusted for anything security-sensitive.
const UNSORTED_TITLE = "Unsorted";

/**
 * One product group. Delete is always enabled here — GroupingWorkspace
 * decides whether a confirmation dialog is needed (only when the group
 * still has photos) before it's ever actually deleted, so a non-empty
 * group is never a one-click destructive action.
 *
 * `data-group-id` lets GroupingWorkspace's document-level Ctrl+A/Escape/
 * Delete keyboard handlers determine which group currently has focus
 * (via `document.activeElement?.closest('[data-group-id]')`) without this
 * component needing to know anything about global keyboard shortcuts
 * itself.
 *
 * The group name is a static label by default — double-click to edit,
 * Enter or clicking elsewhere (blur) saves, Escape cancels and restores
 * the previous name, matching the exact interaction requested rather than
 * always being a live-editable input.
 */
function ProductGroupCard({
  group, photos, selectedIds, onToggleSelect, onSelectAll, onClearSelection, onSelectRange, onRename, onReorder, onSetCover, onRemovePhoto,
  onSplitSelected, onMoveSelected, onMerge, onDelete, saveState, autoEdit, onAutoEditConsumed, listing, onEditFields, onPreviewListing,
}: {
  group: GroupSummary;
  photos: PhotoTileData[];
  selectedIds: Set<string>;
  onToggleSelect: (photoId: string) => void;
  onSelectAll: (draftId: string) => void;
  onClearSelection: (draftId: string) => void;
  onSelectRange: (photoIds: string[]) => void;
  onRename: (draftId: string, title: string) => void;
  onReorder: (draftId: string, orderedIds: string[]) => void;
  onSetCover: (draftId: string, photoId: string) => void;
  onRemovePhoto: (photoId: string) => void;
  onSplitSelected: (draftId: string) => void;
  onMoveSelected: (draftId: string) => void;
  onMerge: (draftId: string) => void;
  onDelete: (draftId: string) => void;
  saveState: "idle" | "saving" | "saved" | "failed";
  // Set true for exactly one render right after this group is created via
  // "+ New product" — drops it straight into rename mode with no click, per
  // the one-click creation requirement. onAutoEditConsumed clears the flag
  // in the parent so it never re-triggers on a later unrelated re-render.
  autoEdit: boolean;
  onAutoEditConsumed: () => void;
  // Milestone 4: null until "Generate Listings" has produced a listing for
  // this group. Never null after that, even while photos/selection change —
  // the listing only ever changes via a fresh Generate or Edit fields save.
  listing: GeneratedListingSummary | null;
  onEditFields: (draftId: string) => void;
  // Milestone 4 UX fix — opens the read-only full preview (complete title/
  // description, never truncated) since the card itself only ever shows a
  // truncated description.
  onPreviewListing: (draftId: string) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(group.title ?? "");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const isUnsorted = group.title === UNSORTED_TITLE;
  const selectedInThisGroup = photos.filter(photo => selectedIds.has(photo.id)).length;
  const allSelected = photos.length > 0 && selectedInThisGroup === photos.length;
  const failedCount = photos.filter(photo => photo.uploadState === "failed").length;
  const stillUploading = photos.some(photo => photo.uploadState === "pending" || photo.uploadState === "uploading");

  function startEditingTitle() {
    setTitleDraft(group.title ?? "");
    setEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }
  function saveTitle() {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== group.title) onRename(group.id, trimmed);
    setEditingTitle(false);
  }
  function cancelEditingTitle() {
    setTitleDraft(group.title ?? "");
    setEditingTitle(false);
  }

  useEffect(() => {
    if (autoEdit) {
      startEditingTitle();
      onAutoEditConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only ever reacts to autoEdit flipping true; startEditingTitle/onAutoEditConsumed read current props
  }, [autoEdit]);

  return <article className="product-group-card" id={`listing-group-${group.id}`} data-group-id={group.id}>
    <header className="product-group-heading">
      {editingTitle
        ? <input
            ref={titleInputRef}
            className="product-group-title-input"
            value={titleDraft}
            autoFocus
            onChange={event => setTitleDraft(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={event => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              else if (event.key === "Escape") cancelEditingTitle();
            }}
            aria-label="Group name"
          />
        : <button type="button" className="product-group-title-display" onDoubleClick={startEditingTitle} title="Double-click to rename">
            {group.title || "Untitled group"}
          </button>}
      {isUnsorted && <span className="product-group-unsorted-badge">Inbox</span>}
      <span className="record-count">{photos.length}</span>
      {failedCount > 0 && <span className="upload-status-badge upload-status-badge-failed">{failedCount} failed</span>}
      {stillUploading && <span className="upload-status-badge upload-status-badge-uploading">Uploading…</span>}
      <span className="product-group-save-state" role="status">
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved"}
        {saveState === "failed" && "Save failed"}
      </span>
      <OverflowMenu label={`More actions for ${group.title || "this group"}`} items={[
        { label: "Merge into another group", onClick: () => onMerge(group.id) },
        // Always enabled — deleting a non-empty group opens a confirmation
        // dialog (owned by GroupingWorkspace) offering to move its photos
        // to Unsorted or delete them; an empty group deletes immediately.
        { label: "Delete group", onClick: () => onDelete(group.id), tone: "danger" },
      ]} />
    </header>

    {listing && <div className="listing-card">
      <p className="listing-card-title">{listing.generatedTitle}</p>
      <p className="listing-card-description">{listing.generatedDescription}</p>
      {(listing.colours.length > 0 || listing.material) && <p className="listing-card-meta">
        {listing.colours.length > 0 && <span className="listing-card-meta-item">{listing.colours.join(" & ")}</span>}
        {listing.material && <span className="listing-card-meta-item">{listing.material}</span>}
      </p>}
      <div className="listing-card-actions">
        <button type="button" className="button-secondary" onClick={() => onPreviewListing(group.id)}>Preview listing</button>
        <button type="button" className="button-secondary" onClick={() => onEditFields(group.id)}>Edit fields</button>
      </div>
    </div>}

    <div className="product-group-selection-row">
      <button type="button" className="button-secondary" onClick={() => (allSelected ? onClearSelection(group.id) : onSelectAll(group.id))} disabled={photos.length === 0}>
        {allSelected ? "Deselect all" : "Select all"}
      </button>
      <span className="product-group-selection-count" role="status">{selectedInThisGroup} selected</span>
      {selectedInThisGroup > 0 && <button type="button" className="button-secondary" onClick={() => onClearSelection(group.id)}>Clear selection</button>}
    </div>

    {selectedInThisGroup > 0 && <div className="product-group-selection-toolbar" role="toolbar" aria-label="Selected photo actions">
      <button type="button" className="button-secondary" onClick={() => onMoveSelected(group.id)}>Move</button>
      <button type="button" className="button-secondary" onClick={() => onSplitSelected(group.id)}>Split into new group</button>
    </div>}

    {photos.length === 0
      ? <p className="product-group-empty">No photos yet — move some in, or delete this empty group.</p>
      : <SortablePhotoGrid
          photos={photos}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onSelectRange={onSelectRange}
          onReorder={orderedIds => onReorder(group.id, orderedIds)}
          onSetCover={photoId => onSetCover(group.id, photoId)}
          onRemove={onRemovePhoto}
        />}
  </article>;
}

export default memo(ProductGroupCard);
