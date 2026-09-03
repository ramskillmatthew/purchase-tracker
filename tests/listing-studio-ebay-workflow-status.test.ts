import { describe, expect, it } from "vitest";
import {
  computeEbayDraftWorkflowStatus, computeEbayWorkflowSecondaryLine, isEbayBatchStatusTerminal, isEbayWorkflowInProgress,
  EBAY_WORKFLOW_STATUS_LABELS, EBAY_WORKFLOW_STATUS_TONE,
} from "@/lib/listing-studio/ebay-workflow-status";

describe("computeEbayDraftWorkflowStatus", () => {
  it("maps every real item status through except cancelled", () => {
    expect(computeEbayDraftWorkflowStatus("queued")).toBe("queued");
    expect(computeEbayDraftWorkflowStatus("uploading_photos")).toBe("uploading_photos");
    expect(computeEbayDraftWorkflowStatus("completed")).toBe("completed");
    expect(computeEbayDraftWorkflowStatus("failed")).toBe("failed");
  });
  it("a cancelled item falls back to null (readiness display) — never shown as its own status", () => {
    expect(computeEbayDraftWorkflowStatus("cancelled")).toBeNull();
  });
  it("an unrecognised status is treated safely as null, never a crash", () => {
    expect(computeEbayDraftWorkflowStatus("something_unexpected")).toBeNull();
  });
});

describe("EBAY_WORKFLOW_STATUS_LABELS", () => {
  it("uses exactly \"eBay draft completed\" for the completed state — never Unpublished/Offer created/Complete on eBay/Published/Live", () => {
    expect(EBAY_WORKFLOW_STATUS_LABELS.completed).toBe("eBay draft completed");
  });
  it("every status has a label and a tone — no gaps", () => {
    for (const status of Object.keys(EBAY_WORKFLOW_STATUS_LABELS) as Array<keyof typeof EBAY_WORKFLOW_STATUS_LABELS>) {
      expect(EBAY_WORKFLOW_STATUS_LABELS[status]).toBeTruthy();
      expect(EBAY_WORKFLOW_STATUS_TONE[status]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("isEbayWorkflowInProgress / isEbayBatchStatusTerminal", () => {
  it("only the four real processing steps pulse as in-progress", () => {
    expect(isEbayWorkflowInProgress("uploading_photos")).toBe(true);
    expect(isEbayWorkflowInProgress("creating_inventory_item")).toBe(true);
    expect(isEbayWorkflowInProgress("creating_draft")).toBe(true);
    expect(isEbayWorkflowInProgress("verifying_draft")).toBe(true);
    expect(isEbayWorkflowInProgress("queued")).toBe(false);
    expect(isEbayWorkflowInProgress("completed")).toBe(false);
    expect(isEbayWorkflowInProgress(null)).toBe(false);
  });
  it("completed/cancelled batches are terminal; pending/in_progress are not", () => {
    expect(isEbayBatchStatusTerminal("completed")).toBe(true);
    expect(isEbayBatchStatusTerminal("cancelled")).toBe(true);
    expect(isEbayBatchStatusTerminal("pending")).toBe(false);
    expect(isEbayBatchStatusTerminal("in_progress")).toBe(false);
  });
});

describe("computeEbayWorkflowSecondaryLine", () => {
  it("queued shows a 1-based queue position", () => {
    expect(computeEbayWorkflowSecondaryLine({ workflowStatus: "queued", queuePosition: 2, errorMessage: null })).toBe("Position 3");
  });
  it("failed shows the real stored error message", () => {
    expect(computeEbayWorkflowSecondaryLine({ workflowStatus: "failed", queuePosition: null, errorMessage: "Shipping policy is no longer available" }))
      .toBe("Shipping policy is no longer available");
  });
  it("completed never leaks the offer id or any other technical detail into the row's secondary line", () => {
    expect(computeEbayWorkflowSecondaryLine({ workflowStatus: "completed", queuePosition: null, errorMessage: null })).toBeNull();
  });
  it("an in-progress step has no secondary line beyond its own label", () => {
    expect(computeEbayWorkflowSecondaryLine({ workflowStatus: "uploading_photos", queuePosition: null, errorMessage: null })).toBeNull();
  });
});
