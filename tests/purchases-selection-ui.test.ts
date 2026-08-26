import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// app/purchases/page.tsx is a "use client" page with no React test harness
// in this project (see tests/purchases-search.test.ts's own comment on this
// established convention) — wiring is asserted structurally against the
// source text; the actual selection/range decision logic it delegates to
// lib/purchases-selection.ts is covered directly in
// tests/purchases-selection.test.ts.
const source = readFileSync("app/purchases/page.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

describe("app/purchases/page.tsx — selection state and imports", () => {
  it("imports the pure selection helpers rather than reimplementing the logic inline", () => {
    expect(source).toContain('import { pruneMissingIds, resolveRowClick, selectionSummary, toggleId, toggleVisiblePage } from "@/lib/purchases-selection";');
  });

  it("stores selected ids as a Set of purchase UUIDs, independent of the current page", () => {
    expect(source).toContain('const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());');
  });

  it("REQUIREMENT: stale selected ids are pruned whenever the underlying rows refresh", () => {
    const fn = source.slice(source.indexOf("useEffect(() => {\n    setSelectedIds(current => pruneMissingIds"), source.indexOf("useEffect(() => {\n    setSelectedIds(current => pruneMissingIds") + 220);
    expect(fn).toContain("pruneMissingIds(current, new Set(rows.map(row => row.id)))");
    expect(fn).toContain("}, [rows]);");
  });

  it("keeps a Shift-click range anchor, separate from the selection itself", () => {
    expect(source).toContain('const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);');
  });
});

describe("app/purchases/page.tsx — per-row checkbox column", () => {
  it("renders a checkbox in a new first column for every saved purchase row, with an identifying accessible label", () => {
    expect(source).toContain('<td className="purchase-checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${row.item_description || "this purchase"} (SKU ${row.sku || "none"}, ${row.order_date})`} checked={selectedIds.has(row.id)} onChange={() => toggleRowSelected(row.id)} /></td>');
  });

  it("REQUIREMENT: clicking the checkbox cell stops propagation so it can never also trigger the row's open/clear-selection click handler", () => {
    const cellIdx = source.indexOf('<td className="purchase-checkbox-cell" onClick={event => event.stopPropagation()}>');
    expect(cellIdx).toBeGreaterThan(-1);
  });

  it("toggling a row's checkbox updates selectedIds via the pure toggleId helper and sets it as the new range anchor", () => {
    const fn = source.slice(source.indexOf("function toggleRowSelected"), source.indexOf("function toggleSelectAllVisible"));
    expect(fn).toContain("setSelectedIds(current => toggleId(current, id));");
    expect(fn).toContain("setRangeAnchor(id);");
  });

  it("REQUIREMENT: selected rows get a distinct purple-tinted background class, not a mutation of the existing Arrived/Stock cells", () => {
    expect(source).toContain('className={selectedIds.has(row.id) ? "purchase-row-selected" : undefined}');
  });

  it("does not replace the existing Arrived/Stock controls — they remain rendered exactly as before", () => {
    expect(source).toContain("<ArrivalToggle id={row.id} arrived={row.arrived} description={row.item_description} onToggle={toggleArrived} />");
    expect(source).toContain("<StockStatusToggle id={row.id} stockStatus={row.stock_status} description={row.item_description} onToggle={toggleStockStatus} />");
  });
});

describe("app/purchases/page.tsx — header select-all checkbox", () => {
  it("renders a header checkbox wired to the current visible page only, using the pure selectionSummary/toggleVisiblePage helpers", () => {
    expect(source).toContain('const pageIds = useMemo(() => pageRows.map(row => row.id), [pageRows]);');
    expect(source).toContain('const selection = useMemo(() => selectionSummary(selectedIds, pageIds), [selectedIds, pageIds]);');
    expect(source).toContain("function toggleSelectAllVisible() {\n    setSelectedIds(current => toggleVisiblePage(current, pageIds));\n  }");
  });

  it("REQUIREMENT: sets the indeterminate DOM property imperatively (no declarative HTML attribute exists for it)", () => {
    expect(source).toContain("const selectAllRef = useRef<HTMLInputElement>(null);");
    expect(source).toContain("useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selection.someSelected; }, [selection.someSelected]);");
  });

  it("the header checkbox is checked only when selection.allSelected is true", () => {
    expect(source).toContain('checked={selection.allSelected} onChange={toggleSelectAllVisible}');
  });
});

describe("app/purchases/page.tsx — Shift-click range selection and click-to-clear", () => {
  it("REQUIREMENT: row clicks are resolved through resolveRowClick, not a bare navigate call", () => {
    expect(source).toContain("onClick={event => handleRowClick(event, row)}");
    expect(source).toContain("const action = resolveRowClick({ shiftKey: event.shiftKey, hasSelection: selectedIds.size > 0, pageIds, anchorId: rangeAnchor, targetId: row.id });");
  });

  it("a range result unions the returned ids into the existing selection, preserving ids outside the range", () => {
    const fn = source.slice(source.indexOf("function handleRowClick"), source.indexOf("async function bulkDeleteSelected"));
    expect(fn).toContain('if (action.type === "range") { setSelectedIds(current => { const next = new Set(current); for (const id of action.ids) next.add(id); return next; }); return; }');
  });

  it("a clear result routes through the same clearSelection() used by the explicit Clear selection button — both reset the range anchor too", () => {
    const fn = source.slice(source.indexOf("function handleRowClick"), source.indexOf("async function bulkDeleteSelected"));
    expect(fn).toContain('if (action.type === "clear") { clearSelection(); return; }');
    const clearFn = source.slice(source.indexOf("function clearSelection"), source.indexOf("// Priority order"));
    expect(clearFn).toContain("setSelectedIds(new Set());");
    expect(clearFn).toContain("setRangeAnchor(null);");
  });

  it("REQUIREMENT: a navigate result still opens the purchase exactly as before", () => {
    const fn = source.slice(source.indexOf("function handleRowClick"), source.indexOf("async function bulkDeleteSelected"));
    expect(fn).toContain("router.push(`/purchases/${row.id}`);");
  });

  it("keyboard Enter still opens the purchase directly, unaffected by selection state", () => {
    expect(source).toContain("onKeyDown={event => { if (event.key === \"Enter\") router.push(`/purchases/${row.id}`); }}");
  });

  it("keeps Shift-click range selection implemented without cluttering the compact action bar", () => {
    expect(source).toContain("shiftKey: event.shiftKey");
    expect(source).not.toContain('className="selection-hint"');
  });
});

describe("app/purchases/page.tsx — Clear selection action", () => {
  it("REQUIREMENT: a compact, explicit Clear selection control is shown only while something is selected", () => {
    expect(source).toContain('{selectedIds.size > 0 && <div className="purchase-bulk-update-bar"');
    expect(source).toContain('className="purchase-bulk-clear" onClick={clearSelection}');
  });

  it("REGRESSION: the unrelated 'Clear all' control is still present, unchanged, and still wired to the confirmation dialog", () => {
    expect(source).toContain('<button className="button-danger" onClick={() => setConfirmation({ type: "all" })}>Clear all</button>');
  });
});

describe("app/purchases/page.tsx — bulk delete button, dynamic label, and confirmation", () => {
  it("REQUIREMENT: the destructive bulk-delete button only renders while at least one purchase is selected, with a dynamic count label", () => {
    expect(source).toContain('{selectedIds.size > 0 && <button type="button" className="button-danger" onClick={() => setBulkDeleteConfirmOpen(true)}>Delete {selectedIds.size} selected</button>}');
  });

  it("sits alongside the existing Import spreadsheet / Bulk mark arrivals / Add purchase actions in the page header", () => {
    const actionsBlock = source.slice(source.indexOf('<div className="purchase-topbar-actions">'), source.indexOf("</header>"));
    expect(actionsBlock).toContain("Import spreadsheet");
    expect(actionsBlock).toContain("Bulk mark arrivals");
    expect(actionsBlock).toContain("Delete {selectedIds.size} selected");
    expect(actionsBlock).toContain("Add purchase");
  });

  it("REQUIREMENT: clicking it opens a confirmation dialog rather than deleting immediately", () => {
    expect(source).toContain("onClick={() => setBulkDeleteConfirmOpen(true)}");
    expect(source).toContain("{bulkDeleteConfirmOpen && <ConfirmDialog");
  });

  it("REQUIREMENT: the confirmation dialog's title, message, and confirm label reflect the deletable/protected eligibility split, not the raw selected count", () => {
    expect(source).toContain("title={deletionDialogTitle(selectedEligibility)}");
    expect(source).toContain("message={deletionDialogMessage(selectedEligibility)}");
    expect(source).toContain("confirmLabel={deletionConfirmLabel(selectedEligibility)}");
    expect(source).toContain("hideConfirm={selectedEligibility.deletableCount === 0}");
  });

  it("REQUIREMENT: disables repeat submission and shows a deleting state via the shared ConfirmDialog's confirming/confirmingLabel props", () => {
    expect(source).toContain("confirming={bulkDeleting}");
    expect(source).toContain('confirmingLabel="Deleting…"');
    const guard = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(guard).toContain("if (bulkDeleting) return;");
  });

  it("REQUIREMENT: sends only the ids already known-deletable from the preflight split, never a purchase already known protected, and never a loop of per-purchase DELETE calls", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain("const deletableIds = selectedRows.filter(row => row.protectedSaleId === null).map(row => row.id);");
    expect(fn).toContain('fetch("/api/purchases/bulk-delete"');
    expect(fn).toContain('method: "POST"');
    expect(fn).toContain("body: JSON.stringify({ ids: deletableIds })");
  });

  it("REQUIREMENT: only reconciles selection and only closes the dialog on a confirmed successful deletion, keeping any newly (race-condition) protected id still selected", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    const successBranch = fn.slice(fn.indexOf("const result = body as DeletePurchasesResult;"));
    expect(successBranch).toContain("const stillProtected = new Set(result.protectedIds);");
    expect(successBranch).toContain("for (const id of deletableIds) if (!stillProtected.has(id)) next.delete(id);");
    expect(successBranch).toContain("setBulkDeleteConfirmOpen(false);");
  });

  it("REQUIREMENT: a failed deletion keeps the dialog open, keeps the selection, and surfaces an actionable error instead — including the RPC's own protected-conflict message on a 409", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain('setBulkDeleteError(body?.error || "Could not delete the selected purchases. Try again.");');
    expect(fn).not.toMatch(/if \(!response\.ok\)[\s\S]{0,80}setSelectedIds\(new Set/);
    expect(fn).not.toMatch(/if \(!response\.ok\)[\s\S]{0,120}setBulkDeleteConfirmOpen\(false\)/);
  });

  it("REQUIREMENT: a 409 (something became protected mid-flight) triggers a refresh so eligibility recomputes from reality, never silently detaching anything", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain('if (response.status === 409) load();');
  });

  it("also removes the deleted ids from a matching Shift-click anchor so a stale anchor can't be reused after deletion", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain("setRangeAnchor(current => (current && deletableIds.includes(current) && !stillProtected.has(current) ? null : current));");
  });

  it("REQUIREMENT: the success toast reports both the actually-deleted count and the FULL protected count (originally-excluded plus any race-condition find)", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain("setDeleteToast(purchasesDeletedMessage(result.deletedCount, selectedEligibility.protectedCount + result.protectedCount));");
  });

  it("does not touch the existing single-purchase delete or Clear-all flows", () => {
    expect(source).toContain("async function remove(id: string) {");
    expect(source).toContain("async function clearAll() {");
  });
});

describe("app/purchases/page.tsx — single-purchase delete: protected vs eligible", () => {
  it("REQUIREMENT: a protected row's Delete button shows the informational PurchaseProtectedDialog instead of the destructive confirmation", () => {
    expect(source).toContain("if (row.protectedSaleId) setProtectedNoticeSaleId(row.protectedSaleId); else setConfirmation({ type: \"one\", id: row.id });");
  });

  it("REQUIREMENT: a 409 on single delete (a race between preflight and confirm) keeps the dialog open, shows the server's own explanation, and refreshes so protection reflects reality", () => {
    const fn = source.slice(source.indexOf("async function remove(id: string) {"), source.indexOf("// Shares safe_delete_purchases"));
    expect(fn).toContain('setDeleteActionError(body?.error || "Could not delete purchase.");');
    expect(fn).toContain("if (response.status === 409) load();");
    expect(fn).not.toMatch(/if \(!response\.ok\)[\s\S]{0,80}setConfirmation\(null\)/);
  });

  it("REQUIREMENT: only closes the dialog on confirmed success", () => {
    const fn = source.slice(source.indexOf("async function remove(id: string) {"), source.indexOf("// Shares safe_delete_purchases"));
    const successBranch = fn.slice(fn.lastIndexOf("setConfirmation(null);"));
    expect(successBranch).toContain("load();");
  });

  it("renders the informational protected dialog (not the destructive ConfirmDialog) when a row is protected", () => {
    expect(source).toContain('{protectedNoticeSaleId && <PurchaseProtectedDialog saleId={protectedNoticeSaleId} onClose={() => setProtectedNoticeSaleId(null)} />}');
  });
});

describe("app/purchases/page.tsx — Clear All respects sales protection", () => {
  it("REQUIREMENT: Clear All's own preflight is computed over every currently loaded purchase, not just the selection", () => {
    const block = source.slice(source.indexOf("const allEligibility: DeletionEligibility"), source.indexOf("function changeSort"));
    expect(block).toContain("rows.filter(row => row.protectedSaleId === null).length");
    expect(block).toContain("rows.filter(row => row.protectedSaleId !== null).length");
  });

  it("REQUIREMENT: the Clear All dialog uses the same eligibility-driven copy and hides the confirm button when everything is protected", () => {
    expect(source).toContain("title={deletionDialogTitle(allEligibility)}");
    expect(source).toContain("message={deletionDialogMessage(allEligibility)}");
    expect(source).toContain("confirmLabel={deletionConfirmLabel(allEligibility)}");
    expect(source).toContain("hideConfirm={allEligibility.deletableCount === 0}");
  });

  it("REQUIREMENT: a successful Clear All shows the exact server-reported deleted/protected counts as a success toast", () => {
    const fn = source.slice(source.indexOf("async function clearAll() {"), source.indexOf("// Updates the one row in place"));
    expect(fn).toContain("purchasesDeletedMessage(body.deletedCount, body.protectedCount)");
  });
});

describe("app/purchases/page.tsx — table structure updated for the new checkbox column", () => {
  it("the empty-state rows span the new 10-column width (was 9)", () => {
    expect(source).not.toContain("colSpan={9}");
    expect((source.match(/colSpan=\{10\}/g) || []).length).toBe(2);
  });

  it("renders a header checkbox cell before the existing sortable columns", () => {
    const theadIdx = source.indexOf("<thead><tr>");
    const checkboxThIdx = source.indexOf('<th className="purchase-checkbox-cell">');
    const columnsMapIdx = source.indexOf("{columns.map(column =>");
    expect(theadIdx).toBeGreaterThan(-1);
    expect(theadIdx).toBeLessThan(checkboxThIdx);
    expect(checkboxThIdx).toBeLessThan(columnsMapIdx);
  });
});

describe("app/globals.css — selection styling", () => {
  it("checkbox column widths are defined for both the new column and every existing shifted column", () => {
    for (let i = 1; i <= 10; i++) expect(css).toContain(`.purchase-grid th:nth-child(${i}) {`);
  });

  it("selected rows use the app's existing purple-tint selection colour, not a new one-off colour", () => {
    expect(css).toContain(".purchase-grid tbody tr.purchase-row-selected { background: var(--primary-soft) !important; }");
  });
});

describe("components/ConfirmDialog.tsx — extended for an in-place deleting state (backward compatible)", () => {
  const dialogSource = readFileSync("components/ConfirmDialog.tsx", "utf8");

  it("confirming/confirmingLabel/error are optional so every existing caller (Clear all, delete-one-purchase, listings bulk delete) keeps working unchanged", () => {
    expect(dialogSource).toContain("confirming?: boolean;");
    expect(dialogSource).toContain("confirmingLabel?: string;");
    expect(dialogSource).toContain("error?: string;");
    expect(dialogSource).toContain("confirming = false");
  });

  it("disables both buttons while confirming, and shows the confirming label instead of the normal one", () => {
    expect(dialogSource).toContain('<button type="button" className="dialog-cancel" onClick={onCancel} disabled={confirming}>{cancelLabel ?? "Keep records"}</button>');
    expect(dialogSource).toContain('{!hideConfirm && <button type="button" className="dialog-confirm" onClick={onConfirm} disabled={confirming}>{confirming ? (confirmingLabel ?? "Deleting…") : confirmLabel}</button>}');
  });

  it("REQUIREMENT: hideConfirm/cancelLabel are optional and backward compatible — every existing caller omitting them keeps the normal two-button layout", () => {
    expect(dialogSource).toContain("hideConfirm?: boolean;");
    expect(dialogSource).toContain("cancelLabel?: string;");
    expect(dialogSource).toContain("hideConfirm = false");
  });

  it("REQUIREMENT: hideConfirm renders only the dismiss button — no destructive confirm action alongside a purchase that cannot currently be deleted", () => {
    const actionsBlock = dialogSource.slice(dialogSource.indexOf('<div className={hideConfirm'), dialogSource.indexOf('</div>', dialogSource.indexOf('<div className={hideConfirm')));
    expect(actionsBlock).toContain('"dialog-actions dialog-actions-single"');
    expect(actionsBlock).toContain("{!hideConfirm &&");
  });

  it("Escape and backdrop-click are both suppressed while confirming, so an in-flight delete can't be dismissed out from under itself", () => {
    expect(dialogSource).toContain('function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !confirming) onCancel(); }');
    expect(dialogSource).toContain("if (event.target === event.currentTarget && !confirming) onCancel();");
  });
});
