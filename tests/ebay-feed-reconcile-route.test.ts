import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, enforceRateLimit, getEbayFeedBatch, reconcileInconsistentFailedFeedBatchItems,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  enforceRateLimit: vi.fn(async () => {}),
  getEbayFeedBatch: vi.fn(async (_ownerId: string, _batchId: string) => null as unknown),
  reconcileInconsistentFailedFeedBatchItems: vi.fn(async (_ownerId: string, _batchId?: string) => [] as Array<{ batchId: string; reconciledItemIds: string[]; alreadyConsistent: boolean }>),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/security/activity", () => ({ enforceRateLimit }));
vi.mock("@/lib/listing-studio/ebay-feed/feed-batches", () => ({ getEbayFeedBatch, reconcileInconsistentFailedFeedBatchItems }));

const { POST: reconcileRoute } = await import("@/app/api/listing-studio/ebay-feed-batches/[batchId]/reconcile/route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_A = "22222222-2222-4222-8222-222222222222";
function params() { return { params: Promise.resolve({ batchId: BATCH_ID }) }; }
function req() { return new Request("http://test", { method: "POST" }); }

function batchDetail(overrides: Record<string, unknown> = {}) {
  return {
    batch: {
      id: BATCH_ID, ownerId: "owner-1", status: "failed", listingCount: 1, displayNumber: 1,
      boxDismissedAt: null, activityDismissedAt: null, ebayTaskId: null, csvRowCount: 1, attemptCount: 3,
      errorCode: "ebay_task_error", errorMessage: "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid.",
      createdAt: "x", startedAt: "x", completedAt: "x", ...overrides,
    },
    items: [{ id: "item-1", batchId: BATCH_ID, marketplaceDraftId: "mdraft-1", productDraftId: PRODUCT_A, queuePosition: 0, sku: "1644", status: "failed", errorCode: "ebay_task_error", errorMessage: "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid.", startedAt: "x", completedAt: "x", generatedTitle: "Title" }],
  };
}

beforeEach(() => {
  requireOwner.mockClear(); enforceRateLimit.mockClear();
  getEbayFeedBatch.mockReset(); reconcileInconsistentFailedFeedBatchItems.mockReset();
  getEbayFeedBatch.mockResolvedValue(batchDetail());
  reconcileInconsistentFailedFeedBatchItems.mockResolvedValue([{ batchId: BATCH_ID, reconciledItemIds: ["item-1"], alreadyConsistent: false }]);
});

describe("POST /api/listing-studio/ebay-feed-batches/[batchId]/reconcile", () => {
  it("requires the authenticated owner", async () => {
    await reconcileRoute(req(), params());
    expect(requireOwner).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid batch id before touching the lib layer", async () => {
    const response = await reconcileRoute(req(), { params: Promise.resolve({ batchId: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    expect(getEbayFeedBatch).not.toHaveBeenCalled();
  });

  it("404s for a batch that doesn't belong to this owner (or doesn't exist)", async () => {
    getEbayFeedBatch.mockResolvedValue(null);
    const response = await reconcileRoute(req(), params());
    expect(response.status).toBe(404);
    expect(reconcileInconsistentFailedFeedBatchItems).not.toHaveBeenCalled();
  });

  it("scopes the repair to exactly this batch id, for this owner", async () => {
    await reconcileRoute(req(), params());
    expect(reconcileInconsistentFailedFeedBatchItems).toHaveBeenCalledWith("owner-1", BATCH_ID);
  });

  it("returns the reconciled item ids and alreadyConsistent flag", async () => {
    const response = await reconcileRoute(req(), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reconciledItemIds).toEqual(["item-1"]);
    expect(body.alreadyConsistent).toBe(false);
  });

  it("REQUIREMENT (test 9/10/12 at the route level): a batch not eligible for reconciliation (wrong status, has a task id, or wrong owner) surfaces as a clean 409, never a 500", async () => {
    reconcileInconsistentFailedFeedBatchItems.mockResolvedValue([]);
    const response = await reconcileRoute(req(), params());
    expect(response.status).toBe(409);
  });

  it("REQUIREMENT (test 15): reconcile never calls or references retry — it is a genuinely separate lib function", () => {
    const source = require("node:fs").readFileSync("app/api/listing-studio/ebay-feed-batches/[batchId]/reconcile/route.ts", "utf8") as string;
    expect(source).not.toContain("retryEbayFeedBatch");
    expect(source).not.toMatch(/\/retry/);
  });

  it("REQUIREMENT: a genuinely unexpected error never leaks raw detail to the browser", async () => {
    reconcileInconsistentFailedFeedBatchItems.mockRejectedValue(new Error("raw internal database connection string leaked accidentally"));
    const response = await reconcileRoute(req(), params());
    expect(response.status).not.toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("connection string");
  });

  it("is rate-limited per owner", async () => {
    await reconcileRoute(req(), params());
    expect(enforceRateLimit).toHaveBeenCalledWith("owner-1", "ebay_feed_batch_reconcile", expect.any(Number), expect.any(Number));
  });
});
