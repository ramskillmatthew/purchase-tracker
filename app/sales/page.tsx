"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CancelSalesResult, SalesOrderListItem, SalesPlatform } from "@/lib/types";
import { formatPenceAsGBP, poundsToPence } from "@/lib/sales/money";
import { profitBadgeTone } from "@/lib/sales/profit";
import { itemGroupsSearchText, summariseItemGroups } from "@/lib/sales/order-summary";
import { isSelectableForCancellation, matchesSalesStatusFilter, salesStatusFilters, type SalesStatusFilter } from "@/lib/sales/status-filter";
import { pruneMissingIds, resolveRowClick, selectionSummary, toggleId, toggleVisiblePage } from "@/lib/purchases-selection";
import { salesCancelledMessage } from "@/lib/success-messages";
import CancelSalesDialog from "@/components/sales/CancelSalesDialog";
import TaskToast from "@/components/TaskToast";
import styles from "./sales.module.css";

const PROFIT_TONE_CLASS = { red: "profitPillRed", amber: "profitPillAmber", green: "profitPillGreen" } as const;

// Record<SalesPlatform, string> (not Record<string, string>) — TypeScript
// itself fails to compile if a platform is ever added/removed from the
// canonical list in lib/validation/sales.ts without a matching label here.
const PLATFORM_LABELS: Record<SalesPlatform, string> = { vinted: "Vinted", ebay: "eBay", depop: "Depop", other: "Other" };

function platformLabel(order: SalesOrderListItem): string {
  return order.platform === "other" && order.custom_platform_name ? order.custom_platform_name : (PLATFORM_LABELS[order.platform] ?? order.platform);
}

function ukDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

export default function SalesPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<SalesOrderListItem[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SalesStatusFilter>("completed");
  // Selected sales-order UUIDs, independent of the current filter/search —
  // never a row index — mirrors the Purchases page's own selection state
  // exactly (see app/purchases/page.tsx, lib/purchases-selection.ts).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [submittingAction, setSubmittingAction] = useState<"return" | "keep" | null>(null);
  const [cancelError, setCancelError] = useState("");
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function load() {
    setError("");
    try {
      const response = await fetch("/api/sales");
      if (!response.ok) { setError("Could not load sales."); return; }
      setOrders(await response.json());
    } catch { setError("Could not load sales."); }
  }
  useEffect(() => { load(); }, []);

  const statusFilteredOrders = useMemo(() => (orders ?? []).filter(order => matchesSalesStatusFilter(order, statusFilter)), [orders, statusFilter]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return statusFilteredOrders;
    return statusFilteredOrders.filter(order => {
      const haystack = [platformLabel(order), order.status, order.sale_date, PLATFORM_LABELS[order.platform] ?? order.platform, itemGroupsSearchText(order.itemGroups)].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [statusFilteredOrders, query]);

  // Shift-click ranges and "select all" are always resolved against exactly
  // this list — the currently visible rows, after status-filter+search,
  // that are actually selectable (status === completed) — never a hidden
  // row and never a cancelled one. Matches the Purchases page's own
  // pageIds convention (see app/purchases/page.tsx), just built from the
  // status filter instead of pagination.
  const selectableIds = useMemo(() => filtered.filter(isSelectableForCancellation).map(order => order.id), [filtered]);
  const selection = useMemo(() => selectionSummary(selectedIds, selectableIds), [selectedIds, selectableIds]);
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selection.someSelected; }, [selection.someSelected]);

  // Reconciles the selection every time what's currently visible+selectable
  // changes — switching the status filter, typing a search, a row leaving
  // "completed" (cancelled elsewhere), or a data refresh. "Delete N
  // selected" must never be able to act on a hidden or no-longer-selectable
  // row, so anything that drops out of `selectableIds` is dropped from the
  // selection too, using the same pruneMissingIds helper the Purchases page
  // uses for its own (differently-triggered) reconciliation.
  useEffect(() => {
    setSelectedIds(current => pruneMissingIds(current, new Set(selectableIds)));
  }, [selectableIds]);

  const summary = useMemo(() => {
    const completed = (orders ?? []).filter(order => order.status === "completed");
    const totalRevenuePence = completed.reduce((sum, order) => sum + poundsToPence(Number(order.total_revenue)), 0);
    const totalFeesPostagePence = completed.reduce((sum, order) => sum + poundsToPence(Number(order.platform_fees)) + poundsToPence(Number(order.postage)), 0);
    const averageOrderPence = completed.length ? Math.round(totalRevenuePence / completed.length) : 0;
    return { count: completed.length, totalRevenuePence, totalFeesPostagePence, averageOrderPence };
  }, [orders]);

  function toggleRowSelected(id: string) {
    setSelectedIds(current => toggleId(current, id));
    setRangeAnchor(id);
  }
  function toggleSelectAllVisible() {
    setSelectedIds(current => toggleVisiblePage(current, selectableIds));
  }
  function clearSelection() {
    setSelectedIds(new Set());
    setRangeAnchor(null);
  }
  // Priority order, matching the Purchases page's handleRowClick exactly:
  // Shift+click always ranges (never clears); a plain click clears the
  // whole selection if anything is selected; only with nothing selected
  // does a plain click open the sale. A cancelled (non-selectable) row is
  // never a valid range endpoint or single-select target — shift-clicking
  // one is a no-op rather than silently "selecting" a row with no checkbox
  // — but it's still a completely normal, always-clickable row otherwise
  // (the sale detail page must stay reachable for cancelled sales too).
  function handleRowClick(event: React.MouseEvent, order: SalesOrderListItem) {
    if (!isSelectableForCancellation(order)) {
      if (event.shiftKey) return;
      if (selectedIds.size > 0) { clearSelection(); return; }
      router.push(`/sales/${order.id}`);
      return;
    }
    const action = resolveRowClick({ shiftKey: event.shiftKey, hasSelection: selectedIds.size > 0, pageIds: selectableIds, anchorId: rangeAnchor, targetId: order.id });
    if (action.type === "range") { setSelectedIds(current => { const next = new Set(current); for (const id of action.ids) next.add(id); return next; }); return; }
    if (action.type === "select-single") { setSelectedIds(current => { const next = new Set(current); next.add(action.id); return next; }); setRangeAnchor(action.id); return; }
    if (action.type === "clear") { clearSelection(); return; }
    router.push(`/sales/${order.id}`);
  }

  const selectedOrders = useMemo(() => filtered.filter(order => selectedIds.has(order.id)), [filtered, selectedIds]);

  async function cancelSelected(returnToStock: boolean) {
    if (submittingAction) return; // REGRESSION guard: never fire a second cancellation while one is still in flight (double-click / repeat submission).
    setSubmittingAction(returnToStock ? "return" : "keep");
    setCancelError("");
    try {
      const response = await fetch("/api/sales/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesOrderIds: Array.from(selectedIds), returnToStock }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Failure preserves the selection and the open dialog — the user
        // never has to re-select anything to retry.
        setCancelError(body?.error || "Could not cancel the selected sales.");
        setSubmittingAction(null);
        return;
      }
      const { ordersCancelled, unitsAffected } = body as CancelSalesResult;
      setCancelDialogOpen(false);
      setSubmittingAction(null);
      clearSelection();
      setSuccessMessage(salesCancelledMessage(ordersCancelled, unitsAffected, returnToStock));
      load();
    } catch {
      setCancelError("Could not cancel the selected sales. Check your connection and try again.");
      setSubmittingAction(null);
    }
  }

  const statusFilterLabel = salesStatusFilters.find(option => option.value === statusFilter)?.label ?? "Completed";

  return <section className="page-shell">
    <header className={styles.topbar}>
      <div className="title-row"><h1>Sales</h1>{orders && <span className="record-count">{orders.length.toLocaleString("en-GB")}</span>}</div>
      <div className={styles.topbarActions}>
        {selectedIds.size > 0 && <button type="button" className="button-danger" onClick={() => setCancelDialogOpen(true)}>Delete {selectedIds.size} selected</button>}
        <button type="button" className="button-secondary" onClick={() => router.push("/sales/reports")}>Reports</button>
        <button type="button" className="button-secondary" onClick={() => router.push("/sales/new?mode=order")}>Order Sale</button>
        <button type="button" className="button" onClick={() => router.push("/sales/new?mode=quick")}>Quick Sale</button>
      </div>
    </header>

    {orders && orders.length > 0 && <div className={styles.summaryGrid}>
      <div className={styles.summaryCard}><span>Completed sales</span><strong>{summary.count.toLocaleString("en-GB")}</strong></div>
      <div className={styles.summaryCard}><span>Total revenue</span><strong>{formatPenceAsGBP(summary.totalRevenuePence)}</strong></div>
      <div className={styles.summaryCard}><span>Fees + postage</span><strong>{formatPenceAsGBP(summary.totalFeesPostagePence)}</strong></div>
      <div className={styles.summaryCard}><span>Average order value</span><strong>{formatPenceAsGBP(summary.averageOrderPence)}</strong></div>
    </div>}

    <div className="data-panel">
      <div className={styles.listToolbar}>
        <div className={styles.statusFilterSwitch} role="group" aria-label="Filter sales by status">
          {salesStatusFilters.map(option => <button key={option.value} type="button" className={statusFilter === option.value ? styles.statusFilterActive : undefined} onClick={() => setStatusFilter(option.value)}>{option.label}</button>)}
        </div>
        <div className={styles.searchBox}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4.5 4.5" /></svg>
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search sales by item, platform, or status" aria-label="Search sales" autoComplete="off" />
        </div>
        {selectedIds.size > 0 && <div className={styles.selectionActions}>
          <span className={styles.selectionHint}>Shift-click rows to select a range</span>
          <button type="button" className="button-secondary" onClick={clearSelection}>Clear selection</button>
        </div>}
      </div>

      {!orders && !error && <div className={styles.loadingState}>
        <div className={styles.skeletonRow} style={{ width: "60%" }} />
        <div className={styles.skeletonRow} style={{ width: "80%" }} />
        <div className={styles.skeletonRow} style={{ width: "45%" }} />
      </div>}

      {error && <div className={styles.errorState}><strong>Could not load sales</strong><span>{error}</span><button type="button" className="button-secondary" onClick={load}>Try again</button></div>}

      {orders && !error && orders.length === 0 && <div className={styles.emptyState}>
        <strong>No sales recorded yet</strong>
        <span>Record your first sale with Quick Sale (one product) or Order Sale (a mixed basket).</span>
        <button type="button" className="button" onClick={() => router.push("/sales/new?mode=quick")}>Quick Sale</button>
      </div>}

      {orders && !error && orders.length > 0 && statusFilteredOrders.length === 0 && <div className={styles.emptyState}>
        <strong>No {statusFilterLabel.toLowerCase()} sales</strong>
        <span>Try a different filter to see other sales.</span>
      </div>}

      {orders && !error && statusFilteredOrders.length > 0 && filtered.length === 0 && <div className={styles.emptyState}>
        <strong>No matching sales</strong>
        <span>Try a different search term.</span>
        <button type="button" className="button-secondary" onClick={() => setQuery("")}>Clear search</button>
      </div>}

      {orders && !error && filtered.length > 0 && <div className="table-scroll">
        <table className={styles.salesTable}>
          <thead><tr>
            <th className={styles.checkboxCell}>
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label={selection.someSelected || selection.allSelected ? `${selection.selectedCount} of ${selectableIds.length} sales selected` : "Select all sales currently shown"}
                checked={selection.allSelected}
                onChange={toggleSelectAllVisible}
              />
            </th>
            <th>Date</th><th>Item Description</th><th>Platform</th><th>Units</th><th className={styles.numeric}>Revenue</th><th className={styles.numeric}>Profit</th><th>Status</th>
          </tr></thead>
          <tbody>
            {filtered.map(order => {
              const descriptionSummary = summariseItemGroups(order.itemGroups);
              const profitTone = profitBadgeTone(order.profitPence);
              const selectable = isSelectableForCancellation(order);
              const rowClassNames = [styles.salesRow, selectedIds.has(order.id) ? styles.rowSelected : "", !selectable ? styles.cancelledRow : ""].filter(Boolean).join(" ");
              return <tr key={order.id} className={rowClassNames} tabIndex={0} onClick={event => handleRowClick(event, order)} onKeyDown={event => { if (event.key === "Enter") router.push(`/sales/${order.id}`); }}>
                <td className={styles.checkboxCell} onClick={event => event.stopPropagation()}>
                  {selectable && <input
                    type="checkbox"
                    aria-label={`Select the ${ukDate(order.sale_date)} ${platformLabel(order)} sale (${order.itemCount} unit${order.itemCount === 1 ? "" : "s"})`}
                    checked={selectedIds.has(order.id)}
                    onChange={() => toggleRowSelected(order.id)}
                  />}
                </td>
                <td>{ukDate(order.sale_date)}</td>
                <td className={styles.descriptionCell}>
                  {descriptionSummary.lines.map((line, index) => <span key={index} className={styles.descriptionLine}>{line}</span>)}
                  {descriptionSummary.overflowCount > 0 && <span className={styles.descriptionMore}>+ {descriptionSummary.overflowCount} more product{descriptionSummary.overflowCount === 1 ? "" : "s"}</span>}
                </td>
                <td>{platformLabel(order)}</td>
                <td>{order.itemCount}</td>
                <td className={styles.numeric}>{formatPenceAsGBP(poundsToPence(Number(order.total_revenue)))}</td>
                <td className={styles.numeric}>
                  <span className={`${styles.profitPill} ${styles[PROFIT_TONE_CLASS[profitTone]]}`} aria-label={`Profit ${formatPenceAsGBP(order.profitPence)}`}>{formatPenceAsGBP(order.profitPence)}</span>
                </td>
                <td><span className={`${styles.statusPill} ${order.status === "completed" ? styles.statusCompleted : order.status === "refunded" ? styles.statusRefunded : styles.statusCancelled}`}>{order.status}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
    </div>

    {cancelDialogOpen && <CancelSalesDialog
      orders={selectedOrders}
      submittingAction={submittingAction}
      error={cancelError}
      onCancel={() => { if (!submittingAction) { setCancelDialogOpen(false); setCancelError(""); } }}
      onConfirm={cancelSelected}
    />}
    {successMessage && <TaskToast message={successMessage} onDismiss={() => setSuccessMessage(null)} />}
  </section>;
}
