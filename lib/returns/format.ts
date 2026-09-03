import { RETURN_WORKFLOW_LABELS, type ReturnWorkflowStatus } from "@/lib/returns/status-sync";
import type { LossType } from "@/lib/returns/types";

/**
 * Client-safe display helpers for the Returns/Losses UI. Formatting only —
 * NEVER any authoritative calculation (those live in lib/returns/* server
 * modules and the Stage 1 API).
 */

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

/** Pence (integer) or a numeric/string pounds value → "£1,184.42". null/NaN → "£0.00". */
export function money(value: number | string | null | undefined, unit: "pence" | "pounds" = "pence"): string {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  if (!Number.isFinite(n)) return gbp.format(0);
  return gbp.format(unit === "pence" ? n / 100 : n);
}

/** A negative-impact pence figure as "−£18.21" (always shows the sign for non-zero). */
export function impactMoney(pence: number | string | null | undefined): string {
  const n = typeof pence === "string" ? Number(pence) : pence ?? 0;
  if (!Number.isFinite(n) || n === 0) return gbp.format(0);
  return `${n < 0 ? "−" : "+"}${gbp.format(Math.abs(n) / 100)}`;
}

export function percent(value: number | null | undefined): string {
  const n = value ?? 0;
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}%`;
}

export const RETURN_STATUS_LABELS = RETURN_WORKFLOW_LABELS;
export const RETURN_STATUS_TONE: Record<ReturnWorkflowStatus, string> = {
  return_started: "#e0a54b",   // amber — in progress
  item_sent: "#4b8fe0",        // blue — in transit
  // Vivid rose/pink-red: a return that has been DELIVERED back is an active
  // negative event for the P&L (the sale's profit is being reversed), so it
  // reads as a strong warning tone — distinct from the amber "started" and
  // the muted "#d96b6b" cancelled, and never green.
  return_delivered: "#ff5c7a",
  return_completed: "#36c98f", // green — resolved
  return_cancelled: "#d96b6b", // muted rose — no longer active
};

export const LOSS_TYPE_LABELS: Record<LossType, string> = {
  lost_inventory: "Lost inventory",
  unsellable_purchase: "Unsellable purchase",
  refund_without_return: "Refund without return",
  other_write_off: "Other write-off",
};

/** British date: "10/08/2026" for exact, "August 2026" for month-only. */
export function displayDate(iso: string | null | undefined, precision?: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m) return iso;
  if (precision === "month") {
    const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${names[Number(m) - 1]} ${y}`;
  }
  return `${d}/${m}/${y}`;
}

/** The canonical list of dashboard/report period presets, matching the rest of the app. */
export const RETURNS_PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "this-month", label: "This Month" },
  { value: "last-month", label: "Last Month" },
  { value: "last-3-months", label: "Last 3 Months" },
  { value: "this-year", label: "This Year" },
  { value: "last-year", label: "Last Year" },
  { value: "all-time", label: "All Time" },
  { value: "custom", label: "Custom Range" },
] as const;
