// Stage 6 (eBay draft batches) — the eBay equivalent of
// extension-workflow-status.ts, kept as its own file rather than folded
// into that one so neither marketplace's workflow vocabulary can ever leak
// into the other's (see this app's own "never collapse two marketplaces'
// workflow states into one shared status" architectural rule). Mirrors
// that file's conventions closely: one authoritative status->label/tone
// mapping, one secondary-line builder, both used identically by the table
// row and the inspector.

export const EBAY_DRAFT_ITEM_STATUSES = [
  "queued", "uploading_photos", "creating_inventory_item", "creating_draft", "verifying_draft", "completed", "failed", "cancelled",
] as const;
export type EbayDraftItemStatus = typeof EBAY_DRAFT_ITEM_STATUSES[number];

export const EBAY_DRAFT_BATCH_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type EbayDraftBatchStatus = typeof EBAY_DRAFT_BATCH_STATUSES[number];

// The status actually displayed for a row/inspector — everything except
// "cancelled" (a cancelled item's row falls back to plain content
// readiness, exactly like a cancelled Vinted extension-batch item does).
export type EbayWorkflowStatus = Exclude<EbayDraftItemStatus, "cancelled">;

export function computeEbayDraftWorkflowStatus(itemStatus: EbayDraftItemStatus | string): EbayWorkflowStatus | null {
  if (itemStatus === "cancelled") return null;
  if ((EBAY_DRAFT_ITEM_STATUSES as readonly string[]).includes(itemStatus)) return itemStatus as EbayWorkflowStatus;
  return null;
}

// CORRECTIVE PASS (Phase J — retiring this pipeline from active use) — the
// completed label was "eBay draft completed", which every user of this app
// would reasonably read as "a genuine eBay draft now exists". It never did:
// this pipeline (lib/listing-studio/ebay-draft-batches.ts) only ever calls
// the Inventory API's createOffer, producing an UNPUBLISHED offer that is
// never visible in Seller Hub — see
// lib/listing-studio/ebay-feed/feed-workflow-status.ts's own header for the
// full architecture story and the NEW pipeline that actually creates a
// genuine, editable Seller Hub draft. Every historical "completed" row from
// this retired pipeline is relabelled here with the truthful description of
// what it actually is — never deleted, never hidden, just no longer
// mis-described. New work no longer flows through this pipeline at all.
export const EBAY_WORKFLOW_STATUS_LABELS: Record<EbayWorkflowStatus, string> = {
  queued: "Queued",
  uploading_photos: "Uploading photos",
  creating_inventory_item: "Creating inventory item",
  creating_draft: "Creating draft",
  verifying_draft: "Verifying draft",
  completed: "Legacy unpublished API offer — not visible in Seller Hub",
  failed: "Failed",
};

// Reuses the exact same illuminated-dot palette
// lib/listing-studio/extension-workflow-status.ts already established for
// Vinted (never a visually distinct eBay colour system) — queued reuses the
// same purple as Vinted's "sent", every in-progress step reuses the same
// blue as Vinted's "in_progress", completed/failed reuse the same green/red.
export const EBAY_WORKFLOW_STATUS_TONE: Record<EbayWorkflowStatus, string> = {
  queued: "#8B7CFF",
  uploading_photos: "#3F8CFF",
  creating_inventory_item: "#3F8CFF",
  creating_draft: "#3F8CFF",
  verifying_draft: "#3F8CFF",
  completed: "#2FCB75",
  failed: "#FF4D57",
};

const IN_PROGRESS_STATUSES: readonly EbayWorkflowStatus[] = ["uploading_photos", "creating_inventory_item", "creating_draft", "verifying_draft"];
export function isEbayWorkflowInProgress(status: EbayWorkflowStatus | null): boolean {
  return status !== null && (IN_PROGRESS_STATUSES as string[]).includes(status);
}

export function isEbayBatchStatusTerminal(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

/**
 * The one place a truthful secondary line under an eBay workflow status is
 * ever built — mirrors computeWorkflowSecondaryLine's exact reasoning.
 * Every value shown is real, already-persisted data; nothing here is
 * invented. Deliberately never shows the offer id here (kept to a
 * restrained secondary technical-details area in the inspector instead,
 * per the product spec) — the row/table secondary line stays short.
 */
export function computeEbayWorkflowSecondaryLine(input: {
  workflowStatus: EbayWorkflowStatus | null;
  queuePosition: number | null;
  errorMessage: string | null;
}): string | null {
  switch (input.workflowStatus) {
    case "queued":
      return input.queuePosition !== null ? `Position ${input.queuePosition + 1}` : null;
    case "failed":
      return input.errorMessage || null;
    default:
      return null;
  }
}
