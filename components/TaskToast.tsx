"use client";

import { useEffect } from "react";

// No toast/notification component existed anywhere in the app before this
// — built as a small, reusable one rather than a one-off, reusing the
// app's existing surface/shadow/button tokens so it still looks native.
export default function TaskToast({ message, actionLabel, onAction, onDismiss, duration = 5000 }: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  duration?: number;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [onDismiss, duration]);

  return (
    <div className="task-toast" role="status">
      <span>{message}</span>
      {actionLabel && onAction && <button type="button" onClick={() => { onAction(); onDismiss(); }}>{actionLabel}</button>}
    </div>
  );
}
