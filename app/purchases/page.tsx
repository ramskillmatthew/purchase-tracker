"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PurchaseForm from "@/components/PurchaseForm";
import ConfirmDialog from "@/components/ConfirmDialog";
import type { Purchase } from "@/lib/types";

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

export default function PurchasesPage() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Purchase | undefined>();
  const [rows, setRows] = useState<Purchase[]>([]);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "order_date", direction: "desc" });
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [confirmation, setConfirmation] = useState<{ type: "one" | "all"; id?: string } | null>(null);

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
  const sortedRows = useMemo(() => [...rows].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    const result = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    return sort.direction === "asc" ? result : -result;
  }), [rows, sort]);
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const pageRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(current => Math.min(current, totalPages)); }, [totalPages]);

  function changeSort(key: SortKey) {
    setSort(current => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
    setPage(1);
  }

  return <section className="page-shell">
    <header className="purchase-topbar">
      <div className="title-row"><h1>Purchases</h1><span className="record-count">{rows.length}</span></div>
      <button className={`button page-action purchase-toggle ${open && !editing ? "purchase-toggle-close" : ""}`} onClick={() => { if (open && !editing) setOpen(false); else { setEditing(undefined); setOpen(true); } }}>
        <span className="purchase-toggle-icon" aria-hidden="true">{open && !editing ? "×" : "+"}</span>
        <span className="purchase-toggle-label">{open && !editing ? "Close form" : "Add purchase"}</span>
      </button>
    </header>

    {open && <div className="form-region"><PurchaseForm key={editing?.id ?? "new"} purchase={editing} onCancel={() => { setEditing(undefined); setOpen(false); }} onSaved={() => { setEditing(undefined); setOpen(false); load(); }} /></div>}

    <div className="data-panel">
      <div className="grid-toolbar">
        <div><strong>{rows.length} rows</strong><span>Page {Math.min(page, totalPages)} of {totalPages}</span></div>
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
          <td><span className={row.arrived === null ? "status-cell status-blank" : row.arrived ? "status-cell status-yes" : "status-cell status-no"}>{row.arrived === null ? "—" : row.arrived ? "Yes" : "No"}</span></td>
          <td><div className="platform-cell"><span>{row.purchased_from}</span><div className="cell-actions"><button onClick={event => { event.stopPropagation(); setEditing(row); setOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button><button onClick={event => { event.stopPropagation(); setConfirmation({ type: "one", id: row.id }); }}>Delete</button></div></div></td>
        </tr>) : <tr className="grid-empty-row"><td colSpan={8}><div><strong>No purchases yet.</strong><span>{error || "Click Add purchase to add your first item."}</span><button onClick={() => setOpen(true)}>Add purchase</button></div></td></tr>}</tbody>
      </table></div>
      <div className="pagination-bar"><span>{sortedRows.length ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, sortedRows.length)} of ${sortedRows.length}` : "0 rows"}</span><div><button disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>← Previous</button><button disabled={page >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>Next →</button></div></div>
    </div>
    {confirmation && <ConfirmDialog title={confirmation.type === "all" ? "Clear all purchases?" : "Delete this purchase?"} message={confirmation.type === "all" ? `This will permanently remove all ${rows.length} saved purchase records. This cannot be undone.` : "This purchase will be permanently removed from your history. This cannot be undone."} confirmLabel={confirmation.type === "all" ? "Clear all purchases" : "Delete purchase"} onCancel={() => setConfirmation(null)} onConfirm={() => confirmation.type === "all" ? clearAll() : remove(confirmation.id!)} />}
  </section>;
}
