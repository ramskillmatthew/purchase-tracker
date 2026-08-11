import type { ExtensionBatchItemStatus } from "./extension-batch-schema";

// Listings Review redesign — the ONE place a listing's extension-workflow
// status is ever derived, from real batch-item + batch status (never a
// second/invented status system). Used identically by the live active-batch
// poll (components/listings-review/ListingsReviewWorkspace.tsx) and the
// page-load historical aggregate (listing_studio_latest_extension_status
// RPC, via app/api/listing-studio/listings-review/route.ts) — both feed
// this exact function the same two inputs.
//
// Deliberately kept separate from listing readiness (lib/listing-studio/
// listing-review.ts's computeListingReviewStatus) — a listing's displayed
// row status is `computeExtensionWorkflowStatus(...) ?? readinessStatus`,
// never a merge of the two concepts into one value.
export type ExtensionWorkflowStatus = "sent" | "in_queue" | "in_progress" | "drafted" | "failed";

export function computeExtensionWorkflowStatus(itemStatus: ExtensionBatchItemStatus | string, batchStatus: string): ExtensionWorkflowStatus | null {
  if (itemStatus === "completed") return "drafted";
  if (itemStatus === "failed") return "failed";
  if (itemStatus === "preparing" || itemStatus === "filling" || itemStatus === "saving") return "in_progress";
  if (itemStatus === "queued") {
    if (batchStatus === "pending_claim") return "sent";
    if (batchStatus === "claimed" || batchStatus === "in_progress") return "in_queue";
    // An expired-unclaimed or cancelled batch's still-queued item never
    // actually got any real extension attention — falls back to readiness.
    return null;
  }
  // "cancelled"/"paused" items, or any unrecognised status.
  return null;
}

export const WORKFLOW_STATUS_LABELS: Record<ExtensionWorkflowStatus, string> = {
  sent: "Sent to extension",
  in_queue: "In queue",
  in_progress: "Draft in progress",
  drafted: "Item drafted",
  failed: "Draft failed",
};

// Exact dot colours from the approved reference design — literal hex, not
// theme-derived, since these are a fixed status vocabulary shared across
// the table, the inspector, the KPI cards, the tabs, Live Activity, and
// toasts (one authoritative mapping, per that redesign's own requirement).
export const WORKFLOW_STATUS_TONE: Record<ExtensionWorkflowStatus, string> = {
  sent: "#8B7CFF",
  in_queue: "#7E8798",
  in_progress: "#3F8CFF",
  drafted: "#2FCB75",
  failed: "#FF4D57",
};

// Readiness tones, on the same exact palette (Ready reuses the same
// emerald as "drafted" — both mean "no outstanding problem"; Needs review
// is the one amber in the whole system).
export const READINESS_TONE_READY = "#2FCB75";
export const READINESS_TONE_NEEDS_REVIEW = "#F4AC32";

/**
 * The one place a truthful secondary line under a workflow status is ever
 * built — used identically by the table row and the inspector, so neither
 * can ever show a different secondary line for the same listing. Every
 * value is real, already-persisted data; nothing here is invented.
 * - In queue: the item's real, stored queue position (1-based for display).
 * - Draft in progress: the extension's own already-computed `detail`
 *   (richest — e.g. "Uploading photo 3 of 8"), falling back to a light
 *   humanisation of `currentStep` when only that is available.
 * - Item drafted: the real, confirmed Vinted draft id — never shown
 *   without one (a listing can only ever reach "drafted" status alongside
 *   a real id in the first place, per computeExtensionWorkflowStatus above).
 * - Failed: the real, stored error message (concise — callers truncate
 *   for the table/tight spaces; the inspector and activity show it in full).
 * - Every other status: no secondary line.
 */
const STEP_LABELS: Record<string, string> = {
  SET_TITLE: "Entering title",
  SET_DESCRIPTION: "Entering description",
  SET_CATEGORY: "Entering category",
  SET_BRAND: "Entering brand",
  SET_SIZE: "Entering size",
  SET_CONDITION: "Entering condition",
  SET_COLOURS: "Entering colours",
  SET_MATERIALS: "Entering material",
  SET_PRICE: "Setting price",
  UPLOAD_PHOTOS: "Uploading photos",
  SAVE_DRAFT: "Saving draft",
};

export function computeWorkflowSecondaryLine(input: {
  workflowStatus: ExtensionWorkflowStatus | null;
  queuePosition: number | null;
  currentStep: string | null;
  detail: string | null;
  vintedDraftId: string | null;
  errorMessage: string | null;
}): string | null {
  switch (input.workflowStatus) {
    case "in_queue":
      return input.queuePosition !== null ? `Position ${input.queuePosition + 1}` : null;
    case "in_progress":
      return input.detail || (input.currentStep ? (STEP_LABELS[input.currentStep] ?? input.currentStep) : null);
    case "drafted":
      return input.vintedDraftId ? `Draft #${input.vintedDraftId}` : null;
    case "failed":
      return input.errorMessage || null;
    default:
      return null;
  }
}

// Listings Review final-item workflow-status bug fix — the poll loop in
// ListingsReviewWorkspace.tsx used to decide "should I keep polling" from a
// `batchStatus` value read inside a setInterval callback whose enclosing
// effect only depends on [activeBatchId]; since that effect never re-runs
// on a batchStatus change (deliberately, so the interval itself isn't torn
// down/recreated every 4s), the `batchStatus` the callback actually saw was
// permanently frozen at whatever it was when the effect first ran — always
// null — so the intended "stop once terminal" check never actually fired.
// The fix replaces the interval with a self-rescheduling poll that always
// decides using the batch status it JUST fetched, never a frozen value —
// this constant/helper is the one place "terminal" is defined for a BATCH
// (distinct from isTerminalItemStatus, which is about one ITEM).
export const BATCH_TERMINAL_STATUSES = ["completed", "cancelled", "expired"] as const;

export function isBatchStatusTerminal(status: string): boolean {
  return (BATCH_TERMINAL_STATUSES as readonly string[]).includes(status);
}

// Because the poll loop above is now sequential (the next poll is only ever
// scheduled once the previous one has fully resolved and been applied),
// two requests from the same loop can never be in flight at once — this
// guard is defense in depth for any other source of a response arriving
// out of order (e.g. a future manual "refresh now" action), never required
// for the loop's own normal operation. `appliedSeq` is the sequence number
// of the most recently APPLIED response; a response is safe to apply only
// if its own sequence number is not older than that.
export function shouldApplyBatchPollResponse(appliedSeq: number, incomingSeq: number): boolean {
  return incomingSeq >= appliedSeq;
}

// Top-tab groupings (All / Ready / Needs review / Drafts / Sent) — "Sent"
// covers everything currently in flight (sent, queued behind another item,
// or actively being filled), "Drafts" covers only a genuinely completed
// Vinted draft. "Draft failed" is intentionally NOT one of the 5 top tabs
// (matching the reference image) — it stays reachable via the Filters
// control instead, so a failed listing is never hidden from view.
export const WORKFLOW_STATUS_TAB_GROUPS: { drafts: ExtensionWorkflowStatus[]; sent: ExtensionWorkflowStatus[] } = {
  drafts: ["drafted"],
  sent: ["sent", "in_queue", "in_progress"],
};
