"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PurchaseForm from "@/components/PurchaseForm";
import ConfirmDialog from "@/components/ConfirmDialog";
import PurchaseImportDialog from "@/components/PurchaseImportDialog";
import BulkArrivalsDialog from "@/components/BulkArrivalsDialog";
import TaskToast from "@/components/TaskToast";
import PageSizeSelect from "@/components/PageSizeSelect";
import ArrivalToggle from "@/components/ArrivalToggle";
import { purchaseAddedMessage } from "@/lib/success-messages";
import { DEFAULT_PAGE_SIZE, parseStoredPageSize, totalPagesFor, type PageSize } from "@/lib/pagination";
import { arrivalFilters, matchesArrivalFilter, parseArrivalFilter, type ArrivalFilter } from "@/lib/purchases";
import type { Purchase } from "@/lib/types";

const PURCHASES_PAGE_SIZE_KEY = "trotters:purchases-page-size";

type SortKey = "order_date" | "seller_name" | "item_description" | "item_size" | "price_purchased" | "sku" | "arrived" | "purchased_from";

const columns: { label: string; key: SortKey }[] = [
  { label: "Order Date", key: "order_date" },
  { label: "Seller", key: "seller_name" },
  { label: "Description", key: "item_description" },
  { label: "Size", key: "item_size" },
  { label: "Price", key: "price_purchased" },
  { label: "SKU", key: "sku" },
  { label: "Arrived", key: "arrived" },
  { label: "Platform", key: "purchased_from" },
];

// Wrapped in Suspense because it reads useSearchParams (the Home page's
// "Awaiting arrival" card links here with ?arrived=not-arrived) — Next.js
// requires that to avoid de-opting the whole route from static prerendering.
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
  const [arrivalFilter, setArrivalFilter] = useState<ArrivalFilter>(() => parseArrivalFilter(searchParams.get("arrived")));
  const [confirmation, setConfirmation] = useState<{ type: "one" | "all"; id?: string } | null>(null);
  const [addedToast, setAddedToast] = useState(false);

  function changeArrivalFilter(next: ArrivalFilter) {
    setArrivalFilter(next);
    setPage(1);
  }

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
  const filteredRows = useMemo(() => rows.filter(row => matchesArrivalFilter(row, arrivalFilter)), [rows, arrivalFilter]);
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

  function changeSort(key: SortKey) {
    setSort(current => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
    setPage(1);
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

  return <section className="page-shell">
    <header className="purchase-topbar">
      <div className="title-row"><h1>Purchases</h1><span className="record-count">{rows.length.toLocaleString("en-GB")}</span></div>
      <div className="purchase-topbar-actions">
        <button type="button" className="button-secondary" onClick={() => setImportOpen(true)}>Import spreadsheet</button>
        <button type="button" className="button-secondary" onClick={() => setBulkArrivalsOpen(true)}>Bulk mark arrivals</button>
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
        <div className="period-switch arrival-filter-switch" role="group" aria-label="Filter by arrival status">
          {arrivalFilters.map(option => <button key={option.value} type="button" className={arrivalFilter === option.value ? "period-active" : ""} onClick={() => changeArrivalFilter(option.value)}>{option.label}</button>)}
        </div>
        {rows.length > 0 && <button className="button-danger" onClick={() => setConfirmation({ type: "all" })}>Clear all</button>}
      </div>
      <div className="table-scroll purchase-grid-scroll"><table className="purchase-grid"><thead><tr>{columns.map(column => <th key={column.key}><button type="button" onClick={() => changeSort(column.key)}><span>{column.label}</span><i className={sort.key === column.key ? "sort-active" : ""}>{sort.key === column.key ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</i></button></th>)}</tr></thead>
        <tbody>{pageRows.length ? pageRows.map(row => <tr key={row.id} tabIndex={0} onClick={() => router.push(`/purchases/${row.id}`)} onKeyDown={event => { if (event.key === "Enter") router.push(`/purchases/${row.id}`); }}>
          <td>{row.order_date}</td>
          <td>{row.seller_name || "—"}</td>
          <td className="description-cell">{row.item_description}</td>
          <td>{row.item_size}</td>
          <td className="numeric-cell">{Number(row.price_purchased).toFixed(2)}</td>
          <td><span className="sku-pill">{row.sku}</span></td>
          <td><ArrivalToggle id={row.id} arrived={row.arrived} description={row.item_description} onToggle={toggleArrived} /></td>
          <td><div className="platform-cell"><span>{row.purchased_from}</span><div className="cell-actions"><button onClick={event => { event.stopPropagation(); setEditing(row); setOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button><button onClick={event => { event.stopPropagation(); setConfirmation({ type: "one", id: row.id }); }}>Delete</button></div></div></td>
        </tr>) : <tr className="grid-empty-row"><td colSpan={8}><div><strong>{rows.length === 0 ? "No purchases yet." : "No purchases match this filter."}</strong><span>{error || (rows.length === 0 ? "Click Add purchase to add your first item." : "Try a different arrival filter.")}</span>{rows.length === 0 && <button onClick={() => setOpen(true)}>Add purchase</button>}</div></td></tr>}</tbody>
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
    {importOpen && <PurchaseImportDialog onClose={() => setImportOpen(false)} onImported={load} />}
    {bulkArrivalsOpen && <BulkArrivalsDialog onClose={() => setBulkArrivalsOpen(false)} onApplied={applyBulkArrivals} />}
    {addedToast && <TaskToast message={purchaseAddedMessage()} onDismiss={() => setAddedToast(false)} />}
  </section>;
}
