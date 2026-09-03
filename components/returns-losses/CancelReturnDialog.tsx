"use client";

import { useState } from "react";
import type { ReturnsLossesListResponse } from "@/lib/returns/api-contract";
import { SALES_PROCESS_STATUS_OPTIONS } from "@/lib/sales/process-status";
import { RETURN_STATUS_LABELS } from "@/lib/returns/format";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

type ReturnRow = Extract<ReturnsLossesListResponse["rows"][number], { recordType: "return" }>;

const RESTORE_OPTIONS = SALES_PROCESS_STATUS_OPTIONS.filter((o) => o.value !== "return_in_process");

export default function CancelReturnDialog({
  returnRow,
  onClose,
  onSaved,
}: {
  returnRow: ReturnRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [restore, setRestore] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasCompleted = returnRow.workflow_status === "return_completed";

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/returns/${returnRow.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(restore ? { restoreSaleStatus: restore } : {}),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(json?.error || "Could not cancel this return.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not cancel this return.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Cancel return"
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>
            Keep return
          </button>
          <button type="button" className="button-danger" disabled={saving} onClick={submit}>
            {saving ? "Cancelling…" : "Cancel return"}
          </button>
        </>
      }
    >
      <p className={styles.footerNote}>
        This return is <strong>{RETURN_STATUS_LABELS[returnRow.workflow_status]}</strong>.
        {wasCompleted
          ? " Cancelling reverses the exact stock and ledger movements its completion applied, once."
          : " No financial movements have been applied yet."}
      </p>
      <label className="field">
        <span className="label">Restore the linked sale to</span>
        <select className="input" value={restore} onChange={(e) => setRestore(e.target.value)}>
          <option value="">Its previous status (snapshotted when the return was logged)</option>
          {RESTORE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.footerNote}>The original sale itself is never deleted — only its process status changes.</p>
      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
