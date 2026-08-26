"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CancelSalesResult, SalesOrderListItem, SalesPlatform, SalesProcessStatus } from "@/lib/types";
import { formatPenceAsGBP, poundsToPence } from "@/lib/sales/money";
import { summariseItemGroups } from "@/lib/sales/order-summary";
import { salesStatusFilters, type SalesStatusFilter } from "@/lib/sales/status-filter";
import { pruneMissingIds, resolveRowClick, selectionSummary, toggleId, toggleVisiblePage } from "@/lib/purchases-selection";
import { salesCancelledMessage } from "@/lib/success-messages";
import { dateRangePresets, describeDateRange, resolveDateFilter, type DateRangePreset } from "@/lib/sales/report-date-range";
import { orderMargin, type HistoryDirection, type HistorySort, type SalesHistoryResponse } from "@/lib/sales/history";
import { SALES_PROCESS_STATUS_OPTIONS, salesProcessPresentation } from "@/lib/sales/process-status";
import CancelSalesDialog from "@/components/sales/CancelSalesDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import TaskToast from "@/components/TaskToast";
import styles from "./sales.module.css";

const PLATFORM_LABELS: Record<SalesPlatform, string> = { vinted: "Vinted", ebay: "eBay", depop: "Depop", other: "Other" };
const CATEGORIES = [{ value: "", label: "All categories" }, { value: "pokemon", label: "Pokémon" }, { value: "non-pokemon-tcg", label: "Non-Pokémon TCG" }, { value: "clothing", label: "Clothing" }, { value: "footwear", label: "Footwear" }, { value: "other", label: "Other" }];
type Filters = { status: SalesStatusFilter; preset: DateRangePreset; start: string; end: string; platform: string; category: string; search: string; page: number; pageSize: number; sort: HistorySort; direction: HistoryDirection };
const DEFAULTS: Filters = { status: "completed", preset: "all-time", start: "", end: "", platform: "", category: "", search: "", page: 1, pageSize: 10, sort: "date", direction: "desc" };

function readFilters(): Filters {
  if (typeof window === "undefined") return DEFAULTS;
  const p = new URLSearchParams(window.location.search);
  return { ...DEFAULTS, status: (p.get("status") as SalesStatusFilter) || DEFAULTS.status, preset: (p.get("preset") as DateRangePreset) || DEFAULTS.preset, start: p.get("start") || "", end: p.get("end") || "", platform: p.get("platform") || "", category: p.get("category") || "", search: p.get("search") || "", page: Number(p.get("page")) || 1, pageSize: Number(p.get("pageSize")) || 10, sort: (p.get("sort") as HistorySort) || "date", direction: p.get("direction") === "asc" ? "asc" : "desc" };
}

function platformLabel(order: SalesOrderListItem) { return order.platform === "other" && order.custom_platform_name ? order.custom_platform_name : PLATFORM_LABELS[order.platform]; }
function ukDate(iso: string) { const [y, m, d] = iso.split("-"); return y && m && d ? `${d}/${m}/${y}` : iso; }
function relativeTime(iso: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : ukDate(iso.slice(0, 10)); }
function pageItems(page: number, total: number): (number | "ellipsis")[] { if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1); const sorted = [...new Set([1, total, page - 1, page, page + 1])].filter(v => v > 0 && v <= total).sort((a, b) => a - b); const result: (number | "ellipsis")[] = []; sorted.forEach((value, i) => { if (i && value - sorted[i - 1] > 1) result.push("ellipsis"); result.push(value); }); return result; }

export default function SalesPage() {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [searchDraft, setSearchDraft] = useState("");
  const [data, setData] = useState<SalesHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [statusSavingId, setStatusSavingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [terminalTransition, setTerminalTransition] = useState<{ ids: string[]; status: "cancelled" | "returned_cancelled" } | null>(null);
  const [bulkStatusSaving, setBulkStatusSaving] = useState(false);
  const [submittingAction, setSubmittingAction] = useState<"return" | "keep" | null>(null);
  const [cancelError, setCancelError] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingCancelled, setDeletingCancelled] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteAfterCancellation, setDeleteAfterCancellation] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const initial = readFilters(); setFilters(initial); setSearchDraft(initial.search); const pop = () => { const next = readFilters(); setFilters(next); setSearchDraft(next.search); }; addEventListener("popstate", pop); return () => removeEventListener("popstate", pop); }, []);
  const update = useCallback((change: Partial<Filters>, replace = false) => { const next = { ...filters, ...change }; if (!("page" in change)) next.page = 1; const params = new URLSearchParams(); Object.entries(next).forEach(([key, value]) => { if (value !== "" && value !== DEFAULTS[key as keyof Filters]) params.set(key, String(value)); }); const url = `${location.pathname}${params.size ? `?${params}` : ""}`; setFilters(next); window.history[replace ? "replaceState" : "pushState"](null, "", url); }, [filters]);
  useEffect(() => { const timer = setTimeout(() => { if (searchDraft !== filters.search) update({ search: searchDraft }, true); }, 300); return () => clearTimeout(timer); }, [searchDraft, filters.search, update]);
  const load = useCallback(async (signal?: AbortSignal) => { setError(""); setLoading(true); try { const p = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)])); const response = await fetch(`/api/sales?${p}`, { signal }); const body = await response.json().catch(() => null); if (!response.ok) throw new Error(body?.error || "Could not load sales."); setData(body); if (body.page !== filters.page) update({ page: body.page }, true); } catch (err) { if ((err as Error).name !== "AbortError") setError((err as Error).message); } finally { if (!signal?.aborted) setLoading(false); } }, [filters, update]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, reloadKey]);

  const selectableIds = useMemo(() => (data?.rows ?? []).map(row => row.id), [data]);
  const selection = useMemo(() => selectionSummary(selectedIds, selectableIds), [selectedIds, selectableIds]);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selection.someSelected; }, [selection.someSelected]);
  useEffect(() => { setSelectedIds(current => pruneMissingIds(current, new Set(selectableIds))); setRangeAnchor(null); }, [selectableIds]);
  const clearSelection = () => { setSelectedIds(new Set()); setRangeAnchor(null); };
  const selectedOrders = useMemo(() => (data?.rows ?? []).filter(row => selectedIds.has(row.id)), [data, selectedIds]);
  const activeSelectedOrders = useMemo(() => selectedOrders.filter(order => order.status === "completed"), [selectedOrders]);

  function rowClick(event: React.MouseEvent, order: SalesOrderListItem) {
    if (!selectableIds.includes(order.id)) { if (!event.shiftKey && selectedIds.size === 0) router.push(`/sales/${order.id}`); else if (!event.shiftKey) clearSelection(); return; }
    const action = resolveRowClick({ shiftKey: event.shiftKey, hasSelection: selectedIds.size > 0, pageIds: selectableIds, anchorId: rangeAnchor, targetId: order.id });
    if (action.type === "range") setSelectedIds(current => new Set([...current, ...action.ids]));
    else if (action.type === "select-single") { setSelectedIds(current => new Set(current).add(action.id)); setRangeAnchor(action.id); }
    else if (action.type === "clear") clearSelection();
    else router.push(`/sales/${order.id}`);
  }

  async function persistProcessStatus(order: SalesOrderListItem, processStatus: SalesProcessStatus) {
    if (statusSavingId) return;
    setStatusError("");
    if ((processStatus === "cancelled" || processStatus === "returned_cancelled") && order.status === "completed") {
      setSelectedIds(new Set([order.id])); setTerminalTransition({ ids: [order.id], status: processStatus }); setCancelDialogOpen(true); return;
    }
    setStatusSavingId(order.id);
    try {
      const response = await fetch(`/api/sales/${order.id}/process-status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processStatus }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not update the sales process status.");
      setData(current => current ? { ...current, rows: current.rows.map(row => row.id === order.id ? { ...row, process_status: processStatus } : row), recentActivity: current.recentActivity.map(row => row.id === order.id ? { ...row, process_status: processStatus } : row) } : current);
    } catch (err) { setStatusError((err as Error).message); }
    finally { setStatusSavingId(null); }
  }

  async function persistBulkProcessStatus(processStatus: SalesProcessStatus) {
    if (bulkStatusSaving || selectedOrders.length === 0) return;
    setStatusError("");
    if (processStatus === "cancelled" || processStatus === "returned_cancelled") {
      const activeIds = activeSelectedOrders.map(order => order.id);
      if (activeIds.length > 0) {
        setDeleteAfterCancellation(false);
        setTerminalTransition({ ids: selectedOrders.map(order => order.id), status: processStatus });
        setCancelDialogOpen(true);
        return;
      }
    }
    setBulkStatusSaving(true);
    try {
      const results = await Promise.all(selectedOrders.map(async order => {
        const response = await fetch(`/api/sales/${order.id}/process-status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processStatus }) });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "Could not update one of the selected sales.");
        return order.id;
      }));
      const changedIds = new Set(results);
      setData(current => current ? { ...current, rows: current.rows.map(row => changedIds.has(row.id) ? { ...row, process_status: processStatus } : row), recentActivity: current.recentActivity.map(row => changedIds.has(row.id) ? { ...row, process_status: processStatus } : row) } : current);
      setSuccessMessage(`${results.length} sale${results.length === 1 ? "" : "s"} changed to ${SALES_PROCESS_STATUS_OPTIONS.find(option => option.value === processStatus)?.label ?? "the selected status"}.`);
      clearSelection();
      setReloadKey(key => key + 1);
    } catch (err) {
      setStatusError(`${(err as Error).message} Refresh before retrying so the latest statuses are shown.`);
      setReloadKey(key => key + 1);
    } finally { setBulkStatusSaving(false); }
  }

  async function cancelSelected(returnToStock: boolean) {
    if (submittingAction) return;
    setSubmittingAction(returnToStock ? "return" : "keep"); setCancelError(""); setStatusError("");
    try {
      const idsToCancel = deleteAfterCancellation || terminalTransition ? activeSelectedOrders.map(order => order.id) : [...selectedIds];
      const response = await fetch("/api/sales/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ salesOrderIds: idsToCancel, returnToStock }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not cancel the selected sales.");
      const result = body as CancelSalesResult;
      let processWarning = "";
      if (terminalTransition) {
        const processResults = await Promise.all(terminalTransition.ids.map(async id => {
          const processResponse = await fetch(`/api/sales/${id}/process-status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processStatus: terminalTransition.status }) });
          const processBody = await processResponse.json().catch(() => null);
          return processResponse.ok ? "" : processBody?.error || "A cancelled sale's process label could not be saved.";
        }));
        processWarning = processResults.find(Boolean) || "";
      }
      if (deleteAfterCancellation) {
        const deleteResponse = await fetch("/api/sales/delete", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ salesOrderIds: [...selectedIds] }) });
        const deleteBody = await deleteResponse.json().catch(() => null);
        if (!deleteResponse.ok) throw new Error(deleteBody?.error || "The sales were cancelled, but could not be permanently deleted.");
        const deleted = Number(deleteBody?.deleted) || selectedIds.size;
        setSuccessMessage(`${deleted} sale record${deleted === 1 ? "" : "s"} permanently deleted.`);
      } else {
        setSuccessMessage(salesCancelledMessage(result.ordersCancelled, result.unitsAffected, returnToStock));
      }
      if (processWarning) setStatusError(processWarning);
      setCancelDialogOpen(false); setTerminalTransition(null); setDeleteAfterCancellation(false); clearSelection(); setReloadKey(key => key + 1);
    } catch (err) { setCancelError((err as Error).message); }
    finally { setSubmittingAction(null); }
  }

  async function permanentlyDeleteCancelled() {
    if (deletingCancelled) return;
    setDeletingCancelled(true); setDeleteError("");
    try {
      const response = await fetch("/api/sales/delete", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ salesOrderIds: [...selectedIds] }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Could not permanently delete the cancelled sales.");
      const count = Number(body?.deleted) || selectedIds.size;
      setDeleteDialogOpen(false); clearSelection(); setReloadKey(key => key + 1);
      setSuccessMessage(`${count} sale record${count === 1 ? "" : "s"} permanently deleted.`);
    } catch (error) { setDeleteError((error as Error).message); }
    finally { setDeletingCancelled(false); }
  }

  function sortBy(sort: HistorySort) { update({ sort, direction: filters.sort === sort && filters.direction === "desc" ? "asc" : "desc" }); }
  const range = resolveDateFilter({ preset: filters.preset, customStart: filters.start, customEnd: filters.end });
  const hasFilters = filters.status !== DEFAULTS.status || filters.preset !== DEFAULTS.preset || !!filters.platform || !!filters.category || !!filters.search;
  const reset = () => { setSearchDraft(""); update(DEFAULTS); historyRef.current?.focus(); };

  return <section className={`page-shell ${styles.salesPage}`}>
    <header className={styles.topbar}><div className="title-row"><h1>Sales</h1>{data && <span className="record-count">{data.total.toLocaleString("en-GB")}</span>}</div><div className={styles.topbarActions}><button className="button-secondary" onClick={() => router.push("/sales/reports")}>Reports</button><button className="button-secondary" onClick={() => router.push("/sales/bulk")}>Bulk Sales</button><button className="button-secondary" onClick={() => router.push("/sales/new?mode=order")}>Order Sale</button><button className="button" onClick={() => router.push("/sales/new?mode=quick")}>Quick Sale</button></div></header>
    <KpiStrip data={data} status={filters.status} />
    <div className={styles.dashboardGrid}>
      <main className={styles.mainColumn}>
        <div className={styles.filterToolbar}>
          <div className={styles.statusFilterSwitch} role="group" aria-label="Filter sales by financial status">{salesStatusFilters.map(option => <button key={option.value} aria-pressed={filters.status === option.value} className={filters.status === option.value ? styles.statusFilterActive : ""} onClick={() => update({ status: option.value })}>{option.label}</button>)}</div>
          <Select label="Date range" value={filters.preset} onChange={value => update({ preset: value as DateRangePreset })}>{dateRangePresets.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          <Select label="Platform" value={filters.platform} onChange={value => update({ platform: value })}><option value="">All platforms</option>{data?.platforms.map(platform => <option value={platform.toLowerCase()} key={platform}>{PLATFORM_LABELS[platform as SalesPlatform] ?? platform}</option>)}</Select>
          <Select label="Category" value={filters.category} onChange={value => update({ category: value })}>{CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
          <label className={styles.searchBox}><span aria-hidden="true">⌕</span><input type="search" value={searchDraft} onChange={e => setSearchDraft(e.target.value)} placeholder="Search sales" aria-label="Search item, platform or status" /></label>
          {hasFilters && <button className={styles.resetButton} onClick={reset}>Reset</button>}
          <span className={styles.rangeLabel}>{range.ok ? describeDateRange(range.range) : range.error}</span>
        </div>
        {filters.preset === "custom" && <div className={styles.customRange}><label>From<input type="date" value={filters.start} onChange={e => update({ start: e.target.value })} /></label><label>To<input type="date" value={filters.end} onChange={e => update({ end: e.target.value })} /></label></div>}
        <div className={styles.dataPanel} ref={historyRef} tabIndex={-1}>
          {statusError && <div className={styles.inlineError} role="alert">{statusError}<button onClick={() => setStatusError("")} aria-label="Dismiss status error">×</button></div>}
          {selectedIds.size > 0 && <div className={`${styles.selectionBar} ${styles.selectionBarVisible}`}><input ref={selectAllRef} type="checkbox" checked={selection.allSelected} onChange={() => setSelectedIds(current => toggleVisiblePage(current, selectableIds))} aria-label="Select all visible sales" /><strong>{selectedIds.size} selected</strong><span>Shift-click to select a range</span><button className="button-secondary" onClick={clearSelection} disabled={bulkStatusSaving}>Clear</button><BulkProcessStatusMenu count={selectedIds.size} saving={bulkStatusSaving} onChange={persistBulkProcessStatus} />{activeSelectedOrders.length === selectedIds.size && <button className="button-secondary" onClick={() => { setDeleteAfterCancellation(false); setTerminalTransition(null); setCancelDialogOpen(true); }}>Cancel {selectedIds.size} selected</button>}<button className="button-danger" onClick={() => { setDeleteError(""); if (activeSelectedOrders.length > 0) { setDeleteAfterCancellation(true); setTerminalTransition(null); setCancelDialogOpen(true); } else setDeleteDialogOpen(true); }}>Permanently delete {selectedIds.size}</button></div>}
          {error ? <State title="Could not load sales" detail={error}><button className="button-secondary" onClick={() => setReloadKey(k => k + 1)}>Try again</button></State> : !data ? <div className={styles.loadingRows}>{Array.from({ length: 7 }, (_, i) => <div className={styles.skeletonRow} key={i} />)}</div> : data.total === 0 ? <State title={hasFilters ? "No sales match these filters" : "No sales recorded yet"} detail={hasFilters ? "Adjust or clear the filters to see more sales." : "Record your first sale with Quick Sale or Order Sale."}>{hasFilters ? <button className="button-secondary" onClick={reset}>Clear filters</button> : <><button className="button" onClick={() => router.push("/sales/new?mode=quick")}>Quick Sale</button><button className="button-secondary" onClick={() => router.push("/sales/new?mode=order")}>Order Sale</button></>}</State> : <div className={loading ? styles.refreshing : ""}><HistoryTable data={data} filters={filters} selection={selection} selectedIds={selectedIds} selectableIds={selectableIds} setSelectedIds={setSelectedIds} setRangeAnchor={setRangeAnchor} rowClick={rowClick} sortBy={sortBy} update={update} onStatusChange={persistProcessStatus} statusSavingId={statusSavingId} /></div>}
        </div>
      </main>
      <RecentActivity data={data} router={router} reset={reset} />
    </div>
    {cancelDialogOpen && <CancelSalesDialog orders={deleteAfterCancellation || terminalTransition ? activeSelectedOrders : selectedOrders} submittingAction={submittingAction} error={cancelError} onCancel={() => { if (!submittingAction) { setCancelDialogOpen(false); setTerminalTransition(null); setDeleteAfterCancellation(false); } }} onConfirm={cancelSelected} />}
    {deleteDialogOpen && <ConfirmDialog title={`Permanently delete ${selectedIds.size} sale${selectedIds.size === 1 ? "" : "s"}?`} message="This permanently removes the selected sale records and their saved line-item history. Any previous stock-return decision will not be reversed. This cannot be undone." confirmLabel="Permanently delete" confirmingLabel="Deleting…" confirming={deletingCancelled} error={deleteError} cancelLabel="Keep sales" onConfirm={permanentlyDeleteCancelled} onCancel={() => { if (!deletingCancelled) setDeleteDialogOpen(false); }} />}
    {successMessage && <TaskToast message={successMessage} onDismiss={() => setSuccessMessage(null)} />}
  </section>;
}

function KpiStrip({ data, status }: { data: SalesHistoryResponse | null; status: SalesStatusFilter }) {
  if (!data) return <div className={`${styles.kpiStrip} ${styles.kpiSkeleton}`} aria-label="Loading sales summaries" />;
  const profitTone = data.kpis.profitPence > 0 ? styles.profitPositive : data.kpis.profitPence < 0 ? styles.profitNegative : styles.profitNeutral;
  const salesCountLabel = status === "pending" ? "Pending sales" : status === "cancelled" ? "Cancelled sales" : status === "all" ? "All sales" : "Completed sales";
  const metrics = [[salesCountLabel, data.kpis.completedSales.toLocaleString("en-GB"), ""], ["Revenue", formatPenceAsGBP(data.kpis.revenuePence), ""], ["Net profit", formatPenceAsGBP(data.kpis.profitPence), profitTone], ["Margin", `${data.kpis.margin.toFixed(2)}%`, ""], ["Average order", formatPenceAsGBP(data.kpis.averageOrderPence), ""]];
  return <div className={styles.kpiStrip} aria-live="polite">{metrics.map(([label, value, tone]) => <div className={styles.kpiMetric} key={label}><span>{label}</span><strong className={tone}>{value}</strong></div>)}</div>;
}

function HistoryTable({ data, filters, selection, selectedIds, selectableIds, setSelectedIds, setRangeAnchor, rowClick, sortBy, update, onStatusChange, statusSavingId }: any) {
  const router = useRouter();
  return <><div className={styles.tableScroll}><table className={styles.salesTable}><thead><tr><th className={styles.checkboxCell}><input type="checkbox" checked={selection.allSelected} onChange={() => setSelectedIds((current: Set<string>) => toggleVisiblePage(current, selectableIds))} aria-label="Select all visible completed sales" /></th><SortHead label="Date" name="date" filters={filters} onSort={sortBy} /><th>Item description</th><th>Platform</th><SortHead label="Units" name="units" filters={filters} onSort={sortBy} /><SortHead label="Revenue" name="revenue" filters={filters} onSort={sortBy} numeric /><SortHead label="Profit" name="profit" filters={filters} onSort={sortBy} numeric /><SortHead label="Margin" name="margin" filters={filters} onSort={sortBy} numeric /><th>Status</th></tr></thead><tbody>{data.rows.map((order: SalesOrderListItem) => { const summary = summariseItemGroups(order.itemGroups); const selected = selectedIds.has(order.id); const profitTone = order.profitPence > 0 ? styles.profitPositive : order.profitPence < 0 ? styles.profitNegative : styles.profitNeutral; return <tr key={order.id} tabIndex={0} className={`${styles.salesRow} ${selected ? styles.rowSelected : ""}`} onClick={(e: React.MouseEvent) => rowClick(e, order)} onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" && selectedIds.size === 0) router.push(`/sales/${order.id}`); }}><td className={styles.checkboxCell} onClick={(e: React.MouseEvent) => e.stopPropagation()}>{order.status === "completed" && <input type="checkbox" checked={selected} onChange={() => { setSelectedIds((current: Set<string>) => toggleId(current, order.id)); setRangeAnchor(order.id); }} aria-label={`Select sale ${ukDate(order.sale_date)}`} />}</td><td>{ukDate(order.sale_date)}</td><td className={styles.descriptionCell} title={order.itemGroups.map(g => `${g.description} × ${g.quantity}`).join(", ")}><span>{summary.lines[0]}</span>{summary.lines.slice(1).map((line, i) => <small key={i}>{line}</small>)}{summary.overflowCount > 0 && <small>+ {summary.overflowCount} more products</small>}</td><td>{platformLabel(order)}</td><td>{order.itemCount}</td><td className={styles.numeric}>{formatPenceAsGBP(poundsToPence(Number(order.total_revenue)))}</td><td className={styles.numeric}><strong className={`${styles.profitValue} ${profitTone}`} aria-label={`Profit ${formatPenceAsGBP(order.profitPence)}`}>{formatPenceAsGBP(order.profitPence)}</strong></td><td className={styles.numeric}>{orderMargin(order).toFixed(2)}%</td><td className={styles.processCell} onClick={(e: React.MouseEvent) => e.stopPropagation()} onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}><ProcessStatusMenu order={order} saving={statusSavingId === order.id} onChange={(value: SalesProcessStatus) => onStatusChange(order, value)} /></td></tr>; })}</tbody></table></div><footer className={styles.pagination}><span>Showing {(data.page - 1) * data.pageSize + 1} to {Math.min(data.page * data.pageSize, data.total)} of {data.total.toLocaleString("en-GB")} results</span><label>Rows per page <select value={data.pageSize} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => update({ pageSize: Number(e.target.value) })}>{[10, 25, 50, 100].map(n => <option key={n}>{n}</option>)}</select></label><nav aria-label="Sales pages"><button disabled={data.page === 1} onClick={() => update({ page: data.page - 1 })} aria-label="Previous page">‹</button>{pageItems(data.page, data.totalPages).map((p, i) => p === "ellipsis" ? <span key={`e${i}`}>…</span> : <button key={p} aria-current={p === data.page ? "page" : undefined} className={p === data.page ? styles.currentPage : ""} onClick={() => update({ page: p })}>{p}</button>)}<button disabled={data.page === data.totalPages} onClick={() => update({ page: data.page + 1 })} aria-label="Next page">›</button></nav></footer></>;
}

function ProcessStatusMenu({ order, saving, onChange }: { order: SalesOrderListItem; saving: boolean; onChange: (value: SalesProcessStatus) => void }) {
  const [open, setOpen] = useState(false); const [activeIndex, setActiveIndex] = useState(0); const rootRef = useRef<HTMLDivElement>(null); const menuRef = useRef<HTMLDivElement>(null); const presentation = salesProcessPresentation(order); const currentIndex = SALES_PROCESS_STATUS_OPTIONS.findIndex(option => option.value === presentation.value);
  useEffect(() => { if (!open) return; setActiveIndex(currentIndex < 0 ? 0 : currentIndex); const focusFrame = requestAnimationFrame(() => menuRef.current?.focus()); function outside(event: MouseEvent) { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); } function escape(event: KeyboardEvent) { if (event.key === "Escape") { setOpen(false); (rootRef.current?.querySelector("button") as HTMLButtonElement | null)?.focus(); } } document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape); return () => { cancelAnimationFrame(focusFrame); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); }; }, [open, currentIndex]);
  function choose(value: SalesProcessStatus) { setOpen(false); if (value !== presentation.value) onChange(value); }
  function triggerKey(event: React.KeyboardEvent<HTMLButtonElement>) { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setActiveIndex(currentIndex < 0 ? 0 : currentIndex); } }
  function menuKey(event: React.KeyboardEvent<HTMLDivElement>) { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const delta = event.key === "ArrowDown" ? 1 : -1; setActiveIndex(index => (index + delta + SALES_PROCESS_STATUS_OPTIONS.length) % SALES_PROCESS_STATUS_OPTIONS.length); } if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); } if (event.key === "End") { event.preventDefault(); setActiveIndex(SALES_PROCESS_STATUS_OPTIONS.length - 1); } if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(SALES_PROCESS_STATUS_OPTIONS[activeIndex].value); } }
  const toneClass = styles[`processTone${presentation.tone[0].toUpperCase()}${presentation.tone.slice(1)}`];
  return <div className={styles.processMenu} ref={rootRef}><button type="button" className={`${styles.processTrigger} ${toneClass}`} aria-label={`Order process status: ${presentation.label}. Change status`} aria-haspopup="listbox" aria-expanded={open} disabled={saving} onClick={() => setOpen(value => !value)} onKeyDown={triggerKey}><i aria-hidden="true" /><span>{saving ? "Saving…" : presentation.shortLabel}</span><b aria-hidden="true">⌄</b></button>{open && <div ref={menuRef} className={styles.processDropdown} role="listbox" aria-label="Choose order process status" aria-activedescendant={`process-option-${order.id}-${activeIndex}`} tabIndex={-1} onKeyDown={menuKey}>{SALES_PROCESS_STATUS_OPTIONS.map((option, index) => <button type="button" id={`process-option-${order.id}-${index}`} role="option" aria-selected={option.value === presentation.value} className={`${styles.processOption} ${styles[`processTone${option.tone[0].toUpperCase()}${option.tone.slice(1)}`]} ${index === activeIndex ? styles.processOptionActive : ""}`} key={option.value} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option.value)}><i aria-hidden="true" /><span>{option.label}</span>{option.value === presentation.value && <b aria-hidden="true">✓</b>}</button>)}</div>}</div>;
}

function BulkProcessStatusMenu({ count, saving, onChange }: { count: number; saving: boolean; onChange: (value: SalesProcessStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menuRef.current?.focus());
    function outside(event: MouseEvent) { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); }
    function escape(event: KeyboardEvent) { if (event.key === "Escape") { setOpen(false); (rootRef.current?.querySelector("button") as HTMLButtonElement | null)?.focus(); } }
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  function choose(value: SalesProcessStatus) { setOpen(false); onChange(value); }
  function menuKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const delta = event.key === "ArrowDown" ? 1 : -1; setActiveIndex(index => (index + delta + SALES_PROCESS_STATUS_OPTIONS.length) % SALES_PROCESS_STATUS_OPTIONS.length); }
    if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
    if (event.key === "End") { event.preventDefault(); setActiveIndex(SALES_PROCESS_STATUS_OPTIONS.length - 1); }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(SALES_PROCESS_STATUS_OPTIONS[activeIndex].value); }
  }
  return <div className={styles.bulkProcessMenu} ref={rootRef}>
    <button type="button" className={styles.bulkProcessTrigger} aria-haspopup="listbox" aria-expanded={open} disabled={saving} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>{saving ? "Changing status…" : "Change status"}<i aria-hidden="true" /></button>
    {open && <div ref={menuRef} className={styles.bulkProcessDropdown} role="listbox" aria-label={`Set status for ${count} selected sales`} aria-activedescendant={`bulk-process-option-${activeIndex}`} tabIndex={-1} onKeyDown={menuKey}>
      <strong>Set status for {count} selected sale{count === 1 ? "" : "s"}</strong>
      {SALES_PROCESS_STATUS_OPTIONS.map((option, index) => <button type="button" id={`bulk-process-option-${index}`} role="option" aria-selected={index === activeIndex} className={`${styles.bulkProcessOption} ${styles[`processTone${option.tone[0].toUpperCase()}${option.tone.slice(1)}`]} ${index === activeIndex ? styles.bulkProcessOptionActive : ""}`} key={option.value} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option.value)}><i aria-hidden="true" /><span>{option.label}</span></button>)}
      <small>Cancellation statuses will ask what should happen to stock.</small>
    </div>}
  </div>;
}

function RecentActivity({ data, router, reset }: { data: SalesHistoryResponse | null; router: ReturnType<typeof useRouter>; reset: () => void }) {
  return <aside className={styles.rightRail}><section className={styles.railCard}><header><h2>Recent Activity</h2><button onClick={reset}>View all</button></header>{!data ? <div className={`${styles.railSkeleton} ${styles.skeleton}`} /> : <div className={styles.activityList}>{data.recentActivity.map(order => { const summary = summariseItemGroups(order.itemGroups); const status = salesProcessPresentation(order); return <button key={order.id} onClick={() => router.push(`/sales/${order.id}`)}><span className={styles.activityMarker}>{summary.lines[0]?.slice(0, 1).toUpperCase() || "S"}</span><span className={styles.activityMain}><strong>{summary.lines[0]}</strong><small className={styles[`processTone${status.tone[0].toUpperCase()}${status.tone.slice(1)}`]}><i aria-hidden="true" />{status.shortLabel}</small></span><span className={styles.activityMeta}><b>{formatPenceAsGBP(poundsToPence(Number(order.total_revenue)))}</b><time>{relativeTime(order.cancelled_at || order.updated_at || order.created_at)}</time></span></button>; })}</div>}</section></aside>;
}

function State({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { return <div className={styles.emptyState}><strong>{title}</strong><span>{detail}</span><div>{children}</div></div>; }
function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) { return <label className={styles.selectControl}><span className="sr-only">{label}</span><select value={value} onChange={e => onChange(e.target.value)}>{children}</select></label>; }
function SortHead({ label, name, filters, onSort, numeric }: { label: string; name: HistorySort; filters: Filters; onSort: (s: HistorySort) => void; numeric?: boolean }) { const active = filters.sort === name; return <th className={numeric ? styles.numeric : ""} aria-sort={active ? (filters.direction === "desc" ? "descending" : "ascending") : "none"}><button onClick={() => onSort(name)} aria-label={`Sort by ${label}`}>{label} <span aria-hidden="true">{active ? (filters.direction === "desc" ? "↓" : "↑") : "↕"}</span></button></th>; }
