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

