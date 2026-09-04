import { describe, expect, it } from "vitest";
import {
  EBAY_FEED_BATCH_STATUSES, EBAY_FEED_ITEM_STATUSES,
  EBAY_FEED_BATCH_STATUS_LABELS, EBAY_FEED_ITEM_STATUS_LABELS, EBAY_FEED_ITEM_STATUS_TONE,
  isEbayFeedBatchStatusTerminal, isEbayFeedBatchInProgress, isEbayFeedItemInProgress,
  computeEbayFeedWorkflowSecondaryLine, computeEbayFeedItemWorkflowStatus, SELLER_HUB_DRAFTS_URL,
  computeEbayFeedBatchBlockingState,
} from "@/lib/listing-studio/ebay-feed/feed-workflow-status";

describe("eBay Feed workflow terminology — never implies auto-publish or reuses the retired Inventory API pipeline's vocabulary", () => {
  it("no label anywhere claims the listing is Published/Live/Listed", () => {
    const allLabels = [...Object.values(EBAY_FEED_BATCH_STATUS_LABELS), ...Object.values(EBAY_FEED_ITEM_STATUS_LABELS)];
    for (const label of allLabels) {
      expect(label, label).not.toMatch(/\bpublish(ed)?\b/i);
      expect(label, label).not.toMatch(/\blive\b/i);
      expect(label, label).not.toMatch(/\blisted\b/i);
    }
  });

  it("no label reuses the retired Inventory API pipeline's own terminology (Offer created / Unpublished)", () => {
    const allLabels = [...Object.values(EBAY_FEED_BATCH_STATUS_LABELS), ...Object.values(EBAY_FEED_ITEM_STATUS_LABELS)];
    for (const label of allLabels) {
      expect(label, label).not.toMatch(/offer created/i);
      expect(label, label).not.toMatch(/unpublished/i);
    }
  });

  it("the success label is exactly 'Seller Hub drafts created' / 'Seller Hub draft created'", () => {
    expect(EBAY_FEED_BATCH_STATUS_LABELS.completed).toBe("Seller Hub drafts created");
    expect(EBAY_FEED_ITEM_STATUS_LABELS.succeeded).toBe("Seller Hub draft created");
  });

  it("every status in the vocabulary has a label — no silent gap", () => {
    for (const status of EBAY_FEED_BATCH_STATUSES) expect(EBAY_FEED_BATCH_STATUS_LABELS[status]).toBeTruthy();
    for (const status of EBAY_FEED_ITEM_STATUSES) expect(EBAY_FEED_ITEM_STATUS_LABELS[status]).toBeTruthy();
  });

  it("terminal/in-progress classification is exhaustive and non-overlapping", () => {
    for (const status of EBAY_FEED_BATCH_STATUSES) {
      const terminal = isEbayFeedBatchStatusTerminal(status);
      const inProgress = isEbayFeedBatchInProgress(status);
      expect(terminal && inProgress, status).toBe(false);
    }
    expect(isEbayFeedBatchStatusTerminal("completed")).toBe(true);
    expect(isEbayFeedBatchStatusTerminal("completed_with_errors")).toBe(true);
    expect(isEbayFeedBatchStatusTerminal("failed")).toBe(true);
    expect(isEbayFeedBatchStatusTerminal("cancelled")).toBe(true);
    expect(isEbayFeedBatchStatusTerminal("queued")).toBe(false);
  });

  it("the Seller Hub drafts URL is exactly the real, confirmed one", () => {
    expect(SELLER_HUB_DRAFTS_URL).toBe("https://www.ebay.co.uk/sh/lst/drafts");
  });
});

describe("PHASE 4 — per-item helpers for the single-listing workflow chip", () => {
  it("every item status has a real hex tone", () => {
    for (const status of EBAY_FEED_ITEM_STATUSES) expect(EBAY_FEED_ITEM_STATUS_TONE[status]).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("only queued/uploaded/awaiting_result pulse as in-progress", () => {
    expect(isEbayFeedItemInProgress("queued")).toBe(true);
    expect(isEbayFeedItemInProgress("uploaded")).toBe(true);
    expect(isEbayFeedItemInProgress("awaiting_result")).toBe(true);
    expect(isEbayFeedItemInProgress("succeeded")).toBe(false);
    expect(isEbayFeedItemInProgress("failed")).toBe(false);
    expect(isEbayFeedItemInProgress("cancelled")).toBe(false);
    expect(isEbayFeedItemInProgress(null)).toBe(false);
  });

  it("computeEbayFeedItemWorkflowStatus maps every real status through except cancelled/null/unrecognised", () => {
    expect(computeEbayFeedItemWorkflowStatus("queued")).toBe("queued");
    expect(computeEbayFeedItemWorkflowStatus("succeeded")).toBe("succeeded");
    expect(computeEbayFeedItemWorkflowStatus("cancelled")).toBeNull();
    expect(computeEbayFeedItemWorkflowStatus(null)).toBeNull();
    expect(computeEbayFeedItemWorkflowStatus("something_unexpected")).toBeNull();
  });

  it("secondary line shows queue position while queued, the real error while failed, nothing otherwise", () => {
    expect(computeEbayFeedWorkflowSecondaryLine({ itemStatus: "queued", queuePosition: 2, errorMessage: null })).toBe("Position 3");
    expect(computeEbayFeedWorkflowSecondaryLine({ itemStatus: "failed", queuePosition: null, errorMessage: "Category ID is invalid" })).toBe("Category ID is invalid");
    expect(computeEbayFeedWorkflowSecondaryLine({ itemStatus: "succeeded", queuePosition: null, errorMessage: null })).toBeNull();
    expect(computeEbayFeedWorkflowSecondaryLine({ itemStatus: null, queuePosition: null, errorMessage: null })).toBeNull();
  });
});

describe("computeEbayFeedBatchBlockingState — CORRECTIVE PASS (duplicate-submission defect, Phase 6): the one shared source of truth for server, route, and client alike", () => {
  it("null status is { kind: \"none\" }", () => {
    expect(computeEbayFeedBatchBlockingState(null, new Map())).toEqual({ kind: "none" });
  });

  it("a queued/uploaded/awaiting_result item is 'active', carrying the batch's display number (Map form)", () => {
    const map = new Map([["batch-1", 1]]);
    for (const itemStatus of ["queued", "uploaded", "awaiting_result"]) {
      expect(computeEbayFeedBatchBlockingState({ batch_id: "batch-1", item_status: itemStatus }, map))
        .toEqual({ kind: "active", batchId: "batch-1", displayNumber: 1 });
    }
  });

  it("a queued item is 'active' using the plain-object form (as a JSON API response would carry it)", () => {
    expect(computeEbayFeedBatchBlockingState({ batch_id: "batch-1", item_status: "queued" }, { "batch-1": 1 }))
      .toEqual({ kind: "active", batchId: "batch-1", displayNumber: 1 });
  });

  it("a failed item is 'failed', carrying the batch's display number", () => {
    expect(computeEbayFeedBatchBlockingState({ batch_id: "batch-1", item_status: "failed" }, new Map([["batch-1", 1]])))
      .toEqual({ kind: "failed", batchId: "batch-1", displayNumber: 1 });
  });

  it("a succeeded or cancelled item is 'none' — never blocks, never offers Retry", () => {
    expect(computeEbayFeedBatchBlockingState({ batch_id: "batch-1", item_status: "succeeded" }, new Map([["batch-1", 1]]))).toEqual({ kind: "none" });
    expect(computeEbayFeedBatchBlockingState({ batch_id: "batch-1", item_status: "cancelled" }, new Map([["batch-1", 1]]))).toEqual({ kind: "none" });
  });

  it("an unknown batch id falls back to display number 0 rather than throwing", () => {
    expect(computeEbayFeedBatchBlockingState({ batch_id: "unknown-batch", item_status: "failed" }, new Map())).toEqual({ kind: "failed", batchId: "unknown-batch", displayNumber: 0 });
  });
});
