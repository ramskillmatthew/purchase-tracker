"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ListingsFilterBar from "./ListingsFilterBar";
import ListingsTable, { type ListingTableRow } from "./ListingsTable";
import ListingDetailsPanel, { type ListingDetails } from "./ListingDetailsPanel";
import PhotoCarouselDialog from "./PhotoCarouselDialog";
import EditListingFieldsDialog, { type ListingFieldsDraft } from "@/components/listing-studio/EditListingFieldsDialog";
import PreviewListingDialog from "@/components/listing-studio/PreviewListingDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  computeListingReviewStatus, buildListingWarnings, matchesListingSearch, matchesQuickFilter,
  type ListingQuickFilter, type ListingReviewStatusFilter, type ReviewableListing,
} from "@/lib/listing-studio/listing-review";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";

type ReviewDraftRow = {
  id: string; created_at: string; updated_at: string;
  // Milestone 6 (Vinted-aware colours/materials): colours/material replace
  // the old free-text colour column.
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; uk_size_source: string | null; sku: string | null; condition: string | null;
  generated_title: string | null; generated_description: string | null;
  ai_result_json: ListingGenerationFields | null;
  review_marked_ready_at: string | null;
  // Milestone 7 (Vinted category catalogue sync). vinted_category_valid is
  // computed server-side by the listings-review route from a fresh
  // catalogue lookup — never derived client-side from stale data.
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
  vinted_category_valid: boolean;
  vinted_category_status: string | null;
  // Follow-up correction (2026-08-04, extended 2026-08-05).
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
  vinted_audience_source: "ai" | "manual" | null;
  vinted_audience_evidence: string[] | null;
};
type ReviewImageRow = { id: string; draft_id: string; sort_order: number };
type ReviewData = { drafts: ReviewDraftRow[]; images: ReviewImageRow[] };

// Every field the UI or its derived status/warnings/edited-detection logic
// needs, computed once per listing when the underlying data actually
// changes — never re-derived per render of any child component.
type ListingRow = ListingDetails & ReviewableListing & { updatedAt: string; photoIds: string[] };

async function runWithConcurrencyLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    let next: T | undefined;
    while ((next = queue.shift())) await task(next);
  });
  await Promise.all(workers);
}

/**
 * Milestone 5 — the primary place generated listings get reviewed before
 * exporting/auto-listing (not built yet: both bulk actions below are
 * disabled placeholders). Deliberately reuses, rather than reimplements,
 * every piece of Milestone 4 it touches: the same Edit Fields dialog and
 * `/fields` PATCH route, the same Preview dialog (extended, not
 * duplicated — see PreviewListingDialog.tsx's own comment), the same
 * `/images/{id}/view` photo endpoint, and the same single-group DELETE
 * route (called with `mode: "delete_photos"`, since every listing shown
 * here necessarily has photos already). Nothing about grouping, title/
 * description templates, SKU extraction, or size conversion is read or
 * written here at all — this page only ever reads/writes the columns
 * those already produced.
 */
export default function ListingsReviewWorkspace() {
  const [drafts, setDrafts] = useState<ReviewDraftRow[]>([]);
  const [images, setImages] = useState<ReviewImageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ListingReviewStatusFilter>("all");
  const [activeQuickFilters, setActiveQuickFilters] = useState<Set<ListingQuickFilter>>(new Set());

  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());

  const [editFieldsListingId, setEditFieldsListingId] = useState<string | null>(null);
  const [savingListingFields, setSavingListingFields] = useState(false);
  const [editFieldsError, setEditFieldsError] = useState("");

  const [previewListingId, setPreviewListingId] = useState<string | null>(null);
  const [carouselListingId, setCarouselListingId] = useState<string | null>(null);
  const [carouselInitialPhotoId, setCarouselInitialPhotoId] = useState<string | null>(null);

  const [markingReadyId, setMarkingReadyId] = useState<string | null>(null);
  const [bulkActionRunning, setBulkActionRunning] = useState(false);
  const [bulkActionError, setBulkActionError] = useState("");
  const [bulkActionMessage, setBulkActionMessage] = useState("");
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [assigningCategoryId, setAssigningCategoryId] = useState<string | null>(null);
  const [reassessingAudienceId, setReassessingAudienceId] = useState<string | null>(null);

  const loadListings = useCallback(async () => {
    try {
      const response = await fetch("/api/listing-studio/listings-review");
      if (!response.ok) { setLoadError("Could not load your listings."); return; }
      const data = await response.json() as ReviewData;
      setDrafts(data.drafts);
      setImages(data.images);
      setLoadError("");
    } catch {
      setLoadError("Could not load your listings. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { loadListings(); }, [loadListings]);

  // One lookup built once per images change, rather than every listing
  // re-filtering/re-sorting the whole array on every render.
  const photoIdsByDraftId = useMemo(() => {
    const map = new Map<string, string[]>();
    const sorted = [...images].sort((a, b) => a.sort_order - b.sort_order);
    for (const image of sorted) {
      const list = map.get(image.draft_id);
      if (list) list.push(image.id); else map.set(image.draft_id, [image.id]);
    }
    return map;
  }, [images]);

  // Status/warnings/edited-ness computed exactly once per listing here —
  // never recomputed by ListingsTable or ListingDetailsPanel themselves.
  const listingRows: ListingRow[] = useMemo(() => drafts.map(draft => {
    const reviewable: ReviewableListing = {
      brand: draft.brand, model: draft.model, productType: draft.product_type, colours: draft.colours ?? [], material: draft.material,
      ukSize: draft.uk_size, sku: draft.sku, ukSizeSource: draft.uk_size_source,
      aiResultJson: draft.ai_result_json, reviewMarkedReadyAt: draft.review_marked_ready_at, updatedAt: draft.updated_at,
      vintedCategoryId: draft.vinted_category_id, vintedCategoryValid: draft.vinted_category_valid, vintedCategorySource: draft.vinted_category_source,
      vintedCategoryStatus: draft.vinted_category_status, vintedAudienceSource: draft.vinted_audience_source,
    };
    const photoIds = photoIdsByDraftId.get(draft.id) ?? [];
    return {
      ...reviewable,
      id: draft.id,
      generatedTitle: draft.generated_title ?? "",
      generatedDescription: draft.generated_description ?? "",
      condition: draft.condition,
      vintedCategoryPath: draft.vinted_category_path,
      vintedAudience: draft.vinted_audience,
      vintedAudienceEvidence: draft.vinted_audience_evidence,
      status: computeListingReviewStatus(reviewable),
      warnings: buildListingWarnings(reviewable),
      coverPhotoId: photoIds[0] ?? null,
      photoIds,
    };
  }), [drafts, photoIdsByDraftId]);

  const listingsById = useMemo(() => new Map(listingRows.map(row => [row.id, row])), [listingRows]);

  const filteredRows = useMemo(() => listingRows.filter(row => {
    if (statusFilter !== "all" && row.status !== statusFilter) return false;
    for (const filter of activeQuickFilters) if (!matchesQuickFilter(row, filter)) return false;
    return matchesListingSearch({ generatedTitle: row.generatedTitle, sku: row.sku, brand: row.brand, model: row.model, colours: row.colours }, searchQuery);
  }), [listingRows, statusFilter, activeQuickFilters, searchQuery]);

  const tableRows: ListingTableRow[] = filteredRows;
  const selectedListing = selectedListingId ? listingsById.get(selectedListingId) ?? null : null;
  const carouselListing = carouselListingId ? listingsById.get(carouselListingId) ?? null : null;
  const previewListing = previewListingId ? listingsById.get(previewListingId) ?? null : null;
  const editFieldsListing = editFieldsListingId ? listingsById.get(editFieldsListingId) ?? null : null;

  const toggleQuickFilter = useCallback((filter: ListingQuickFilter) => {
    setActiveQuickFilters(current => {
      const next = new Set(current);
      if (next.has(filter)) next.delete(filter); else next.add(filter);
      return next;
    });
  }, []);

  const toggleBulkSelect = useCallback((id: string) => {
    setBulkSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setBulkSelectedIds(current => {
      const visibleIds = filteredRows.map(row => row.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => current.has(id));
      if (allSelected) {
        const next = new Set(current);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...current, ...visibleIds]);
    });
  }, [filteredRows]);

  const openCarousel = useCallback((listingId: string, initialPhotoId?: string) => {
    setCarouselListingId(listingId);
    setCarouselInitialPhotoId(initialPhotoId ?? null);
  }, []);

  async function handleMarkReady(listingId: string) {
    setMarkingReadyId(listingId);
    setBulkActionError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/mark-ready`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not mark this listing ready."); return; }
      setDrafts(current => current.map(draft => draft.id === listingId ? { ...draft, review_marked_ready_at: body.reviewMarkedReadyAt } : draft));
    } catch {
      setBulkActionError("Network error — could not mark this listing ready.");
    } finally {
      setMarkingReadyId(null);
    }
  }

  // Follow-up correction (2026-08-04) — "Assign category" retry action.
  // Uses only this listing's already-stored structured fields: no photo
  // reanalysis, no title/description regeneration, no other field changes.
  async function handleAssignCategory(listingId: string) {
    setAssigningCategoryId(listingId);
    setBulkActionError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/assign-category`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not assign a category to this listing."); return; }
      setDrafts(current => current.map(draft => draft.id === listingId ? {
        ...draft,
        vinted_category_id: body.vintedCategoryId, vinted_category_path: body.vintedCategoryPath, vinted_category_source: body.vintedCategorySource,
        vinted_category_status: body.vintedCategoryStatus, vinted_category_valid: body.vintedCategoryId !== null,
        // Follow-up correction (2026-08-05): this route now also tries a
        // cheap, text-only audience reassessment before giving up — reflect
        // whatever audience it ended up with (unchanged when protected as
        // manual, or when nothing improved it).
        vinted_audience: body.vintedAudience, vinted_audience_evidence: body.vintedAudienceEvidence,
        updated_at: new Date().toISOString(),
      } : draft));
    } catch {
      setBulkActionError("Network error — could not assign a category to this listing.");
    } finally {
      setAssigningCategoryId(null);
    }
  }

  // Follow-up correction (2026-08-05) — the explicit, cost-warned
  // "Reassess audience" action: re-sends this listing's actual stored
  // photos to Claude specifically to look for audience evidence. Real AI
  // cost, so it is never triggered automatically — only from this
  // deliberate click, after the user confirms the cost warning.
  async function handleReassessAudience(listingId: string) {
    if (!window.confirm("Reassess audience from photos? This sends this listing's photos to the AI again and has a small AI cost.")) return;
    setReassessingAudienceId(listingId);
    setBulkActionError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/reassess-audience`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not reassess this listing's audience."); return; }
      if (!body.attempted) { setBulkActionMessage(body.message || "This listing's audience is already manually set."); return; }
      setDrafts(current => current.map(draft => draft.id === listingId ? {
        ...draft,
        vinted_audience: body.vintedAudience, vinted_audience_source: "ai", vinted_audience_evidence: body.vintedAudienceEvidence,
        vinted_category_id: body.vintedCategoryId, vinted_category_path: body.vintedCategoryPath, vinted_category_source: body.vintedCategorySource,
        vinted_category_status: body.vintedCategoryStatus, vinted_category_valid: body.vintedCategoryId !== null,
        updated_at: new Date().toISOString(),
      } : draft));
    } catch {
      setBulkActionError("Network error — could not reassess this listing's audience.");
    } finally {
      setReassessingAudienceId(null);
    }
  }

  // Follow-up correction (2026-08-04) — "Assign missing categories" bulk
  // action. ONE HTTP request for every selected listing (never one
  // request per listing — the server itself is concurrency-bounded), then
  // a full reload so every row (including fresh category-validity checks)
  // reflects the server's own final state rather than being patched
  // piecemeal client-side.
  async function handleBulkAssignCategories() {
    const ids = [...bulkSelectedIds];
    if (!ids.length) return;
    setBulkActionRunning(true);
    setBulkActionError("");
    setBulkActionMessage("");
    try {
      const response = await fetch("/api/listing-studio/listings-review/assign-categories", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds: ids }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setBulkActionError(body.error || "Could not assign categories to these listings."); return; }
      const s = body.summary;
      const parts = [
        `${s.deterministicCount} assigned deterministically`, `${s.aiAssignedCount} assigned using AI`,
        `${s.audienceRequiredCount} need an audience`, `${s.noMatchCount} had no match`,
      ];
      if (s.failedCount > 0) parts.push(`${s.failedCount} failed`);
      if (s.skippedCount > 0) parts.push(`${s.skippedCount} already had a manual category`);
      const costSuffix = s.estimatedCostUsd !== null ? ` Estimated AI cost: $${s.estimatedCostUsd.toFixed(4)}.` : "";
      setBulkActionMessage(`${parts.join(", ")}.${costSuffix}`);
      await loadListings();
    } catch {
      setBulkActionError("Network error — could not assign categories to these listings.");
    } finally {
      setBulkActionRunning(false);
    }
  }

  async function handleBulkMarkReady() {
    const ids = [...bulkSelectedIds];
    if (!ids.length) return;
    setBulkActionRunning(true);
    setBulkActionError("");
    let failureCount = 0;
    await runWithConcurrencyLimit(ids, 5, async id => {
      try {
        const response = await fetch(`/api/listing-studio/groups/${id}/mark-ready`, { method: "POST" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) { failureCount += 1; return; }
        setDrafts(current => current.map(draft => draft.id === id ? { ...draft, review_marked_ready_at: body.reviewMarkedReadyAt } : draft));
      } catch { failureCount += 1; }
    });
    if (failureCount > 0) setBulkActionError(`${failureCount} of ${ids.length} listing${ids.length === 1 ? "" : "s"} could not be marked ready.`);
    setBulkSelectedIds(new Set());
    setBulkActionRunning(false);
  }

  async function commitDelete(ids: string[]) {
    setBulkActionRunning(true);
    setBulkActionError("");
    let failureCount = 0;
    await runWithConcurrencyLimit(ids, 5, async id => {
      try {
        const response = await fetch(`/api/listing-studio/groups/${id}`, {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "delete_photos" }),
        });
        if (!response.ok) { failureCount += 1; return; }
        setDrafts(current => current.filter(draft => draft.id !== id));
        setImages(current => current.filter(image => image.draft_id !== id));
      } catch { failureCount += 1; }
    });
    if (failureCount > 0) setBulkActionError(`${failureCount} of ${ids.length} listing${ids.length === 1 ? "" : "s"} could not be deleted.`);
    setBulkSelectedIds(current => { const next = new Set(current); for (const id of ids) next.delete(id); return next; });
    setSelectedListingId(current => (ids.includes(current ?? "") ? null : current));
    setBulkActionRunning(false);
  }

  function handleBulkDelete() {
    setBulkDeleteConfirmOpen(false);
    commitDelete([...bulkSelectedIds]);
  }

  async function handleSaveListingFields(fields: ListingFieldsDraft) {
    if (!editFieldsListingId) return;
    const listingId = editFieldsListingId;
    setSavingListingFields(true);
    setEditFieldsError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${listingId}/fields`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: fields.brand || null, model: fields.model || null, productType: fields.productType || null,
          colours: fields.colours, material: fields.material || null, ukSize: fields.ukSize || null, sku: fields.sku || null,
          vintedAudience: fields.vintedAudience, vintedCategoryId: fields.vintedCategoryId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setEditFieldsError(body.error || "Could not save these fields."); return; }
      // Mirrors the same fields the /fields route itself sets server-side
      // (see that route's own uk_size_source line) — the route's response
      // body doesn't echo uk_size_source/updated_at, so they're set the
      // same way here rather than doing a full reload after every edit.
      setDrafts(current => current.map(draft => draft.id === listingId ? {
        ...draft,
        brand: body.brand, model: body.model, product_type: body.productType, colours: body.colours, material: body.material,
        uk_size: body.ukSize, uk_size_source: body.ukSize ? "manual" : null, sku: body.sku,
        generated_title: body.generatedTitle, generated_description: body.generatedDescription,
        vinted_audience: body.vintedAudience, vinted_audience_source: body.vintedAudienceSource,
        // The /fields route only ever persists a category id after
        // confirming it's currently publishable — safe to mark it valid
        // here without a further round-trip.
        vinted_category_id: body.vintedCategoryId, vinted_category_path: body.vintedCategoryPath, vinted_category_source: body.vintedCategorySource,
        vinted_category_status: body.vintedCategoryStatus,
        vinted_category_valid: body.vintedCategoryId !== null,
        updated_at: new Date().toISOString(),
      } : draft));
      setEditFieldsListingId(null);
    } catch {
      setEditFieldsError("Network error — could not save these fields.");
    } finally {
      setSavingListingFields(false);
    }
  }

  const hasAnyData = drafts.length > 0;
  const bulkCount = bulkSelectedIds.size;

  return <div className="listings-review-layout">
    <ListingsFilterBar
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      statusFilter={statusFilter}
      onStatusFilterChange={setStatusFilter}
      activeQuickFilters={activeQuickFilters}
      onToggleQuickFilter={toggleQuickFilter}
    />

    {loadError && <div className="home-error">{loadError}</div>}
    {bulkActionError && <div className="home-error" role="alert">{bulkActionError}</div>}
    {bulkActionMessage && <div className="listings-review-bulk-message" role="status">{bulkActionMessage}</div>}

    {bulkCount > 0 && <div className="listings-review-bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="listings-review-bulk-count">{bulkCount} selected</span>
      <button type="button" className="button-secondary" disabled={bulkActionRunning} onClick={handleBulkAssignCategories}>{bulkActionRunning ? "Assigning categories…" : "Assign missing categories"}</button>
      <button type="button" className="button-secondary" disabled={bulkActionRunning} onClick={handleBulkMarkReady}>Mark ready</button>
      <button type="button" className="button-danger" disabled={bulkActionRunning} onClick={() => setBulkDeleteConfirmOpen(true)}>Delete</button>
      <button type="button" className="button-secondary" disabled title="Coming in a future milestone">Export</button>
      <button type="button" className="button-secondary" disabled title="Coming in a future milestone">List automatically</button>
    </div>}

    {!loading && !hasAnyData && !loadError && <p className="listing-empty-explanation">No generated listings yet — generate listings from your product groups in Listing Studio, then come back here to review them.</p>}

    {hasAnyData && <div className="listings-review-split">
      <ListingsTable
        rows={tableRows}
        selectedListingId={selectedListingId}
        bulkSelectedIds={bulkSelectedIds}
        onSelectListing={setSelectedListingId}
        onToggleBulkSelect={toggleBulkSelect}
        onToggleSelectAll={toggleSelectAll}
      />
      <ListingDetailsPanel
        listing={selectedListing}
        markingReady={markingReadyId === selectedListingId}
        assigningCategory={assigningCategoryId === selectedListingId}
        reassessingAudience={reassessingAudienceId === selectedListingId}
        onOpenCarousel={id => openCarousel(id)}
        onPreview={setPreviewListingId}
        onEditFields={setEditFieldsListingId}
        onAssignCategory={handleAssignCategory}
        onReassessAudience={handleReassessAudience}
        onMarkReady={handleMarkReady}
      />
    </div>}

    {carouselListing && <PhotoCarouselDialog
      title={carouselListing.generatedTitle || "Photos"}
      photos={carouselListing.photoIds.map(id => ({ id }))}
      initialPhotoId={carouselInitialPhotoId}
      onClose={() => setCarouselListingId(null)}
    />}

    {previewListing && <PreviewListingDialog
      groupTitle={previewListing.generatedTitle || "this listing"}
      generatedTitle={previewListing.generatedTitle}
      generatedDescription={previewListing.generatedDescription}
      ukSize={previewListing.ukSize}
      sku={previewListing.sku}
      condition={previewListing.condition}
      coverImageUrl={previewListing.coverPhotoId ? `/api/listing-studio/images/${previewListing.coverPhotoId}/view` : null}
      onClose={() => setPreviewListingId(null)}
    />}

    {editFieldsListing && <EditListingFieldsDialog
      groupTitle={editFieldsListing.generatedTitle || "this listing"}
      fields={{
        brand: editFieldsListing.brand ?? "", model: editFieldsListing.model ?? "", productType: editFieldsListing.productType ?? "",
        colours: editFieldsListing.colours ?? [], material: editFieldsListing.material ?? "", ukSize: editFieldsListing.ukSize ?? "", sku: editFieldsListing.sku ?? "",
        vintedAudience: editFieldsListing.vintedAudience ?? "unknown",
        vintedCategoryId: editFieldsListing.vintedCategoryId, vintedCategoryPath: editFieldsListing.vintedCategoryPath,
      }}
      loading={savingListingFields}
      error={editFieldsError}
      onClose={() => { setEditFieldsListingId(null); setEditFieldsError(""); }}
      onSave={handleSaveListingFields}
    />}

    {bulkDeleteConfirmOpen && <ConfirmDialog
      title={`Delete ${bulkCount} listing${bulkCount === 1 ? "" : "s"}?`}
      message="These listings and their photos will be permanently deleted. This cannot be undone."
      confirmLabel={`Delete ${bulkCount} listing${bulkCount === 1 ? "" : "s"}`}
      onConfirm={handleBulkDelete}
      onCancel={() => setBulkDeleteConfirmOpen(false)}
    />}
  </div>;
}
