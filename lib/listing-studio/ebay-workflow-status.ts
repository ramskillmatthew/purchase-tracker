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

// Exact label required for the completed state — "eBay draft completed",
// never "Unpublished"/"Offer created"/"Complete on eBay"/"Published"/"Live".
export const EBAY_WORKFLOW_STATUS_LABELS: Record<EbayWorkflowStatus, string> = {
  queued: "Queued",
  uploading_photos: "Uploading photos",
  creating_inventory_item: "Creating inventory item",
  creating_draft: "Creating draft",
  verifying_draft: "Verifying draft",
  completed: "eBay draft completed",
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
