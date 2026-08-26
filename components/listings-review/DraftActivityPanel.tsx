"use client";

import { memo, useState } from "react";

export type ActivityEventTone = "sent" | "queue" | "progress" | "success" | "failure";

// One real, derived event per genuine state transition observed while
// polling an active extension batch (see ListingsReviewWorkspace.tsx's own
// comment on how these are built via diffing, never fabricated). `id` is a
// stable dedup key so the same transition is never appended twice;
// `detail` is only ever present on a still-in-progress "progress" event
// and is UPDATED in place as fresher step detail arrives, never appended
// as a new row.
//
// Multi-batch support — every event now carries its own immutable
// `batchId` (never the reusable display number alone) plus the display
// label/browser attribution already resolved by the parent at the moment
// the event was created, so a later-reused "Batch 1" number can never
// retroactively relabel an older event that belongs to a different batch.
export type ActivityEvent = {
  id: string;
  batchId: string;
  batchLabel: string;
  browserLabel?: string | null;
  tone: ActivityEventTone;
  message: string;
  detail?: string | null;
  timestampIso: string;
};

export type ActivityBatchFilter = { batchId: string; label: string };

const TONE_LABELS: Record<ActivityEventTone, string> = {
  sent: "Sent", queue: "Queued", progress: "In progress", success: "Success", failure: "Failed",
};

function formatShortTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const COLLAPSED_VISIBLE_COUNT = 6;

/**
 * Small, presentational right-rail panel beneath the inspector (reference
 * image 4) — every event it renders was already derived, filtered (by
 * batch), and capped by the parent (never fetches or computes anything
 * itself). "View all" only toggles between the capped slice and the full
 * already-filtered `events` array the parent hands in — there is no
 * second, larger backing store; nothing here is persisted. No Retry action
 * is rendered anywhere in this panel: the existing recourse for a failed
 * item (resend, via the table row/inspector overflow menu) is unchanged
 * and still available.
 *
 * Multi-batch support — still exactly ONE panel (never one per batch).
 * `filters` lists every batch whose activity isn't dismissed, in display
 * order; `events` is already scoped to `selectedFilter` by the parent.
 * The "Dismiss … activity" action only ever appears once a specific batch
 * (not "All") is selected, and only ever affects that one batch's own
 * activity — never the batch's processing, never its box, never any other
 * batch's events.
 */
function DraftActivityPanel({ events, isLive, filters, selectedFilter, onSelectFilter, onDismissActivity }: {
  events: ActivityEvent[];
  isLive: boolean;
  filters: ActivityBatchFilter[];
  selectedFilter: string;
  onSelectFilter: (filter: string) => void;
  onDismissActivity: (batchId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleEvents = showAll ? events : events.slice(0, COLLAPSED_VISIBLE_COUNT);
  const selectedFilterLabel = filters.find(f => f.batchId === selectedFilter)?.label ?? "batch";

  return <section className="lr-activity-panel" aria-label="Live activity">
    <div className="lr-activity-header">
      <h2>{isLive && <i aria-hidden="true" className="lr-activity-live-dot" />}Live activity</h2>
      {events.length > COLLAPSED_VISIBLE_COUNT && <button type="button" className="lr-activity-view-all" onClick={() => setShowAll(current => !current)}>
        {showAll ? "Show less" : "View all"}
      </button>}
    </div>

    {filters.length > 0 && <div className="lr-activity-filters" role="tablist" aria-label="Filter activity by batch">
      <button type="button" role="tab" aria-selected={selectedFilter === "all"} className={`lr-activity-filter-btn${selectedFilter === "all" ? " active" : ""}`} onClick={() => onSelectFilter("all")}>All</button>
      {filters.map(f => <button key={f.batchId} type="button" role="tab" aria-selected={selectedFilter === f.batchId} className={`lr-activity-filter-btn${selectedFilter === f.batchId ? " active" : ""}`} onClick={() => onSelectFilter(f.batchId)}>{f.label}</button>)}
    </div>}

    {selectedFilter !== "all" && filters.some(f => f.batchId === selectedFilter) && <button type="button" className="lr-activity-dismiss-batch" onClick={() => onDismissActivity(selectedFilter)}>
      Dismiss {selectedFilterLabel} activity
    </button>}

    {events.length === 0
      ? <div className="lr-activity-empty">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.2" /><path d="M9 6v3.2l2 1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <p>No extension activity yet.</p>
        </div>
      : <ul className="lr-activity-list" aria-live="polite" aria-relevant="additions">
          {visibleEvents.map(event => <li key={event.id} className={`lr-activity-row lr-activity-row-${event.tone}`}>
            <time className="lr-activity-time" dateTime={event.timestampIso}>{formatShortTimestamp(event.timestampIso)}</time>
            <i aria-hidden="true" className={`lr-activity-dot lr-activity-dot-${event.tone}`} />
            <div className="lr-activity-row-body">
              <span className="lr-activity-batch-tag">{event.batchLabel}{event.browserLabel ? ` · ${event.browserLabel}` : ""}</span>
              <span className="lr-activity-message">
                <span className="sr-only">{TONE_LABELS[event.tone]}: </span>
                {event.message}
              </span>
              {event.detail && <span className="lr-activity-detail">{event.detail}</span>}
            </div>
          </li>)}
        </ul>}
  </section>;
}

export default memo(DraftActivityPanel);
