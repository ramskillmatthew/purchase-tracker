"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UploadDropzone from "./UploadDropzone";
import UploadQueue from "./UploadQueue";
import ProductGroupCard, { computeStatus, STATUS_LABELS, type CardStatus, type GeneratedListingSummary } from "./ProductGroupCard";
import EditListingFieldsDialog, { type ListingFieldsDraft } from "./EditListingFieldsDialog";
import PreviewListingDialog from "./PreviewListingDialog";
import MovePhotosDialog, { type MovableGroup } from "./MovePhotosDialog";
import MergeGroupsDialog, { type MergeableGroup } from "./MergeGroupsDialog";
import DeleteGroupDialog, { type DeleteGroupMode } from "./DeleteGroupDialog";
import ClearWorkspaceDialog from "./ClearWorkspaceDialog";
import WorkflowSteps from "./WorkflowSteps";
import TaskToast from "@/components/TaskToast";
import ConfirmDialog from "@/components/ConfirmDialog";
import type { UploadItem } from "./upload-types";
import type { PhotoTileData } from "./SortablePhotoGrid";
import { isAcceptedFile, partitionDuplicateFiles } from "@/lib/listing-studio/file-selection";
import { CHUNK_OVERLAP_SIZE, MAX_AUTO_GROUP_BATCH_SIZE, MAX_AUTO_GROUP_SESSION_SIZE } from "@/lib/listing-studio/upload-limits";
import { prepareImagePreview, releaseImagePreview } from "@/lib/listing-studio/client-image-processing";

type WorkspaceDraft = {
  id: string; title: string | null; status: string; created_at: string; updated_at: string;
  // Milestone 4 (AI listing generation) — see ProductGroupCard.tsx's
  // GeneratedListingSummary for why generated_title/generated_description
  // are distinct from `title` above.
  // Milestone 6 (Vinted-aware colours/materials): colours/material replace
  // the old free-text colour column.
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; sku: string | null; generated_title: string | null; generated_description: string | null;
  // Milestone 7 (Vinted category catalogue sync).
  vinted_category_id: number | null; vinted_category_path: string | null; vinted_category_source: "ai" | "manual" | null;
  vinted_category_status: string | null;
  // Follow-up correction (2026-08-04).
  vinted_audience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null;
};
type WorkspaceImage = {
  id: string; draft_id: string; original_filename: string; mime_type: string; file_size: number;
  width: number | null; height: number | null; sort_order: number;
  detected_role: string | null; confirmed_role: string | null; upload_state: PhotoTileData["uploadState"]; preview_available: boolean;
};
type WorkspaceData = { drafts: WorkspaceDraft[]; images: WorkspaceImage[] };

// A brand-new group (via "+ New product" or "Move/Split -> New group") has
// none of Milestone 4's listing fields yet — spread into the locally
// appended draft object right after creation, before the next
// loadWorkspace() call replaces it with the server's own copy.
const BLANK_LISTING_FIELDS = {
  brand: null, model: null, product_type: null, colours: null, material: null,
  uk_size: null, sku: null, generated_title: null, generated_description: null,
  vinted_category_id: null, vinted_category_path: null, vinted_category_source: null, vinted_category_status: null,
  vinted_audience: null,
} as const;

type SaveState = "idle" | "saving" | "saved" | "failed";

// A stable reference for groups with no photos, so memo()'d ProductGroupCard
// doesn't see a "changed" prop (a fresh []) on every unrelated re-render.
const EMPTY_PHOTOS: PhotoTileData[] = [];

// REGRESSION (v3): a proposal is now always a CONTIGUOUS sequence range
// (ordered boundary detection), never an arbitrary photo selection — see
// lib/listing-studio/auto-group-schemas.ts's top-of-file comment for why.
type AutoGroupProposal = {
  proposedGroupId: string; imageIds: string[]; photoCount: number;
  boundaryReason: string; warnings: string[];
};
type AutoGroupSummary = {
  ranAnalysis: boolean;
  groupsCreated: { draftId: string; title: string; photoCount: number }[];
  photosGroupedCount: number;
  photosPendingReviewCount: number;
  photosLeftInUnsortedCount: number;
  totalUnsortedAtStart: number;
  truncated: boolean;
};

// Cycled on a timer while any one chunk's request is in flight — there is no
// real incremental progress to report *within* a single request, but the
// analysedSoFar/totalToAnalyse counters below (updated once per completed
// chunk) ARE real progress, shown alongside this.
const AUTO_GROUP_STAGE_TEXTS = ["Preparing photos", "Comparing products", "Building product groups", "Applying groups"];

type AutoGroupProgress = {
  totalToAnalyse: number;
  analysedSoFar: number;
  productsIdentifiedSoFar: number;
  stageIndex: number;
};


// Undo toast contract: onAction runs when the user clicks "Undo"; onDismiss
// always runs afterward (immediately on click, or automatically once the
// toast's timer elapses). Delay-based actions (deletes) only make their real
// API call inside onDismiss, and only if onAction didn't already cancel it —
// so nothing destructive happens until the undo window actually passes.
// Inverse-based actions (move/split/merge) have already been committed to
// the server by the time the toast appears; onAction there just replays the
// opposite call.
type PendingUndo = { message: string; onAction: () => void; onDismiss: () => void };

async function runWithConcurrencyLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    let next: T | undefined;
    while ((next = queue.shift())) await task(next);
  });
  await Promise.all(workers);
}

function putWithProgress(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
    xhr.setRequestHeader("apikey", anonKey);
    xhr.setRequestHeader("Authorization", `Bearer ${anonKey}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress((event.loaded / event.total) * 100); };
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error(`Upload failed (status ${xhr.status})`)); };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export default function GroupingWorkspace() {
  const [drafts, setDrafts] = useState<WorkspaceDraft[]>([]);
  const [images, setImages] = useState<WorkspaceImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploadNotice, setUploadNotice] = useState("");
  const [uploadSuccessMessage, setUploadSuccessMessage] = useState("");
  // Visual redesign — client-side only, narrows the already-loaded `drafts`
  // array for display; never a new fetch, never sent to the server.
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CardStatus | "all">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [moveDialogGroupId, setMoveDialogGroupId] = useState<string | null>(null);
  const [moveDialogMode, setMoveDialogMode] = useState<"move" | "split">("move");
  const [mergeDialogGroupId, setMergeDialogGroupId] = useState<string | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<{ id: string; title: string; photoCount: number } | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  // Set to a group's id for exactly one render right after "+ New product"
  // creates it, so its card opens straight into rename mode with no click.
  const [autoEditGroupId, setAutoEditGroupId] = useState<string | null>(null);
  const handleAutoEditConsumed = useCallback(() => setAutoEditGroupId(null), []);

  const [autoGroupRunning, setAutoGroupRunning] = useState(false);
  const [autoGroupProgress, setAutoGroupProgress] = useState<AutoGroupProgress | null>(null);
  const [autoGroupError, setAutoGroupError] = useState<string | null>(null);
  const [autoGroupSummary, setAutoGroupSummary] = useState<AutoGroupSummary | null>(null);
  const [autoGroupProposals, setAutoGroupProposals] = useState<AutoGroupProposal[]>([]);
  const [applyingProposalId, setApplyingProposalId] = useState<string | null>(null);

  const [clearWorkspaceDialogOpen, setClearWorkspaceDialogOpen] = useState(false);
  const [clearingWorkspace, setClearingWorkspace] = useState(false);
  const [clearWorkspaceError, setClearWorkspaceError] = useState("");

  // Milestone 4 (AI listing generation)
  const [generatingListings, setGeneratingListings] = useState(false);
  const [generateListingsProgress, setGenerateListingsProgress] = useState<{ done: number; total: number } | null>(null);
  const [generateListingsError, setGenerateListingsError] = useState<string | null>(null);
  const [editFieldsGroupId, setEditFieldsGroupId] = useState<string | null>(null);
  const [savingListingFields, setSavingListingFields] = useState(false);
  const [editFieldsError, setEditFieldsError] = useState("");
  // Milestone 4 UX fix — read-only full preview, distinct from Edit fields.
  const [previewGroupId, setPreviewGroupId] = useState<string | null>(null);
  // Visual redesign (compact/expandable product cards) — display-only,
  // never persisted: which single card currently shows its full photo
  // grid. Safe to switch freely between groups since every real piece of
  // state (images, selection, etc.) already lives in THIS component, never
  // inside the card itself — collapsing/expanding a card can never lose
  // data. Only one expanded at a time, per the redesign spec.
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  // Visual redesign (per-card generation status) — display-only tracking
  // layered onto the EXISTING handleGenerateListings loop below, purely
  // additive: never changes its request order, retries, error handling, or
  // API payloads/results. currentlyGeneratingGroupId is set/cleared around
  // each already-sequential fetch; generationFailedGroupIds is reset at the
  // start of each run and gains one id per already-existing failure branch.
  const [currentlyGeneratingGroupId, setCurrentlyGeneratingGroupId] = useState<string | null>(null);
  const [generationFailedGroupIds, setGenerationFailedGroupIds] = useState<Set<string>>(new Set());

  // Visual redesign — the upload-success banner is a temporary notification,
  // not a permanent status line: it clears itself a few seconds after being
  // set, on top of the three existing places that already set/clear it.
  useEffect(() => {
    if (!uploadSuccessMessage) return;
    const timer = setTimeout(() => setUploadSuccessMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [uploadSuccessMessage]);

  const uploadItemsRef = useRef<UploadItem[]>([]);
  useEffect(() => { uploadItemsRef.current = uploadItems; }, [uploadItems]);
  const pendingUndoRef = useRef<PendingUndo | null>(null);
  useEffect(() => { pendingUndoRef.current = pendingUndo; }, [pendingUndo]);

  // If another undo-able action starts while one is still pending, resolve
  // the earlier one right away (its own timeout would otherwise still fire
  // later, which is harmless, but only one toast can be shown at a time and
  // the user's attention has already moved on).
  function forceResolvePendingUndo() {
    pendingUndoRef.current?.onDismiss();
  }

  async function loadWorkspace(): Promise<WorkspaceData | null> {
    try {
      const response = await fetch("/api/listing-studio/workspace");
      if (!response.ok) { setLoadError("Could not load your workspace."); return null; }
      const data = await response.json() as WorkspaceData;
      setDrafts(data.drafts);
      setImages(data.images);
      setLoadError("");
      return data;
    } catch { setLoadError("Could not load your workspace. Check your connection and try again."); return null; }
    finally { setLoading(false); }
  }
  useEffect(() => { loadWorkspace(); }, []);

  function flashSaved() {
    setSaveState("saved");
    setTimeout(() => setSaveState(current => (current === "saved" ? "idle" : current)), 2000);
  }
  // REGRESSION: this single saveState is shared by every group card at
  // once (see the shared `saveState={saveState}` prop below) — it's a
  // workspace-wide "something is saving / just saved / just failed"
  // indicator, not a per-card one. "saved" always auto-cleared back to
  // "idle" via flashSaved's own timeout, but "failed" never did — so a
  // single failed save from ANY action (a rename, a reorder, a stale
  // reference on the losing side of a race, one flaky request) left every
  // card permanently showing "Save failed" until the next unrelated action
  // happened to succeed, long after that original failure was resolved or
  // irrelevant. flashFailed mirrors flashSaved exactly (same
  // guarded-timeout pattern, just a longer window so a real failure stays
  // visible long enough to actually notice) so the indicator always
  // reflects *recent* activity, never a stale failure from minutes ago.
  function flashFailed() {
    setSaveState("failed");
    setTimeout(() => setSaveState(current => (current === "failed" ? "idle" : current)), 5000);
  }
  async function withSaveState(action: () => Promise<Response>): Promise<{ ok: boolean; error?: string }> {
    setSaveState("saving");
    try {
      const response = await action();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { flashFailed(); return { ok: false, error: body.error || "Save failed." }; }
      flashSaved();
      return { ok: true };
    } catch { flashFailed(); return { ok: false, error: "Network error — please try again." }; }
  }

  // ---- Upload flow ----
  async function handleFilesSelected(files: File[]) {
    setUploadNotice("");
    setUploadSuccessMessage("");
    const accepted: File[] = [];
    const rejected: File[] = [];
    for (const file of files) (isAcceptedFile(file) ? accepted : rejected).push(file);

    const existingKeys = new Set(uploadItemsRef.current.map(item => `${item.file.name.trim().toLowerCase()}:${item.file.size}`));
    const { unique, duplicates } = partitionDuplicateFiles(existingKeys, accepted);

    const notices: string[] = [];
    if (rejected.length) notices.push(`${rejected.length} file(s) skipped — unsupported type: ${rejected.map(f => f.name).join(", ")}`);
    if (duplicates.length) notices.push(`${duplicates.length} file(s) already added, skipped: ${duplicates.map(f => f.name).join(", ")}`);
    if (notices.length) setUploadNotice(notices.join(" "));
    if (!unique.length) return;

    const newItems: UploadItem[] = unique.map(file => ({
      clientId: crypto.randomUUID(), file, imageId: null, draftId: null,
      previewUrl: null, previewAvailable: true, state: "pending", progress: 0, errorMessage: null,
    }));
    setUploadItems(current => [...current, ...newItems]);

    newItems.forEach(item => {
      prepareImagePreview(item.file).then(preview => {
        setUploadItems(current => current.map(existing => existing.clientId === item.clientId ? { ...existing, previewUrl: preview.previewUrl, previewAvailable: preview.previewAvailable } : existing));
      });
    });

    await runUploadBatch(newItems);
  }

  async function runUploadBatch(items: UploadItem[]) {
    const ids = new Set(items.map(item => item.clientId));
    setUploadItems(current => current.map(item => ids.has(item.clientId) ? { ...item, state: "uploading" } : item));
    try {
      const response = await fetch("/api/listing-studio/uploads", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: items.map(item => ({ filename: item.file.name, mimeType: item.file.type || "application/octet-stream", fileSize: item.file.size })) }),
      });
      const data = await response.json();
      if (!response.ok) {
        setUploadItems(current => current.map(item => ids.has(item.clientId) ? { ...item, state: "failed", errorMessage: data.error || "Could not start upload." } : item));
        return;
      }
      const { draftId, images: serverImages } = data as { draftId: string; images: { imageId: string; uploadUrl: string }[] };
      const paired = items.map((item, index) => ({ item, server: serverImages[index] }));
      setUploadItems(current => current.map(item => {
        const pair = paired.find(p => p.item.clientId === item.clientId);
        return pair ? { ...item, imageId: pair.server.imageId } : item;
      }));

      await runWithConcurrencyLimit(paired, 3, ({ item, server }) => uploadOneFile(item.clientId, item.file, server.imageId, server.uploadUrl));
      const fresh = await loadWorkspace();

      // Upload-to-group transition (UX refinement spec §8): tell the user
      // exactly what happened and where, then bring that group into view —
      // never leave them wondering what to click next.
      const succeeded = uploadItemsRef.current.filter(item => ids.has(item.clientId) && item.state === "uploaded").length;
      if (succeeded > 0) {
        const groupTitle = fresh?.drafts.find(draft => draft.id === draftId)?.title || "Unsorted";
        setUploadSuccessMessage(`${succeeded} photo${succeeded === 1 ? "" : "s"} uploaded and added to ${groupTitle}`);
        requestAnimationFrame(() => {
          document.getElementById(`listing-group-${draftId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    } catch {
      setUploadItems(current => current.map(item => ids.has(item.clientId) ? { ...item, state: "failed", errorMessage: "Network error — please retry." } : item));
    }
  }

  async function uploadOneFile(clientId: string, file: File, imageId: string, uploadUrl: string) {
    try {
      await putWithProgress(uploadUrl, file, progress => {
        setUploadItems(current => current.map(item => item.clientId === clientId ? { ...item, progress } : item));
      });
      const current = uploadItemsRef.current.find(item => item.clientId === clientId);
      const confirmResponse = await fetch(`/api/listing-studio/uploads/${imageId}/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewAvailable: current?.previewAvailable ?? true }),
      });
      const body = await confirmResponse.json().catch(() => ({}));
      if (!confirmResponse.ok) {
        setUploadItems(current2 => current2.map(item => item.clientId === clientId ? { ...item, state: "failed", errorMessage: body.error || "Could not confirm upload." } : item));
        return;
      }
      setUploadItems(current2 => current2.map(item => item.clientId === clientId ? { ...item, state: "uploaded", progress: 100 } : item));
    } catch {
      setUploadItems(current => current.map(item => item.clientId === clientId ? { ...item, state: "failed", errorMessage: "Upload failed — please retry." } : item));
    }
  }

  async function handleRetryUpload(clientId: string) {
    const item = uploadItemsRef.current.find(existing => existing.clientId === clientId);
    if (!item?.imageId) return;
    setUploadItems(current => current.map(existing => existing.clientId === clientId ? { ...existing, state: "uploading", progress: 0, errorMessage: null } : existing));
    try {
      const response = await fetch(`/api/listing-studio/uploads/${item.imageId}/retry`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setUploadItems(current => current.map(existing => existing.clientId === clientId ? { ...existing, state: "failed", errorMessage: data.error || "Could not retry." } : existing));
        return;
      }
      await uploadOneFile(clientId, item.file, item.imageId, data.uploadUrl);
      await loadWorkspace();
    } catch {
      setUploadItems(current => current.map(existing => existing.clientId === clientId ? { ...existing, state: "failed", errorMessage: "Network error — please retry." } : existing));
    }
  }

  async function handleRemoveUploadItem(clientId: string) {
    const item = uploadItemsRef.current.find(existing => existing.clientId === clientId);
    releaseImagePreview(item?.previewUrl ?? null);
    setUploadItems(current => current.filter(existing => existing.clientId !== clientId));
    if (item?.imageId) {
      await fetch(`/api/listing-studio/images/${item.imageId}`, { method: "DELETE" }).catch(() => {});
      await loadWorkspace();
    }
  }

  // ---- Selection ----
  const toggleSelect = useCallback((photoId: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId); else next.add(photoId);
      return next;
    });
  }, []);

  const handleSelectRange = useCallback((photoIds: string[]) => {
    setSelectedIds(current => new Set([...current, ...photoIds]));
  }, []);

  // Both operate against `images` state — the group's full photo list —
  // never against whatever SortablePhotoGrid currently renders, so they
  // correctly reach photos hidden behind its own display limit. Each only
  // ever adds/removes that one group's own ids, never touching another
  // group's current selection.
  const handleSelectAllInGroup = useCallback((draftId: string) => {
    setSelectedIds(current => {
      const groupImageIds = images.filter(image => image.draft_id === draftId).map(image => image.id);
      return new Set([...current, ...groupImageIds]);
    });
  }, [images]);

  const handleClearSelectionInGroup = useCallback((draftId: string) => {
    setSelectedIds(current => {
      const groupImageIds = new Set(images.filter(image => image.draft_id === draftId).map(image => image.id));
      const next = new Set(current);
      for (const id of groupImageIds) next.delete(id);
      return next;
    });
  }, [images]);

  // ---- Delayed-undo deletes: nothing destructive happens until the toast's
  // ~5s window elapses with no click, so "Undo" never needs to reverse an
  // API call that already ran — it just restores what was optimistically
  // hidden from local state. ----
  async function commitDeletePhotos(imageIds: string[]) {
    if (!imageIds.length) return;
    setSaveState("saving");
    try {
      await runWithConcurrencyLimit(imageIds, 5, async photoId => { await fetch(`/api/listing-studio/images/${photoId}`, { method: "DELETE" }); });
      flashSaved();
    } catch { flashFailed(); }
  }

  const handleRemovePhoto = useCallback((photoId: string) => {
    const snapshot = images.find(image => image.id === photoId);
    if (!snapshot) return;
    forceResolvePendingUndo();
    setImages(current => current.filter(image => image.id !== photoId));
    setSelectedIds(current => { const next = new Set(current); next.delete(photoId); return next; });
    let undone = false;
    setPendingUndo({
      message: `"${snapshot.original_filename}" removed`,
      onAction: () => { undone = true; setImages(current => [...current, snapshot]); },
      onDismiss: () => { if (!undone) commitDeletePhotos([photoId]); setPendingUndo(null); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- forceResolvePendingUndo/commitDeletePhotos read the latest refs/state themselves
  }, [images]);

  function handleBulkDeleteSelected() {
    const ids = [...selectedIds];
    setBulkDeleteConfirmOpen(false);
    if (!ids.length) return;
    forceResolvePendingUndo();
    const snapshots = images.filter(image => ids.includes(image.id));
    setImages(current => current.filter(image => !ids.includes(image.id)));
    setSelectedIds(new Set());
    let undone = false;
    setPendingUndo({
      message: `${snapshots.length} photo${snapshots.length === 1 ? "" : "s"} removed`,
      onAction: () => { undone = true; setImages(current => [...current, ...snapshots]); },
      onDismiss: () => { if (!undone) commitDeletePhotos(ids); setPendingUndo(null); },
    });
  }

  async function handleRename(draftId: string, title: string) {
    const result = await withSaveState(() => fetch(`/api/listing-studio/groups/${draftId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    }));
    if (result.ok) setDrafts(current => current.map(draft => draft.id === draftId ? { ...draft, title } : draft));
  }

  async function handleReorder(draftId: string, orderedImageIds: string[]) {
    setImages(current => {
      const orderIndex = new Map(orderedImageIds.map((id, index) => [id, index]));
      return current.map(image => image.draft_id === draftId && orderIndex.has(image.id) ? { ...image, sort_order: orderIndex.get(image.id)! } : image);
    });
    await withSaveState(() => fetch(`/api/listing-studio/groups/${draftId}/reorder`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderedImageIds }),
    }));
  }

  function handleSetCover(draftId: string, photoId: string) {
    const groupImages = images.filter(image => image.draft_id === draftId).sort((a, b) => a.sort_order - b.sort_order);
    const orderedIds = [photoId, ...groupImages.map(image => image.id).filter(id => id !== photoId)];
    handleReorder(draftId, orderedIds);
  }

  // "+ New product": one click, no modal, no textbox. The server assigns
  // the next "Product N" placeholder (lib/listing-studio/group-naming.ts is
  // the single source of truth for that number); the group is appended
  // locally right away so it can be scrolled into view and dropped into
  // rename mode without waiting on a second round trip.
  async function handleCreateGroup() {
    setSaveState("saving");
    try {
      const response = await fetch("/api/listing-studio/groups", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { flashFailed(); return; }
      const { draftId, title } = body as { draftId: string; title: string };
      const now = new Date().toISOString();
      setDrafts(current => [...current, { id: draftId, title, status: "grouping", created_at: now, updated_at: now, ...BLANK_LISTING_FIELDS }]);
      flashSaved();
      setAutoEditGroupId(draftId);
      requestAnimationFrame(() => {
        document.getElementById(`listing-group-${draftId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch { flashFailed(); }
  }

  // An empty group deletes (after the undo window) immediately; a group
  // with photos opens a confirmation dialog first — never a silent
  // bulk-delete of someone's photos — offering the safe "move to Unsorted"
  // default or an explicit, visibly destructive "delete everything" choice.
  function handleDeleteGroup(draftId: string) {
    const photoCount = images.filter(image => image.draft_id === draftId).length;
    if (photoCount === 0) {
      const group = drafts.find(draft => draft.id === draftId);
      scheduleDelayedGroupDelete(draftId, group?.title || "this group", undefined);
      return;
    }
    const group = drafts.find(draft => draft.id === draftId);
    setDeleteGroupTarget({ id: draftId, title: group?.title || "this group", photoCount });
  }

  function handleConfirmDeleteGroup(mode: DeleteGroupMode) {
    if (!deleteGroupTarget) return;
    scheduleDelayedGroupDelete(deleteGroupTarget.id, deleteGroupTarget.title, mode);
    setDeleteGroupTarget(null);
  }

  function scheduleDelayedGroupDelete(draftId: string, title: string, mode: DeleteGroupMode | undefined) {
    forceResolvePendingUndo();
    const removedDraft = drafts.find(draft => draft.id === draftId) ?? null;
    const removedImages = images.filter(image => image.draft_id === draftId);
    setDrafts(current => current.filter(draft => draft.id !== draftId));
    setImages(current => current.filter(image => image.draft_id !== draftId));
    setSelectedIds(current => {
      const next = new Set(current);
      for (const image of removedImages) next.delete(image.id);
      return next;
    });
    let undone = false;
    setPendingUndo({
      message: `"${title}" deleted`,
      onAction: () => {
        undone = true;
        if (removedDraft) setDrafts(current => [...current, removedDraft]);
        setImages(current => [...current, ...removedImages]);
      },
      onDismiss: () => {
        if (!undone) {
          (async () => {
            setSaveState("saving");
            try {
              const response = await fetch(`/api/listing-studio/groups/${draftId}`, {
                method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode ? { mode } : {}),
              });
              if (response.ok) { flashSaved(); await loadWorkspace(); } else flashFailed();
            } catch { flashFailed(); }
          })();
        }
        setPendingUndo(null);
      },
    });
  }

  async function handleMove(targetDraftId: string) {
    setDialogBusy(true);
    const imageIds = [...selectedIds];
    const originalDraftByImage = new Map(imageIds.map(id => [id, images.find(image => image.id === id)?.draft_id ?? null]));
    const targetGroup = drafts.find(draft => draft.id === targetDraftId);
    const result = await withSaveState(() => fetch("/api/listing-studio/groups/move-images", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageIds, targetDraftId }),
    }));
    setDialogBusy(false);
    if (result.ok) {
      setMoveDialogGroupId(null); setSelectedIds(new Set()); await loadWorkspace();
      forceResolvePendingUndo();
      setPendingUndo({
        message: `${imageIds.length} photo${imageIds.length === 1 ? "" : "s"} moved to "${targetGroup?.title || "the group"}"`,
        onAction: () => {
          (async () => {
            const bySource = new Map<string, string[]>();
            for (const [imageId, sourceDraftId] of originalDraftByImage) {
              if (!sourceDraftId) continue;
              const list = bySource.get(sourceDraftId);
              if (list) list.push(imageId); else bySource.set(sourceDraftId, [imageId]);
            }
            for (const [sourceDraftId, ids] of bySource) {
              await fetch("/api/listing-studio/groups/move-images", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageIds: ids, targetDraftId: sourceDraftId }),
              });
            }
            await loadWorkspace();
          })();
        },
        onDismiss: () => setPendingUndo(null),
      });
    }
  }

  // Move → New group: no textbox — the server auto-names the destination
  // (same helper/sequence as "+ New product"). Appended to local state
  // immediately so handleMove's own `drafts.find(...)` lookup (for its undo
  // toast's group name) resolves correctly without waiting on a reload.
  async function handleCreateAndMove() {
    setDialogBusy(true);
    const created = await fetch("/api/listing-studio/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const createdBody = await created.json().catch(() => ({}));
    if (!created.ok) { setDialogBusy(false); flashFailed(); return; }
    const { draftId, title } = createdBody as { draftId: string; title: string };
    const now = new Date().toISOString();
    setDrafts(current => [...current, { id: draftId, title, status: "grouping", created_at: now, updated_at: now, ...BLANK_LISTING_FIELDS }]);
    await handleMove(draftId);
  }

  // Split → New group: same idea — no textbox; the split route auto-names
  // the new group and returns the resolved title for the undo toast.
  async function handleSplit() {
    if (!moveDialogGroupId) return;
    setDialogBusy(true);
    const imageIds = [...selectedIds];
    const sourceDraftId = moveDialogGroupId;
    const response = await fetch("/api/listing-studio/groups/split", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceDraftId, imageIds }),
    });
    const body = await response.json().catch(() => ({}));
    setDialogBusy(false);
    if (response.ok) {
      const { title: targetTitle } = body as { draftId: string; title: string };
      setMoveDialogGroupId(null); setSelectedIds(new Set()); flashSaved(); await loadWorkspace();
      forceResolvePendingUndo();
      setPendingUndo({
        message: `${imageIds.length} photo${imageIds.length === 1 ? "" : "s"} split into "${targetTitle}"`,
        onAction: () => {
          (async () => {
            await fetch("/api/listing-studio/groups/move-images", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageIds, targetDraftId: sourceDraftId }),
            });
            await loadWorkspace();
          })();
        },
        onDismiss: () => setPendingUndo(null),
      });
    } else flashFailed();
  }

  async function handleMerge(targetDraftId: string) {
    if (!mergeDialogGroupId) return;
    setDialogBusy(true);
    const sourceDraftId = mergeDialogGroupId;
    const sourceTitle = drafts.find(draft => draft.id === sourceDraftId)?.title || "this group";
    const sourceImageIds = images.filter(image => image.draft_id === sourceDraftId).map(image => image.id);
    const targetTitle = drafts.find(draft => draft.id === targetDraftId)?.title || "the group";
    const result = await withSaveState(() => fetch("/api/listing-studio/groups/merge", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceDraftId, targetDraftId }),
    }));
    setDialogBusy(false);
    if (result.ok) {
      setMergeDialogGroupId(null); await loadWorkspace();
      forceResolvePendingUndo();
      setPendingUndo({
        message: `"${sourceTitle}" merged into "${targetTitle}"`,
        onAction: () => {
          (async () => {
            const created = await fetch("/api/listing-studio/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: sourceTitle }) });
            const createdBody = await created.json().catch(() => ({}));
            if (!created.ok || !sourceImageIds.length) { await loadWorkspace(); return; }
            await fetch("/api/listing-studio/groups/move-images", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageIds: sourceImageIds, targetDraftId: createdBody.draftId }),
            });
            await loadWorkspace();
          })();
        },
        onDismiss: () => setPendingUndo(null),
      });
    }
  }

  // ---- Automatic AI product grouping ----
  // One click processes a whole normal listing session (up to
  // MAX_AUTO_GROUP_SESSION_SIZE photos) without the user ever clicking
  // again: the eligible Unsorted set is sliced into
  // MAX_AUTO_GROUP_BATCH_SIZE-sized chunks here, and this loop calls the
  // analyze route once per chunk, automatically, in sequence — each request
  // stays small and safely bounded server-side (see that route's own
  // maxDuration), while the whole run still covers everything. A chunk that
  // fails for a reason that might be transient (502) doesn't abort the
  // run — its photos simply stay in Unsorted and the loop continues, since
  // one bad batch out of several must never waste the chunks that already
  // succeeded; a chunk reporting the service isn't configured at all (503)
  // stops the loop immediately, since every remaining chunk would fail
  // identically. There is no meaningful, safe way to cancel mid-flight
  // here — a chunk may already have created and moved high-confidence
  // groups by the time a "Cancel" click could reach it, and pretending to
  // stop something that already happened would be worse than not offering
  // cancellation at all — so this deliberately has no Cancel action, only
  // Retry after a failure (which simply re-runs the same logic against
  // whatever is still in Unsorted — already-grouped photos are naturally
  // excluded next time, so retrying never reprocesses a success).
  async function handleAutoGroupProducts() {
    const unsortedDraft = drafts.find(draft => draft.title === "Unsorted");
    const eligible = unsortedDraft
      ? images.filter(image => image.draft_id === unsortedDraft.id && image.upload_state === "uploaded").sort((a, b) => a.sort_order - b.sort_order)
      : [];
    if (eligible.length === 0) {
      setAutoGroupError(null);
      setAutoGroupSummary({ ranAnalysis: false, groupsCreated: [], photosGroupedCount: 0, photosPendingReviewCount: 0, photosLeftInUnsortedCount: 0, totalUnsortedAtStart: 0, truncated: false });
      setAutoGroupProposals([]);
      return;
    }

    const totalEligible = eligible.length;
    const capped = eligible.slice(0, MAX_AUTO_GROUP_SESSION_SIZE);
    const chunks: typeof capped[] = [];
    for (let i = 0; i < capped.length; i += MAX_AUTO_GROUP_BATCH_SIZE) chunks.push(capped.slice(i, i + MAX_AUTO_GROUP_BATCH_SIZE));

    setAutoGroupRunning(true);
    setAutoGroupError(null);
    setAutoGroupSummary(null);
    setAutoGroupProposals([]);
    setAutoGroupProgress({ totalToAnalyse: capped.length, analysedSoFar: 0, productsIdentifiedSoFar: 0, stageIndex: 0 });
    const stageTimer = setInterval(() => {
      setAutoGroupProgress(current => current && { ...current, stageIndex: (current.stageIndex + 1) % AUTO_GROUP_STAGE_TEXTS.length });
    }, 2500);

    // Every chunk is only ANALYSED here — never applied — so a physical
    // product spanning a chunk boundary can be reconciled (stitched back
    // together via continuesFromPreviousChunk) before anything is written.
    // Only after every chunk is done does one single apply-session call
    // reconcile the whole session and apply it, all-or-nothing.
    const chunkResults: { groups: unknown[]; ungroupedImageIds: string[] }[] = [];
    let hardStopError: string | null = null;
    let softFailureCount = 0;
    let proposedBoundariesSoFar = 0;

    try {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const chunkStartSequenceIndex = chunkIndex * MAX_AUTO_GROUP_BATCH_SIZE + 1;
        // A small read-only tail of the previous chunk, shown again so the
        // model can judge whether this chunk's first photo continues that
        // same physical product across the chunk boundary — never
        // re-analysed or re-moved, context only.
        const overlapImageIds = chunkIndex > 0 ? chunks[chunkIndex - 1].slice(-CHUNK_OVERLAP_SIZE).map(image => image.id) : [];

        setAutoGroupProgress(current => current && { ...current, stageIndex: 0 });
        let response: Response;
        try {
          response = await fetch("/api/listing-studio/groups/auto-group", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageIds: chunk.map(image => image.id), overlapImageIds, chunkStartSequenceIndex }),
          });
        } catch { hardStopError = "Network error — please try again."; break; }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 503) { hardStopError = body.error || "Automatic grouping is not available right now."; break; }
          softFailureCount += 1;
          setAutoGroupProgress(current => current && { ...current, analysedSoFar: current.analysedSoFar + chunk.length });
          continue;
        }
        chunkResults.push(body.data);
        proposedBoundariesSoFar += Array.isArray(body.data?.groups) ? body.data.groups.length : 0;
        setAutoGroupProgress(current => current && {
          ...current,
          analysedSoFar: current.analysedSoFar + chunk.length,
          productsIdentifiedSoFar: proposedBoundariesSoFar,
        });
      }

      if (chunkResults.length > 0) {
        setAutoGroupProgress(current => current && { ...current, stageIndex: AUTO_GROUP_STAGE_TEXTS.length - 1 });
        try {
          const applyResponse = await fetch("/api/listing-studio/groups/auto-group/apply-session", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageIds: capped.map(image => image.id), chunkResults }),
          });
          const applyBody = await applyResponse.json().catch(() => ({}));
          if (!applyResponse.ok) {
            hardStopError = hardStopError ?? applyBody.error ?? "Could not apply this session's groups.";
          } else {
            setAutoGroupSummary({
              ranAnalysis: true, truncated: totalEligible > capped.length || hardStopError !== null,
              totalUnsortedAtStart: totalEligible,
              groupsCreated: applyBody.groupsCreated ?? [], photosGroupedCount: applyBody.photosGroupedCount ?? 0,
              photosPendingReviewCount: applyBody.photosPendingReviewCount ?? 0, photosLeftInUnsortedCount: applyBody.photosLeftInUnsortedCount ?? 0,
            });
            setAutoGroupProposals(applyBody.proposedGroups ?? []);
            if ((applyBody.groupsCreated?.length ?? 0) > 0) await loadWorkspace();
          }
        } catch { hardStopError = hardStopError ?? "Network error — please try again."; }
      }

      if (hardStopError) setAutoGroupError(hardStopError);
      else if (softFailureCount > 0) setAutoGroupError(`${softFailureCount} of ${chunks.length} batches could not be analysed. Click Auto-group products again to retry them.`);
    } finally {
      clearInterval(stageTimer);
      setAutoGroupRunning(false);
      setAutoGroupProgress(null);
    }
  }

  async function handleApplyAutoGroupProposal(proposal: AutoGroupProposal) {
    setApplyingProposalId(proposal.proposedGroupId);
    setAutoGroupError(null);
    try {
      const response = await fetch("/api/listing-studio/groups/auto-group/apply", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageIds: proposal.imageIds }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setAutoGroupError(body.error || "Could not create this group."); return; }
      setAutoGroupProposals(current => current.filter(p => p.proposedGroupId !== proposal.proposedGroupId));
      await loadWorkspace();
      flashSaved();
    } catch { setAutoGroupError("Network error — please try again."); }
    finally { setApplyingProposalId(null); }
  }

  // No API call — these photos were never moved, so "skip" just stops
  // showing the suggestion; they remain exactly where they already are.
  function handleDismissAutoGroupProposal(proposedGroupId: string) {
    setAutoGroupProposals(current => current.filter(p => p.proposedGroupId !== proposedGroupId));
  }

  // ---- Clear all (workspace-wide reset) ----
  // One dedicated server call (DELETE /api/listing-studio/workspace) does
  // every photo and every group, Unsorted included, in one transaction —
  // never one request per image/group. Any pending undo toast is discarded
  // outright (setPendingUndo(null), not forceResolvePendingUndo()) rather
  // than fired: its target rows are about to be deleted by this action
  // anyway, so replaying its real network effect would be redundant at
  // best. Every other piece of local state this feature touches (upload
  // queue, auto-group progress/summary/proposals/error, selection, every
  // open dialog, the shared save indicator) is reset directly; drafts/
  // images themselves come from a real loadWorkspace() call afterward so
  // the UI reflects the server's own confirmation of empty, not an
  // assumption.
  async function handleClearWorkspace() {
    setClearingWorkspace(true);
    setClearWorkspaceError("");
    try {
      const response = await fetch("/api/listing-studio/workspace", { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setClearWorkspaceError(body.error || "Could not clear the workspace. Please try again.");
        return;
      }

      setPendingUndo(null);
      setSelectedIds(new Set());
      setUploadItems([]);
      setUploadNotice("");
      setUploadSuccessMessage("");
      setAutoGroupRunning(false);
      setAutoGroupProgress(null);
      setAutoGroupError(null);
      setAutoGroupSummary(null);
      setAutoGroupProposals([]);
      setApplyingProposalId(null);
      setMoveDialogGroupId(null);
      setMergeDialogGroupId(null);
      setDeleteGroupTarget(null);
      setBulkDeleteConfirmOpen(false);
      setAutoEditGroupId(null);
      setSaveState("idle");
      setLoadError("");
      setClearWorkspaceDialogOpen(false);
      await loadWorkspace();
    } catch {
      setClearWorkspaceError("Network error — could not clear the workspace. Please try again.");
    } finally {
      setClearingWorkspace(false);
    }
  }

  // ---- AI listing generation (Milestone 4) ----
  // One request per eligible group (not Unsorted, has at least one photo,
  // not yet generated — see eligibleListingGroups below), sequential,
  // continuing past an individual group's failure rather than aborting the
  // whole run, mirroring handleAutoGroupProducts's own resilience
  // convention. Never sends a title/description to the AI and never
  // accepts one back — see lib/listing-studio/listing-generation-schemas.ts's
  // own top comment. Re-clicking simply retries whichever groups still
  // have no generated_title; an already-generated group is never
  // regenerated by this bulk action.
  async function handleGenerateListings() {
    if (!eligibleListingGroups.length) return;
    setGeneratingListings(true);
    setGenerateListingsError(null);
    setGenerateListingsProgress({ done: 0, total: eligibleListingGroups.length });
    // Visual redesign — display-only, reset for this run; never read by any
    // request below, so it cannot affect what actually happens.
    setGenerationFailedGroupIds(new Set());

    let failureCount = 0;
    let anySucceeded = false;
    for (const group of eligibleListingGroups) {
      setCurrentlyGeneratingGroupId(group.id); // display-only — the fetch below is unchanged
      try {
        const response = await fetch(`/api/listing-studio/groups/${group.id}/generate`, { method: "POST" });
        if (response.ok) anySucceeded = true;
        else { failureCount += 1; setGenerationFailedGroupIds(current => new Set(current).add(group.id)); }
      } catch {
        failureCount += 1;
        setGenerationFailedGroupIds(current => new Set(current).add(group.id));
      }
      setGenerateListingsProgress(current => current && { ...current, done: current.done + 1 });
    }
    setCurrentlyGeneratingGroupId(null);

    if (anySucceeded) await loadWorkspace();
    if (failureCount > 0) {
      setGenerateListingsError(`${failureCount} of ${eligibleListingGroups.length} listing${eligibleListingGroups.length === 1 ? "" : "s"} could not be generated. Click Generate Listings again to retry them.`);
    }
    setGeneratingListings(false);
    setGenerateListingsProgress(null);
  }

  // Structured fields are the sole editable source of truth — saving here
  // always regenerates title/description via the server's own
  // listing-template.ts call, with no AI call. See EditListingFieldsDialog's
  // own top comment.
  async function handleSaveListingFields(fields: ListingFieldsDraft) {
    if (!editFieldsGroupId) return;
    const draftId = editFieldsGroupId;
    setSavingListingFields(true);
    setEditFieldsError("");
    try {
      const response = await fetch(`/api/listing-studio/groups/${draftId}/fields`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: fields.brand || null, model: fields.model || null, productType: fields.productType || null,
          colours: fields.colours, material: fields.material || null, ukSize: fields.ukSize || null, sku: fields.sku || null,
          vintedAudience: fields.vintedAudience, vintedCategoryId: fields.vintedCategoryId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setEditFieldsError(body.error || "Could not save these fields."); return; }
      setDrafts(current => current.map(draft => draft.id === draftId ? {
        ...draft,
        brand: body.brand, model: body.model, product_type: body.productType, colours: body.colours, material: body.material,
        uk_size: body.ukSize, sku: body.sku, generated_title: body.generatedTitle, generated_description: body.generatedDescription,
        vinted_audience: body.vintedAudience,
        vinted_category_id: body.vintedCategoryId, vinted_category_path: body.vintedCategoryPath, vinted_category_source: body.vintedCategorySource,
        vinted_category_status: body.vintedCategoryStatus,
      } : draft));
      setEditFieldsGroupId(null);
    } catch {
      setEditFieldsError("Network error — could not save these fields.");
    } finally {
      setSavingListingFields(false);
    }
  }

  function handleCloseEditFields() {
    setEditFieldsGroupId(null);
    setEditFieldsError("");
  }

  // ---- Keyboard shortcuts ----
  // Ctrl/Cmd+A selects every photo in whichever group currently has focus
  // (via the data-group-id ancestor set on each ProductGroupCard); Escape
  // clears the whole selection; Delete opens the existing bulk-delete
  // confirmation rather than deleting immediately. Disabled while any
  // dialog is open, or while typing in a text field (renaming a group,
  // typing a new group's name), so native input behaviour is never hijacked.
  const anyDialogOpen = Boolean(moveDialogGroupId || mergeDialogGroupId || deleteGroupTarget || bulkDeleteConfirmOpen || clearWorkspaceDialogOpen || editFieldsGroupId || previewGroupId);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const isEditable = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isEditable || anyDialogOpen) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        const groupEl = target instanceof HTMLElement ? target.closest("[data-group-id]") : null;
        const groupId = groupEl?.getAttribute("data-group-id");
        if (groupId) { event.preventDefault(); handleSelectAllInGroup(groupId); }
        return;
      }
      if (event.key === "Escape") {
        setSelectedIds(current => (current.size > 0 ? new Set() : current));
        return;
      }
      if (event.key === "Delete") {
        if (selectedIds.size > 0) { event.preventDefault(); setBulkDeleteConfirmOpen(true); }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, anyDialogOpen, handleSelectAllInGroup]);

  // A single lookup built once per images change, rather than every group
  // re-filtering/re-sorting the whole array on every render.
  const photosByGroupMap = useMemo(() => {
    const map = new Map<string, PhotoTileData[]>();
    const sorted = [...images].sort((a, b) => a.sort_order - b.sort_order);
    for (const image of sorted) {
      const tile: PhotoTileData = {
        id: image.id, filename: image.original_filename, role: image.confirmed_role ?? image.detected_role,
        uploadState: image.upload_state, previewAvailable: image.preview_available,
      };
      const list = map.get(image.draft_id);
      if (list) list.push(tile); else map.set(image.draft_id, [tile]);
    }
    return map;
  }, [images]);

  // Milestone 4 (AI listing generation) — a single lookup keyed by draft
  // id, rebuilt only when `drafts` changes, so memo()'d ProductGroupCard
  // never sees a "changed" listing prop on an unrelated re-render.
  const listingsByDraftId = useMemo(() => {
    const map = new Map<string, GeneratedListingSummary | null>();
    for (const draft of drafts) {
      map.set(draft.id, draft.generated_title && draft.generated_description ? {
        brand: draft.brand, model: draft.model, productType: draft.product_type, colours: draft.colours ?? [], material: draft.material,
        ukSize: draft.uk_size, sku: draft.sku, generatedTitle: draft.generated_title, generatedDescription: draft.generated_description,
      } : null);
    }
    return map;
  }, [drafts]);
  // Eligible for "Generate Listings": a real product group (never
  // Unsorted), with at least one photo, not already generated. Re-clicking
  // only ever processes whichever groups still lack a generated_title.
  const eligibleListingGroups = drafts.filter(draft =>
    draft.title !== "Unsorted" && !draft.generated_title && images.some(image => image.draft_id === draft.id),
  );
  const editFieldsTarget = drafts.find(draft => draft.id === editFieldsGroupId) ?? null;
  const previewTarget = drafts.find(draft => draft.id === previewGroupId) ?? null;
  const previewListing = previewGroupId ? listingsByDraftId.get(previewGroupId) ?? null : null;

  const movableGroups: MovableGroup[] = drafts.filter(draft => draft.id !== moveDialogGroupId).map(draft => ({ id: draft.id, title: draft.title, photoCount: images.filter(image => image.draft_id === draft.id).length }));
  const mergeSourceGroup = drafts.find(draft => draft.id === mergeDialogGroupId);
  const mergeableGroups: MergeableGroup[] = drafts.filter(draft => draft.id !== mergeDialogGroupId).map(draft => ({ id: draft.id, title: draft.title, photoCount: images.filter(image => image.draft_id === draft.id).length }));

  // Empty state (UX refinement spec §4): nothing but the upload panel and a
  // one-line explanation until there's real data — no stat cards, no empty
  // grouping section, no floating "Create new group" button.
  const hasAnyData = drafts.length > 0 || images.length > 0;
  const readyCount = drafts.filter(draft => draft.status === "ready").length;
  const unsortedDraft = drafts.find(draft => draft.title === "Unsorted");
  const unsortedPhotoCount = unsortedDraft ? images.filter(image => image.draft_id === unsortedDraft.id).length : 0;
  // "Clear all" is disabled while anything destructive/long-running of its
  // own is already in flight — an upload, an auto-group run, or another
  // clear — so it can never race with, or be raced by, one of those.
  const uploadsActive = uploadItems.some(item => item.state === "pending" || item.state === "uploading");
  const clearWorkspaceDisabled = autoGroupRunning || clearingWorkspace || uploadsActive || generatingListings;
  const generateListingsDisabled = generatingListings || autoGroupRunning || clearingWorkspace || uploadsActive;

  // Visual redesign — every value below is derived from state already
  // computed above; no new fetch, no new persisted concept. Photos
  // uploaded, real product groups (never Unsorted), groups still eligible
  // to generate, and groups already generated — the same four values the
  // old stat-card grid showed, now surfaced as one inline toolbar line.
  const productGroupsCount = drafts.filter(draft => draft.title !== "Unsorted").length;
  const orderedProductDrafts = drafts.filter(draft => draft.title !== "Unsorted");
  // Client-side only (no new fetch): narrows the already-loaded product
  // queue by name/brand/model/generated title, and by the exact same
  // status a row's own badge already shows — reuses computeStatus (the one
  // existing source of truth for status) rather than re-deriving it.
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleProductDrafts = orderedProductDrafts.filter(draft => {
    if (normalizedSearch) {
      const haystack = [draft.title, draft.brand, draft.model, draft.generated_title].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(normalizedSearch)) return false;
    }
    if (statusFilter !== "all") {
      const draftStatus = computeStatus(false, listingsByDraftId.get(draft.id) ?? null, draft.id === currentlyGeneratingGroupId, generationFailedGroupIds.has(draft.id), draft.vinted_category_id);
      if (draftStatus !== statusFilter) return false;
    }
    return true;
  });
  const handleToggleExpand = useCallback((draftId: string) => {
    setExpandedGroupId(current => (current === draftId ? null : draftId));
  }, []);

  // Shared by the Unsorted row and every real product row — keeps the two
  // render sites (Unsorted is never part of the searchable/filterable
  // product list) from duplicating this large, identical prop list.
  function renderGroupCard(draft: WorkspaceDraft) {
    return <ProductGroupCard
      key={draft.id}
      group={draft}
      photos={photosByGroupMap.get(draft.id) ?? EMPTY_PHOTOS}
      selectedIds={selectedIds}
      onToggleSelect={toggleSelect}
      onSelectAll={handleSelectAllInGroup}
      onClearSelection={handleClearSelectionInGroup}
      onSelectRange={handleSelectRange}
      onRename={handleRename}
      onReorder={handleReorder}
      onSetCover={handleSetCover}
      onRemovePhoto={handleRemovePhoto}
      onMoveSelected={groupId => { setMoveDialogMode("move"); setMoveDialogGroupId(groupId); }}
      onSplitSelected={groupId => { setMoveDialogMode("split"); setMoveDialogGroupId(groupId); }}
      onMerge={groupId => setMergeDialogGroupId(groupId)}
      onDelete={handleDeleteGroup}
      saveState={saveState}
      autoEdit={draft.id === autoEditGroupId}
      onAutoEditConsumed={handleAutoEditConsumed}
      listing={listingsByDraftId.get(draft.id) ?? null}
      onEditFields={setEditFieldsGroupId}
      onPreviewListing={setPreviewGroupId}
      expanded={draft.id === expandedGroupId}
      onToggleExpand={handleToggleExpand}
      isGenerating={draft.id === currentlyGeneratingGroupId}
      hasFailedGeneration={generationFailedGroupIds.has(draft.id)}
    />;
  }

  return <div className="listing-studio-create">
    <WorkflowSteps
      hasPhotos={images.length > 0}
      needsGrouping={unsortedPhotoCount > 0}
      hasEligibleGroups={eligibleListingGroups.length > 0}
      hasGeneratedDrafts={readyCount > 0}
    />

    {!hasAnyData && <>
      <UploadDropzone onFilesSelected={handleFilesSelected} />
      {uploadNotice && <p className="import-note" role="status">{uploadNotice}</p>}
      <UploadQueue items={uploadItems} onRetry={handleRetryUpload} onRemove={handleRemoveUploadItem} />
      {loadError && <div className="home-error">{loadError}</div>}
      {!loading && <div className="listing-empty-workspace" role="status">No photos in this batch</div>}
    </>}

    {hasAnyData && <>
      <UploadDropzone onFilesSelected={handleFilesSelected} compact />
      {uploadNotice && <p className="import-note" role="status">{uploadNotice}</p>}
      <UploadQueue items={uploadItems} onRetry={handleRetryUpload} onRemove={handleRemoveUploadItem} />

      {uploadSuccessMessage && <div className="listing-upload-success" role="status">
        <strong>{uploadSuccessMessage}</strong>
      </div>}

      {loadError && <div className="home-error">{loadError}</div>}

      <div className="listing-batch-toolbar">
        <strong className="listing-batch-toolbar-counts">
          {images.length} photo{images.length === 1 ? "" : "s"} · {productGroupsCount} product{productGroupsCount === 1 ? "" : "s"} · {eligibleListingGroups.length} ready to generate · {readyCount} draft{readyCount === 1 ? "" : "s"} generated
        </strong>
        <div className="listing-batch-toolbar-controls">
          <label className="field listing-batch-search">
            <span className="label sr-only">Search</span>
            <input
              className="input"
              type="search"
              placeholder="Search by name, brand, or model"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              aria-label="Search product groups"
            />
          </label>
          <label className="field listing-batch-status-filter">
            <span className="label sr-only">Status</span>
            <select className="input" value={statusFilter} onChange={event => setStatusFilter(event.target.value as CardStatus | "all")} aria-label="Filter by status">
              <option value="all">All statuses</option>
              {(Object.keys(STATUS_LABELS) as CardStatus[]).map(value => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            </select>
          </label>
        </div>
      </div>

      <p className="auto-group-order-hint">For best results, keep each product&rsquo;s photos together in upload order.</p>

      {clearWorkspaceError && !clearingWorkspace && <div className="auto-group-error" role="alert">
        <span>{clearWorkspaceError}</span>
        <button type="button" className="button-secondary" onClick={() => setClearWorkspaceDialogOpen(true)}>Retry</button>
      </div>}

      {generatingListings && generateListingsProgress && <div className="auto-group-progress" role="status">
        <span className="auto-group-progress-spinner" aria-hidden="true" />
        <div className="auto-group-progress-text">
          <strong>Generating listings {generateListingsProgress.done} / {generateListingsProgress.total}</strong>
        </div>
      </div>}

      {generateListingsError && !generatingListings && <div className="auto-group-error" role="alert">
        <span>{generateListingsError}</span>
        <button type="button" className="button-secondary" onClick={handleGenerateListings}>Retry</button>
      </div>}

      {autoGroupRunning && autoGroupProgress && <div className="auto-group-progress" role="status">
        <span className="auto-group-progress-spinner" aria-hidden="true" />
        <div className="auto-group-progress-text">
          <strong>Analysing photos {autoGroupProgress.analysedSoFar} / {autoGroupProgress.totalToAnalyse}</strong>
          <span>{AUTO_GROUP_STAGE_TEXTS[autoGroupProgress.stageIndex]}…</span>
          <span className="auto-group-progress-stats">
            {autoGroupProgress.productsIdentifiedSoFar} product{autoGroupProgress.productsIdentifiedSoFar === 1 ? "" : "s"} identified so far · {autoGroupProgress.totalToAnalyse - autoGroupProgress.analysedSoFar} photo{autoGroupProgress.totalToAnalyse - autoGroupProgress.analysedSoFar === 1 ? "" : "s"} remaining
          </span>
        </div>
      </div>}

      {autoGroupError && !autoGroupRunning && <div className="auto-group-error" role="alert">
        <span>{autoGroupError}</span>
        <button type="button" className="button-secondary" onClick={handleAutoGroupProducts}>Retry</button>
      </div>}

      {autoGroupSummary && !autoGroupRunning && (autoGroupSummary.ranAnalysis
        ? <div className="auto-group-summary" role="status">
            <button type="button" className="auto-group-summary-close" onClick={() => setAutoGroupSummary(null)} aria-label="Dismiss">×</button>
            <strong>{autoGroupSummary.groupsCreated.length} product group{autoGroupSummary.groupsCreated.length === 1 ? "" : "s"} created</strong>
            <span>{autoGroupSummary.photosGroupedCount} photo{autoGroupSummary.photosGroupedCount === 1 ? "" : "s"} grouped</span>
            <span>{autoGroupSummary.photosLeftInUnsortedCount} photo{autoGroupSummary.photosLeftInUnsortedCount === 1 ? "" : "s"} left in Unsorted</span>
            {autoGroupSummary.truncated && <p className="auto-group-truncated-note">Not every eligible photo was analysed this run — click Auto-group products again to process the rest.</p>}
          </div>
        : <p className="auto-group-empty-note">No photos in Unsorted to group.</p>)}

      {autoGroupProposals.length > 0 && <div className="auto-group-review">
        <h3>Review {autoGroupProposals.length} suggested group{autoGroupProposals.length === 1 ? "" : "s"}</h3>
        <p className="auto-group-review-hint">Not fully confident — check each one before creating it.</p>
        {autoGroupProposals.map(proposal => <div key={proposal.proposedGroupId} className="auto-group-proposal-card">
          <div className="auto-group-proposal-thumbs">
            {proposal.imageIds.slice(0, 6).map(imageId =>
              // eslint-disable-next-line @next/next/no-img-element -- private, per-request signed redirect URL; see SortablePhotoGrid.tsx for the same rationale
              <img key={imageId} src={`/api/listing-studio/images/${imageId}/view`} alt="" />)}
            {proposal.imageIds.length > 6 && <span className="auto-group-proposal-thumbs-more">+{proposal.imageIds.length - 6}</span>}
          </div>
          <div className="auto-group-proposal-body">
            <div className="auto-group-proposal-heading">
              <strong>{proposal.photoCount} photo{proposal.photoCount === 1 ? "" : "s"}</strong>
              <span className="auto-group-proposal-confidence">Medium confidence</span>
            </div>
            <p className="auto-group-proposal-reasoning">{proposal.boundaryReason}</p>
            {proposal.warnings.length > 0 && <ul className="auto-group-proposal-warnings">{proposal.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
          </div>
          <div className="auto-group-proposal-actions">
            <button type="button" className="button-secondary" onClick={() => handleDismissAutoGroupProposal(proposal.proposedGroupId)} disabled={applyingProposalId === proposal.proposedGroupId}>Reject</button>
            <button type="button" className="button" onClick={() => handleApplyAutoGroupProposal(proposal)} disabled={applyingProposalId === proposal.proposedGroupId}>
              {applyingProposalId === proposal.proposedGroupId ? "Accepting…" : "Accept"}
            </button>
          </div>
        </div>)}
      </div>}

      {/* Unsorted is a distinct inbox queue, never part of the searchable/
          filterable product list below — and per explicit instruction, it
          renders nothing at all once it has no photos left, not even a
          collapsed empty row. */}
      {unsortedPhotoCount > 0 && unsortedDraft && <div className="product-groups-list listing-unsorted-section">
        {renderGroupCard(unsortedDraft)}
      </div>}

      {orderedProductDrafts.length > 0 && <>
        <div className="listing-list-header listing-row-grid">
          <span className="listing-list-header-cell listing-list-header-main">Product group</span>
          <span className="listing-list-header-cell listing-list-header-photos">Photos</span>
          <span className="listing-list-header-cell listing-list-header-status">Status</span>
          <span className="listing-list-header-cell listing-list-header-actions">Actions</span>
        </div>
        <div className="product-groups-list">
          {visibleProductDrafts.length === 0
            ? <p className="listing-no-matches" role="status">No products match your search or filter.</p>
            : visibleProductDrafts.map(draft => renderGroupCard(draft))}
        </div>
      </>}

      <div className="listing-sticky-bar" role="toolbar" aria-label="Listing Studio actions">
        <div className="listing-sticky-bar-selection" role="status">
          {selectedIds.size > 0
            ? <>
                <strong>{selectedIds.size} photo{selectedIds.size === 1 ? "" : "s"} selected</strong>
                <button type="button" className="button-secondary" onClick={() => setSelectedIds(new Set())}>Clear selection</button>
              </>
            : <strong>{productGroupsCount} product{productGroupsCount === 1 ? "" : "s"} · {images.length} photo{images.length === 1 ? "" : "s"}</strong>}
        </div>
        <div className="listing-sticky-bar-actions">
          <button type="button" className="button-secondary" onClick={handleCreateGroup}>+ New product</button>
          <button type="button" className="button-secondary" onClick={handleAutoGroupProducts} disabled={autoGroupRunning || unsortedPhotoCount === 0} title={unsortedPhotoCount === 0 ? "No photos in Unsorted to group" : undefined}>
            {autoGroupRunning ? "Grouping…" : "Auto-group"}
          </button>
          <button
            type="button"
            className="button"
            onClick={handleGenerateListings}
            disabled={generateListingsDisabled || eligibleListingGroups.length === 0}
            title={eligibleListingGroups.length === 0 ? "No product groups to generate listings for" : undefined}
          >
            {generatingListings ? "Generating…" : "Generate listings"}
          </button>
          {/* Visually separated from the constructive actions above (own
              margin, destructive red styling) — never grouped into the same
              cluster as Auto-group/Generate/New product. */}
          <button
            type="button"
            className="button-danger listing-clear-all listing-sticky-bar-danger"
            onClick={() => setClearWorkspaceDialogOpen(true)}
            disabled={clearWorkspaceDisabled}
            title={clearWorkspaceDisabled ? "Wait for the current upload or grouping run to finish" : undefined}
          >
            Clear all
          </button>
        </div>
      </div>
    </>}

    {moveDialogGroupId && <MovePhotosDialog
      action={moveDialogMode}
      groups={movableGroups}
      selectedCount={selectedIds.size}
      loading={dialogBusy}
      onClose={() => setMoveDialogGroupId(null)}
      onMove={handleMove}
      onCreateAndMove={moveDialogMode === "split" ? handleSplit : handleCreateAndMove}
    />}
    {mergeDialogGroupId && <MergeGroupsDialog
      sourceTitle={mergeSourceGroup?.title || "this group"}
      groups={mergeableGroups}
      loading={dialogBusy}
      onClose={() => setMergeDialogGroupId(null)}
      onMerge={handleMerge}
    />}
    {deleteGroupTarget && <DeleteGroupDialog
      groupTitle={deleteGroupTarget.title}
      photoCount={deleteGroupTarget.photoCount}
      loading={false}
      onClose={() => setDeleteGroupTarget(null)}
      onConfirm={handleConfirmDeleteGroup}
    />}
    {bulkDeleteConfirmOpen && <ConfirmDialog
      title={`Delete ${selectedIds.size} photo${selectedIds.size === 1 ? "" : "s"}?`}
      message="These photos will be removed. You can undo for a few seconds after."
      confirmLabel={`Delete ${selectedIds.size} photo${selectedIds.size === 1 ? "" : "s"}`}
      onConfirm={handleBulkDeleteSelected}
      onCancel={() => setBulkDeleteConfirmOpen(false)}
    />}
    {pendingUndo && <TaskToast message={pendingUndo.message} actionLabel="Undo" onAction={pendingUndo.onAction} onDismiss={pendingUndo.onDismiss} />}
    {clearWorkspaceDialogOpen && <ClearWorkspaceDialog
      loading={clearingWorkspace}
      onClose={() => setClearWorkspaceDialogOpen(false)}
      onConfirm={handleClearWorkspace}
    />}
    {editFieldsTarget && <EditListingFieldsDialog
      groupTitle={editFieldsTarget.title || "this group"}
      fields={{
        brand: editFieldsTarget.brand ?? "", model: editFieldsTarget.model ?? "", productType: editFieldsTarget.product_type ?? "",
        colours: editFieldsTarget.colours ?? [], material: editFieldsTarget.material ?? "", ukSize: editFieldsTarget.uk_size ?? "", sku: editFieldsTarget.sku ?? "",
        vintedAudience: editFieldsTarget.vinted_audience ?? "unknown",
        vintedCategoryId: editFieldsTarget.vinted_category_id, vintedCategoryPath: editFieldsTarget.vinted_category_path,
      }}
      loading={savingListingFields}
      error={editFieldsError}
      onClose={handleCloseEditFields}
      onSave={handleSaveListingFields}
    />}
    {previewTarget && previewListing && <PreviewListingDialog
      groupTitle={previewTarget.title || "this group"}
      generatedTitle={previewListing.generatedTitle}
      generatedDescription={previewListing.generatedDescription}
      ukSize={previewListing.ukSize}
      sku={previewListing.sku}
      onClose={() => setPreviewGroupId(null)}
    />}
  </div>;
}
