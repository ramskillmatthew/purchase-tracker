"use client";

import { useEffect } from "react";

export default function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onCancel(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close">×</button>
      <div className="dialog-danger-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 8.5v9m7-9v9M5 6h14M9 6V3.8h6V6m2.5 0-.7 14H7.2L6.5 6" /></svg></div>
      <div className="dialog-copy"><p className="dialog-eyebrow">Permanent action</p><h2 id="confirm-title">{title}</h2><p id="confirm-message">{message}</p></div>
      <div className="dialog-actions"><button type="button" className="dialog-cancel" onClick={onCancel}>Keep records</button><button type="button" className="dialog-confirm" onClick={onConfirm}>{confirmLabel}</button></div>
    </div>
  </div>;
}
