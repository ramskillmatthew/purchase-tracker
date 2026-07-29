"use client";

import { useState } from "react";

/**
 * Circular arrival toggle — visually a smaller sibling of the task-circle
 * control (components/TaskRow.tsx) so it reuses the same design language
 * instead of inventing a new checkbox style. Fully self-contained: owns its
 * own optimistic/pending/error state and defers the actual save to the
 * caller's `onToggle`, so it drops into both the Purchases table and the
 * global search dropdown without either needing to know about pending
 * state.
 */
export default function ArrivalToggle({ id, arrived, description, onToggle, size = "sm" }: {
  id: string;
  arrived: boolean | null;
  description?: string | null;
  // Performs the PATCH and reports success — never mutates the caller's
  // purchase list itself, so the caller decides how (and whether) its own
  // state updates once the save actually lands.
  onToggle: (id: string, nextArrived: boolean) => Promise<boolean>;
  size?: "sm" | "md";
}) {
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  const done = optimistic ?? arrived === true;
  const label = (description ?? "").trim() || "this purchase";
  const actionLabel = done ? `Mark ${label} as not arrived` : `Mark ${label} as arrived`;

  async function handleClick(event: React.MouseEvent) {
    event.stopPropagation();
    if (pending) return;
    setPending(true);
    setError("");
    const next = !done;
    setOptimistic(next);
    const ok = await onToggle(id, next);
    setPending(false);
    // REGRESSION guard: on failure, restore exactly how it looked before the
    // press — never leave the control showing a state the database doesn't
    // actually have. On success, drop the local override since the caller's
    // own `arrived` prop has by now been updated to the same value.
    setOptimistic(null);
    if (!ok) setError("Could not save — try again.");
  }

  return <div className="arrival-toggle-wrap">
    <button
      type="button"
      className={`arrival-toggle arrival-toggle-${size}${done ? " arrival-toggle-done" : ""}`}
      onClick={handleClick}
      disabled={pending}
      aria-pressed={done}
      aria-label={actionLabel}
      title={actionLabel}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17l9-10" /></svg>
    </button>
    {error && <span className="arrival-toggle-error" role="alert">{error}</span>}
  </div>;
}
