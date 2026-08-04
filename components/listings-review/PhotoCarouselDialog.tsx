"use client";

import { useEffect, useState } from "react";

export type CarouselPhoto = { id: string };

/**
 * Milestone 5 — a simple lightbox for inspecting every photo a listing was
 * generated from (sole shots, size labels, SKU labels, profile/heel shots)
 * without leaving Listings Review to go back to Listing Studio. No
 * reordering, no role/cover assignment, no selection state — this is pure
 * viewing, a deliberately smaller/different concern from
 * SortablePhotoGrid.tsx (which owns all of that during grouping).
 */
export default function PhotoCarouselDialog({ title, photos, initialPhotoId, onClose }: {
  title: string;
  photos: CarouselPhoto[];
  initialPhotoId: string | null;
  onClose: () => void;
}) {
  const [activePhotoId, setActivePhotoId] = useState(() => initialPhotoId ?? photos[0]?.id ?? null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { onClose(); return; }
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const index = photos.findIndex(photo => photo.id === activePhotoId);
      if (index === -1) return;
      const nextIndex = event.key === "ArrowRight" ? Math.min(index + 1, photos.length - 1) : Math.max(index - 1, 0);
      setActivePhotoId(photos[nextIndex].id);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, photos, activePhotoId]);

  if (!photos.length || !activePhotoId) return null;

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-modal photo-carousel-modal" role="dialog" aria-modal="true" aria-labelledby="photo-carousel-title">
      <div className="task-modal-heading">
        <h2 id="photo-carousel-title">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="photo-carousel-body">
        {/* eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; matches every other listing-studio photo <img> */}
        <img key={activePhotoId} className="photo-carousel-main-image" src={`/api/listing-studio/images/${activePhotoId}/view`} alt="" />
      </div>
      <div className="photo-carousel-thumbnail-strip" role="tablist" aria-label="Photos in this listing">
        {photos.map(photo => <button
          key={photo.id}
          type="button"
          role="tab"
          aria-selected={photo.id === activePhotoId}
          className={photo.id === activePhotoId ? "photo-carousel-thumbnail photo-carousel-thumbnail-active" : "photo-carousel-thumbnail"}
          onClick={() => setActivePhotoId(photo.id)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL */}
          <img src={`/api/listing-studio/images/${photo.id}/view`} alt="" />
        </button>)}
      </div>
    </div>
  </div>;
}
