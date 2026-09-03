"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReturnsLossesListResponse, LossEditPreviewResponse } from "@/lib/returns/api-contract";
import { money, impactMoney, LOSS_TYPE_LABELS } from "@/lib/returns/format";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

type LossRow = Extract<ReturnsLossesListResponse["rows"][number], { recordType: "loss" }>;
const n = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));

export default function EditLossDialog({
  lossRow,
  onClose,
  onSaved,
}: {
  lossRow: LossRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customerRefund, setCustomerRefund] = useState(String(n(lossRow.customer_refund) || ""));
  const [otherCosts, setOtherCosts] = useState(String(n(lossRow.other_costs) || ""));
  const [eventDate, setEventDate] = useState((lossRow.event_date ?? "").slice(0, 10));
  const [eventPrecision, setEventPrecision] = useState<"exact" | "month">(
    (lossRow.event_precision as "exact" | "month") ?? "exact",
  );
  const [stockAction, setStockAction] = useState<"remove_from_stock" | "keep_in_stock">(
    (lossRow.stock_action as "remove_from_stock" | "keep_in_stock") ?? "remove_from_stock",
  );
  const [notes, setNotes] = useState(lossRow.notes ?? "");

  const [preview, setPreview] = useState<LossEditPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const payload = useMemo(
    () => ({
      customerRefund: customerRefund ? Number(customerRefund) : 0,
      otherCosts: otherCosts ? Number(otherCosts) : 0,
      eventDate: eventDate || undefined,
      eventPrecision,
      stockAction,
      notes: notes.trim() || null,
    }),
    [customerRefund, otherCosts, eventDate, eventPrecision, stockAction, notes],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const controller = new AbortController();
    debounceRef.current = setTimeout(() => {
      setPreviewError(null);
      fetch(`/api/losses/${lossRow.id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(json?.error || "Could not preview this edit.");
          setPreview(json as LossEditPreviewResponse);
        })
        .catch((e: unknown) => {
          if (e instanceof Error && e.name !== "AbortError") {
            setPreview(null);
            setPreviewError(e.message);
          }
        });
    }, 300);
    return () => {
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [lossRow.id, payload]);

  const blocked = (preview?.stockConflicts.length ?? 0) > 0;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/losses/${lossRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(json?.error || "Could not edit this loss.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not edit this loss.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Edit loss / write-off"
      onClose={onClose}
      wide
      busy={saving}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="button" disabled={saving || blocked} onClick={submit}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <p className={styles.footerNote}>
        {LOSS_TYPE_LABELS[lossRow.loss_type]} · {lossRow.itemTitle ?? lossRow.sku ?? "no linked item"} · qty {lossRow.quantity}
      </p>

      <div className="task-modal-grid">
        <label className="field">
          <span className="label">Event date</span>
          <input className="input" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Date precision</span>
          <select
            className="input"
            value={eventPrecision}
            onChange={(e) => setEventPrecision(e.target.value as "exact" | "month")}
          >
            <option value="exact">Exact day</option>
            <option value="month">Month only</option>
          </select>
        </label>
      </div>

      <label className="field">
        <span className="label">Stock</span>
        <select
          className="input"
          value={stockAction}
          onChange={(e) => setStockAction(e.target.value as "remove_from_stock" | "keep_in_stock")}
        >
          <option value="remove_from_stock">Removed from stock</option>
          <option value="keep_in_stock">Kept in stock (cost write-down only)</option>
        </select>
      </label>

      <div className="task-modal-grid">
        {lossRow.loss_type === "refund_without_return" ? (
          <label className="field">
            <span className="label">Customer refund (£)</span>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={customerRefund}
              onChange={(e) => setCustomerRefund(e.target.value)}
            />
          </label>
        ) : null}
        <label className="field">
          <span className="label">Other costs (£)</span>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={otherCosts}
            onChange={(e) => setOtherCosts(e.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span className="label">Notes</span>
        <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {previewError ? <p className="task-modal-error">{previewError}</p> : null}

      {preview && preview.lines.length > 0 ? (
        <div className={styles.detailCard}>
          <h3>Difference preview</h3>
          <div className={styles.diffList}>
            {preview.lines.map((l) => (
              <div key={l.label} className={styles.diffRow}>
                <span>{l.label}</span>
                <span className="before">{money(l.beforePence ?? 0)}</span>
                <span className="arrow">→</span>
                <strong>{money(l.afterPence ?? 0)}</strong>
              </div>
            ))}
          </div>
          <div className={styles.detailRow}>
            <span>Net profit impact change</span>
            <strong className={styles.negativeCell}>{impactMoney(preview.netProfitImpactDeltaPence)}</strong>
          </div>
          {preview.recognitionMonthChange ? (
            <div className={styles.detailRow}>
              <span>Recognition month</span>
              <strong>
                {preview.recognitionMonthChange.from ?? "—"} → {preview.recognitionMonthChange.to ?? "—"}
              </strong>
            </div>
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <p className="task-modal-error">
          Blocked: {preview?.stockConflicts.length} written-off unit(s) have changed stock state since. Resolve that
          first.
        </p>
      ) : null}
      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
