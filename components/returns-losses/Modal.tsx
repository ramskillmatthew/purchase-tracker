"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";

/**
 * Shared shell for every Returns / Losses dialog — reuses the app's existing
 * `.task-modal.investment-modal` design-system classes (backdrop, heading,
 * body, actions) plus Escape-to-close and backdrop-click-to-close, matching
 * ConfirmDialog / RecordTransactionModal.
 */
export default function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  busy = false,
  labelledBy = "rl-modal-title",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
  busy?: boolean;
  labelledBy?: string;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="task-modal investment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={wide ? { width: "min(880px, 96vw)" } : undefined}
      >
        <div className="task-modal-heading">
          <h2 id={labelledBy}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" disabled={busy}>
            ×
          </button>
        </div>
        <div className="task-modal-body">{children}</div>
        <div className="task-modal-actions">{footer}</div>
      </div>
    </div>
  );
}
