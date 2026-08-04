import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("components/AppHeader.tsx — Listing Studio navigation", () => {
  const source = read("components/AppHeader.tsx");
  it("adds a 'Listing Studio' link to /listing-studio with a dedicated icon, without removing/renaming any existing link", () => {
    expect(source).toContain('{ label: "Listing Studio", href: "/listing-studio", icon: "camera" }');
    for (const label of ["Home", "Tasks", "Purchases", "Bulk Input", "Email Assistant", "Purchase Import", "Expenses", "Export", "Settings"]) {
      expect(source).toContain(`label: "${label}"`);
    }
  });
});

describe("app/listing-studio/page.tsx — view labels represent views, not actions (UX refinement spec §1)", () => {
  const source = read("app/listing-studio/page.tsx");

  it("labels the tabs 'Create' and 'Saved drafts' — never 'Create drafts', which reads as a generate-now action", () => {
    expect(source).toContain(">Create<");
    expect(source).toContain(">Saved drafts<");
    expect(source).not.toContain("Create drafts<");
  });

  it("supports ?view=create and ?view=saved, defaulting to create", () => {
    expect(source).toContain('searchParams.get("view") === "saved" ? "saved" : "create"');
  });

  it("is wrapped in Suspense (useSearchParams requirement), matching the Purchases page convention", () => {
    expect(source).toContain("<Suspense fallback={null}><ListingStudioPageInner /></Suspense>");
  });

  it("renders the compact workflow indicator near the heading", () => {
    expect(source).toContain("<WorkflowSteps />");
  });

  it("renders the full Create view via GroupingWorkspace, and a distinct Saved placeholder — never the same component for both", () => {
    expect(source).toContain("<GroupingWorkspace />");
    expect(source).toContain("<SavedDraftsPlaceholder />");
  });

  it("the Saved placeholder is clearly a placeholder, not a fake full implementation", () => {
    expect(source).toMatch(/coming in a later milestone/i);
  });
});

describe("components/listing-studio/WorkflowSteps.tsx — unfinished AI steps are visibly disabled, never clickable (UX refinement spec §2)", () => {
  const source = read("components/listing-studio/WorkflowSteps.tsx");

  it("lists exactly the four required steps in order", () => {
    expect(source).toMatch(/Upload photos[\s\S]*Group products[\s\S]*Generate drafts[\s\S]*Review/);
  });

  it("marks Upload photos and Group products as available", () => {
    const uploadStep = source.slice(source.indexOf('{ label: "Upload photos"'), source.indexOf('{ label: "Group products"') + 40);
    const groupStep = source.slice(source.indexOf('{ label: "Group products"'), source.indexOf('{ label: "Generate drafts"') + 40);
    expect(uploadStep).toContain("available: true");
    expect(groupStep).toContain("available: true");
  });

  it("marks Generate drafts and Review as not available, with a 'Coming next' badge", () => {
    const generateStep = source.slice(source.indexOf('{ label: "Generate drafts"'), source.indexOf('{ label: "Review"') + 20);
    const reviewStep = source.slice(source.indexOf('{ label: "Review"'), source.length);
    expect(generateStep).toContain("available: false");
    expect(reviewStep).toContain("available: false");
    expect(source).toContain("Coming next");
  });

  it("renders every step as plain text — never a <button> or <a>, so an unfinished step can never be clicked", () => {
    expect(source).not.toContain("<button");
    expect(source).not.toContain("<a ");
    expect(source).not.toContain("<Link");
  });
});

describe("components/listing-studio/UploadDropzone.tsx — one polished panel (UX refinement spec §3)", () => {
  const source = read("components/listing-studio/UploadDropzone.tsx");

  it("has exactly one primary action (Choose photos) and a visually secondary one (Choose folder)", () => {
    expect(source).toContain("Choose photos");
    expect(source).toContain("Choose folder");
    expect(source).toContain('className="button listing-dropzone-primary"');
    expect(source).toContain('className="button-secondary listing-dropzone-secondary"');
  });

  it("uses real, keyboard-accessible <input type=file> pickers, not a div-only click handler", () => {
    expect(source).toContain('type="file"');
    expect(source).toContain("multiple");
  });

  it("accepts JPG/PNG/WEBP/HEIC/HEIF by both MIME type and extension", () => {
    for (const value of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", ".jpg", ".heic"]) expect(source).toContain(value);
  });

  it("the whole panel is the drag target, in addition to the file pickers", () => {
    expect(source).toContain("onDrop");
    expect(source).toContain("listing-dropzone-active");
  });

  it("offers folder selection as a clearly separate, optional action", () => {
    expect(source).toContain("webkitdirectory");
  });
});

describe("components/listing-studio/UploadPhotoCard.tsx / UploadStatusBadge.tsx", () => {
  it("is a single dense row (thumbnail/name/size/status/actions), not a tall card with a full-width button beneath it", () => {
    const source = read("components/listing-studio/UploadPhotoCard.tsx");
    expect(source).toContain('className="upload-photo-row');
    expect(source).toContain("formatBytes(item.file.size)");
    expect(source).toContain('item.state === "failed" && <button');
  });
  it("status text never relies on colour alone — a text label is always rendered", () => {
    const source = read("components/listing-studio/UploadStatusBadge.tsx");
    expect(source).toMatch(/LABELS\[state\]/);
  });
});

describe("components/listing-studio/UploadQueue.tsx — collapse/expand behaviour (UX refinement spec §5/§12)", () => {
  const source = read("components/listing-studio/UploadQueue.tsx");

  it("starts collapsed by default (manualExpanded initial state is false)", () => {
    expect(source).toContain("useState(false)");
  });

  it("is forced expanded while anything is pending/uploading/failed, regardless of the manual toggle", () => {
    expect(source).toContain('item.state === "pending" || item.state === "uploading" || item.state === "failed"');
    expect(source).toContain("const expanded = hasActiveOrFailed || manualExpanded;");
  });

  it("only shows the manual expand/collapse toggle once nothing needs attention — a failure can never be hidden by accident", () => {
    expect(source).toContain("{!hasActiveOrFailed && <button");
  });

  it("shows a compact 'N photos uploaded' summary once everything succeeded", () => {
    expect(source).toContain("uploadedCount === items.length");
    expect(source).toContain("photo${items.length === 1");
  });
});

describe("components/listing-studio/OverflowMenu.tsx", () => {
  const source = read("components/listing-studio/OverflowMenu.tsx");
  it("closes on Escape and on an outside click", () => {
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("containerRef.current?.contains(event.target as Node)");
  });
  it("every item is a real, keyboard-reachable menuitem button", () => {
    expect(source).toContain('role="menuitem"');
    expect(source).toContain('aria-haspopup="menu"');
  });
});

describe("components/listing-studio/SortablePhotoGrid.tsx — dense grid, compact controls, display limit (UX refinement spec §6/§12)", () => {
  const source = read("components/listing-studio/SortablePhotoGrid.tsx");

  it("supports drag-and-drop reordering", () => {
    expect(source).toContain("draggable");
    expect(source).toContain("onDragStart");
    expect(source).toContain("onDrop");
  });

  it("provides a keyboard/touch-accessible alternative to drag-and-drop — always-visible move buttons, never hover-only", () => {
    expect(source).toContain("move(photo.id, -1)");
    expect(source).toContain("move(photo.id, 1)");
    expect(source).not.toMatch(/:hover\s*\{[^}]*display:\s*(flex|block)/);
  });

  it("puts Make-cover/Remove into a compact per-tile overflow menu rather than a full row of buttons", () => {
    expect(source).toContain("<OverflowMenu");
    expect(source).toContain('label: "Make cover"');
    expect(source).toContain('label: "Remove"');
  });

  it("the first photo is treated as the cover image, with no separate cover-flag column needed", () => {
    expect(source).toContain("const isCover = trueIndex === 0;");
  });

  it("large groups initially show only the first displayLimit photos", () => {
    expect(source).toContain("const DEFAULT_DISPLAY_LIMIT = 16");
    expect(source).toContain("index < displayLimit");
  });

  it("never hides a selected or failed photo, even beyond the display limit", () => {
    expect(source).toContain("selectedIds.has(photo.id)");
    expect(source).toMatch(/index < displayLimit \|\| selectedIds\.has\(photo\.id\) \|\| photo\.uploadState === "failed"/);
  });

  it("provides a 'Show all N photos' control that only affects local render state, never sort_order or a save call", () => {
    const fn = source.slice(source.indexOf("hiddenCount > 0"), source.indexOf("hiddenCount > 0") + 200);
    expect(fn).toContain("setShowAll(true)");
    expect(fn).not.toContain("onReorder");
  });

  it("image alt text is based on role and position, not generic", () => {
    expect(source).toContain("photo.role ?? \"Unclassified\"");
    expect(source).toContain("position ${trueIndex + 1}");
  });
});

describe("components/listing-studio/ProductGroupCard.tsx — contextual toolbar, overflow menu, Unsorted indicator (UX refinement spec §6/§7)", () => {
  const source = read("components/listing-studio/ProductGroupCard.tsx");

  it("saves the group title on blur/Enter, never one request per keystroke", () => {
    expect(source).toContain("onBlur={saveTitle}");
    expect(source).not.toMatch(/onChange=\{event => onRename/);
  });

  it("shows a clear visual indicator for the Unsorted (inbox) group", () => {
    expect(source).toContain('const UNSORTED_TITLE = "Unsorted"');
    expect(source).toContain("isUnsorted &&");
    expect(source).toContain("product-group-unsorted-badge");
  });

  it("displays the shared save state in the group header", () => {
    expect(source).toContain('className="product-group-save-state"');
  });

  it("Move/Split only appear once photos are selected in this group — never a permanently visible row of buttons", () => {
    expect(source).toContain("selectedInThisGroup > 0 && <div");
    expect(source).not.toMatch(/product-group-actions/);
  });

  it("Merge and Delete live in a compact overflow menu, not a permanent full-width danger button", () => {
    expect(source).toContain("<OverflowMenu");
    expect(source).toContain('label: "Merge into another group"');
    expect(source).toContain('label: "Delete group"');
    expect(source).not.toMatch(/className="button-danger"[^>]*>\s*Delete group/);
  });

  it("Delete group is always enabled here — the confirmation-vs-immediate decision is made by the parent workspace, not disabled/hidden in this card", () => {
    const start = source.indexOf('label: "Delete group"');
    const fn = source.slice(start, start + 100);
    expect(fn).not.toContain("disabled");
    expect(fn).toContain("onClick: () => onDelete(group.id)");
  });
});

describe("components/listing-studio/ProductGroupCard.tsx — Select all / Clear selection controls", () => {
  const source = read("components/listing-studio/ProductGroupCard.tsx");

  it("always shows a live plain-count summary — '0 selected' / '1 selected' / 'N selected' — never the old 'N of TOTAL' phrasing", () => {
    expect(source).toContain("{selectedInThisGroup} selected");
    expect(source).not.toMatch(/\{selectedInThisGroup\} of \{photos\.length\} selected/);
  });

  it("Select all becomes 'Deselect all' once every photo in the group is already selected; disabled only when the group is empty", () => {
    expect(source).toContain("const allSelected = photos.length > 0 && selectedInThisGroup === photos.length;");
    expect(source).toContain("disabled={photos.length === 0}");
    expect(source).toContain('{allSelected ? "Deselect all" : "Select all"}');
    expect(source).toContain("onClick={() => (allSelected ? onClearSelection(group.id) : onSelectAll(group.id))}");
  });

  it("Clear selection is only rendered — not just disabled — once at least one photo in this group is selected", () => {
    expect(source).toContain("{selectedInThisGroup > 0 && <button type=\"button\" className=\"button-secondary\" onClick={() => onClearSelection(group.id)}>Clear selection</button>}");
  });

  it("uses the exact label 'Clear selection', not 'Unselect photos'", () => {
    expect(source).toContain(">Clear selection<");
    expect(source).not.toMatch(/Unselect/i);
  });

  it("Select all / count / Clear selection sit in their own compact row, separate from the Move/Split contextual toolbar", () => {
    expect(source).toContain('className="product-group-selection-row"');
    const rowIndex = source.indexOf('className="product-group-selection-row"');
    const toolbarIndex = source.indexOf('className="product-group-selection-toolbar"');
    expect(rowIndex).toBeGreaterThan(-1);
    expect(toolbarIndex).toBeGreaterThan(rowIndex);
  });

  it("passes onSelectAll/onClearSelection through as required props, scoped by this group's own id", () => {
    expect(source).toContain("onSelectAll: (draftId: string) => void;");
    expect(source).toContain("onClearSelection: (draftId: string) => void;");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — Select all / Clear selection scoping and selection-cleanup rules", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("Select all adds every photo id belonging to that group, derived from full workspace state — never limited to whatever SortablePhotoGrid currently renders", () => {
    const fn = source.slice(source.indexOf("const handleSelectAllInGroup = useCallback"), source.indexOf("const handleClearSelectionInGroup = useCallback"));
    expect(fn).toContain("images.filter(image => image.draft_id === draftId).map(image => image.id)");
    expect(fn).toContain("new Set([...current, ...groupImageIds])");
  });

  it("Select all only ever adds ids — it can never remove an existing selection from another group", () => {
    const fn = source.slice(source.indexOf("const handleSelectAllInGroup = useCallback"), source.indexOf("const handleClearSelectionInGroup = useCallback"));
    expect(fn).not.toContain(".delete(");
  });

  it("Clear selection only removes this group's own ids from the selection, leaving every other group's selection untouched", () => {
    const fn = source.slice(source.indexOf("const handleClearSelectionInGroup = useCallback"), source.indexOf("async function commitDeletePhotos"));
    expect(fn).toContain("images.filter(image => image.draft_id === draftId).map(image => image.id)");
    expect(fn).toContain("for (const id of groupImageIds) next.delete(id);");
    expect(fn).not.toContain("new Set()"); // never a blanket clear-everything
  });

  it("removing a photo drops it from images/selection immediately, deferring the actual DELETE call behind the undo window", () => {
    const fn = source.slice(source.indexOf("const handleRemovePhoto = useCallback"), source.indexOf("function handleBulkDeleteSelected"));
    const filterImagesIndex = fn.indexOf("setImages(current => current.filter");
    const deleteSelectionIndex = fn.indexOf("next.delete(photoId)");
    const scheduleUndoIndex = fn.indexOf("setPendingUndo({");
    expect(filterImagesIndex).toBeGreaterThan(-1);
    expect(deleteSelectionIndex).toBeGreaterThan(filterImagesIndex);
    expect(scheduleUndoIndex).toBeGreaterThan(deleteSelectionIndex);
    // The real network delete only ever runs inside onDismiss, and only if undo wasn't clicked.
    expect(fn).toContain("onDismiss: () => { if (!undone) commitDeletePhotos([photoId]); setPendingUndo(null); }");
  });

  it("a successful move clears the selection so stale ids from the moved group are never left behind", () => {
    const fn = source.slice(source.indexOf("async function handleMove"), source.indexOf("async function handleCreateAndMove"));
    expect(fn).toContain("setMoveDialogGroupId(null); setSelectedIds(new Set()); await loadWorkspace();");
  });

  it("a successful split clears the selection so stale ids from the source group are never left behind", () => {
    const fn = source.slice(source.indexOf("async function handleSplit"), source.indexOf("async function handleMerge"));
    expect(fn).toContain("setMoveDialogGroupId(null); setSelectedIds(new Set()); flashSaved(); await loadWorkspace();");
  });

  it("still wires Select all/Clear selection into ProductGroupCard alongside the existing selection/move/split/merge/reorder/cover handlers", () => {
    for (const prop of ["onToggleSelect={toggleSelect}", "onSelectAll={handleSelectAllInGroup}", "onClearSelection={handleClearSelectionInGroup}", "onMoveSelected=", "onSplitSelected=", "onMerge=", "onReorder={handleReorder}", "onSetCover={handleSetCover}"]) {
      expect(source).toContain(prop);
    }
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — empty state, upload-to-group transition, compact stats (UX refinement spec §4/§8/§9)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("hides all grouping UI (stats, toolbar, groups list) until there is real data", () => {
    const emptyBranch = source.slice(source.indexOf("!loading && !hasAnyData"), source.indexOf("{hasAnyData && <>"));
    expect(emptyBranch).toContain("listing-empty-explanation");
    expect(source).not.toMatch(/Photos uploaded<\/span>/);
    expect(source).not.toContain("Needs review");
  });

  it("the empty-state explanation mentions the Unsorted group", () => {
    expect(source).toMatch(/Unsorted group/);
  });

  it("the '+ New product' toolbar only renders once there is data — never floating in empty space", () => {
    const hasAnyDataBranch = source.slice(source.indexOf("{hasAnyData && <>"), source.indexOf("</>}"));
    expect(hasAnyDataBranch).toContain("+ New product");
  });

  it("shows a compact one-line summary with descriptive wording (photos uploaded · product groups · drafts generated) instead of the old five-card dashboard", () => {
    expect(source).toContain("listing-studio-summary-line");
    expect(source).toContain("photo{images.length === 1 ? \"\" : \"s\"} uploaded");
    expect(source).toContain("product group{drafts.length === 1");
    expect(source).toContain("draft{readyCount === 1 ? \"\" : \"s\"} generated");
  });

  it("shows a success message naming the destination group after a successful upload, and points to the next action", () => {
    expect(source).toContain("uploaded and added to");
    expect(source).toContain("Select photos and split them into product groups.");
  });

  it("scrolls the just-uploaded group into view rather than leaving the user to find it themselves", () => {
    expect(source).toContain("scrollIntoView({ behavior: \"smooth\", block: \"start\" })");
    expect(source).toContain("listing-group-${draftId}");
  });

  it("uploads the whole batch via one /api/listing-studio/uploads request, never one request per file", () => {
    expect(source).toContain('fetch("/api/listing-studio/uploads"');
    expect(source.match(/fetch\("\/api\/listing-studio\/uploads"/g)?.length).toBe(1);
  });

  it("limits concurrent PUTs rather than uploading an unbounded batch all at once", () => {
    expect(source).toContain("runWithConcurrencyLimit(paired, 3,");
  });

  it("never marks an upload item 'uploaded' until the confirm call itself succeeds", () => {
    const fn = source.slice(source.indexOf("async function uploadOneFile"), source.indexOf("async function handleRetryUpload"));
    expect(fn).toContain("/confirm`");
    expect(fn).toMatch(/confirmResponse\.ok/);
    expect(fn.indexOf("confirmResponse.ok")).toBeLessThan(fn.indexOf('state: "uploaded"'));
  });

  it("existing grouping operations still call the exact same API routes as Milestone 2", () => {
    for (const path of [
      "/api/listing-studio/groups/${draftId}",
      "/api/listing-studio/groups/${draftId}/reorder",
      "/api/listing-studio/groups/move-images",
      "/api/listing-studio/groups/split",
      "/api/listing-studio/groups/merge",
      "/api/listing-studio/images/${photoId}",
      "/api/listing-studio/uploads/${item.imageId}/retry",
    ]) {
      expect(source).toContain(path);
    }
  });

  it("reorder/rename/move/split/merge each show a saving/saved/failed state", () => {
    expect(source).toContain('setSaveState("saving")');
    expect(source).toContain('setSaveState("saved")');
    expect(source).toContain('setSaveState("failed")');
  });

  it("rejects unsupported files and reports duplicates rather than silently dropping them", () => {
    expect(source).toContain("isAcceptedFile");
    expect(source).toContain("partitionDuplicateFiles");
    expect(source).toContain("setUploadNotice");
  });

  it("releases blob preview URLs on removal to avoid leaking memory across a large batch", () => {
    expect(source).toContain("releaseImagePreview(item?.previewUrl ?? null)");
  });

  it("passes the shared save state down to each group card", () => {
    expect(source).toContain("saveState={saveState}");
  });

  it("deletes an empty group (after the undo window) with no confirmation dialog, via the same delayed-undo scheduler used for populated groups", () => {
    const fn = source.slice(source.indexOf("function handleDeleteGroup"), source.indexOf("function handleConfirmDeleteGroup"));
    expect(fn).toContain("if (photoCount === 0) {");
    expect(fn).toContain('scheduleDelayedGroupDelete(draftId, group?.title || "this group", undefined);');
  });

  it("opens the confirmation dialog instead of deleting immediately when the group has photos", () => {
    const fn = source.slice(source.indexOf("function handleDeleteGroup"), source.indexOf("function handleConfirmDeleteGroup"));
    expect(fn).toContain("setDeleteGroupTarget({ id: draftId, title: group?.title || \"this group\", photoCount });");
  });

  it("optimistically removes the group and its photos locally, and only calls the DELETE API — then reloads the workspace — once the undo window elapses without a click", () => {
    const fn = source.slice(source.indexOf("function scheduleDelayedGroupDelete"), source.indexOf("async function handleMove"));
    expect(fn).toContain("setDrafts(current => current.filter(draft => draft.id !== draftId));");
    expect(fn).toContain("setImages(current => current.filter(image => image.draft_id !== draftId));");
    const undoneCheckIndex = fn.indexOf("if (!undone) {");
    const fetchIndex = fn.indexOf("fetch(`/api/listing-studio/groups/${draftId}`");
    const reloadIndex = fn.indexOf("await loadWorkspace();");
    expect(undoneCheckIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(undoneCheckIndex);
    expect(reloadIndex).toBeGreaterThan(fetchIndex);
  });

  it("clicking Undo restores the deleted group and its photos locally with no API call ever having been made", () => {
    const fn = source.slice(source.indexOf("function scheduleDelayedGroupDelete"), source.indexOf("async function handleMove"));
    expect(fn).toContain("onAction: () => {");
    expect(fn).toContain("undone = true;");
    expect(fn).toContain("if (removedDraft) setDrafts(current => [...current, removedDraft]);");
    expect(fn).toContain("setImages(current => [...current, ...removedImages]);");
  });

  it("renders DeleteGroupDialog only when a delete target is set", () => {
    expect(source).toContain("{deleteGroupTarget && <DeleteGroupDialog");
  });
});

describe("components/listing-studio/DeleteGroupDialog.tsx — group deletion with photos (UX fix)", () => {
  const source = read("components/listing-studio/DeleteGroupDialog.tsx");

  it("explains what will happen and offers both disposal choices", () => {
    expect(source).toContain("Choose what should happen to them");
    expect(source).toContain("Move photos to Unsorted and delete group");
    expect(source).toContain("Delete group and remove all photos");
  });

  it("pre-selects the safer 'move to Unsorted' option by default", () => {
    expect(source).toContain('useState<DeleteGroupMode>("move_to_unsorted")');
  });

  it("visually switches to a danger-styled confirm button only once the destructive option is explicitly selected", () => {
    expect(source).toContain('mode === "delete_photos" ? "button-danger" : "button"');
  });

  it("the destructive option's own label still makes the consequence clear, while acknowledging the brief undo window before it commits", () => {
    expect(source).toMatch(/Permanently deletes[\s\S]*undo/);
  });

  it("Escape and backdrop click are both guarded by the loading state, matching every other dialog in this app", () => {
    expect(source).toContain('event.key === "Escape" && !loading');
    expect(source).toContain("event.target === event.currentTarget && !loading");
  });
});

describe("components/listing-studio/SortablePhotoGrid.tsx — shift-click range selection, performance (production-ready polish §4/§10)", () => {
  const source = read("components/listing-studio/SortablePhotoGrid.tsx");

  it("clicking photo 2 then shift-clicking photo 8 selects the full inclusive range, by true position in the full photos array", () => {
    expect(source).toContain("onSelectRange: (photoIds: string[]) => void;");
    const fn = source.slice(source.indexOf("function handleCheckboxClick"), source.indexOf("const visiblePhotos ="));
    expect(fn).toContain("event.shiftKey && lastClickedId.current");
    expect(fn).toContain("event.preventDefault()");
    expect(fn).toContain("fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]");
    expect(fn).toContain("onSelectRange(ids.slice(start, end + 1))");
  });

  it("tracks the shift-click anchor in a ref, not state — so clicking a checkbox never itself triggers a re-render", () => {
    expect(source).toContain("const lastClickedId = useRef<string | null>(null);");
  });

  it("resolves the range against the full photos array, so it stays correct even when the anchor or target is hidden behind the display limit", () => {
    const fn = source.slice(source.indexOf("function handleCheckboxClick"), source.indexOf("const visiblePhotos ="));
    expect(fn).toContain("const ids = photos.map(photo => photo.id);");
  });

  it("is wrapped in memo() so an unrelated parent re-render doesn't force every group's grid to re-render", () => {
    expect(source).toContain("export default memo(SortablePhotoGrid);");
  });
});

describe("components/listing-studio/ProductGroupCard.tsx — double-click-to-rename, stronger selection styling, memo (production-ready polish §5/§7/§10)", () => {
  const source = read("components/listing-studio/ProductGroupCard.tsx");

  it("shows the group name as a static label by default — double-click enters edit mode, rather than an always-live input", () => {
    expect(source).toContain("const [editingTitle, setEditingTitle] = useState(false);");
    expect(source).toContain("onDoubleClick={startEditingTitle}");
    expect(source).toMatch(/editingTitle\s*\?\s*<input/);
  });

  it("Enter saves (via blur) and Escape cancels and restores the previous title, without saving", () => {
    const fn = source.slice(source.indexOf("onKeyDown={event => {"), source.indexOf("aria-label=\"Group name\""));
    expect(fn).toContain('if (event.key === "Enter") (event.target as HTMLInputElement).blur();');
    expect(fn).toContain('else if (event.key === "Escape") cancelEditingTitle();');
    const cancelFn = source.slice(source.indexOf("function cancelEditingTitle"), source.indexOf("function cancelEditingTitle") + 200);
    expect(cancelFn).not.toContain("onRename");
  });

  it("clicking elsewhere (blur) also saves the new title", () => {
    expect(source).toContain("onBlur={saveTitle}");
  });

  it("exposes data-group-id on the card so document-level keyboard shortcuts can scope Ctrl+A to whichever group has focus", () => {
    expect(source).toContain("data-group-id={group.id}");
  });

  it("is wrapped in memo() so selecting inside one group doesn't necessarily force every other group's card to re-render", () => {
    expect(source).toContain("export default memo(ProductGroupCard);");
  });
});

describe("app/globals.css — stronger selected-photo styling (production-ready polish §5)", () => {
  const source = read("app/globals.css");

  it("gives a selected photo tile a solid ring plus a tinted fill, not just a border-color change", () => {
    const rule = source.slice(source.indexOf(".photo-tile-selected {"), source.indexOf(".photo-tile-selected {") + 200);
    expect(rule).toContain("background: var(--primary-soft)");
    expect(rule).toContain("box-shadow: 0 0 0 2px var(--primary)");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — keyboard shortcuts (production-ready polish §6)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("Ctrl/Cmd+A selects every photo in whichever group currently has focus, and prevents the browser's own select-all", () => {
    const fn = source.slice(source.indexOf("function handleKeyDown"), source.indexOf("document.addEventListener(\"keydown\", handleKeyDown)"));
    expect(fn).toContain('(event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a"');
    expect(fn).toContain('target.closest("[data-group-id]")');
    expect(fn).toContain("event.preventDefault(); handleSelectAllInGroup(groupId);");
  });

  it("Escape clears the entire selection", () => {
    const fn = source.slice(source.indexOf("function handleKeyDown"), source.indexOf("document.addEventListener(\"keydown\", handleKeyDown)"));
    expect(fn).toContain('event.key === "Escape"');
    expect(fn).toContain("setSelectedIds(current => (current.size > 0 ? new Set() : current));");
  });

  it("Delete opens the bulk-delete confirmation rather than deleting immediately", () => {
    const fn = source.slice(source.indexOf("function handleKeyDown"), source.indexOf("document.addEventListener(\"keydown\", handleKeyDown)"));
    expect(fn).toContain('event.key === "Delete"');
    expect(fn).toContain("setBulkDeleteConfirmOpen(true)");
    expect(fn).not.toContain("handleBulkDeleteSelected()");
  });

  it("ignores all three shortcuts while typing in a text field or while any dialog is open, so native input behaviour is never hijacked", () => {
    const fn = source.slice(source.indexOf("function handleKeyDown"), source.indexOf("document.addEventListener(\"keydown\", handleKeyDown)"));
    expect(fn).toContain('target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable');
    expect(fn).toContain("if (isEditable || anyDialogOpen) return;");
  });

  it("confirming the bulk-delete dialog calls handleBulkDeleteSelected, which clears the selection and closes the dialog", () => {
    expect(source).toContain("onConfirm={handleBulkDeleteSelected}");
    const fn = source.slice(source.indexOf("function handleBulkDeleteSelected"), source.indexOf("async function handleRename"));
    expect(fn).toContain("setBulkDeleteConfirmOpen(false);");
    expect(fn).toContain("setSelectedIds(new Set());");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — undo toast after delete/move/split/merge (production-ready polish §8)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("reuses the existing TaskToast component (its default 5s duration) for every undo, rather than a new bespoke toast", () => {
    expect(source).toContain('import TaskToast from "@/components/TaskToast";');
    expect(source).toContain('{pendingUndo && <TaskToast message={pendingUndo.message} actionLabel="Undo" onAction={pendingUndo.onAction} onDismiss={pendingUndo.onDismiss} />}');
  });

  it("a completed move shows an inverse-action undo that moves the photos back to their original groups", () => {
    const fn = source.slice(source.indexOf("async function handleMove"), source.indexOf("async function handleCreateAndMove"));
    expect(fn).toContain("originalDraftByImage");
    expect(fn).toContain("setPendingUndo({");
    expect(fn).toContain('targetDraftId: sourceDraftId');
  });

  it("a completed split shows an inverse-action undo that moves the split photos back into the source group", () => {
    const fn = source.slice(source.indexOf("async function handleSplit"), source.indexOf("async function handleMerge"));
    expect(fn).toContain("setPendingUndo({");
    expect(fn).toContain("targetDraftId: sourceDraftId");
  });

  it("a completed merge shows an inverse-action undo that recreates the source group and moves its photos back", () => {
    const fn = source.slice(source.indexOf("async function handleMerge"), source.indexOf("// ---- Keyboard shortcuts"));
    expect(fn).toContain("setPendingUndo({");
    expect(fn).toContain('fetch("/api/listing-studio/groups", { method: "POST"');
  });

  it("a new undo-able action resolves any still-pending undo first, so timers/toasts never silently overlap", () => {
    expect(source).toContain("function forceResolvePendingUndo() {");
    expect(source).toContain("pendingUndoRef.current?.onDismiss();");
    expect(source.match(/forceResolvePendingUndo\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — performance: memoized photo lookup, stable empty array, useCallback'd handlers (production-ready polish §10)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("builds a single draftId -> photos lookup with useMemo, rather than every group re-filtering/re-sorting the full images array on every render", () => {
    expect(source).toContain("const photosByGroupMap = useMemo(() => {");
    expect(source).toContain("}, [images]);");
    expect(source).toContain("photos={photosByGroupMap.get(draft.id) ?? EMPTY_PHOTOS}");
  });

  it("uses a module-level stable empty array for groups with no photos, so memo() isn't defeated by a fresh [] every render", () => {
    expect(source).toContain("const EMPTY_PHOTOS: PhotoTileData[] = [];");
  });

  it("wraps the selection handlers passed to every ProductGroupCard in useCallback", () => {
    for (const handler of ["const toggleSelect = useCallback", "const handleSelectRange = useCallback", "const handleSelectAllInGroup = useCallback", "const handleClearSelectionInGroup = useCallback", "const handleRemovePhoto = useCallback"]) {
      expect(source).toContain(handler);
    }
  });
});

describe("components/listing-studio/MovePhotosDialog.tsx — no manual naming, segmented control, dynamic button labels (Move/Create speed redesign)", () => {
  const source = read("components/listing-studio/MovePhotosDialog.tsx");

  it("never collects a typed group name — no textbox, no 'New group name' label, no newTitle state", () => {
    expect(source).not.toContain("New group name");
    expect(source).not.toContain("newTitle");
    expect(source).not.toContain('placeholder="e.g. Product 2"');
    expect(source).not.toMatch(/<input\b/);
  });

  it("onCreateAndMove takes no argument — the destination name is never supplied by this dialog", () => {
    expect(source).toContain("onCreateAndMove: () => void;");
  });

  it("shows nothing else once 'New group' is selected — no picker, no extra options rendered for that branch", () => {
    expect(source).not.toMatch(/\{mode === "new" &&/);
  });

  it("the destination toggle is a real segmented control, not two disconnected buttons", () => {
    expect(source).toContain('<div className="listing-move-mode" role="radiogroup" aria-label="Destination type">');
    expect(source).toContain('className={mode === "existing" ? "listing-move-mode-active" : ""}');
    expect(source).toContain('className={mode === "new" ? "listing-move-mode-active" : ""}');
  });

  it("the primary button reads 'Move photos' for an existing destination, and 'Create group & move photos' / 'Create group & split photos' for a new one", () => {
    expect(source).toContain('const confirmLabel = mode === "existing" ? "Move photos" : action === "split" ? "Create group & split photos" : "Create group & move photos";');
  });

  it("Escape closes the dialog, and Enter immediately confirms when 'New group' is selected", () => {
    const fn = source.slice(source.indexOf("function handleKeyDown"), source.indexOf("document.addEventListener(\"keydown\", handleKeyDown)"));
    expect(fn).toContain('event.key === "Escape"');
    expect(fn).toContain('event.key === "Enter" && mode === "new" && !loading');
  });
});

describe("components/listing-studio/ProductGroupCard.tsx — auto-edit on creation (speed redesign §5/§9)", () => {
  const source = read("components/listing-studio/ProductGroupCard.tsx");

  it("enters rename mode by itself when autoEdit is set, and reports back so the parent clears the flag", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    if (autoEdit)"), source.indexOf("return <article"));
    expect(fn).toContain("startEditingTitle();");
    expect(fn).toContain("onAutoEditConsumed();");
  });

  it("takes autoEdit/onAutoEditConsumed as required props", () => {
    expect(source).toContain("autoEdit: boolean;");
    expect(source).toContain("onAutoEditConsumed: () => void;");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — '+ New product' one-click creation, automatic naming everywhere (speed redesign)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("creates the group with no title in the request — the server assigns the next Product-N name", () => {
    const fn = source.slice(source.indexOf("async function handleCreateGroup"), source.indexOf("// An empty group deletes"));
    expect(fn).toContain('fetch("/api/listing-studio/groups", {\n        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),');
  });

  it("appends the newly created group locally, sets it to auto-edit, and scrolls it into view — no modal, no confirmation, no textbox anywhere in this flow", () => {
    const fn = source.slice(source.indexOf("async function handleCreateGroup"), source.indexOf("// An empty group deletes"));
    expect(fn).toContain("setDrafts(current => [...current, { id: draftId, title, status: \"grouping\"");
    expect(fn).toContain("setAutoEditGroupId(draftId);");
    expect(fn).toContain("scrollIntoView({ behavior: \"smooth\", block: \"start\" })");
  });

  it("Move → New group and Split → New group never send a title/newTitle — the server names both, exactly like '+ New product'", () => {
    const moveFn = source.slice(source.indexOf("async function handleCreateAndMove"), source.indexOf("async function handleSplit"));
    expect(moveFn).toContain("async function handleCreateAndMove() {");
    expect(moveFn).not.toContain("JSON.stringify({ title }");
    expect(moveFn).toContain('body: JSON.stringify({}) });');

    const splitFn = source.slice(source.indexOf("async function handleSplit"), source.indexOf("async function handleMerge"));
    expect(splitFn).toContain("async function handleSplit() {");
    expect(splitFn).not.toContain("newTitle");
    expect(splitFn).toContain("body: JSON.stringify({ sourceDraftId, imageIds }),");
  });

  it("Move → New group appends the created group locally before moving, so the undo toast can resolve its real name", () => {
    const fn = source.slice(source.indexOf("async function handleCreateAndMove"), source.indexOf("async function handleSplit"));
    expect(fn).toContain("setDrafts(current => [...current, { id: draftId, title, status: \"grouping\"");
    expect(fn).toContain("await handleMove(draftId);");
  });

  it("wires autoEdit/onAutoEditConsumed into every ProductGroupCard using one stable, useCallback'd consumer", () => {
    expect(source).toContain("const handleAutoEditConsumed = useCallback(() => setAutoEditGroupId(null), []);");
    expect(source).toContain("autoEdit={draft.id === autoEditGroupId}");
    expect(source).toContain("onAutoEditConsumed={handleAutoEditConsumed}");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — automatic AI product grouping: analyze-per-chunk, apply only after whole-session reconciliation (Milestone 3 v3)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");
  const handlerFn = () => source.slice(source.indexOf("async function handleAutoGroupProducts"), source.indexOf("async function handleApplyAutoGroupProposal"));

  it("adds an 'Auto-group products' action, disabled while running or when there are no Unsorted photos to analyse", () => {
    expect(source).toContain("{autoGroupRunning ? \"Grouping…\" : \"Auto-group products\"}");
    expect(source).toContain("disabled={autoGroupRunning || unsortedPhotoCount === 0}");
  });

  it("computes the eligible Unsorted set from local state, capped at MAX_AUTO_GROUP_SESSION_SIZE and sliced into MAX_AUTO_GROUP_BATCH_SIZE-sized chunks — the whole session's worth of photos, not just one small batch", () => {
    const fn = handlerFn();
    expect(fn).toContain('images.filter(image => image.draft_id === unsortedDraft.id && image.upload_state === "uploaded").sort((a, b) => a.sort_order - b.sort_order)');
    expect(fn).toContain("eligible.slice(0, MAX_AUTO_GROUP_SESSION_SIZE)");
    expect(fn).toContain("for (let i = 0; i < capped.length; i += MAX_AUTO_GROUP_BATCH_SIZE) chunks.push(capped.slice(i, i + MAX_AUTO_GROUP_BATCH_SIZE));");
  });

  it("loops through every chunk automatically, in sequence, behind one click — the user is never asked to click again — and every chunk is only ANALYSED here, never applied", () => {
    const fn = handlerFn();
    expect(fn).toContain("for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {");
    expect(fn).toContain('fetch("/api/listing-studio/groups/auto-group", {');
    expect(fn).not.toContain("rpc/listing_studio_apply_boundary_session");
    expect(fn).toContain("chunkResults.push(body.data);");
  });

  it("REGRESSION: sends this chunk's own global sequence start, and a read-only overlap of the previous chunk's tail (CHUNK_OVERLAP_SIZE), so the model can judge continuity across the chunk boundary — never re-analysing or re-moving the overlap photos themselves", () => {
    const fn = handlerFn();
    expect(fn).toContain("const chunkStartSequenceIndex = chunkIndex * MAX_AUTO_GROUP_BATCH_SIZE + 1;");
    expect(fn).toContain("const overlapImageIds = chunkIndex > 0 ? chunks[chunkIndex - 1].slice(-CHUNK_OVERLAP_SIZE).map(image => image.id) : [];");
    expect(fn).toContain("body: JSON.stringify({ imageIds: chunk.map(image => image.id), overlapImageIds, chunkStartSequenceIndex })");
  });

  it("a 503 (service not configured) stops the whole chunk loop immediately — every remaining chunk would fail identically", () => {
    const fn = handlerFn();
    expect(fn).toContain('if (response.status === 503) { hardStopError = body.error');
    expect(fn).toContain("break;");
  });

  it("any other chunk failure (502, or a network error) is treated as possibly transient — that chunk's photos simply aren't included in chunkResults, and the loop continues with the next chunk rather than aborting the whole run", () => {
    const fn = handlerFn();
    expect(fn).toContain("softFailureCount += 1;");
    expect(fn).toContain("continue;");
  });

  it("REGRESSION: reconciles and applies the WHOLE session in exactly one call, only after every chunk has been analysed — never applying one chunk's result before the rest are known", () => {
    const fn = handlerFn();
    const loopEndIndex = fn.indexOf("if (chunkResults.length > 0) {");
    const applySessionIndex = fn.indexOf('fetch("/api/listing-studio/groups/auto-group/apply-session"');
    expect(loopEndIndex).toBeGreaterThan(-1);
    expect(applySessionIndex).toBeGreaterThan(loopEndIndex);
    expect(fn.match(/fetch\("\/api\/listing-studio\/groups\/auto-group\/apply-session"/g)?.length).toBe(1);
    expect(fn).toContain("body: JSON.stringify({ imageIds: capped.map(image => image.id), chunkResults })");
  });

  it("REGRESSION: a failure applying the whole session (409) is surfaced as a hard error, distinct from a per-chunk analyze failure — nothing is reported as created unless the transactional apply actually succeeded", () => {
    const fn = handlerFn();
    expect(fn).toContain("hardStopError = hardStopError ?? applyBody.error ?? \"Could not apply this session's groups.\";");
  });

  it("reports real, running progress after every completed chunk — photos analysed so far, and boundaries proposed so far — not just a cosmetic spinner", () => {
    const fn = handlerFn();
    expect(fn).toContain("analysedSoFar: current.analysedSoFar + chunk.length");
    expect(fn).toContain("proposedBoundariesSoFar += Array.isArray(body.data?.groups) ? body.data.groups.length : 0;");
    expect(fn).toContain("productsIdentifiedSoFar: proposedBoundariesSoFar");
  });

  it("cycles a secondary cosmetic stage label on a timer alongside the real per-chunk progress counters, and advances to the final 'Applying groups' stage once the whole-session apply call starts", () => {
    expect(source).toContain('const AUTO_GROUP_STAGE_TEXTS = ["Preparing photos", "Comparing products", "Building product groups", "Applying groups"];');
    const fn = handlerFn();
    expect(fn).toContain("setInterval(() => {");
    expect(fn).toContain("stageIndex: (current.stageIndex + 1) % AUTO_GROUP_STAGE_TEXTS.length");
    expect(fn).toContain("clearInterval(stageTimer)");
    expect(fn).toContain("stageIndex: AUTO_GROUP_STAGE_TEXTS.length - 1 });");
  });

  it("REGRESSION: deliberately has no Cancel action — nothing can be safely rolled back once the session apply may already have created and moved high-confidence groups", () => {
    expect(source).not.toMatch(/>Cancel</);
    expect(source).not.toMatch(/AbortController/);
  });

  it("reloads the workspace only when at least one group was actually created by the session apply — an all-review or all-failed run never needs a refetch", () => {
    const fn = handlerFn();
    expect(fn).toContain("if ((applyBody.groupsCreated?.length ?? 0) > 0) await loadWorkspace();");
  });

  it("shows a clear failure message with a Retry action that simply re-invokes the same handler — retrying naturally skips whatever already succeeded, since those photos have already left Unsorted", () => {
    expect(source).toContain('{autoGroupError && !autoGroupRunning && <div className="auto-group-error" role="alert">');
    expect(source).toContain("<button type=\"button\" className=\"button-secondary\" onClick={handleAutoGroupProducts}>Retry</button>");
  });

  it("shows the success summary (groups created / photos grouped / photos left in Unsorted) from the whole-session apply result, and a distinct empty-state note when there was nothing to analyse", () => {
    expect(source).toContain("{autoGroupSummary.groupsCreated.length} product group{autoGroupSummary.groupsCreated.length === 1 ? \"\" : \"s\"} created");
    expect(source).toContain("{autoGroupSummary.photosGroupedCount} photo{autoGroupSummary.photosGroupedCount === 1 ? \"\" : \"s\"} grouped");
    expect(source).toContain("{autoGroupSummary.photosLeftInUnsortedCount} photo{autoGroupSummary.photosLeftInUnsortedCount === 1 ? \"\" : \"s\"} left in Unsorted");
    expect(source).toContain("No photos in Unsorted to group.");
  });

  it("surfaces a truncation note when the session cap was hit or the run stopped early, inviting another click to cover the rest", () => {
    expect(source).toContain("{autoGroupSummary.truncated &&");
    const fn = handlerFn();
    expect(fn).toContain("truncated: totalEligible > capped.length || hardStopError !== null");
  });

  it("medium-confidence proposals (contiguous ranges pending review) are rendered with photo thumbnails, boundaryReason, warnings, and explicit Accept/Reject actions — never applied silently", () => {
    expect(source).toContain("{autoGroupProposals.length > 0 && <div className=\"auto-group-review\">");
    expect(source).toContain("auto-group-proposal-thumbs");
    expect(source).toContain("{proposal.boundaryReason}");
    expect(source).toContain("proposal.warnings.map(");
    expect(source).toContain("onClick={() => handleDismissAutoGroupProposal(proposal.proposedGroupId)}");
    expect(source).toContain("onClick={() => handleApplyAutoGroupProposal(proposal)}");
  });

  it("REGRESSION: the review actions read 'Accept' / 'Reject', not 'Create group' / 'Skip' — same underlying handlers, wording only", () => {
    expect(source).toContain(">Reject</button>");
    expect(source).toContain('{applyingProposalId === proposal.proposedGroupId ? "Accepting…" : "Accept"}');
    expect(source).not.toContain(">Skip<");
    expect(source).not.toContain('"Create group"');
  });

  it("applying (Accept) a proposal posts its exact imageIds to the single-proposal apply endpoint (unchanged by the v3 redesign), removes it from the pending list on success, and reloads the workspace", () => {
    const fn = source.slice(source.indexOf("async function handleApplyAutoGroupProposal"), source.indexOf("function handleDismissAutoGroupProposal"));
    expect(fn).toContain('fetch("/api/listing-studio/groups/auto-group/apply", {');
    expect(fn).toContain("body: JSON.stringify({ imageIds: proposal.imageIds })");
    expect(fn).toContain("current.filter(p => p.proposedGroupId !== proposal.proposedGroupId)");
    expect(fn).toContain("await loadWorkspace();");
  });

  it("dismissing (Reject) a proposal makes no API call — the photos were never moved, so there's nothing to undo", () => {
    const fn = source.slice(source.indexOf("function handleDismissAutoGroupProposal"), source.indexOf("// ---- Clear all"));
    expect(fn).not.toContain("fetch(");
  });

  it("computes unsortedPhotoCount from the real Unsorted group's own photos, not a guess", () => {
    expect(source).toContain('const unsortedDraft = drafts.find(draft => draft.title === "Unsorted");');
    expect(source).toContain("const unsortedPhotoCount = unsortedDraft ? images.filter(image => image.draft_id === unsortedDraft.id).length : 0;");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — REGRESSION: 'Save failed' getting stuck on every card (separate bug, fixed alongside the v3 redesign)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("flashFailed mirrors flashSaved: sets 'failed', then auto-resets back to 'idle' after a guarded timeout, so a stale failure can never persist indefinitely", () => {
    const fn = source.slice(source.indexOf("function flashFailed()"), source.indexOf("function flashFailed()") + 250);
    expect(fn).toContain('setSaveState("failed");');
    expect(fn).toContain('setTimeout(() => setSaveState(current => (current === "failed" ? "idle" : current)), 5000);');
  });

  it("REGRESSION: every failure path calls flashFailed() — there is exactly one raw setSaveState(\"failed\") call in the whole file, and it's flashFailed's own definition", () => {
    expect(source.match(/setSaveState\("failed"\)/g)?.length).toBe(1);
    // every other former call site now goes through flashFailed()
    expect(source.match(/flashFailed\(\)/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("withSaveState (renames, reorders, merges) calls flashFailed on both a non-ok response and a thrown network error", () => {
    const fn = source.slice(source.indexOf("async function withSaveState"), source.indexOf("// ---- Upload flow"));
    expect(fn).toContain("if (!response.ok) { flashFailed(); return { ok: false");
    expect(fn).toContain("catch { flashFailed(); return { ok: false");
  });

  it("commitDeletePhotos (the real delayed-delete network call) calls flashFailed on failure", () => {
    const fn = source.slice(source.indexOf("async function commitDeletePhotos"), source.indexOf("const handleRemovePhoto"));
    expect(fn).toContain("catch { flashFailed(); }");
  });

  it("handleCreateGroup ('+ New product') calls flashFailed on a non-ok response and on a thrown error", () => {
    const fn = source.slice(source.indexOf("async function handleCreateGroup"), source.indexOf("// An empty group deletes"));
    expect(fn).toContain("if (!response.ok) { flashFailed(); return; }");
    expect(fn).toContain("catch { flashFailed(); }");
  });

  it("scheduleDelayedGroupDelete's real (non-undone) delete calls flashFailed on a non-ok response or thrown error", () => {
    const fn = source.slice(source.indexOf("function scheduleDelayedGroupDelete"), source.indexOf("async function handleMove"));
    expect(fn).toContain("if (response.ok) { flashSaved(); await loadWorkspace(); } else flashFailed();");
    expect(fn).toContain("catch { flashFailed(); }");
  });

  it("handleCreateAndMove (Move -> New group) calls flashFailed when creating the new group fails", () => {
    const fn = source.slice(source.indexOf("async function handleCreateAndMove"), source.indexOf("async function handleSplit"));
    expect(fn).toContain("if (!created.ok) { setDialogBusy(false); flashFailed(); return; }");
  });

  it("handleSplit calls flashFailed on a non-ok response", () => {
    const fn = source.slice(source.indexOf("async function handleSplit"), source.indexOf("async function handleMerge"));
    expect(fn).toContain("} else flashFailed();");
  });
});

describe("components/listing-studio/ClearWorkspaceDialog.tsx — confirmation dialog", () => {
  const source = read("components/listing-studio/ClearWorkspaceDialog.tsx");

  it("uses the exact required title, body copy, and button labels", () => {
    expect(source).toContain(">Clear all photos and groups?<");
    expect(source).toContain("This will permanently delete every uploaded photo and product group in Listing Studio. This action cannot be undone.");
    expect(source).toContain(">Cancel<");
    expect(source).toContain("Clear everything");
  });

  it("the confirm button is styled as clearly destructive", () => {
    expect(source).toContain('className="button-danger"');
  });

  it("REGRESSION: while loading, both buttons are disabled and the confirm label reads 'Clearing…'", () => {
    expect(source).toMatch(/className="button-secondary" onClick=\{onClose\} disabled=\{loading\}/);
    expect(source).toMatch(/className="button-danger" disabled=\{loading\} onClick=\{onConfirm\}/);
    expect(source).toContain('{loading ? "Clearing…" : "Clear everything"}');
  });

  it("Escape closes the dialog, but only when not loading", () => {
    expect(source).toContain('event.key === "Escape" && !loading');
  });

  it("clicking the backdrop closes the dialog, matching the existing modal convention, but only when not loading", () => {
    expect(source).toContain("event.target === event.currentTarget && !loading");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — 'Clear all' workspace-wide reset", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");
  const handlerFn = () => source.slice(source.indexOf("async function handleClearWorkspace"), source.indexOf("// ---- Keyboard shortcuts"));

  it("adds a clearly destructive but not overly prominent 'Clear all' action in the same toolbar as Auto-group products / + New product", () => {
    const toolbar = source.slice(source.indexOf('<div className="product-groups-toolbar">'), source.indexOf('{autoGroupRunning && autoGroupProgress'));
    expect(toolbar).toContain("Clear all");
    expect(toolbar).toContain('className="button-danger listing-clear-all"');
  });

  it("does not execute immediately on click — it only opens the confirmation dialog", () => {
    const toolbar = source.slice(source.indexOf('<div className="product-groups-toolbar">'), source.indexOf('{autoGroupRunning && autoGroupProgress'));
    expect(toolbar).toContain("onClick={() => setClearWorkspaceDialogOpen(true)}");
    expect(toolbar).not.toContain("onClick={handleClearWorkspace}");
  });

  it("shows a small, unobtrusive helper note near Auto-group products about keeping each product's photos together in upload order — never as an error/warning banner", () => {
    const toolbar = source.slice(source.indexOf('<div className="product-groups-toolbar">'), source.indexOf('{clearWorkspaceError &&'));
    expect(toolbar).toContain('<p className="auto-group-order-hint">For best results, keep each product');
    expect(toolbar).not.toContain('role="alert"');
    expect(toolbar).not.toContain('role="status"');
  });

  it("REGRESSION: disables the 'Clear all' trigger while an upload is active, while auto-grouping is running, while a clear is already running, or while listings are generating", () => {
    expect(source).toContain("const uploadsActive = uploadItems.some(item => item.state === \"pending\" || item.state === \"uploading\");");
    expect(source).toContain("const clearWorkspaceDisabled = autoGroupRunning || clearingWorkspace || uploadsActive || generatingListings;");
    const toolbar = source.slice(source.indexOf('<div className="product-groups-toolbar">'), source.indexOf('{autoGroupRunning && autoGroupProgress'));
    expect(toolbar).toContain("disabled={clearWorkspaceDisabled}");
  });

  it("renders ClearWorkspaceDialog only when clearWorkspaceDialogOpen is true, wired to the real handler and loading state", () => {
    expect(source).toContain("{clearWorkspaceDialogOpen && <ClearWorkspaceDialog");
    expect(source).toContain("loading={clearingWorkspace}");
    expect(source).toContain("onConfirm={handleClearWorkspace}");
  });

  it("REGRESSION: calls the single dedicated DELETE endpoint exactly once — never one call per photo or group", () => {
    const fn = handlerFn();
    expect(fn).toContain('fetch("/api/listing-studio/workspace", { method: "DELETE" })');
    expect(fn.match(/fetch\("\/api\/listing-studio\/workspace"/g)?.length).toBe(1);
  });

  it("on a non-ok response, reports the error and leaves every local state untouched — nothing is assumed cleared just because the dialog was open", () => {
    const fn = handlerFn();
    const failureBranch = fn.slice(fn.indexOf("if (!response.ok)"), fn.indexOf("setPendingUndo(null);"));
    expect(failureBranch).toContain("setClearWorkspaceError(body.error ||");
    expect(failureBranch).toContain("return;");
  });

  it("REGRESSION: on success, discards (never fires) any pending undo toast, since its target rows are about to be deleted anyway", () => {
    const fn = handlerFn();
    expect(fn).toContain("setPendingUndo(null);");
    expect(fn).not.toContain("forceResolvePendingUndo();");
  });

  it("on success, clears selection, the whole upload queue, every auto-group UI state field (progress/error/summary/proposals), every open dialog, the shared save indicator, and the load error, then closes its own dialog", () => {
    const fn = handlerFn();
    for (const call of [
      "setSelectedIds(new Set());", "setUploadItems([]);", "setUploadNotice(\"\");", "setUploadSuccessMessage(\"\");",
      "setAutoGroupRunning(false);", "setAutoGroupProgress(null);", "setAutoGroupError(null);", "setAutoGroupSummary(null);",
      "setAutoGroupProposals([]);", "setApplyingProposalId(null);",
      "setMoveDialogGroupId(null);", "setMergeDialogGroupId(null);", "setDeleteGroupTarget(null);", "setBulkDeleteConfirmOpen(false);",
      "setAutoEditGroupId(null);", "setSaveState(\"idle\");", "setLoadError(\"\");", "setClearWorkspaceDialogOpen(false);",
    ]) {
      expect(fn).toContain(call);
    }
  });

  it("REGRESSION: refreshes drafts/images from a real loadWorkspace() call after success — the empty state is confirmed by the server, not assumed locally", () => {
    const fn = handlerFn();
    expect(fn).toContain("await loadWorkspace();");
    const loadWorkspaceIndex = fn.indexOf("await loadWorkspace();");
    const dialogCloseIndex = fn.indexOf("setClearWorkspaceDialogOpen(false);");
    expect(loadWorkspaceIndex).toBeGreaterThan(dialogCloseIndex);
  });

  it("a network error is also surfaced, and clearingWorkspace is always reset in a finally block regardless of outcome", () => {
    const fn = handlerFn();
    expect(fn).toContain('setClearWorkspaceError("Network error — could not clear the workspace. Please try again.");');
    expect(fn).toMatch(/finally \{\s*setClearingWorkspace\(false\);\s*\}/);
  });

  it("includes clearWorkspaceDialogOpen in anyDialogOpen, so keyboard shortcuts (Ctrl+A/Escape/Delete) are disabled while this dialog is open, matching every other dialog", () => {
    expect(source).toContain("const anyDialogOpen = Boolean(moveDialogGroupId || mergeDialogGroupId || deleteGroupTarget || bulkDeleteConfirmOpen || clearWorkspaceDialogOpen || editFieldsGroupId || previewGroupId);");
  });
});

describe("components/listing-studio/EditListingFieldsDialog.tsx — Milestone 4: the only place structured listing fields are edited", () => {
  const source = read("components/listing-studio/EditListingFieldsDialog.tsx");

  it("has exactly the required fields — Brand, Model, Product type, Colour 1, Colour 2 (optional), Material, UK size, SKU, Vinted audience, Vinted category — and nothing else editable", () => {
    for (const label of ["Brand", "Model", "Product type", "Colour 1", "Colour 2 (optional)", "Material", "UK size", "SKU", "Vinted audience", "Vinted category"]) {
      expect(source).toContain(`<span className="label">${label}</span>`);
    }
  });

  it("Milestone 6 (Vinted-aware colours/materials): Colour 1/Colour 2/Material are enum <select>s populated from VINTED_COLOURS/VINTED_MATERIALS, never free-text <input>s", () => {
    expect(source).toContain("VINTED_COLOURS, VINTED_MATERIALS");
    expect(source).toContain('from "@/lib/listing-studio/listing-generation-schemas";');
    expect(source).toContain("{VINTED_COLOURS.map(colour => <option key={colour} value={colour}>{colour}</option>)}");
    expect(source).toContain("{VINTED_MATERIALS.map(material => <option key={material} value={material}>{material}</option>)}");
    // Colour 1, Colour 2, Material, Vinted audience (follow-up correction, 2026-08-04).
    expect(source.match(/<select className="input"/g)?.length).toBe(4);
  });

  it("Follow-up correction (2026-08-04): Vinted audience is an enum <select> populated from VINTED_AUDIENCE_VALUES, never free text", () => {
    expect(source).toContain("VINTED_AUDIENCE_VALUES");
    expect(source).toContain("VINTED_AUDIENCE_LABELS");
    expect(source).toContain("{audienceOptions.map(value => <option key={value} value={value}>{VINTED_AUDIENCE_LABELS[value]}</option>)}");
  });

  it("Business-rule follow-up correction: footwear must never offer Boys/Girls in the Vinted Audience selector — audienceOptions excludes them exactly when the current product type is footwear, but keeps them for clothing/uncertain", () => {
    expect(source).toContain('const audienceOptions = deriveDraftItemFamily(draft.productType) === "footwear"');
    expect(source).toContain('? VINTED_AUDIENCE_VALUES.filter(value => value !== "boys" && value !== "girls")');
    expect(source).toContain(": VINTED_AUDIENCE_VALUES;");
  });

  it("Business-rule follow-up correction: a previously saved Boys/Girls footwear value is normalised to Women on load, with its category cleared so a save recomputes a compatible one", () => {
    expect(source).toContain("function buildInitialDraft(fields: ListingFieldsDraft): ListingFieldsDraft {");
    expect(source).toContain("const normalisedAudience = normaliseFootwearVintedAudience(fields.vintedAudience, itemFamily);");
    expect(source).toContain("vintedCategoryId: audienceChanged ? null : fields.vintedCategoryId,");
    expect(source).toContain("vintedCategoryPath: audienceChanged ? null : fields.vintedCategoryPath,");
    expect(source).toContain("useState<ListingFieldsDraft>(() => buildInitialDraft(fields));");
  });

  it("Business-rule follow-up correction: a previously saved footwear model/product type carrying children's wording (e.g. 'Clifton 9 Youth') is cleaned on load too, in the same buildInitialDraft pass", () => {
    expect(source).toContain("const cleanedModel = normaliseFootwearListingText(fields.model, itemFamily, normalisedAudience) ?? \"\";");
    expect(source).toContain("const cleanedProductType = normaliseFootwearListingText(fields.productType, itemFamily, normalisedAudience) ?? \"\";");
  });

  it("REGRESSION: a colour picked in both dropdowns collapses to one entry, and clearing/reordering never exceeds 2 colours (structurally impossible — only 2 selects exist)", () => {
    expect(source).toContain("return { ...current, colours: [...new Set(slots.filter(Boolean))] };");
  });

  it("REGRESSION: has no title or description field anywhere — those are never directly editable", () => {
    expect(source).not.toMatch(/label">Title</i);
    expect(source).not.toMatch(/label">Description</i);
    expect(source).not.toContain("textarea");
  });

  it("while saving, disables every input and both buttons, and the save button reads 'Saving…'", () => {
    expect(source).toContain('disabled={loading}');
    expect(source.match(/disabled=\{loading\}/g)?.length).toBeGreaterThanOrEqual(10); // 5 inputs + 3 selects + cancel + save
    expect(source).toContain('{loading ? "Saving…" : "Save"}');
  });

  it("Escape and backdrop-click close the dialog, guarded by !loading, matching every other bespoke dialog in this feature", () => {
    expect(source).toContain('event.key === "Escape" && !loading');
    expect(source).toContain("event.target === event.currentTarget && !loading");
  });

  it("shows a save error inline in the dialog when passed one, rather than a separate page-level banner", () => {
    expect(source).toContain('{error && <p className="upload-photo-error" role="alert">{error}</p>}');
  });
});

describe("components/listing-studio/ProductGroupCard.tsx — Milestone 4: the generated listing card", () => {
  const source = read("components/listing-studio/ProductGroupCard.tsx");

  it("renders the generated title/description and an Edit fields action only once a listing has been generated for this group", () => {
    const cardBlock = source.slice(source.indexOf("{listing &&"), source.indexOf("<div className=\"product-group-selection-row\">"));
    expect(cardBlock).toContain("{listing.generatedTitle}");
    expect(cardBlock).toContain("{listing.generatedDescription}");
    expect(cardBlock).toContain('onClick={() => onEditFields(group.id)}');
    expect(cardBlock).toContain(">Edit fields<");
  });

  it("REGRESSION: generatedTitle/generatedDescription are a distinct prop from the group's own display name (`group.title`) — never the same field, never colliding with the rename UX", () => {
    expect(source).toContain("export type GeneratedListingSummary = {");
    const typeBlock = source.slice(source.indexOf("export type GeneratedListingSummary = {"), source.indexOf("export type GroupSummary = {") + 1 || source.length);
    expect(source).toMatch(/generatedTitle: string;/);
    expect(source).toMatch(/generatedDescription: string;/);
    // The rename UX still only ever reads/writes group.title, never listing.generatedTitle.
    expect(source).toContain("onRename(group.id, trimmed)");
  });

  it("does not render the listing card at all when this group has no generated listing yet", () => {
    expect(source).toMatch(/\{listing && <div className="listing-card">/);
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — Milestone 4: 'Generate Listings' bulk action", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");
  const handlerFn = () => source.slice(source.indexOf("async function handleGenerateListings"), source.indexOf("async function handleSaveListingFields"));

  it("adds a 'Generate Listings' action in the same toolbar as Auto-group products, disabled when there is nothing eligible or another run is active", () => {
    const toolbar = source.slice(source.indexOf('<div className="product-groups-toolbar">'), source.indexOf('<p className="auto-group-order-hint">'));
    expect(toolbar).toContain("Generate Listings");
    expect(toolbar).toContain("onClick={handleGenerateListings}");
    expect(toolbar).toContain("disabled={generateListingsDisabled || eligibleListingGroups.length === 0}");
  });

  it("REGRESSION: eligible groups exclude Unsorted, empty groups, and groups already generated — re-clicking only retries what's still missing", () => {
    expect(source).toContain('draft.title !== "Unsorted" && !draft.generated_title && images.some(image => image.draft_id === draft.id)');
  });

  it("calls the single-group generate endpoint once per eligible group, sequentially, continuing past an individual failure rather than aborting the whole run", () => {
    const fn = handlerFn();
    expect(fn).toContain("for (const group of eligibleListingGroups) {");
    expect(fn).toContain("fetch(`/api/listing-studio/groups/${group.id}/generate`, { method: \"POST\" })");
    expect(fn).toContain("failureCount += 1;");
    expect(fn).not.toContain("break;");
  });

  it("reports real running progress (done/total) while generating", () => {
    const fn = handlerFn();
    expect(fn).toContain("setGenerateListingsProgress({ done: 0, total: eligibleListingGroups.length });");
    expect(fn).toContain("setGenerateListingsProgress(current => current && { ...current, done: current.done + 1 });");
  });

  it("reloads the workspace only if at least one group actually succeeded, and reports a retry-friendly error if any failed", () => {
    const fn = handlerFn();
    expect(fn).toContain("if (anySucceeded) await loadWorkspace();");
    expect(fn).toContain("could not be generated. Click Generate Listings again to retry them.");
  });

  it("never sends any request body at all to the generate endpoint — the route derives everything itself from the group's own stored photos", () => {
    const fn = handlerFn();
    expect(fn).toContain('fetch(`/api/listing-studio/groups/${group.id}/generate`, { method: "POST" })');
    expect(fn).not.toContain("body:");
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — Milestone 4: 'Edit fields' save flow (no AI call)", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");
  const handlerFn = () => source.slice(source.indexOf("async function handleSaveListingFields"), source.indexOf("function handleCloseEditFields"));

  it("PATCHes the dedicated fields endpoint for the group currently open in the dialog", () => {
    const fn = handlerFn();
    expect(fn).toContain("fetch(`/api/listing-studio/groups/${draftId}/fields`, {");
    expect(fn).toContain('method: "PATCH"');
  });

  it("REGRESSION: on success, updates local state with the server's own returned structured + generated fields — never assumes the client-typed values are what got saved", () => {
    const fn = handlerFn();
    expect(fn).toContain("brand: body.brand, model: body.model, product_type: body.productType, colours: body.colours, material: body.material,");
    expect(fn).toContain("uk_size: body.ukSize, sku: body.sku, generated_title: body.generatedTitle, generated_description: body.generatedDescription,");
  });

  it("on failure, shows the error inline in the dialog (editFieldsError) and returns immediately — never reaches the dialog-closing line on a failed save", () => {
    const fn = handlerFn();
    const failureIndex = fn.indexOf('if (!response.ok) { setEditFieldsError(body.error || "Could not save these fields."); return; }');
    const closeIndex = fn.indexOf("setEditFieldsGroupId(null);");
    expect(failureIndex).toBeGreaterThan(-1);
    expect(failureIndex).toBeLessThan(closeIndex); // the failure branch's own `return;` exits before this line is ever reached
  });

  it("closes the dialog only after a successful save", () => {
    const fn = handlerFn();
    const successIndex = fn.indexOf("setDrafts(current =>");
    const closeIndex = fn.indexOf("setEditFieldsGroupId(null);");
    expect(closeIndex).toBeGreaterThan(successIndex);
  });

  it("renders EditListingFieldsDialog only when a group is being edited, seeded with that group's current structured fields (blank strings for null)", () => {
    expect(source).toContain("{editFieldsTarget && <EditListingFieldsDialog");
    expect(source).toContain("brand: editFieldsTarget.brand ?? \"\", model: editFieldsTarget.model ?? \"\", productType: editFieldsTarget.product_type ?? \"\",");
    expect(source).toContain("loading={savingListingFields}");
    expect(source).toContain("error={editFieldsError}");
  });
});

describe("components/listing-studio/PreviewListingDialog.tsx — Milestone 4 UX fix: full, read-only listing preview", () => {
  const source = read("components/listing-studio/PreviewListingDialog.tsx");

  it("renders the complete title and description via plain interpolation — never sliced/truncated/ellipsised", () => {
    expect(source).toContain('<p className="preview-listing-title-text">{generatedTitle || "No title generated yet."}</p>');
    expect(source).toContain('<p className="preview-listing-description-text">{generatedDescription || "No description generated yet."}</p>');
    expect(source).not.toMatch(/\.slice\(|\.substring\(|…|line-clamp/);
  });

  it("REGRESSION: the description is rendered with white-space: pre-wrap (see globals.css) so every line break, blank line, and run of spaces is preserved exactly as stored — never collapsed or reformatted", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.preview-listing-description-text\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  it("shows UK size and SKU, each falling back to a clear 'Not set' when null", () => {
    expect(source).toContain('<span>{ukSize || "Not set"}</span>');
    expect(source).toContain('<span>{sku || "Not set"}</span>');
  });

  it("REGRESSION: is read-only — no input, textarea, or onChange anywhere in this dialog; editing only ever happens via EditListingFieldsDialog", () => {
    expect(source).not.toMatch(/<input\b|<textarea\b|onChange/);
  });

  it("does not show any confidence score, badge, or label anywhere", () => {
    expect(source).not.toMatch(/confidence/i);
  });

  it("never makes an AI call or imports anything AI-related", () => {
    expect(source).not.toMatch(/anthropic|Anthropic|fetch\(/i);
  });

  it("has a Copy title button and a Copy description button, each copying the exact corresponding text via the Clipboard API", () => {
    expect(source).toContain('onClick={() => copy(generatedTitle, "title")}');
    expect(source).toContain('onClick={() => copy(generatedDescription, "description")}');
    expect(source).toContain("navigator.clipboard.writeText(text)");
  });

  it("REGRESSION: shows a brief 'Copied!' success state per-button, independently, that reverts back to the original label", () => {
    expect(source).toContain('{copiedField === "title" ? "Copied!" : "Copy title"}');
    expect(source).toContain('{copiedField === "description" ? "Copied!" : "Copy description"}');
    expect(source).toContain('setTimeout(() => setCopiedField(current => (current === field ? null : current)), 2000);');
  });

  it("a clipboard failure is caught silently — never thrown, never shown as an error — since the full text is still visible in the modal either way", () => {
    const copyFn = source.slice(source.indexOf("async function copy"), source.indexOf("return <div"));
    expect(copyFn).toContain("try {");
    expect(copyFn).toContain("} catch {");
  });

  it("Escape and backdrop-click close the dialog, matching the existing modal convention in this feature", () => {
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("event.target === event.currentTarget");
  });

  it("has a single Close action — no Save, since nothing here is editable", () => {
    expect(source).toContain(">Close</button>");
    expect(source).not.toMatch(/>Save</);
  });
});

describe("components/listing-studio/ProductGroupCard.tsx — Milestone 4 UX fix: 'Preview listing' action beside 'Edit fields'", () => {
  const source = read("components/listing-studio/ProductGroupCard.tsx");

  it("renders a compact 'Preview listing' action alongside 'Edit fields', inside the same listing card, only once a listing exists", () => {
    const cardBlock = source.slice(source.indexOf("{listing &&"), source.indexOf('<div className="product-group-selection-row">'));
    expect(cardBlock).toContain('onClick={() => onPreviewListing(group.id)}');
    expect(cardBlock).toContain(">Preview listing<");
    expect(cardBlock).toContain('onClick={() => onEditFields(group.id)}');
    expect(cardBlock).toContain('className="listing-card-actions"');
  });

  it("takes onPreviewListing as a required prop, scoped by this group's own id, matching onEditFields's own convention", () => {
    expect(source).toContain("onPreviewListing: (draftId: string) => void;");
  });

  it("REGRESSION: the card itself is unaffected — still truncates the description (line-clamp) and stays compact; only a new button was added, not a redesign", () => {
    expect(source).toContain('<p className="listing-card-description">{listing.generatedDescription}</p>');
  });
});

describe("components/listing-studio/GroupingWorkspace.tsx — Milestone 4 UX fix: 'Preview listing' wiring", () => {
  const source = read("components/listing-studio/GroupingWorkspace.tsx");

  it("tracks which group's preview is open in its own dedicated state, distinct from Edit fields' own state", () => {
    expect(source).toContain("const [previewGroupId, setPreviewGroupId] = useState<string | null>(null);");
  });

  it("passes onPreviewListing={setPreviewGroupId} to every ProductGroupCard", () => {
    expect(source).toContain("onPreviewListing={setPreviewGroupId}");
  });

  it("renders PreviewListingDialog only when both the target group and its generated listing exist, seeded from the same listingsByDraftId lookup Edit fields and the card itself already use", () => {
    expect(source).toContain("const previewTarget = drafts.find(draft => draft.id === previewGroupId) ?? null;");
    expect(source).toContain("const previewListing = previewGroupId ? listingsByDraftId.get(previewGroupId) ?? null : null;");
    expect(source).toContain("{previewTarget && previewListing && <PreviewListingDialog");
  });

  it("passes the exact stored generatedTitle/generatedDescription/ukSize/sku through untouched — no new formatting/AI call in the wiring itself", () => {
    const dialogBlock = source.slice(source.indexOf("{previewTarget && previewListing && <PreviewListingDialog"), source.indexOf("{previewTarget && previewListing && <PreviewListingDialog") + 400);
    expect(dialogBlock).toContain("generatedTitle={previewListing.generatedTitle}");
    expect(dialogBlock).toContain("generatedDescription={previewListing.generatedDescription}");
    expect(dialogBlock).toContain("ukSize={previewListing.ukSize}");
    expect(dialogBlock).toContain("sku={previewListing.sku}");
  });

  it("closing the preview resets previewGroupId back to null", () => {
    expect(source).toContain("onClose={() => setPreviewGroupId(null)}");
  });

  it("includes previewGroupId in anyDialogOpen, so keyboard shortcuts are disabled while this dialog is open, matching every other dialog", () => {
    expect(source).toContain("const anyDialogOpen = Boolean(moveDialogGroupId || mergeDialogGroupId || deleteGroupTarget || bulkDeleteConfirmOpen || clearWorkspaceDialogOpen || editFieldsGroupId || previewGroupId);");
  });
});

