import { describe, expect, it } from "vitest";
import * as EbayQueueState from "../vinted-draft-queue-extension/shared/ebay-queue-state.js";

const NOW = "2026-09-10T12:00:00.000Z";

function fixturePayload(overrides: Partial<{ itemId: string; sku: string }> = {}) {
  return {
    schemaVersion: "ebay-extension-batch-v1",
    batchId: "b1",
    expiresAt: "2026-09-10T12:10:00.000Z",
    items: [{
      itemId: overrides.itemId ?? "item-1",
      marketplaceDraftId: "mdraft-1", productDraftId: "pdraft-1", queuePosition: 0,
      sku: overrides.sku ?? "1644", marketplace: "EBAY_UK",
      title: "On Running Cloud 5", description: "desc", categoryId: "95672", categoryName: "Trainers",
      conditionValue: "Used – Very Good", conditionDescription: null,
      brand: "On Running", size: "4", colour: "Blue", itemSpecifics: [],
      pricePence: 3500, priceDisplay: "£35.00", quantity: 1,
      photos: [{ position: 0, path: "/api/extension/ebay-batch/photos/11111111-1111-4111-8111-111111111111/0", fileName: "01.jpg" }],
      fulfillmentPolicy: null, returnPolicy: null, paymentPolicy: null,
    }],
  };
}

describe("eBay extension queue-state — payload application", () => {
  it("a fresh item starts QUEUED with attemptCount 0", () => {
    const state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    expect(state.batch.items[0].status).toBe(EbayQueueState.EBAY_ITEM_STATUSES.QUEUED);
    expect(state.batch.items[0].attemptCount).toBe(0);
  });

  it("re-fetching the SAME batch preserves queue-controlled fields (status/attemptCount) but refreshes listing fields", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemAttemptStarting(state, "item-1", NOW);
    const refetched = EbayQueueState.applyEbayBatchPayload(state, fixturePayload({ sku: "1644-updated" }), NOW);
    expect(refetched.batch.items[0].status).toBe(EbayQueueState.EBAY_ITEM_STATUSES.PREPARING);
    expect(refetched.batch.items[0].attemptCount).toBe(1);
    expect(refetched.batch.items[0].sku).toBe("1644-updated");
  });
});

describe("eBay extension queue-state — REQUIREMENT (Phase 8): duplicate protection", () => {
  it("re-sending an item that is QUEUED is recognised as already active", () => {
    const state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    expect(EbayQueueState.isEbayItemAlreadyActive(state, "item-1")).toBe(true);
  });

  it("re-sending an item that is WAITING_FOR_REVIEW is recognised as already active — a completed operation can never be replayed", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemWaitingForReview(state, "item-1", NOW);
    expect(EbayQueueState.isEbayItemAlreadyActive(state, "item-1")).toBe(true);
  });

  it("a FAILED item is NOT 'already active' — it genuinely needs an explicit Retry", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemFailed(state, "item-1", "SET_TITLE", "boom", NOW);
    expect(EbayQueueState.isEbayItemAlreadyActive(state, "item-1")).toBe(false);
  });

  it("applyRetryEbayItem only requeues a genuinely FAILED item — a true no-op (same reference) for WAITING_FOR_REVIEW or QUEUED", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    const queued = EbayQueueState.applyRetryEbayItem(state, "item-1");
    expect(queued).toBe(state); // already queued — same reference back

    state = EbayQueueState.applyEbayItemWaitingForReview(state, "item-1", NOW);
    const waiting = EbayQueueState.applyRetryEbayItem(state, "item-1");
    expect(waiting).toBe(state); // a completed operation cannot be replayed by retry either

    state = EbayQueueState.applyEbayItemFailed(state, "item-1", "SET_TITLE", "boom", NOW);
    const retried = EbayQueueState.applyRetryEbayItem(state, "item-1");
    expect(retried.batch.items[0].status).toBe(EbayQueueState.EBAY_ITEM_STATUSES.QUEUED);
  });

  it("applyCancelEbayItem only cancels a genuinely QUEUED item — never one already in flight", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemAttemptStarting(state, "item-1", NOW);
    const unchanged = EbayQueueState.applyCancelEbayItem(state, "item-1");
    expect(unchanged).toBe(state);
  });
});

describe("eBay extension queue-state — REQUIREMENT: resume after browser/service-worker restart", () => {
  it("an in-flight item (preparing/filling) is reset to QUEUED, and the stale tab id is cleared", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemAttemptStarting(state, "item-1", NOW);
    state = EbayQueueState.applyEbaySelectedTab(state, 42);
    const resumed = EbayQueueState.resumeEbayAfterRestart(state);
    expect(resumed.batch.items[0].status).toBe(EbayQueueState.EBAY_ITEM_STATUSES.QUEUED);
    expect(resumed.batch.ebayTabId).toBeNull();
  });

  it("a WAITING_FOR_REVIEW item (a completed operation) is left completely untouched by restart recovery", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemWaitingForReview(state, "item-1", NOW);
    const resumed = EbayQueueState.resumeEbayAfterRestart(state);
    expect(resumed.batch.items[0].status).toBe(EbayQueueState.EBAY_ITEM_STATUSES.WAITING_FOR_REVIEW);
  });

  it("is idempotent — calling it again on already-consistent state returns the same reference", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemWaitingForReview(state, "item-1", NOW);
    const once = EbayQueueState.resumeEbayAfterRestart(state);
    const twice = EbayQueueState.resumeEbayAfterRestart(once);
    expect(twice).toBe(once);
  });
});

describe("eBay extension queue-state — the watchdog", () => {
  it("finds an in-flight item that has gone past the timeout with no progress", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemAttemptStarting(state, "item-1", NOW);
    const later = new Date(new Date(NOW).getTime() + 120_000).toISOString();
    const stalled = EbayQueueState.findStalledEbayItem(state, later, 60_000);
    expect(stalled?.itemId).toBe("item-1");
  });

  it("never flags a WAITING_FOR_REVIEW or FAILED item as stalled — only genuinely in-flight statuses", () => {
    let state = EbayQueueState.applyEbayBatchPayload(EbayQueueState.createInitialEbayState(), fixturePayload(), NOW);
    state = EbayQueueState.applyEbayItemWaitingForReview(state, "item-1", NOW);
    const later = new Date(new Date(NOW).getTime() + 120_000).toISOString();
    expect(EbayQueueState.findStalledEbayItem(state, later, 60_000)).toBeNull();
  });
});
