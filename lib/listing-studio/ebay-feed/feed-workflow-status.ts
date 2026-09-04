// The Sell Feed API equivalent of lib/listing-studio/ebay-workflow-status.ts
// — kept as its own file for the same reason that one is kept separate from
// Vinted's: no marketplace's (and, here, no PIPELINE's — this is a
// genuinely different mechanism from the retired Inventory API pipeline,
// see lib/ebay-account/feed-client.ts's own header) workflow vocabulary may
// leak into another's.
//
// TERMINOLOGY — deliberately never "Published"/"Live"/"Listed" anywhere in
// this file: this pipeline creates an editable Seller Hub DRAFT, which the
// user must open and manually publish themselves in Seller Hub. Also never
// "Offer created"/"Unpublished" (the old, retired Inventory-API-pipeline's
// own vocabulary, kept in ebay-workflow-status.ts for the legacy batches
// that vocabulary still describes) — this pipeline's success state is
// exactly "Seller Hub draft created".

export const EBAY_FEED_BATCH_STATUSES = [
  "queued", "generating_csv", "creating_task", "uploading", "processing",
  "downloading_result", "parsing_result",
  "completed", "completed_with_errors", "failed", "cancelled",
] as const;
export type EbayFeedBatchStatus = typeof EBAY_FEED_BATCH_STATUSES[number];

export const EBAY_FEED_ITEM_STATUSES = ["queued", "uploaded", "awaiting_result", "succeeded", "failed", "cancelled"] as const;
export type EbayFeedItemStatus = typeof EBAY_FEED_ITEM_STATUSES[number];

// The status actually displayed for a row — everything except "cancelled"
// (a cancelled item falls back to null/readiness display), mirroring
// ebay-workflow-status.ts's own EbayWorkflowStatus/computeEbayDraftWorkflowStatus
// exactly.
export type EbayFeedWorkflowStatus = Exclude<EbayFeedItemStatus, "cancelled">;

export function computeEbayFeedItemWorkflowStatus(itemStatus: EbayFeedItemStatus | string | null | undefined): EbayFeedWorkflowStatus | null {
  if (!itemStatus || itemStatus === "cancelled") return null;
  if ((EBAY_FEED_ITEM_STATUSES as readonly string[]).includes(itemStatus)) return itemStatus as EbayFeedWorkflowStatus;
  return null;
}

export function isEbayFeedBatchStatusTerminal(status: string): boolean {
  return status === "completed" || status === "completed_with_errors" || status === "failed" || status === "cancelled";
}

export const EBAY_FEED_BATCH_STATUS_LABELS: Record<EbayFeedBatchStatus, string> = {
  queued: "Queued",
  generating_csv: "Preparing your draft file",
  creating_task: "Starting eBay upload",
  uploading: "Uploading to eBay",
  processing: "eBay is processing your drafts",
  downloading_result: "Retrieving results from eBay",
  parsing_result: "Reviewing results",
  completed: "Seller Hub drafts created",
  completed_with_errors: "Seller Hub drafts created (some failed)",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const EBAY_FEED_ITEM_STATUS_LABELS: Record<EbayFeedItemStatus, string> = {
  queued: "Queued",
  uploaded: "Uploaded to eBay",
  awaiting_result: "Waiting for eBay",
  succeeded: "Seller Hub draft created",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Same illuminated-dot palette every other workflow status system in this
// app already uses (see ebay-workflow-status.ts's own comment) — never a
// visually distinct system for this pipeline.
export const EBAY_FEED_BATCH_STATUS_TONE: Record<EbayFeedBatchStatus, string> = {
  queued: "#8B7CFF",
  generating_csv: "#3F8CFF",
  creating_task: "#3F8CFF",
  uploading: "#3F8CFF",
  processing: "#3F8CFF",
  downloading_result: "#3F8CFF",
  parsing_result: "#3F8CFF",
  completed: "#2FCB75",
  completed_with_errors: "#F5A623",
  failed: "#FF4D57",
  cancelled: "#8A8F98",
};

const IN_PROGRESS_BATCH_STATUSES: readonly EbayFeedBatchStatus[] = [
  "generating_csv", "creating_task", "uploading", "processing", "downloading_result", "parsing_result",
];
export function isEbayFeedBatchInProgress(status: EbayFeedBatchStatus | string): boolean {
  return (IN_PROGRESS_BATCH_STATUSES as string[]).includes(status);
}

// PHASE 4 (Listings Review UI wiring) — the per-ITEM equivalents of the
// batch-level maps above, for the single-listing "workflow" chip
// (ListingsTable's own eBay column, ListingDetailsPanel's own eBay tab) —
// mirrors ebay-workflow-status.ts's own EBAY_WORKFLOW_STATUS_TONE /
// isEbayWorkflowInProgress / computeEbayWorkflowSecondaryLine exactly, for
// this pipeline's own item-status vocabulary.
export const EBAY_FEED_ITEM_STATUS_TONE: Record<EbayFeedItemStatus, string> = {
  queued: "#8B7CFF",
  uploaded: "#3F8CFF",
  awaiting_result: "#3F8CFF",
  succeeded: "#2FCB75",
  failed: "#FF4D57",
  cancelled: "#8A8F98",
};

const IN_PROGRESS_ITEM_STATUSES: readonly EbayFeedItemStatus[] = ["queued", "uploaded", "awaiting_result"];
export function isEbayFeedItemInProgress(status: EbayFeedItemStatus | null): boolean {
  return status !== null && (IN_PROGRESS_ITEM_STATUSES as string[]).includes(status);
}

/** The one place a truthful secondary line under a per-listing eBay Feed
 * workflow status is ever built — mirrors
 * ebay-workflow-status.ts's own computeEbayWorkflowSecondaryLine exactly.
 * Every value shown is real, already-persisted data. */
export function computeEbayFeedWorkflowSecondaryLine(input: {
  itemStatus: EbayFeedItemStatus | null;
  queuePosition: number | null;
  errorMessage: string | null;
}): string | null {
  switch (input.itemStatus) {
    case "queued":
      return input.queuePosition !== null ? `Position ${input.queuePosition + 1}` : null;
    case "failed":
      return input.errorMessage || null;
    default:
      return null;
  }
}

/** The link every "completed" surface (batch card, activity row, per-item
 * success state) offers so the user can go review and manually publish
 * their new drafts themselves — this application never auto-publishes, so
 * this link is not a convenience shortcut past that, it IS the next
 * required step. */
export const SELLER_HUB_DRAFTS_URL = "https://www.ebay.co.uk/sh/lst/drafts";

// ---------------------------------------------------------------------
// CORRECTIVE PASS (duplicate-submission defect, second failed-submission
// audit) — one shared, single-source-of-truth notion of "does this
// listing currently have a Seller Hub Feed submission that should block
// (or redirect) a plain 'Create' action", used identically by:
//   - the server (lib/listing-studio/ebay-feed/feed-batches.ts's own
//     resolveFeedBatchBlockingStates, feeding both the preview builder
//     and the real batch-creation eligibility check)
//   - the listings-review API route (attaches the already-computed result
//     onto each row, so the client never has to re-derive it from raw
//     status fields)
//   - the client (ListingsReviewWorkspace.tsx's own ebayEligibilityById,
//     which mirrors the server's eligibility check exactly)
// so all three can never disagree about whether a listing is currently
// blocked, and why.

export type EbayFeedBatchBlockingState =
  | { kind: "none" }
  /** A still-in-flight (non-terminal-batch) item — the ordinary "this
   * listing is already being processed" case. */
  | { kind: "active"; batchId: string; displayNumber: number }
  /** The listing's most recent Seller Hub Feed attempt ended in a FAILED
   * batch and was never retried — must not silently become eligible for a
   * brand-new "Create" again (Phase 6's explicit requirement); the UI
   * offers a deliberate "Retry Seller Hub draft" action for this case
   * instead. */
  | { kind: "failed"; batchId: string; displayNumber: number }
  /** CORRECTIVE PASS (third real-submission audit — the live Batch #1/
   * SKU 1644 inconsistency) — the parent batch has already reached a
   * TERMINAL status, but this item's own row was never updated to match
   * (it is still queued/uploaded/awaiting_result). This is a genuine data
   * inconsistency, never a still-active submission: it can only exist for
   * a batch that failed BEFORE markBatchFailed's own item-cascade fix
   * existed (see feed-batches.ts's own markBatchFailed comment), or from
   * some other bug that left the same shape. Deliberately distinct from
   * both "active" (which would wrongly claim this is still genuinely
   * working) and "failed" (which would offer a Retry that first needs
   * this inconsistency resolved) — the UI must require an explicit
   * reconciliation step (see feed-batches.ts's own
   * reconcileInconsistentFailedFeedBatchItems) before Retry is ever
   * offered for this listing. */
  | { kind: "needs_reconciliation"; batchId: string; displayNumber: number };

/** Shared, byte-identical copy for the "needs_reconciliation" state —
 * defined once here so the table row, the inspector panel, and the
 * blocking-reason text can never drift apart on wording. */
export const NEEDS_RECONCILIATION_LABEL = "Failed — local batch state needs reconciliation";
export const NEEDS_RECONCILIATION_SECONDARY_LINE = "This attempt failed before eBay was ever contacted, but its local record wasn't fully updated. Nothing reached eBay — reconcile it before retrying.";
// CORRECTIVE PASS (fourth real-submission audit — Phase 7 error
// presentation) — a genuinely short variant for the narrow table
// workflow cell specifically ("Workflow cell should say only: Ready/
// Queued/Processing/Failed/Draft created" — no long prose, even as a
// secondary line). The fuller NEEDS_RECONCILIATION_SECONDARY_LINE above
// is still used by the wider inspector panel and the full-width status
// panel, which both have room for it.
export const NEEDS_RECONCILIATION_SHORT_HINT = "Nothing reached eBay — see status panel";

/** Pure function over already-fetched status fields — never fetches
 * anything itself. `displayNumberByBatchId` may be a Map (server-internal
 * use) or a plain object (safe to build directly from a JSON API
 * response, which can never carry a Map). `batch_status`/`ebay_task_id`
 * are optional ONLY for backward compatibility with call sites that
 * predate this corrective pass and cannot supply them (they simply never
 * see "needs_reconciliation" — every real call site now supplies both). */
export function computeEbayFeedBatchBlockingState(
  status: { batch_id: string; item_status: string; batch_status?: string; ebay_task_id?: string | null } | null,
  displayNumberByBatchId: Map<string, number> | Record<string, number>,
): EbayFeedBatchBlockingState {
  if (!status) return { kind: "none" };
  const displayNumber = displayNumberByBatchId instanceof Map
    ? (displayNumberByBatchId.get(status.batch_id) ?? 0)
    : (displayNumberByBatchId[status.batch_id] ?? 0);
  const itemInProgress = isEbayFeedItemInProgress(status.item_status as EbayFeedItemStatus);
  if (itemInProgress && status.batch_status !== undefined && isEbayFeedBatchStatusTerminal(status.batch_status)) {
    // The parent already reached a terminal outcome (failed, completed,
    // completed_with_errors, or cancelled) but this item still looks
    // in-progress — a stale, inconsistent local row, never a genuinely
    // still-active submission. Checked BEFORE the ordinary "active"
    // branch below specifically so a stale row can never be misreported
    // as "still working".
    return { kind: "needs_reconciliation", batchId: status.batch_id, displayNumber };
  }
  if (itemInProgress) {
    return { kind: "active", batchId: status.batch_id, displayNumber };
  }
  if (status.item_status === "failed") {
    return { kind: "failed", batchId: status.batch_id, displayNumber };
  }
  return { kind: "none" };
}
