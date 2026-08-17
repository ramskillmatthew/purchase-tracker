"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PurchaseForm from "@/components/PurchaseForm";
import ConfirmDialog from "@/components/ConfirmDialog";
import PurchaseImportDialog from "@/components/PurchaseImportDialog";
import BulkArrivalsDialog from "@/components/BulkArrivalsDialog";
import TaskToast from "@/components/TaskToast";
import PageSizeSelect from "@/components/PageSizeSelect";
import ArrivalToggle from "@/components/ArrivalToggle";
import StockStatusToggle from "@/components/StockStatusToggle";
import { purchaseAddedMessage, stockStatusChangedMessage } from "@/lib/success-messages";
import { DEFAULT_PAGE_SIZE, parseStoredPageSize, totalPagesFor, type PageSize } from "@/lib/pagination";
import { matchesStockFilter, parseStockFilter, stockFilters, type StockFilter } from "@/lib/purchases";
import { buildPurchaseSearchText, matchesPurchaseSearchText, normalizeSearchTerms } from "@/lib/purchase-search";
import { pruneMissingIds, resolveRowClick, selectionSummary, toggleId, toggleVisiblePage } from "@/lib/purchases-selection";
import type { Purchase, StockStatus } from "@/lib/types";

const PURCHASES_PAGE_SIZE_KEY = "trotters:purchases-page-size";

type SortKey = "order_date" | "seller_name" | "item_description" | "item_size" | "price_purchased" | "sku" | "arrived" | "stock_status" | "purchased_from";

const columns: { label: string; key: SortKey }[] = [
  { label: "Order Date", key: "order_date" },
  { label: "Seller", key: "seller_name" },
  { label: "Description", key: "item_description" },
  { label: "Size", key: "item_size" },
  { label: "Price", key: "price_purchased" },
  { label: "SKU", key: "sku" },
  { label: "Arrived", key: "arrived" },
  { label: "Stock", key: "stock_status" },
  { label: "Platform", key: "purchased_from" },
];

// Wrapped in Suspense because it reads useSearchParams (the Home page's
// Stock value / In stock awaiting arrival cards link here with
// ?stock=in-stock / ?stock=waiting-on-arrival) — Next.js requires that to
// avoid de-opting the whole route from static prerendering.
export default function PurchasesPage() {
  return <Suspense fallback={null}><PurchasesPageInner /></Suspense>;
}

function PurchasesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkArrivalsOpen, setBulkArrivalsOpen] = useState(false);
  const [editing, setEditing] = useState<Purchase | undefined>();
  const [rows, setRows] = useState<Purchase[]>([]);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "order_date", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [stockFilter, setStockFilter] = useState<StockFilter>(() => parseStockFilter(searchParams.get("stock")));
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [confirmation, setConfirmation] = useState<{ type: "one" | "all"; id?: string } | null>(null);
  const [addedToast, setAddedToast] = useState(false);
  const [stockToast, setStockToast] = useState<string | null>(null);
  // Selected purchase UUIDs, independent of the current page/filter/sort —
  // never a row index, so selections survive pagination and re-sorting.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The Shift-click range anchor. Reset whenever the selection is cleared
  // (including via the row-click-to-clear gesture below) so a later
  // Shift-click can never reuse a stale range.
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState("");

  function changeStockFilter(next: StockFilter) {
    setStockFilter(next);
    setPage(1);
  }
  // Pagination must never be left on a page that no longer exists for the
  // new results — reset happens synchronously with every keystroke, never
  // debounced, since the visible table itself updates immediately too.
  function changeQuery(next: string) {
    setQuery(next);
    setPage(1);
  }

  // Debounced URL sync — the visible input and filtered table update
  // instantly from local `query`/`stockFilter` state above; only the URL
  // write is debounced, so continuous typing never triggers a URL update
  // (or the query-string-driven re-render that would follow it) on every
  // keystroke. Rebuilds BOTH `stock` and `q` from current live state
  // (never by trusting whatever the URL already happens to say), so the
  // two can never drift apart — e.g. changing the stock filter (which,
  // before this, never wrote back to the URL at all) and then typing a
  // search must leave the URL reflecting both current selections, never a
  // stale `stock` value left over from the page's initial load.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (stockFilter === "all") params.delete("stock"); else params.set("stock", stockFilter);
      const trimmedQuery = query.trim();
      if (trimmedQuery) params.set("q", trimmedQuery); else params.delete("q");
      const next = params.toString();
      if (next !== searchParams.toString()) router.replace(next ? `/purchases?${next}` : "/purchases", { scroll: false });
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes router/searchParams: including them would reset the debounce timer on every navigation this effect itself performs (including its own replace() call), and could never settle. Only query/stockFilter changing should ever restart the debounce.
  }, [query, stockFilter]);

  // Restored after mount (not in the initial useState) so the server-rendered
  // and first-client-render HTML always agree on the default — avoids a
  // hydration mismatch, matching the existing dark-mode restore pattern in
  // components/AppHeader.tsx.
  useEffect(() => {
    try { setPageSizeState(parseStoredPageSize(window.localStorage.getItem(PURCHASES_PAGE_SIZE_KEY))); }
    catch { /* localStorage may be unavailable (private browsing) — the default page size still works */ }
  }, []);
  function changePageSize(next: PageSize) {
    setPageSizeState(next);
    setPage(1);
    try { window.localStorage.setItem(PURCHASES_PAGE_SIZE_KEY, String(next)); } catch { /* remembering is a convenience, never required */ }
  }

  async function load() {
    const response = await fetch("/api/purchases");
    if (response.ok) { setRows(await response.json()); setError(""); } else setError("Connect Supabase to view purchases.");
  }
  useEffect(() => { load(); }, []);
  // If a refresh (or a bulk delete) leaves a selected id no longer present
  // in `rows`, drop it from the selection rather than holding onto a stale id.
  useEffect(() => {
    setSelectedIds(current => pruneMissingIds(current, new Set(rows.map(row => row.id))));
  }, [rows]);

  async function remove(id: string) {
    const response = await fetch(`/api/purchases?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setConfirmation(null);
    if (response.ok) load(); else setError("Could not delete purchase.");
  }
  async function clearAll() {
    const response = await fetch("/api/purchases?clear=all", { method: "DELETE" });
    setConfirmation(null);
    if (response.ok) { setEditing(undefined); setOpen(false); load(); } else setError("Could not clear purchases.");
  }
  // Updates the one row in place — never refetches the whole table, so
  // toggling arrival on a large list stays instant and doesn't disturb sort
  // position, page, or scroll.
  async function toggleArrived(id: string, next: boolean) {
    try {
      const response = await fetch(`/api/purchases?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arrived: next }),
      });
      if (!response.ok) return false;
      setRows(current => current.map(row => row.id === id ? { ...row, arrived: next } : row));
      return true;
    } catch { return false; }
  }
  // Mirrors toggleArrived exactly — updates the one row in place via PATCH,
  // never a full page reload. Stock status and arrival stay fully independent:
  // this never reads or writes `arrived`, and toggleArrived above never
  // reads or writes `stock_status`. Only shows the bottom-right confirmation
  // on a genuine success — a failure surfaces via the toggle's own inline
  // error state instead (see StockStatusToggle), never a fabricated toast.
  async function toggleStockStatus(id: string, next: StockStatus) {
    try {
      const response = await fetch(`/api/purchases?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stock_status: next }),
      });
      if (!response.ok) return false;
      const changed = rows.find(row => row.id === id);
      setRows(current => current.map(row => row.id === id ? { ...row, stock_status: next } : row));
      setStockToast(stockStatusChangedMessage(changed?.item_description, next));
      return true;
    } catch { return false; }
  }
  // Pipeline order: all purchases -> stock filter -> search -> sort ->
  // pagination (below). `filteredRows` is the final stock+search result —
  // the SAME collection every downstream consumer (row count, sort,
  // pagination, "N matching rows") reads, so none of them can ever
  // disagree about which rows currently qualify.
  const stockFilteredRows = useMemo(() => rows.filter(row => matchesStockFilter(row, stockFilter)), [rows, stockFilter]);
  const searchTerms = useMemo(() => normalizeSearchTerms(query), [query]);
  // The expensive per-row step (building each row's searchable text) is
  // memoised on stockFilteredRows alone, so it is recomputed only when the
  // underlying rows or the active stock filter change — never on every
  // keystroke. The actual per-keystroke work (searchTerms below) is just a
  // cheap `.includes()` scan over these already-built strings.
  const searchIndex = useMemo(
    () => stockFilteredRows.map(row => ({ row, searchText: buildPurchaseSearchText(row) })),
    [stockFilteredRows],
  );
  const filteredRows = useMemo(
    () => searchTerms.length === 0
      ? stockFilteredRows
      : searchIndex.filter(entry => matchesPurchaseSearchText(entry.searchText, searchTerms)).map(entry => entry.row),
    [stockFilteredRows, searchIndex, searchTerms],
  );
  const sortedRows = useMemo(() => [...filteredRows].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    const result = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    return sort.direction === "asc" ? result : -result;
  }), [filteredRows, sort]);
  const totalPages = totalPagesFor(sortedRows.length, pageSize);
  const pageRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(current => Math.min(current, totalPages)); }, [totalPages]);
  // Shift-click ranges and "select all" are always resolved against this
  // exact visible-page id list — the same order the user sees, after
  // search/filter/sort/pagination — never against every purchase.
  const pageIds = useMemo(() => pageRows.map(row => row.id), [pageRows]);
  const selection = useMemo(() => selectionSummary(selectedIds, pageIds), [selectedIds, pageIds]);
  const selectAllRef = useRef<HTMLInputElement>(null);
  // No declarative HTML attribute for the indeterminate checkbox state — it's
  // only exposed as a DOM property, set imperatively (mirrors the same
  // pattern in components/listings-review/ListingsTable.tsx).
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selection.someSelected; }, [selection.someSelected]);

  function changeSort(key: SortKey) {
    setSort(current => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
    setPage(1);
  }

  function toggleRowSelected(id: string) {
    setSelectedIds(current => toggleId(current, id));
    setRangeAnchor(id);
  }
  function toggleSelectAllVisible() {
    setSelectedIds(current => toggleVisiblePage(current, pageIds));
  }
  function clearSelection() {
    setSelectedIds(new Set());
    setRangeAnchor(null);
  }
  // Priority order: Shift+click always ranges (never clears); a plain click
  // clears the whole selection if anything is selected; only with nothing
  // selected does a plain click open the purchase. See resolveRowClick.
  function handleRowClick(event: React.MouseEvent, row: Purchase) {
    const action = resolveRowClick({ shiftKey: event.shiftKey, hasSelection: selectedIds.size > 0, pageIds, anchorId: rangeAnchor, targetId: row.id });
    if (action.type === "range") { setSelectedIds(current => { const next = new Set(current); for (const id of action.ids) next.add(id); return next; }); return; }
    if (action.type === "select-single") { setSelectedIds(current => { const next = new Set(current); next.add(action.id); return next; }); setRangeAnchor(action.id); return; }
    if (action.type === "clear") { clearSelection(); return; }
    router.push(`/purchases/${row.id}`);
  }
  async function bulkDeleteSelected() {
    if (bulkDeleting) return;
    setBulkDeleting(true);
    setBulkDeleteError("");
    try {
      const ids = Array.from(selectedIds);
      const response = await fetch("/api/purchases/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!response.ok) { setBulkDeleteError("Could not delete the selected purchases. Try again."); setBulkDeleting(false); return; }
      const { deletedIds } = await response.json() as { deletedIds: string[] };
      const deleted = new Set<string>(deletedIds);
      setSelectedIds(current => { const next = new Set(current); for (const id of deleted) next.delete(id); return next; });
      setRangeAnchor(current => (current && deleted.has(current) ? null : current));
      setBulkDeleteConfirmOpen(false);
      setBulkDeleting(false);
      load();
    } catch {
      setBulkDeleteError("Could not delete the selected purchases. Try again.");
      setBulkDeleting(false);
    }
  }

  // Patches the affected rows in place for an instant filter/search update,
  // then still revalidates from the database in the background — the same
  // "existing pattern" import flows use (see onImported/load above) — so
  // this stays correct even if something else changed the data meanwhile.
  function applyBulkArrivals(updatedIds: string[]) {
    if (updatedIds.length) {
      const updated = new Set(updatedIds);
      setRows(current => current.map(row => updated.has(row.id) ? { ...row, arrived: true } : row));
    }
    load();
  }

  const hasActiveSearch = searchTerms.length > 0;
  const matchingRowsLabel = filteredRows.length === 1 ? "1 matching row" : `${filteredRows.length.toLocaleString("en-GB")} matching rows`;

  return <section className="page-shell">
    <header className="purchase-topbar">
      <div className="title-row"><h1>Purchases</h1><span className="record-count">{rows.length.toLocaleString("en-GB")}</span></div>
      <div className="purchase-topbar-actions">
        <button type="button" className="button-secondary" onClick={() => setImportOpen(true)}>Import spreadsheet</button>
        <button type="button" className="button-secondary" onClick={() => setBulkArrivalsOpen(true)}>Bulk mark arrivals</button>
        {selectedIds.size > 0 && <button type="button" className="button-danger" onClick={() => setBulkDeleteConfirmOpen(true)}>Delete {selectedIds.size} selected</button>}
        <button className={`button page-action purchase-toggle ${open && !editing ? "purchase-toggle-close" : ""}`} onClick={() => { if (open && !editing) setOpen(false); else { setEditing(undefined); setOpen(true); } }}>
          <span className="purchase-toggle-icon" aria-hidden="true">{open && !editing ? "×" : "+"}</span>
          <span className="purchase-toggle-label">{open && !editing ? "Close form" : "Add purchase"}</span>
        </button>
      </div>
    </header>

    {open && <div className="form-region"><PurchaseForm key={editing?.id ?? "new"} purchase={editing} onCancel={() => { setEditing(undefined); setOpen(false); }} onSaved={() => {
      const wasCreate = editing === undefined;
      setEditing(undefined); setOpen(false); load();
      if (wasCreate) setAddedToast(true);
    }} /></div>}

    <div className="data-panel">
      <div className="grid-toolbar">
        <div><strong>{filteredRows.length.toLocaleString("en-GB")} rows</strong><span>Page {Math.min(page, totalPages)} of {totalPages}</span></div>
        <div className="period-switch stock-filter-switch" role="group" aria-label="Filter by stock status">
          {stockFilters.map(option => <button key={option.value} type="button" className={stockFilter === option.value ? "period-active" : ""} onClick={() => changeStockFilter(option.value)}>{option.label}</button>)}
        </div>
        <div className="grid-toolbar-actions">
          {selectedIds.size > 0 && <span className="selection-hint">Shift-click rows to select a range</span>}
          {selectedIds.size > 0 && <button type="button" className="button-secondary" onClick={clearSelection}>Clear selection</button>}
          {rows.length > 0 && <button className="button-danger" onClick={() => setConfirmation({ type: "all" })}>Clear all</button>}
        </div>
      </div>
      <div className="purchase-search-row">
        <div className="app-global-search purchase-search-box">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4.5 4.5" /></svg>
          <input
            type="search"
            value={query}
            onChange={event => changeQuery(event.target.value)}
            onKeyDown={event => { if (event.key === "Escape" && query) { event.stopPropagation(); changeQuery(""); } }}
            placeholder="Search purchases"
            aria-label="Search purchases"
            autoComplete="off"
          />
          {query && <button type="button" onClick={() => changeQuery("")} aria-label="Clear purchase search">×</button>}
        </div>
        {hasActiveSearch && <span className="purchase-search-count" role="status">{matchingRowsLabel}</span>}
      </div>
      <div className="table-scroll purchase-grid-scroll"><table className="purchase-grid"><thead><tr>
        <th className="purchase-checkbox-cell"><input ref={selectAllRef} type="checkbox" aria-label={selection.someSelected ? `${selection.selectedCount} of ${pageRows.length} purchases on this page selected` : "Select all purchases on this page"} checked={selection.allSelected} onChange={toggleSelectAllVisible} /></th>
        {columns.map(column => <th key={column.key}><button type="button" onClick={() => changeSort(column.key)}><span>{column.label}</span><i className={sort.key === column.key ? "sort-active" : ""}>{sort.key === column.key ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</i></button></th>)}
      </tr></thead>
        <tbody>{pageRows.length ? pageRows.map(row => <tr key={row.id} tabIndex={0} className={selectedIds.has(row.id) ? "purchase-row-selected" : undefined} onClick={event => handleRowClick(event, row)} onKeyDown={event => { if (event.key === "Enter") router.push(`/purchases/${row.id}`); }}>
          <td className="purchase-checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${row.item_description || "this purchase"} (SKU ${row.sku || "none"}, ${row.order_date})`} checked={selectedIds.has(row.id)} onChange={() => toggleRowSelected(row.id)} /></td>
          <td>{row.order_date}</td>
          <td>{row.seller_name || "—"}</td>
          <td className="description-cell">{row.item_description}</td>
          <td>{row.item_size}</td>
          <td className="numeric-cell">{Number(row.price_purchased).toFixed(2)}</td>
          <td><span className="sku-pill">{row.sku}</span></td>
          <td><ArrivalToggle id={row.id} arrived={row.arrived} description={row.item_description} onToggle={toggleArrived} /></td>
          <td><StockStatusToggle id={row.id} stockStatus={row.stock_status} description={row.item_description} onToggle={toggleStockStatus} /></td>
          <td><div className="platform-cell"><span>{row.purchased_from}</span><div className="cell-actions"><button onClick={event => { event.stopPropagation(); setEditing(row); setOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button><button onClick={event => { event.stopPropagation(); setConfirmation({ type: "one", id: row.id }); }}>Delete</button></div></div></td>
        </tr>) : hasActiveSearch ? <tr className="grid-empty-row"><td colSpan={10}><div><strong>No matching purchases</strong><span>No purchases match your search. Try different search terms, or clear the search to see all purchases in this view.</span><button onClick={() => changeQuery("")}>Clear search</button></div></td></tr> : <tr className="grid-empty-row"><td colSpan={10}><div><strong>{rows.length === 0 ? "No purchases yet." : "No purchases match this filter."}</strong><span>{error || (rows.length === 0 ? "Click Add purchase to add your first item." : "Try a different stock filter.")}</span>{rows.length === 0 && <button onClick={() => setOpen(true)}>Add purchase</button>}</div></td></tr>}</tbody>
      </table></div>
      <div className="pagination-bar">
        <span>{sortedRows.length ? `${((page - 1) * pageSize + 1).toLocaleString("en-GB")}–${Math.min(page * pageSize, sortedRows.length).toLocaleString("en-GB")} of ${sortedRows.length.toLocaleString("en-GB")}` : "0 rows"}</span>
        <div className="pagination-bar-controls">
          <PageSizeSelect value={pageSize} onChange={changePageSize} />
          <div className="pagination-buttons">
            <button disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>← Previous</button>
            <button disabled={page >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>Next →</button>
          </div>
        </div>
      </div>
    </div>
    {confirmation && <ConfirmDialog title={confirmation.type === "all" ? "Clear all purchases?" : "Delete this purchase?"} message={confirmation.type === "all" ? `This will permanently remove all ${rows.length.toLocaleString("en-GB")} saved purchase records. This cannot be undone.` : "This purchase will be permanently removed from your history. This cannot be undone."} confirmLabel={confirmation.type === "all" ? "Clear all purchases" : "Delete purchase"} onCancel={() => setConfirmation(null)} onConfirm={() => confirmation.type === "all" ? clearAll() : remove(confirmation.id!)} />}
    {bulkDeleteConfirmOpen && <ConfirmDialog
      title={`Delete ${selectedIds.size} purchase${selectedIds.size === 1 ? "" : "s"}?`}
      message="The selected purchase records will be permanently removed. This cannot be undone."
      confirmLabel={`Delete ${selectedIds.size} purchase${selectedIds.size === 1 ? "" : "s"}`}
      confirming={bulkDeleting}
      confirmingLabel="Deleting…"
      error={bulkDeleteError}
      onCancel={() => { if (!bulkDeleting) { setBulkDeleteConfirmOpen(false); setBulkDeleteError(""); } }}
      onConfirm={bulkDeleteSelected}
    />}
    {importOpen && <PurchaseImportDialog onClose={() => setImportOpen(false)} onImported={load} />}
    {bulkArrivalsOpen && <BulkArrivalsDialog onClose={() => setBulkArrivalsOpen(false)} onApplied={applyBulkArrivals} />}
    {addedToast && <TaskToast message={purchaseAddedMessage()} onDismiss={() => setAddedToast(false)} />}
    {stockToast && <TaskToast message={stockToast} onDismiss={() => setStockToast(null)} position="bottom-right" />}
  </section>;
}
