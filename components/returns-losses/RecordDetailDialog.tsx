"use client";

import { useEffect, useState } from "react";
import type { ReturnsLossesListResponse } from "@/lib/returns/api-contract";
import type { ReturnLossAuditEventRow, ReturnRecordRow, LossRecordRow } from "@/lib/returns/types";
import {
  money,
  impactMoney,
  displayDate,
  RETURN_STATUS_LABELS,
  LOSS_TYPE_LABELS,
} from "@/lib/returns/format";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

type Row = ReturnsLossesListResponse["rows"][number];

const EVENT_LABELS: Record<ReturnLossAuditEventRow["event_type"], string> = {
  record_created: "Record created",
  status_changed: "Status changed",
  sale_linked: "Linked to sale",
  purchase_linked: "Linked to purchase",
  quantity_changed: "Quantity changed",
  amount_changed: "Amounts recalculated",
  inventory_restored: "Inventory restored to stock",
  inventory_written_off: "Inventory written off",
  return_completed: "Return completed",
  outcome_selected: "Outcome selected",
  return_cancelled: "Return cancelled",
  record_edited: "Record edited",
  record_reversed: "Movements reversed",
  record_deleted: "Record deleted",
  recognition_month_changed: "Recognition month changed",
  sales_status_changed: "Linked sale status changed",
};

function describe(ev: ReturnLossAuditEventRow): string {
  const d = ev.detail ?? {};
  switch (ev.event_type) {
    case "status_changed":
    case "sales_status_changed":
      return d.from && d.to ? `${String(d.from)} → ${String(d.to)}` : d.to ? `→ ${String(d.to)}` : "";
    case "outcome_selected":
      return d.outcome ? String(d.outcome) : "";
    case "recognition_month_changed":
      return d.from || d.to ? `${d.from ? String(d.from) : "—"} → ${d.to ? String(d.to) : "—"}` : "";
    case "quantity_changed":
      return d.from != null && d.to != null ? `${String(d.from)} → ${String(d.to)} units` : "";
    case "return_completed":
      return typeof d.netProfitImpactPence === "number"
        ? `Net profit impact ${impactMoney(d.netProfitImpactPence)}${d.recognitionMonth ? ` · recognised ${String(d.recognitionMonth)}` : ""}`
        : "";
    case "amount_changed":
      return typeof d.netProfitImpactPence === "number" ? `Net profit impact ${impactMoney(d.netProfitImpactPence)}` : "";
    case "inventory_restored":
    case "inventory_written_off":
      return typeof d.units === "number" || typeof d.count === "number" || typeof d.reversed === "number"
        ? `${String(d.units ?? d.count ?? d.reversed)} unit(s)`
        : "";
    default:
      return "";
  }
}

export default function RecordDetailDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const isReturn = row.recordType === "return";
  const [record, setRecord] = useState<ReturnRecordRow | LossRecordRow | null>(null);
  const [events, setEvents] = useState<ReturnLossAuditEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/${isReturn ? "returns" : "losses"}/${row.id}`, { signal: controller.signal })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json?.error || "Could not load this record.");
        setRecord(json.record);
        setEvents(json.events ?? []);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [row.id, isReturn]);

  const ret = isReturn ? (record as ReturnRecordRow | null) : null;
  const loss = !isReturn ? (record as LossRecordRow | null) : null;

  return (
    <Modal
      title={isReturn ? "Return detail" : "Loss / write-off detail"}
      onClose={onClose}
      wide
      footer={
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      }
    >
      {loading ? <p className={styles.footerNote}>Loading…</p> : null}
      {error ? <p className="task-modal-error">{error}</p> : null}

      {record ? (
        <div className={styles.detailGrid}>
          <div className={styles.detailCard}>
            <h3>{isReturn ? "Return" : "Loss"} summary</h3>
            <div className={styles.detailRow}>
              <span>Reference</span>
              <strong>{record.reference}</strong>
            </div>
            <div className={styles.detailRow}>
              <span>{isReturn ? "Status" : "Type"}</span>
              <strong>
                {ret ? RETURN_STATUS_LABELS[ret.workflow_status] : loss ? LOSS_TYPE_LABELS[loss.loss_type] : ""}
              </strong>
            </div>
            <div className={styles.detailRow}>
              <span>Item</span>
              <strong>{row.itemTitle ?? row.sku ?? "—"}</strong>
            </div>
            <div className={styles.detailRow}>
              <span>Quantity</span>
              <strong>{record.quantity}</strong>
            </div>
            {ret ? (
              <>
                <div className={styles.detailRow}>
                  <span>Started</span>
                  <strong>{displayDate(ret.started_on, ret.started_precision)}</strong>
                </div>
                {ret.completed_on ? (
                  <div className={styles.detailRow}>
                    <span>Completed</span>
                    <strong>{displayDate(ret.completed_on, ret.completed_precision)}</strong>
                  </div>
                ) : null}
                {ret.recognition_month ? (
                  <div className={styles.detailRow}>
                    <span>Recognition month</span>
                    <strong>{ret.recognition_month}</strong>
                  </div>
                ) : null}
              </>
            ) : null}
            {loss ? (
              <div className={styles.detailRow}>
                <span>Event date</span>
                <strong>{displayDate(loss.event_date, loss.event_precision)}</strong>
              </div>
            ) : null}
          </div>

          <div className={styles.detailCard}>
            <h3>Financial impact</h3>
            {ret ? (
              <>
                <div className={styles.detailRow}>
                  <span>Revenue reversed</span>
                  <strong>{money(Number(ret.revenue_reversed), "pounds")}</strong>
                </div>
                <div className={styles.detailRow}>
                  <span>Profit reversed</span>
                  <strong>{money(Number(ret.profit_reversed), "pounds")}</strong>
                </div>
                <div className={styles.detailRow}>
                  <span>Return postage</span>
                  <strong>{money(Number(ret.return_postage), "pounds")}</strong>
                </div>
                <div className={styles.detailRow}>
                  <span>Inventory write-off</span>
                  <strong>{money(Number(ret.inventory_write_off), "pounds")}</strong>
                </div>
                <div className={styles.detailRow}>
                  <span>Stock value restored</span>
                  <strong>{money(Number(ret.stock_value_restored), "pounds")}</strong>
                </div>
              </>
            ) : null}
            {loss ? (
              <>
                <div className={styles.detailRow}>
                  <span>Customer refund</span>
                  <strong>{money(Number(loss.customer_refund), "pounds")}</strong>
                </div>
                <div className={styles.detailRow}>
                  <span>Stock value removed</span>
                  <strong>{money(Number(loss.stock_value_removed), "pounds")}</strong>
                </div>
                <div className={styles.detailRow}>
                  <span>Other costs</span>
                  <strong>{money(Number(loss.other_costs), "pounds")}</strong>
                </div>
              </>
            ) : null}
            <div className={styles.detailRow}>
              <span>Net profit impact</span>
              <strong className={styles.negativeCell}>
                {impactMoney(Math.round(Number(record.net_profit_impact) * 100))}
              </strong>
            </div>
            <p className={styles.footerNote}>
              Restored stock value is a balance-sheet movement — it is never counted as profit.
            </p>
          </div>
        </div>
      ) : null}

      {record ? (
        <div className={styles.detailCard} style={{ marginTop: 16 }}>
          <h3>Audit history</h3>
          {events.length === 0 ? (
            <p className={styles.footerNote}>No audit events recorded.</p>
          ) : (
            <ul className={styles.auditList}>
              {events.map((ev) => (
                <li key={ev.id} className={styles.auditItem}>
                  <time>{new Date(ev.created_at).toLocaleString("en-GB")}</time>
                  <span>
                    <strong>{EVENT_LABELS[ev.event_type] ?? ev.event_type}</strong>
                    {describe(ev) ? ` — ${describe(ev)}` : ""}
                    {ev.actor ? ` · ${ev.actor}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
