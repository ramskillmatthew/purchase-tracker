"use client";

import { useState } from "react";
import { nextStockStatus } from "@/lib/purchases";
import type { StockStatus } from "@/lib/types";

/**
 * Row-level stock-status control — deliberately mirrors ArrivalToggle's
 * own self-contained optimistic/pending/error pattern (see that
 * component's own comment) rather than inventing a new one: owns its own
 * pending/optimistic/error state, defers the actual save to the caller's
 * `onToggle`, and never requires a confirmation dialog or opening the
 * purchase's edit screen. Visually reuses the existing .status-cell /
 * .status-yes / .status-no pill classes (previously the Purchases table's
 * own plain arrival label, before ArrivalToggle replaced it) so the two
 * stock states look native to this exact table rather than introducing a
 * new visual language.
 */
export default function StockStatusToggle({ id, stockStatus, description, onToggle }: {
  id: string;
  stockStatus: StockStatus;
  description?: string | null;
  // Performs the PATCH and reports success — never mutates the caller's
  // purchase list itself, so the caller decides how (and whether) its own
  // state updates, and whether to show a confirmation, once the save
  // actually lands.
  onToggle: (id: string, next: StockStatus) => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<StockStatus | null>(null);
  const [error, setError] = useState("");

  const current = optimistic ?? stockStatus;
  const inStock = current === "in_stock";
  const label = (description ?? "").trim() || "this purchase";
  const actionLabel = inStock ? `Mark ${label} as no longer in stock` : `Mark ${label} as in stock`;

  async function handleClick(event: React.MouseEvent) {
    event.stopPropagation();
    if (pending) return;
    setPending(true);
    setError("");
    const next = nextStockStatus(current);
    setOptimistic(next);
    const ok = await onToggle(id, next);
    setPending(false);
    // REGRESSION guard (same as ArrivalToggle): on failure, restore exactly
    // how it looked before the press — never leave the control showing a
    // state the database doesn't actually have. On success, drop the local
    // override since the caller's own `stockStatus` prop has by now been
    // updated to the same value.
    setOptimistic(null);
    if (!ok) setError("Could not save — try again.");
  }

  return <div className="stock-status-toggle-wrap">
    <button
      type="button"
      className={`status-cell stock-status-toggle ${inStock ? "status-yes" : "status-no"}`}
      onClick={handleClick}
      disabled={pending}
      aria-pressed={inStock}
      aria-label={actionLabel}
      title={actionLabel}
    >
      {inStock ? "In stock" : "No longer in stock"}
    </button>
    {error && <span className="stock-status-toggle-error" role="alert">{error}</span>}
  </div>;
}
