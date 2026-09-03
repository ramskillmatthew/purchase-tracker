"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReturnsLossesListResponse, ReturnEditPreviewResponse } from "@/lib/returns/api-contract";
import { money, impactMoney } from "@/lib/returns/format";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

type ReturnRow = Extract<ReturnsLossesListResponse["rows"][number], { recordType: "return" }>;

const n = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));

export default function EditReturnDialog({
  returnRow,
  onClose,
  onSaved,
}: {
  returnRow: ReturnRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const completed = returnRow.workflow_status === "return_completed";
  const [outcome, setOutcome] = useState<"returned_safely" | "buyer_refunded_no_return">(
    (returnRow.outcome as "returned_safely" | "buyer_refunded_no_return") ?? "returned_safely",
  );
  const [completedOn, setCompletedOn] = useState((returnRow.completed_on ?? "").slice(0, 10));
  const [completedPrecision, setCompletedPrecision] = useState<"exact" | "month">(
    (returnRow.completed_precision as "exact" | "month") ?? "exact",
  );
  const [returnPostage, setReturnPostage] = useState(String(n(returnRow.return_postage) || ""));
  const [unrecovered, setUnrecovered] = useState(String(n(returnRow.unrecovered_costs) || ""));
  const [otherCosts, setOtherCosts] = useState(String(n(returnRow.other_costs) || ""));
  const [notes, setNotes] = useState(returnRow.notes ?? "");

  const [preview, setPreview] = useState<ReturnEditPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const payload = useMemo(() => {
    const p: Record<string, unknown> = {
      returnPostage: returnPostage ? Number(returnPostage) : 0,
      unrecoveredCosts: unrecovered ? Number(unrecovered) : 0,
      otherCosts: otherCosts ? Number(otherCosts) : 0,
      notes: notes.trim() || null,
    };
    if (completed) {
      p.outcome = outcome;
      if (completedOn) {
        p.completedOn = completedOn;
        p.completedPrecision = completedPrecision;
      }
    }
    return p;
  }, [completed, outcome, completedOn, completedPrecision, returnPostage, unrecovered, otherCosts, notes]);

  useEffect(() => {
    if (!completed) {
      setPreview(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const controller = new AbortController();
    debounceRef.current = setTimeout(() => {
      setPreviewError(null);
      fetch(`/api/returns/${returnRow.id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(json?.error || "Could not preview this edit.");
          setPreview(json as ReturnEditPreviewResponse);
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
  }, [returnRow.id, payload, completed]);

  const blocked = (preview?.stockConflicts.length ?? 0) > 0;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/returns/${returnRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(json?.error || "Could not edit this return.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not edit this return.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Edit return"
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
      {completed ? (
        <label className="field">
          <span className="label">Outcome</span>
          <select
            className="input"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as "returned_safely" | "buyer_refunded_no_return")}
          >
            <option value="returned_safely">Returned safely</option>
            <option value="buyer_refunded_no_return">Buyer refunded, item not returned</option>
          </select>
        </label>
      ) : (
        <p className={styles.footerNote}>
          This return is not completed yet — changes are stored and applied when it completes.
        </p>
      )}

      {completed ? (
        <div className="task-modal-grid">
          <label className="field">
            <span className="label">Completed on</span>
            <input className="input" type="date" value={completedOn} onChange={(e) => setCompletedOn(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Date precision</span>
            <select
              className="input"
              value={completedPrecision}
              onChange={(e) => setCompletedPrecision(e.target.value as "exact" | "month")}
            >
              <option value="exact">Exact day</option>
              <option value="month">Month only</option>
            </select>
          </label>
        </div>
      ) : null}

      <div className="task-modal-grid">
        <label className="field">
          <span className="label">Return postage (£)</span>
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
          <span className="label">Unrecovered fees (£)</span>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={unrecovered}
            onChange={(e) => setUnrecovered(e.target.value)}
          />
        </label>
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
          {preview.movementsToApply || preview.movementsToReverse ? (
            <p className={styles.footerNote}>
              {preview.movementsToReverse} stock movement(s) reversed · {preview.movementsToApply} applied.
            </p>
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <p className="task-modal-error">
          Blocked: {preview?.stockConflicts.length} affected unit(s) have changed stock state since completion. Resolve
          that first.
        </p>
      ) : null}
      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
