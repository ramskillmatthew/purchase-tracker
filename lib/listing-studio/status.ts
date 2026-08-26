import type { ListingDraftStatus } from "./types";

// Stage 1 spec §12 deliberately excludes any browser-listing status
// ("Do not add browser-listing statuses yet") — this table is exhaustive
// for Stage 1 and must not grow ad hoc elsewhere.
const STATUS_TRANSITIONS: Record<ListingDraftStatus, readonly ListingDraftStatus[]> = {
  uploading: ["grouping", "failed"],
  grouping: ["analysing", "needs_review", "failed"],
  analysing: ["needs_review", "ready", "failed"],
  needs_review: ["analysing", "ready", "archived"],
  ready: ["needs_review", "archived"],
  failed: ["grouping", "analysing", "archived"],
  archived: ["needs_review"],
};

/**
 * Pure state-machine shape check only — does NOT know whether the draft's
 * data actually qualifies for the target status. Marking "ready" additionally
 * requires the caller to have run lib/listing-studio/readiness.ts's
 * validateDraftReadiness() and passed a true result — see canMarkReady below.
 */
export function isValidStatusTransition(from: ListingDraftStatus, to: ListingDraftStatus): boolean {
  if (from === to) return false;
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The specific gate for the one status transition that must never happen on
 * structure alone: reaching "ready" also requires validateDraftReadiness()
 * to report the draft is actually complete.
 */
export function canMarkReady(from: ListingDraftStatus, readiness: { ready: boolean }): boolean {
  return isValidStatusTransition(from, "ready") && readiness.ready;
}

/**
 * Shapes a listing_status_history row. Deliberately does not stamp
 * created_at/id/draft_id here — those are assigned at the DB-write layer
 * (Milestone 2+), keeping this function a pure, timestamp-free shape-builder
 * that's trivial to test.
 */
export function buildStatusHistoryEntry(previousStatus: ListingDraftStatus | null, newStatus: ListingDraftStatus, reason?: string | null): { previousStatus: ListingDraftStatus | null; newStatus: ListingDraftStatus; reason: string | null } {
  return { previousStatus, newStatus, reason: reason ?? null };
}
