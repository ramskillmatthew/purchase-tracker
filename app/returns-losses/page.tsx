"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { ReturnsLossesListResponse } from "@/lib/returns/api-contract";
import {
  money,
  percent,
  displayDate,
  RETURN_STATUS_LABELS,
  RETURN_STATUS_TONE,
  LOSS_TYPE_LABELS,
  RETURNS_PERIOD_OPTIONS,
} from "@/lib/returns/format";
import LogReturnDialog from "@/components/returns-losses/LogReturnDialog";
import LogLossDialog from "@/components/returns-losses/LogLossDialog";
import CompleteReturnDialog from "@/components/returns-losses/CompleteReturnDialog";
import CancelReturnDialog from "@/components/returns-losses/CancelReturnDialog";
import AdvanceReturnDialog from "@/components/returns-losses/AdvanceReturnDialog";
import EditReturnDialog from "@/components/returns-losses/EditReturnDialog";
import EditLossDialog from "@/components/returns-losses/EditLossDialog";
import DeleteReturnLossDialog from "@/components/returns-losses/DeleteReturnLossDialog";
import RecordDetailDialog from "@/components/returns-losses/RecordDetailDialog";
import { broadcastReturnsChanged } from "@/lib/returns/events";
import styles from "./returns-losses.module.css";

type Tab = "all" | "returns" | "losses";
type Row = ReturnsLossesListResponse["rows"][number];
type Kpis = ReturnsLossesListResponse["kpis"];

const RETURN_KPIS: { key: keyof Kpis; label: string; kind: "pence" | "pct" | "count"; tone?: "positive" | "amber" }[] = [
  { key: "itemsReturned", label: "Items returned", kind: "count", tone: "amber" },
  { key: "revenueLostFromReturnsPence", label: "Revenue reversed", kind: "pence" },
  { key: "profitLostFromReturnsPence", label: "Profit reversed", kind: "pence" },
  { key: "returnRatePercent", label: "Return rate", kind: "pct" },
  { key: "returnPostagePence", label: "Return postage", kind: "pence" },
];
const LOSS_KPIS: { key: keyof Kpis; label: string }[] = [
  { key: "refundsWithoutReturnPence", label: "Refunded without return" },
  { key: "lostInventoryPence", label: "Inventory lost" },
  { key: "unsellableStockPence", label: "Unsellable purchases" },
  { key: "totalLossesPence", label: "Total losses" },
];

function toneStyle(tone: string): CSSProperties {
  return { ["--tone" as keyof CSSProperties]: tone } as CSSProperties;
}

export default function ReturnsLossesPage() {
  const [preset, setPreset] = useState("this-month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [platform, setPlatform] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"event_date" | "financial_impact" | "created_at">("event_date");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  const [data, setData] = useState<ReturnsLossesListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [logReturnOpen, setLogReturnOpen] = useState(false);
  const [logLossOpen, setLogLossOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [completeRow, setCompleteRow] = useState<Row | null>(null);
  const [cancelRow, setCancelRow] = useState<Row | null>(null);
  const [advanceRow, setAdvanceRow] = useState<Row | null>(null);
  const [editReturnRow, setEditReturnRow] = useState<Row | null>(null);
  const [editLossRow, setEditLossRow] = useState<Row | null>(null);
  const [deleteRow, setDeleteRow] = useState<Row | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchDraft.trim()), 300);
    return () => clearTimeout(t);
  }, [searchDraft]);
  useEffect(() => {
    setPage(1);
  }, [preset, customStart, customEnd, platform, statusFilter, search, tab, sort, direction]);

  const refresh = useCallback(() => {
    setReloadKey((k) => k + 1);
    // Home Net Profit + Sales Overview also depend on active-return figures.
    broadcastReturnsChanged();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ preset, type: tab, page: String(page), pageSize: "25", sort, direction });
    if (preset === "custom") {
      qs.set("start", customStart);
      qs.set("end", customEnd);
    }
    if (platform) qs.set("platform", platform);
    if (statusFilter) qs.set("status", statusFilter);
    if (search) qs.set("search", search);
    fetch(`/api/returns?${qs.toString()}`, { signal: controller.signal })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { error?: string } & ReturnsLossesListResponse;
        if (!r.ok) {
          if (/table|schema cache|does not exist|relation|not installed/i.test(String(body?.error ?? ""))) {
            setMigrationMissing(true);
            return;
          }
          throw new Error(String(body?.error || "Could not load returns, losses & write-offs."));
        }
        setMigrationMissing(false);
        setData(body);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Something went wrong loading this page.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [preset, customStart, customEnd, platform, statusFilter, search, tab, page, sort, direction, reloadKey]);

  const kpis = data?.kpis ?? null;
  const platforms = useMemo(
    () => [...new Set((data?.returns ?? []).map((r) => r.salePlatform).filter((x): x is string => !!x))],
    [data],
  );

  function resetFilters() {
    setPreset("this-month");
    setCustomStart("");
    setCustomEnd("");
    setPlatform("");
    setStatusFilter("");
    setSearchDraft("");
    setSearch("");
    setTab("all");
  }
  function toggleSort(col: typeof sort) {
    if (sort === col) setDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(col);
      setDirection("desc");
    }
  }
  const sortMark = (col: typeof sort) => (sort === col ? (direction === "desc" ? " ↓" : " ↑") : "");

  return (
    <section className={`page-shell ${styles.page}`}>
      <header className={styles.header}>
        <div>
          <h1>
            Returns, Losses &amp; Write-offs {data ? <span className="record-count">{data.total}</span> : null}
          </h1>
          <p>
            Track returns against sales, record lost or unsellable inventory, and apply the right stock, sales-status and
            net-profit changes for the correct month.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className="button-secondary"
            onClick={() => setLogLossOpen(true)}
            disabled={migrationMissing}
          >
            <span className="button-plus">+</span>Log loss / write-off
          </button>
          <button type="button" className="button" onClick={() => setLogReturnOpen(true)} disabled={migrationMissing}>
            <span className="button-plus">+</span>Log return
          </button>
        </div>
      </header>

      {migrationMissing ? (
        <div className={styles.migrationBanner} role="status">
          <span>
            The Returns, Losses &amp; Write-offs database tables are not installed yet. Apply{" "}
            <code>supabase-returns-losses.sql</code> in the Supabase SQL editor, then reload this page. The rest of the app
            is unaffected.
          </span>
        </div>
      ) : null}
      {error ? (
        <div className={styles.errorBanner} role="alert">
          {error}{" "}
          <button type="button" className={styles.reset} onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      <div className={styles.filterBar}>
        <select aria-label="Reporting period" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {RETURNS_PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {preset === "custom" ? (
          <>
            <input
              aria-label="Start date"
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => setCustomStart(e.target.value)}
            />
            <input
              aria-label="End date"
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </>
        ) : null}
        <select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select aria-label="Status or type" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All reasons</option>
          {tab !== "losses"
            ? Object.entries(RETURN_STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))
            : null}
          {tab !== "returns"
            ? Object.entries(LOSS_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))
            : null}
        </select>
        <input
          aria-label="Search records"
          className={styles.search}
          type="search"
          placeholder="Search SKU, item, sale or purchase reference…"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
        />
        <button type="button" className={styles.reset} onClick={resetFilters}>
          Reset
        </button>
      </div>

      <div className={styles.overviewGroup}>
        <span className={styles.overviewLabel}>Returns overview</span>
        <div className={`${styles.kpiRow} ${styles.kpiRow5}`}>
          {RETURN_KPIS.map((c) => (
            <article
              key={String(c.key)}
              className={`${styles.kpiCard} ${c.tone ? styles[c.tone] : ""} ${
                loading && !kpis ? styles.kpiSkeleton : ""
              }`}
            >
              <span>{c.label}</span>
              <strong>
                {!kpis
                  ? "—"
                  : c.kind === "pct"
                    ? percent(kpis[c.key] as number)
                    : c.kind === "count"
                      ? (kpis[c.key] as number).toLocaleString("en-GB")
                      : money(kpis[c.key] as number)}
              </strong>
            </article>
          ))}
        </div>
      </div>
      <div className={styles.overviewGroup}>
        <span className={styles.overviewLabel}>Losses &amp; write-offs overview</span>
        <div className={`${styles.kpiRow} ${styles.kpiRow4}`}>
          {LOSS_KPIS.map((c) => (
            <article
              key={String(c.key)}
              className={`${styles.kpiCard} ${styles.negative} ${loading && !kpis ? styles.kpiSkeleton : ""}`}
            >
              <span>{c.label}</span>
              <strong>{!kpis ? "—" : money(kpis[c.key] as number)}</strong>
            </article>
          ))}
        </div>
      </div>

      <div className="data-panel">
        <div className="table-toolbar">
          <div className={styles.tabs} role="tablist" aria-label="Record type">
            {(["all", "returns", "losses"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? styles.active : ""}
                onClick={() => {
                  setTab(t);
                  setStatusFilter("");
                }}
              >
                {t === "all" ? "All" : t === "returns" ? "Returns" : "Losses & write-offs"}
              </button>
            ))}
          </div>
          <p className="table-meta">
            {data
              ? `Showing ${data.rows.length ? (data.page - 1) * data.pageSize + 1 : 0}–${Math.min(
                  data.page * data.pageSize,
                  data.total,
                )} of ${data.total}`
              : ""}
          </p>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>
                  <button type="button" className={styles.reset} onClick={() => toggleSort("event_date")}>
                    Date{sortMark("event_date")}
                  </button>
                </th>
                <th>Item / SKU</th>
                <th>Related sale / purchase</th>
                <th>Qty</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>
                  <button type="button" className={styles.reset} onClick={() => toggleSort("financial_impact")}>
                    Net profit impact{sortMark("financial_impact")}
                  </button>
                </th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i}>
                      <td colSpan={8}>&nbsp;</td>
                    </tr>
                  ))
                : null}
              {!loading && data && data.rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">
                      <div>
                        <h2>No records in this period</h2>
                        <p>Log a return or a loss / write-off, or widen the period filter.</p>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null}
              {data?.rows.map((row) => {
                const view =
                  row.recordType === "return"
                    ? {
                        kind: "Return",
                        label: RETURN_STATUS_LABELS[row.workflow_status],
                        tone: RETURN_STATUS_TONE[row.workflow_status],
                        statusValue: row.workflow_status as string,
                        evDate: row.completed_on ?? row.started_on,
                        evPrec: row.completed_on ? row.completed_precision : row.started_precision,
                        related: row.saleReference
                          ? `${displayDate(row.saleDate)} · ${row.salePlatform ?? ""}`
                          : "—",
                      }
                    : {
                        kind: "Loss",
                        label: LOSS_TYPE_LABELS[row.loss_type],
                        tone: "#d96b6b",
                        statusValue: row.loss_type as string,
                        evDate: row.event_date,
                        evPrec: row.event_precision,
                        related: row.purchaseReference
                          ? `${row.supplier ?? ""} · ${displayDate(row.purchaseDate)}`
                          : row.saleReference
                            ? "Linked sale"
                            : "—",
                      };
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => setDetailRow(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setDetailRow(row);
                    }}
                  >
                    <td>
                      <span className="status-badge" style={toneStyle(view.tone)}>
                        <i />
                        {view.kind}
                      </span>
                    </td>
                    <td>{displayDate(view.evDate, view.evPrec)}</td>
                    <td>
                      <div className={styles.tableCell}>{row.itemTitle ?? "—"}</div>
                      <div className={styles.sku}>SKU: {row.sku ?? "—"}</div>
                    </td>
                    <td className={styles.dimCell}>{view.related}</td>
                    <td>{row.quantity}</td>
                    <td>
                      <span className="status-badge" style={toneStyle(view.tone)} data-status={view.statusValue}>
                        <i />
                        {view.label}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }} className={styles.negativeCell}>
                      {money(row.net_profit_impact, "pounds")}
                    </td>
                    <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      <div className={styles.rowActions}>
                        <button type="button" onClick={() => setDetailRow(row)}>
                          View
                        </button>
                        {row.recordType === "return" &&
                        row.workflow_status !== "return_completed" &&
                        row.workflow_status !== "return_cancelled" ? (
                          <>
                            {row.workflow_status === "return_started" || row.workflow_status === "item_sent" ? (
                              <button type="button" onClick={() => setAdvanceRow(row)}>
                                Advance
                              </button>
                            ) : null}
                            <button type="button" onClick={() => setCompleteRow(row)}>
                              Complete
                            </button>
                            <button type="button" onClick={() => setEditReturnRow(row)}>
                              Edit
                            </button>
                            <button type="button" onClick={() => setCancelRow(row)}>
                              Cancel
                            </button>
                          </>
                        ) : null}
                        {row.recordType === "return" && row.workflow_status === "return_completed" ? (
                          <>
                            <button type="button" onClick={() => setEditReturnRow(row)}>
                              Edit
                            </button>
                            <button type="button" onClick={() => setCancelRow(row)}>
                              Cancel
                            </button>
                          </>
                        ) : null}
                        {row.recordType === "loss" ? (
                          <button type="button" onClick={() => setEditLossRow(row)}>
                            Edit
                          </button>
                        ) : null}
                        <button type="button" className="danger" onClick={() => setDeleteRow(row)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && data.totalPages > 1 ? (
          <div className={styles.pager}>
            <span>
              Page {data.page} of {data.totalPages}
            </span>
            <nav aria-label="Pages">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => p - 1)}
                aria-label="Previous page"
              >
                ‹
              </button>
              {Array.from({ length: data.totalPages }, (_, i) => i + 1)
                .slice(0, 8)
                .map((p) => (
                  <button
                    type="button"
                    key={p}
                    aria-current={p === data.page ? "page" : undefined}
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </button>
                ))}
              <button
                type="button"
                disabled={data.page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Next page"
              >
                ›
              </button>
            </nav>
          </div>
        ) : null}
      </div>

      {logReturnOpen ? (
        <LogReturnDialog
          onClose={() => setLogReturnOpen(false)}
          onSaved={() => {
            setLogReturnOpen(false);
            refresh();
          }}
        />
      ) : null}
      {logLossOpen ? (
        <LogLossDialog
          onClose={() => setLogLossOpen(false)}
          onSaved={() => {
            setLogLossOpen(false);
            refresh();
          }}
        />
      ) : null}
      {detailRow ? <RecordDetailDialog row={detailRow} onClose={() => setDetailRow(null)} /> : null}
      {completeRow && completeRow.recordType === "return" ? (
        <CompleteReturnDialog
          returnRow={completeRow}
          onClose={() => setCompleteRow(null)}
          onSaved={() => {
            setCompleteRow(null);
            refresh();
          }}
        />
      ) : null}
      {cancelRow && cancelRow.recordType === "return" ? (
        <CancelReturnDialog
          returnRow={cancelRow}
          onClose={() => setCancelRow(null)}
          onSaved={() => {
            setCancelRow(null);
            refresh();
          }}
        />
      ) : null}
      {advanceRow && advanceRow.recordType === "return" ? (
        <AdvanceReturnDialog
          returnRow={advanceRow}
          onClose={() => setAdvanceRow(null)}
          onSaved={() => {
            setAdvanceRow(null);
            refresh();
          }}
        />
      ) : null}
      {editReturnRow && editReturnRow.recordType === "return" ? (
        <EditReturnDialog
          returnRow={editReturnRow}
          onClose={() => setEditReturnRow(null)}
          onSaved={() => {
            setEditReturnRow(null);
            refresh();
          }}
        />
      ) : null}
      {editLossRow && editLossRow.recordType === "loss" ? (
        <EditLossDialog
          lossRow={editLossRow}
          onClose={() => setEditLossRow(null)}
          onSaved={() => {
            setEditLossRow(null);
            refresh();
          }}
        />
      ) : null}
      {deleteRow ? (
        <DeleteReturnLossDialog
          row={deleteRow}
          onClose={() => setDeleteRow(null)}
          onSaved={() => {
            setDeleteRow(null);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}
