"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UploadDropzone from "./UploadDropzone";
import UploadQueue from "./UploadQueue";
import ProductGroupCard from "./ProductGroupCard";
import MovePhotosDialog, { type MovableGroup } from "./MovePhotosDialog";
import MergeGroupsDialog, { type MergeableGroup } from "./MergeGroupsDialog";
import DeleteGroupDialog, { type DeleteGroupMode } from "./DeleteGroupDialog";
import TaskToast from "@/components/TaskToast";
import ConfirmDialog from "@/components/ConfirmDialog";
import type { UploadItem } from "./upload-types";
import type { PhotoTileData } from "./SortablePhotoGrid";
import { isAcceptedFile, partitionDuplicateFiles } from "@/lib/listing-studio/file-selection";
import { prepareImagePreview, releaseImagePreview } from "@/lib/listing-studio/client-image-processing";

type WorkspaceDraft = { id: string; title: string | null; status: string; created_at: string; updated_at: string };
type WorkspaceImage = {
  id: string; draft_id: string; original_filename: string; mime_type: string; file_size: number;
  width: number | null; height: number | null; sort_order: number;
  detected_role: string | null; confirmed_role: string | null; upload_state: PhotoTileData["uploadState"]; preview_available: boolean;
};
type WorkspaceData = { drafts: WorkspaceDraft[]; images: WorkspaceImage[] };

type SaveState = "idle" | "saving" | "saved" | "failed";

// A stable reference for groups with no photos, so memo()'d ProductGroupCard
// doesn't see a "changed" prop (a fresh []) on every unrelated re-render.
const EMPTY_PHOTOS: PhotoTileData[] = [];

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
  async function withSaveState(action: () => Promise<Response>): Promise<{ ok: boolean; error?: string }> {
    setSaveState("saving");
    try {
      const response = await action();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setSaveState("failed"); return { ok: false, error: body.error || "Save failed." }; }
      flashSaved();
      return { ok: true };
    } catch { setSaveState("failed"); return { ok: false, error: "Network error — please try again." }; }
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
    } catch { setSaveState("failed"); }
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
      if (!response.ok) { setSaveState("failed"); return; }
      const { draftId, title } = body as { draftId: string; title: string };
      const now = new Date().toISOString();
      setDrafts(current => [...current, { id: draftId, title, status: "grouping", created_at: now, updated_at: now }]);
      flashSaved();
      setAutoEditGroupId(draftId);
      requestAnimationFrame(() => {
        document.getElementById(`listing-group-${draftId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch { setSaveState("failed"); }
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
              if (response.ok) { flashSaved(); await loadWorkspace(); } else setSaveState("failed");
            } catch { setSaveState("failed"); }
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
    if (!created.ok) { setDialogBusy(false); setSaveState("failed"); return; }
    const { draftId, title } = createdBody as { draftId: string; title: string };
    const now = new Date().toISOString();
    setDrafts(current => [...current, { id: draftId, title, status: "grouping", created_at: now, updated_at: now }]);
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
    } else setSaveState("failed");
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

  // ---- Keyboard shortcuts ----
  // Ctrl/Cmd+A selects every photo in whichever group currently has focus
  // (via the data-group-id ancestor set on each ProductGroupCard); Escape
  // clears the whole selection; Delete opens the existing bulk-delete
  // confirmation rather than deleting immediately. Disabled while any
  // dialog is open, or while typing in a text field (renaming a group,
  // typing a new group's name), so native input behaviour is never hijacked.
  const anyDialogOpen = Boolean(moveDialogGroupId || mergeDialogGroupId || deleteGroupTarget || bulkDeleteConfirmOpen);
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

  const movableGroups: MovableGroup[] = drafts.filter(draft => draft.id !== moveDialogGroupId).map(draft => ({ id: draft.id, title: draft.title, photoCount: images.filter(image => image.draft_id === draft.id).length }));
  const mergeSourceGroup = drafts.find(draft => draft.id === mergeDialogGroupId);
  const mergeableGroups: MergeableGroup[] = drafts.filter(draft => draft.id !== mergeDialogGroupId).map(draft => ({ id: draft.id, title: draft.title, photoCount: images.filter(image => image.draft_id === draft.id).length }));

  // Empty state (UX refinement spec §4): nothing but the upload panel and a
  // one-line explanation until there's real data — no stat cards, no empty
  // grouping section, no floating "Create new group" button.
  const hasAnyData = drafts.length > 0 || images.length > 0;
  const readyCount = drafts.filter(draft => draft.status === "ready").length;

  return <div className="listing-studio-create">
    <UploadDropzone onFilesSelected={handleFilesSelected} />
    {uploadNotice && <p className="import-note" role="status">{uploadNotice}</p>}
    <UploadQueue items={uploadItems} onRetry={handleRetryUpload} onRemove={handleRemoveUploadItem} />

    {uploadSuccessMessage && <div className="listing-upload-success" role="status">
      <strong>{uploadSuccessMessage}</strong>
      <span>Select photos and split them into product groups.</span>
    </div>}

    {loadError && <div className="home-error">{loadError}</div>}

    {!loading && !hasAnyData && <p className="listing-empty-explanation">Upload photos first. They will be placed into an Unsorted group so you can divide them into products.</p>}

    {hasAnyData && <>
      <div className="listing-studio-summary-line" role="status">
        <span>{images.length} photo{images.length === 1 ? "" : "s"} uploaded</span>
        <span aria-hidden="true">·</span>
        <span>{drafts.length} product group{drafts.length === 1 ? "" : "s"}</span>
        <span aria-hidden="true">·</span>
        <span>{readyCount} draft{readyCount === 1 ? "" : "s"} generated</span>
      </div>

      <div className="product-groups-toolbar">
        <button type="button" className="button-secondary" onClick={handleCreateGroup}>+ New product</button>
      </div>

      <div className="product-groups-list">
        {drafts.map(draft => <ProductGroupCard
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
        />)}
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
  </div>;
}
