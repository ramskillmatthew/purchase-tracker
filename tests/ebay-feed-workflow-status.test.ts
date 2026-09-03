import { describe, expect, it } from "vitest";
import {
  EBAY_FEED_BATCH_STATUSES, EBAY_FEED_ITEM_STATUSES,
  EBAY_FEED_BATCH_STATUS_LABELS, EBAY_FEED_ITEM_STATUS_LABELS,
  isEbayFeedBatchStatusTerminal, isEbayFeedBatchInProgress, SELLER_HUB_DRAFTS_URL,
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
