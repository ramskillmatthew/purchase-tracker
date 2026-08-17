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

  it("provides a discoverable Shift-click hint only while a selection is active", () => {
    expect(source).toContain('{selectedIds.size > 0 && <span className="selection-hint">Shift-click rows to select a range</span>}');
  });
});

describe("app/purchases/page.tsx — Clear selection action", () => {
  it("REQUIREMENT: a compact, explicit Clear selection control is shown only while something is selected", () => {
    expect(source).toContain('{selectedIds.size > 0 && <button type="button" className="button-secondary" onClick={clearSelection}>Clear selection</button>}');
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

  it("REQUIREMENT: the confirmation dialog's title, message, and confirm label reflect the exact selected count", () => {
    expect(source).toContain("title={`Delete ${selectedIds.size} purchase${selectedIds.size === 1 ? \"\" : \"s\"}?`}");
    expect(source).toContain('message="The selected purchase records will be permanently removed. This cannot be undone."');
    expect(source).toContain("confirmLabel={`Delete ${selectedIds.size} purchase${selectedIds.size === 1 ? \"\" : \"s\"}`}");
  });

  it("REQUIREMENT: disables repeat submission and shows a deleting state via the shared ConfirmDialog's confirming/confirmingLabel props", () => {
    expect(source).toContain("confirming={bulkDeleting}");
    expect(source).toContain('confirmingLabel="Deleting…"');
    const guard = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(guard).toContain("if (bulkDeleting) return;");
  });

  it("uses a dedicated POST to the bulk-delete route with the exact selected ids, never a loop of per-purchase DELETE calls", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain('fetch("/api/purchases/bulk-delete"');
    expect(fn).toContain('method: "POST"');
    expect(fn).toContain("body: JSON.stringify({ ids })");
  });

  it("REQUIREMENT: only removes deleted ids from selection and only closes the dialog on a confirmed successful deletion", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    const successBranch = fn.slice(fn.indexOf("const { deletedIds }"));
    expect(successBranch).toContain("setSelectedIds(current => { const next = new Set(current); for (const id of deleted) next.delete(id); return next; });");
    expect(successBranch).toContain("setBulkDeleteConfirmOpen(false);");
  });

  it("REQUIREMENT: a failed deletion keeps the dialog open, keeps the selection, and surfaces an actionable error instead", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain('if (!response.ok) { setBulkDeleteError("Could not delete the selected purchases. Try again."); setBulkDeleting(false); return; }');
    expect(fn).not.toMatch(/if \(!response\.ok\)[\s\S]{0,40}setSelectedIds\(new Set/);
    expect(fn).not.toMatch(/if \(!response\.ok\)[\s\S]{0,40}setBulkDeleteConfirmOpen\(false\)/);
  });

  it("also removes the deleted ids from a matching Shift-click anchor so a stale anchor can't be reused after deletion", () => {
    const fn = source.slice(source.indexOf("async function bulkDeleteSelected"), source.indexOf("// Patches the affected rows in place"));
    expect(fn).toContain("setRangeAnchor(current => (current && deleted.has(current) ? null : current));");
  });

  it("does not touch the existing single-purchase delete or Clear-all flows", () => {
    expect(source).toContain("async function remove(id: string) {");
    expect(source).toContain("async function clearAll() {");
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
    expect(dialogSource).toContain('<button type="button" className="dialog-cancel" onClick={onCancel} disabled={confirming}>Keep records</button>');
    expect(dialogSource).toContain('<button type="button" className="dialog-confirm" onClick={onConfirm} disabled={confirming}>{confirming ? (confirmingLabel ?? "Deleting…") : confirmLabel}</button>');
  });

  it("Escape and backdrop-click are both suppressed while confirming, so an in-flight delete can't be dismissed out from under itself", () => {
    expect(dialogSource).toContain('function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !confirming) onCancel(); }');
    expect(dialogSource).toContain("if (event.target === event.currentTarget && !confirming) onCancel();");
  });
});
