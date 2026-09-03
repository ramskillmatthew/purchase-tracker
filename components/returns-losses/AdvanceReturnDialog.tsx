"use client";

import { useState } from "react";
import type { ReturnsLossesListResponse } from "@/lib/returns/api-contract";
import { RETURN_STATUS_LABELS } from "@/lib/returns/format";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

type ReturnRow = Extract<ReturnsLossesListResponse["rows"][number], { recordType: "return" }>;

const NEXT_STAGE: Record<string, "item_sent" | "return_delivered" | null> = {
  return_started: "item_sent",
  item_sent: "return_delivered",
};

export default function AdvanceReturnDialog({
  returnRow,
  onClose,
  onSaved,
}: {
  returnRow: ReturnRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const target = NEXT_STAGE[returnRow.workflow_status] ?? null;
  const [stage, setStage] = useState<"item_sent" | "return_delivered">(target ?? "item_sent");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [precision, setPrecision] = useState<"exact" | "month">("exact");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/returns/${returnRow.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, date, precision }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(json?.error || "Could not update this return's stage.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not update this return's stage.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Advance return status"
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="button" disabled={saving} onClick={submit}>
            {saving ? "Saving…" : "Advance"}
          </button>
        </>
      }
    >
      <p className={styles.footerNote}>
        Currently: <strong>{RETURN_STATUS_LABELS[returnRow.workflow_status]}</strong>. Completion and cancellation have
        their own actions.
      </p>
      <label className="field">
        <span className="label">Move to</span>
        <select className="input" value={stage} onChange={(e) => setStage(e.target.value as "item_sent" | "return_delivered")}>
          <option value="item_sent">Item sent</option>
          <option value="return_delivered">Return delivered</option>
        </select>
      </label>
      <div className="task-modal-grid">
        <label className="field">
          <span className="label">Date</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Date precision</span>
          <select className="input" value={precision} onChange={(e) => setPrecision(e.target.value as "exact" | "month")}>
            <option value="exact">Exact day</option>
            <option value="month">Month only</option>
          </select>
        </label>
      </div>
      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
