"use client";

import { useState } from "react";
import type { ReturnsLossesListResponse } from "@/lib/returns/api-contract";
import { SALES_PROCESS_STATUS_OPTIONS } from "@/lib/sales/process-status";
import Modal from "./Modal";
import styles from "@/app/returns-losses/returns-losses.module.css";

type Row = ReturnsLossesListResponse["rows"][number];
const RESTORE_OPTIONS = SALES_PROCESS_STATUS_OPTIONS.filter((o) => o.value !== "return_in_process");

export default function DeleteReturnLossDialog({
  row,
  onClose,
  onSaved,
}: {
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isReturn = row.recordType === "return";
  const [restore, setRestore] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const url = isReturn ? `/api/returns/${row.id}` : `/api/losses/${row.id}`;
      const r = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isReturn && restore ? { confirm: true, restoreSaleStatus: restore } : { confirm: true }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(json?.error || "Could not delete this record.");
        setSaving(false);
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not delete this record.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={isReturn ? "Delete & reverse return" : "Delete & reverse loss"}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>
            Keep record
          </button>
          <button type="button" className="button-danger" disabled={saving} onClick={submit}>
            {saving ? "Reversing…" : "Delete & reverse"}
          </button>
        </>
      }
    >
      <p className={styles.footerNote}>
        This soft-deletes the record and reverses every stock and ledger movement it applied, exactly once. It is
        excluded from all KPIs and the dashboard net-profit adjustment afterwards.
        {isReturn ? " The original sale is never deleted." : ""}
      </p>
      {isReturn ? (
        <label className="field">
          <span className="label">Restore the linked sale to</span>
          <select className="input" value={restore} onChange={(e) => setRestore(e.target.value)}>
            <option value="">Its snapshotted previous status</option>
            {RESTORE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error ? <p className="task-modal-error">{error}</p> : null}
    </Modal>
  );
}
