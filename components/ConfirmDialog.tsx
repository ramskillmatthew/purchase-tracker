"use client";

import { useEffect } from "react";

export default function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel, confirming = false, confirmingLabel, error }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  // Optional — callers that run an async delete in place (rather than
  // closing the dialog immediately) pass these to disable both buttons and
  // show progress/error state without closing on a failed attempt. Every
  // existing caller omits them and keeps its prior immediate-close behaviour.
  confirming?: boolean;
  confirmingLabel?: string;
  error?: string;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !confirming) onCancel(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, confirming]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !confirming) onCancel(); }}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close" disabled={confirming}>×</button>
      <div className="dialog-danger-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 8.5v9m7-9v9M5 6h14M9 6V3.8h6V6m2.5 0-.7 14H7.2L6.5 6" /></svg></div>
      <div className="dialog-copy"><p className="dialog-eyebrow">Permanent action</p><h2 id="confirm-title">{title}</h2><p id="confirm-message">{message}</p></div>
      {error && <p className="import-select-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="dialog-cancel" onClick={onCancel} disabled={confirming}>Keep records</button><button type="button" className="dialog-confirm" onClick={onConfirm} disabled={confirming}>{confirming ? (confirmingLabel ?? "Deleting…") : confirmLabel}</button></div>
    </div>
  </div>;
}
