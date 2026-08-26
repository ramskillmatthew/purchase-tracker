"use client";

import { memo, useEffect, useRef, useState } from "react";
import SortablePhotoGrid, { type PhotoTileData } from "./SortablePhotoGrid";
import OverflowMenu from "./OverflowMenu";

// Visual redesign — widened to include every structured field the draft
// row already carries (lib/listing-studio/types.ts / the workspace API's
// own select list), not just id/title/status. This is a pure TYPE
// completeness fix: GroupingWorkspace already passes the full draft object
// as `group` — these fields were always present at runtime, just not
// typed, so a compact card can show brand/size/SKU/colour/material even
// BEFORE a listing has been generated (using whatever's already been
// filled in), never a new fetch or a new field.
export type GroupSummary = {
  id: string; title: string | null; status: string;
  brand: string | null; model: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; sku: string | null;
  // Milestone 7 (Vinted category catalogue sync) — null until a category
  // has actually been assigned; used here only to derive the "Needs
  // review" display status (a generated listing with no category yet is a
  // real, existing, actionable gap — see
  // lib/listing-studio/vinted-category-assignment.ts).
  vinted_category_id: number | null;
  source_type: "photos" | "ebay_uk"; source_url: string | null; source_item_id: string | null;
};

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

export type CardStatus = "ready" | "needs_review" | "generating" | "failed" | "not_generated";

// Visual redesign — the ONE place a card's status badge is derived, from
// data that already exists (never persisted/invented): a generated listing
// with a real Vinted category is Ready (the exact same real signal
// GroupingWorkspace's own readyCount already uses — draft.status ready
// implies both); a generated listing missing a category is Needs review
// (lib/listing-studio/vinted-category-assignment.ts's own real gap);
// isGenerating/hasFailedGeneration are the display-only, non-persisted
// tracking GroupingWorkspace's handleGenerateListings loop now also
// records (see that file's own comment) — never a new backend concept.
// Exported so GroupingWorkspace's status filter reuses this exact
// derivation instead of inventing a second one.
export function computeStatus(isUnsorted: boolean, listing: GeneratedListingSummary | null, isGenerating: boolean, hasFailedGeneration: boolean, vintedCategoryId: number | null): CardStatus | null {
  if (isUnsorted) return null; // the inbox has no generation-status concept
  if (isGenerating) return "generating";
  if (listing) return vintedCategoryId == null ? "needs_review" : "ready";
  if (hasFailedGeneration) return "failed";
  return "not_generated";
}
export const STATUS_LABELS: Record<CardStatus, string> = {
  ready: "Ready", needs_review: "Needs review", generating: "Generating…", failed: "Failed", not_generated: "Not generated",
};

/**
 * One product group — visually redesigned into a compact horizontal card
 * (cover thumbnail + strip + summary line + status) with the full existing
 * photo-management interface (select-all, Move/Split toolbar,
 * SortablePhotoGrid) revealed only once expanded. Delete is always enabled
 * here — GroupingWorkspace decides whether a confirmation dialog is needed
 * (only when the group still has photos) before it's ever actually
 * deleted, so a non-empty group is never a one-click destructive action.
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
  expanded, onToggleExpand, isGenerating, hasFailedGeneration,
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
  // Visual redesign — compact by default; the full photo-management body
  // (select-all/Move/Split/SortablePhotoGrid) only renders when expanded.
  expanded: boolean;
  onToggleExpand: (draftId: string) => void;
  isGenerating: boolean;
  hasFailedGeneration: boolean;
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

  const status = computeStatus(isUnsorted, listing, isGenerating, hasFailedGeneration, group.vinted_category_id);
  const coverPhoto = photos[0] ?? null;
  const stripPhotos = photos.slice(1, 6);
  const remainderCount = Math.max(0, photos.length - 1 - stripPhotos.length);

  // Structured fields: prefer the confirmed post-generation values, fall
  // back to whatever's already stored on the draft directly (both are
  // already-loaded data — never a new fetch). Lets a not-yet-generated
  // group still show real brand/size/SKU/colour/material if already set.
  const brand = listing?.brand ?? group.brand;
  const model = listing?.model ?? group.model;
  const ukSize = listing?.ukSize ?? group.uk_size;
  const sku = listing?.sku ?? group.sku;
  const colours = listing?.colours ?? group.colours ?? [];
  const material = listing?.material ?? group.material;
  const titleLine = [brand, model].filter(Boolean).join(" ") || group.title || "Untitled group";

  function openCoverOrThumb() {
    // No dedicated full-image lightbox exists anywhere in this codebase —
    // expanding the card (the existing SortablePhotoGrid) is the closest
    // real "inspect this photo" behaviour, and is where every existing
    // per-photo control (reorder, make cover, remove) already lives.
    onToggleExpand(group.id);
  }

  return <article className={`product-group-card${expanded ? " product-group-card-expanded" : ""}`} id={`listing-group-${group.id}`} data-group-id={group.id}>
    <div className="product-group-compact listing-row-grid">
      <div className="product-group-col product-group-col-main">
        <button type="button" className="product-group-cover" onClick={openCoverOrThumb} aria-label={isUnsorted ? "Expand Unsorted photos" : `Expand ${group.title || "this group"}`}>
          {coverPhoto
            ? (coverPhoto.previewAvailable
                // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; see SortablePhotoGrid.tsx for the same rationale
                ? <img src={`/api/listing-studio/images/${coverPhoto.id}/view`} alt="" />
                : <span className="photo-tile-fallback" aria-hidden="true">No preview</span>)
            : <span className="product-group-cover-empty" aria-hidden="true">No photo</span>}
          {coverPhoto && <span className="photo-tile-cover-badge">Cover</span>}
        </button>

        {photos.length > 1 && <div className="product-group-thumb-strip" aria-hidden="true">
          {stripPhotos.map(photo => <button type="button" key={photo.id} className="product-group-thumb" onClick={openCoverOrThumb} tabIndex={-1}>
            {photo.previewAvailable
              // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; see SortablePhotoGrid.tsx for the same rationale
              ? <img src={`/api/listing-studio/images/${photo.id}/view`} alt="" />
              : <span className="photo-tile-fallback" aria-hidden="true" />}
          </button>)}
          {remainderCount > 0 && <button type="button" className="product-group-thumb product-group-thumb-more" onClick={openCoverOrThumb}>+{remainderCount}</button>}
        </div>}

        <div className="product-group-summary">
          <div className="product-group-heading">
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
                  {isUnsorted ? (group.title || "Unsorted") : titleLine}
                </button>}
            {isUnsorted && <span className="product-group-unsorted-badge">Inbox</span>}
            {!isUnsorted && group.source_type === "ebay_uk" && <span className="product-group-source-badge">Imported from eBay</span>}
            {failedCount > 0 && <span className="upload-status-badge upload-status-badge-failed">{failedCount} failed</span>}
            {stillUploading && <span className="upload-status-badge upload-status-badge-uploading">Uploading…</span>}
          </div>

          {!isUnsorted && <div className="product-group-meta-line">
            {ukSize && <span className="product-group-meta-item">UK {ukSize}</span>}
            {sku && <span className="product-group-meta-item">SKU {sku}</span>}
            {colours.length > 0 && <span className="product-group-meta-chip">{colours.join(" & ")}</span>}
            {material && <span className="product-group-meta-chip">{material}</span>}
          </div>}
        </div>
      </div>

      <div className="product-group-col product-group-col-photos">
        <span className="record-count">{photos.length}</span>
      </div>

      <div className="product-group-col product-group-col-status">
        {status && <span className={`listing-generation-status listing-generation-status-${status}`} role="status">{STATUS_LABELS[status]}</span>}
        <span className="product-group-save-state" role="status">
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && "Saved"}
          {saveState === "failed" && "Save failed"}
        </span>
      </div>

      <div className="product-group-col product-group-col-actions">
        <div className="product-group-compact-actions">
          {listing && <button type="button" className="button-secondary" onClick={() => onPreviewListing(group.id)}>Preview</button>}
          {listing && <button type="button" className="button-secondary" onClick={() => onEditFields(group.id)}>Edit fields</button>}
          <button type="button" className="button-secondary" onClick={() => onToggleExpand(group.id)} aria-expanded={expanded}>
            {expanded ? "Collapse" : "Manage photos"}
          </button>
          <OverflowMenu label={`More actions for ${group.title || "this group"}`} items={[
            { label: "Merge into another group", onClick: () => onMerge(group.id) },
            // Always enabled — deleting a non-empty group opens a confirmation
            // dialog (owned by GroupingWorkspace) offering to move its photos
            // to Unsorted or delete them; an empty group deletes immediately.
            { label: "Delete group", onClick: () => onDelete(group.id), tone: "danger" },
          ]} />
        </div>
      </div>
    </div>

    {expanded && <div className="product-group-expanded-body">
      {listing && <div className="listing-card">
        <p className="listing-card-title">{listing.generatedTitle}</p>
        <p className="listing-card-description">{listing.generatedDescription}</p>
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
    </div>}
  </article>;
}

export default memo(ProductGroupCard);
