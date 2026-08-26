"use client";

import { useEffect } from "react";

// No toast/notification component existed anywhere in the app before this
// — built as a small, reusable one rather than a one-off, reusing the
// app's existing surface/shadow/button tokens so it still looks native.
//
// `position` — "center" (default) is the original bottom-center placement
// every existing call site (Tasks, Purchases "purchase added") already
// relies on, left completely unchanged. "bottom-right" is a same-
// component variant (identical border/shadow/radius/animation, just
// repositioned) used by the Purchases page's stock-status confirmation —
// Listings Review's own former bottom-right toast stack was removed
// entirely in an earlier redesign pass (it duplicated that page's Live
// Activity panel) and no longer exists anywhere to literally reuse, so
// this reconstructs the same visual pattern on the one existing,
// currently-live toast component instead of a new one-off.
export default function TaskToast({ message, actionLabel, onAction, onDismiss, duration = 5000, position = "center" }: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  duration?: number;
  position?: "center" | "bottom-right";
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [onDismiss, duration]);

  return (
    <div className={position === "bottom-right" ? "task-toast task-toast-bottom-right" : "task-toast"} role="status">
      <span>{message}</span>
      {actionLabel && onAction && <button type="button" onClick={() => { onAction(); onDismiss(); }}>{actionLabel}</button>}
    </div>
  );
}
