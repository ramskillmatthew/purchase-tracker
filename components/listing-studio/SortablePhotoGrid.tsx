"use client";

import { memo, useRef, useState } from "react";
import OverflowMenu from "./OverflowMenu";

export type PhotoTileData = {
  id: string;
  filename: string;
  role: string | null;
  uploadState: "pending" | "uploading" | "uploaded" | "failed";
  previewAvailable: boolean;
};

const DEFAULT_DISPLAY_LIMIT = 16;

/**
 * Reorderable photo grid. Drag-and-drop is one way to reorder, but every
 * tile also has always-visible (never hover-only) move-earlier/move-later
 * buttons — a fully keyboard- and touch-accessible alternative. Make-cover
 * and Remove live in a compact per-tile overflow menu rather than a full
 * row of buttons beneath every photo (UX refinement spec §5/§6).
 *
 * Large groups only render the first `displayLimit` photos plus any
 * selected or failed photo beyond that (never hidden), with a "Show all N
 * photos" control to reveal the rest — purely a client-side render limit,
 * never touching sort_order or triggering any save (spec §6: "Expanding
 * and collapsing must not affect saved order").
 *
 * Shift-click support: clicking a checkbox remembers it as the anchor
 * (a ref, not state — never causes a re-render on its own); shift-clicking
 * a second checkbox selects every photo between the two, by true position
 * in the full `photos` order — so it works correctly even when the anchor
 * or target is currently hidden behind the display limit.
 */
function SortablePhotoGrid({ photos, selectedIds, onToggleSelect, onSelectRange, onReorder, onSetCover, onRemove, displayLimit = DEFAULT_DISPLAY_LIMIT }: {
  photos: PhotoTileData[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectRange: (photoIds: string[]) => void;
  onReorder: (orderedIds: string[]) => void;
  onSetCover: (id: string) => void;
  onRemove: (id: string) => void;
  displayLimit?: number;
}) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const lastClickedId = useRef<string | null>(null);

  function move(id: string, delta: number) {
    const ids = photos.map(photo => photo.id);
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next);
  }

  function handleDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) { setDraggedId(null); return; }
    const ids = photos.map(photo => photo.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) { setDraggedId(null); return; }
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, draggedId);
    setDraggedId(null);
    onReorder(next);
  }

  function handleCheckboxClick(event: React.MouseEvent<HTMLInputElement>, photoId: string) {
    if (event.shiftKey && lastClickedId.current) {
      event.preventDefault(); // suppress the normal single-photo toggle — this click means "select the range" instead
      const ids = photos.map(photo => photo.id);
      const fromIndex = ids.indexOf(lastClickedId.current);
      const toIndex = ids.indexOf(photoId);
      if (fromIndex !== -1 && toIndex !== -1) {
        const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
        onSelectRange(ids.slice(start, end + 1));
      }
      return;
    }
    lastClickedId.current = photoId;
  }

  const visiblePhotos = showAll
    ? photos
    : photos.filter((photo, index) => index < displayLimit || selectedIds.has(photo.id) || photo.uploadState === "failed");
  const hiddenCount = photos.length - visiblePhotos.length;

  return <>
    <ul className="photo-grid" aria-label="Photos in this group">
      {visiblePhotos.map(photo => {
        const trueIndex = photos.indexOf(photo);
        const isCover = trueIndex === 0;
        const selected = selectedIds.has(photo.id);
        return <li
          key={photo.id}
          className={`photo-tile${selected ? " photo-tile-selected" : ""}${draggedId === photo.id ? " photo-tile-dragging" : ""}`}
          draggable
          onDragStart={() => setDraggedId(photo.id)}
          onDragOver={event => event.preventDefault()}
          onDrop={() => handleDrop(photo.id)}
        >
          <label className="photo-tile-select">
            <input
              type="checkbox"
              checked={selected}
              onClick={event => handleCheckboxClick(event, photo.id)}
              onChange={() => onToggleSelect(photo.id)}
              aria-label={`Select ${photo.filename}`}
            />
          </label>
          <div className="photo-tile-image">
            {photo.uploadState === "failed"
              ? <span className="photo-tile-fallback" aria-hidden="true">Failed</span>
              : photo.previewAvailable
                // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; see components/listing-studio/GroupingWorkspace.tsx for the same rationale
                ? <img src={`/api/listing-studio/images/${photo.id}/view`} alt={`${photo.role ?? "Unclassified"} photo, position ${trueIndex + 1}${isCover ? ", cover photo" : ""}`} />
                : <span className="photo-tile-fallback" aria-hidden="true">No preview</span>}
            {isCover && <span className="photo-tile-cover-badge">Cover</span>}
          </div>
          <div className="photo-tile-toolbar">
            <button type="button" onClick={() => move(photo.id, -1)} disabled={trueIndex === 0} aria-label={`Move ${photo.filename} earlier`}>←</button>
            <span className="photo-tile-filename" title={photo.filename}>{photo.filename}</span>
            <button type="button" onClick={() => move(photo.id, 1)} disabled={trueIndex === photos.length - 1} aria-label={`Move ${photo.filename} later`}>→</button>
            <OverflowMenu label={`More actions for ${photo.filename}`} items={[
              ...(isCover ? [] : [{ label: "Make cover", onClick: () => onSetCover(photo.id) }]),
              { label: "Remove", onClick: () => onRemove(photo.id), tone: "danger" as const },
            ]} />
          </div>
        </li>;
      })}
    </ul>
    {hiddenCount > 0 && <button type="button" className="button-secondary photo-grid-show-all" onClick={() => setShowAll(true)}>Show all {photos.length} photos</button>}
  </>;
}

export default memo(SortablePhotoGrid);
