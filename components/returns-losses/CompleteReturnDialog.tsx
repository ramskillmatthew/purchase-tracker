"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReturnsLossesListResponse, CompleteReturnPreviewResponse } from "@/lib/returns/api-contract";
import { money, impactMoney, displayDate } from "@/lib/returns/format";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

type ReturnRow = Extract<ReturnsLossesListResponse["rows"][number], { recordType: "return" }>;
type Outcome = "returned_safely" | "buyer_refunded_no_return";

export default function CompleteReturnDialog({
  returnRow,
  onClose,
  onSaved,
}: {
  returnRow: ReturnRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [completedOn, setCompletedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [precision, setPrecision] = useState<"exact" | "month">("exact");
  const [refundMode, setRefundMode] = useState<"full" | "partial">("full");
  const [partialRefund, setPartialRefund] = useState("");
  const [returnPostage, setReturnPostage] = useState("");
  const [unrecovered, setUnrecovered] = useState("");
  const [notes, setNotes] = useState("");

  const [preview, setPreview] = useState<CompleteReturnPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const body = useMemo(
    () => ({
      outcome,
      completedOn,
      completedPrecision: precision,
      refundMode,
      partialRefundAmount: refundMode === "partial" && partialRefund ? Number(partialRefund) : undefined,
      returnPostage: returnPostage ? Number(returnPostage) : 0,
      unrecoveredCosts: unrecovered ? Number(unrecovered) : 0,
      notes: notes.trim() || undefined,
    }),
    [outcome, completedOn, precision, refundMode, partialRefund, returnPostage, unrecovered, notes],
  );

  useEffect(() => {
    if (!outcome) {
      setPreview(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const controller = new AbortController();
    debounceRef.current = setTimeout(() => {
      setPreviewError(null);
      fetch(`/api/returns/${returnRow.id}/complete/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(json?.error || "Could not preview this completion.");
          setPreview(json as CompleteReturnPreviewResponse);
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
  }, [returnRow.id, body, outcome]);

  async function submit() {
    if (!outcome) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/returns/${returnRow.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(json?.error || "Could not complete this return.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not complete this return.");
      setSaving(false);
    }
  }

  const imp = preview?.impact;

  return (
    <Modal
      title="Complete return"
      onClose={onClose}
      wide
      busy={saving}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="button" disabled={!outcome || saving} onClick={submit}>
            {saving ? "Completing…" : "Complete return"}
          </button>
        </>
      }
    >
      <p className={styles.footerNote}>
        {returnRow.itemTitle ?? "Return"} · {returnRow.quantity} unit{returnRow.quantity === 1 ? "" : "s"} ·{" "}
        {returnRow.saleReference ? `sale ${displayDate(returnRow.saleDate)}` : "no linked sale"}
      </p>

      <div className="field">
        <span className="label">What happened to the item?</span>
        <div className={styles.outcomeChoices}>
          <button
            type="button"
            className={`${styles.outcomeChoice} ${outcome === "returned_safely" ? styles.selected : ""}`}
            onClick={() => setOutcome("returned_safely")}
          >
            <strong>Returned safely</strong>
            <span>Item is back and re-sellable. Its stock value is restored (a balance-sheet move, not profit).</span>
          </button>
          <button
            type="button"
            className={`${styles.outcomeChoice} ${outcome === "buyer_refunded_no_return" ? styles.selectedDanger : ""}`}
            onClick={() => setOutcome("buyer_refunded_no_return")}
          >
            <strong>Buyer refunded, item not returned</strong>
            <span>You refunded the buyer and the item is gone. Its cost is written off once.</span>
          </button>
        </div>
      </div>

      <div className="task-modal-grid">
        <label className="field">
          <span className="label">Completed on</span>
          <input className="input" type="date" value={completedOn} onChange={(e) => setCompletedOn(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Date precision</span>
          <select className="input" value={precision} onChange={(e) => setPrecision(e.target.value as "exact" | "month")}>
            <option value="exact">Exact day</option>
            <option value="month">Month only</option>
          </select>
        </label>
      </div>

      <div className="task-modal-grid">
        <label className="field">
          <span className="label">Refund</span>
          <select className="input" value={refundMode} onChange={(e) => setRefundMode(e.target.value as "full" | "partial")}>
            <option value="full">Full refund</option>
            <option value="partial">Partial refund</option>
          </select>
        </label>
        {refundMode === "partial" ? (
          <label className="field">
            <span className="label">Partial refund amount (£)</span>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={partialRefund}
              onChange={(e) => setPartialRefund(e.target.value)}
            />
          </label>
        ) : null}
      </div>

      <div className="task-modal-grid">
        <label className="field">
          <span className="label">Return postage you paid (£)</span>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={returnPostage}
            onChange={(e) => setReturnPostage(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">Unrecovered fees / other costs (£)</span>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={unrecovered}
            onChange={(e) => setUnrecovered(e.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span className="label">Notes (optional)</span>
        <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {previewError ? <p className="task-modal-error">{previewError}</p> : null}

      {imp && preview ? (
        <>
          <div className={styles.impactGrid}>
            <div className={styles.cell}>
              <span>Revenue reversed</span>
              <strong>{money(imp.revenueReversedPence)}</strong>
            </div>
            <div className={`${styles.cell} ${styles.total}`}>
              <span>Profit reversed</span>
              <strong>{money(imp.profitReversedPence)}</strong>
              <small>COGS-inclusive</small>
            </div>
            <div className={styles.cell}>
              <span>Extra return costs</span>
              <strong>{money(imp.extraCostsPence)}</strong>
            </div>
            {outcome === "buyer_refunded_no_return" ? (
              <div className={`${styles.cell} ${styles.total}`}>
                <span>Inventory written off</span>
                <strong>{money(imp.inventoryWriteOffPence)}</strong>
              </div>
            ) : (
              <div className={`${styles.cell} ${styles.reversed}`}>
                <span>Stock value restored</span>
                <strong>{money(imp.stockValueRestoredPence)}</strong>
                <small>balance sheet, not profit</small>
              </div>
            )}
            <div className={`${styles.cell} ${styles.total}`}>
              <span>Net profit impact</span>
              <strong>{impactMoney(imp.netProfitImpactPence)}</strong>
              <small>recognised {preview.recognitionMonth}</small>
            </div>
          </div>
          <p className={styles.footerNote}>{preview.accountingNote}</p>
        </>
      ) : null}

      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
