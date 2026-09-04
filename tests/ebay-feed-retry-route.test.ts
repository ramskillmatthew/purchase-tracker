import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, enforceRateLimit, getEbayFeedBatch, retryEbayFeedBatch, runEbayFeedBatchProcessTick,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  enforceRateLimit: vi.fn(async () => {}),
  getEbayFeedBatch: vi.fn(async (_ownerId: string, _batchId: string) => null as unknown),
  retryEbayFeedBatch: vi.fn(async (_ownerId: string, _batchId: string) => ({ resumedFromTaskId: null as string | null, resumedStatus: "queued" as const })),
  runEbayFeedBatchProcessTick: vi.fn(async () => ({ claimedCount: 0, batchStatus: null as string | null, hasMoreWork: false })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/security/activity", () => ({ enforceRateLimit }));
vi.mock("@/lib/listing-studio/ebay-feed/feed-batches", () => ({ getEbayFeedBatch, retryEbayFeedBatch, runEbayFeedBatchProcessTick }));

const { POST: retryRoute } = await import("@/app/api/listing-studio/ebay-feed-batches/[batchId]/retry/route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_A = "22222222-2222-4222-8222-222222222222";
function params() { return { params: Promise.resolve({ batchId: BATCH_ID }) }; }
function req() { return new Request("http://test", { method: "POST" }); }

function failedBatch(overrides: Record<string, unknown> = {}) {
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
  getEbayFeedBatch.mockReset(); retryEbayFeedBatch.mockReset(); runEbayFeedBatchProcessTick.mockReset();
  getEbayFeedBatch.mockResolvedValue(failedBatch());
  retryEbayFeedBatch.mockResolvedValue({ resumedFromTaskId: null, resumedStatus: "queued" });
  runEbayFeedBatchProcessTick.mockResolvedValue({ claimedCount: 1, batchStatus: "generating_csv", hasMoreWork: true });
});

describe("POST /api/listing-studio/ebay-feed-batches/[batchId]/retry", () => {
  it("requires the authenticated owner", async () => {
    await retryRoute(req(), params());
    expect(requireOwner).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid batch id before touching the lib layer", async () => {
    const response = await retryRoute(req(), { params: Promise.resolve({ batchId: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    expect(getEbayFeedBatch).not.toHaveBeenCalled();
  });

  it("404s for a batch that doesn't belong to this owner (or doesn't exist)", async () => {
    getEbayFeedBatch.mockResolvedValue(null);
    const response = await retryRoute(req(), params());
    expect(response.status).toBe(404);
    expect(retryEbayFeedBatch).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: refuses to retry a batch that isn't currently 'failed' — never calls retryEbayFeedBatch", async () => {
    getEbayFeedBatch.mockResolvedValue(failedBatch({ status: "processing" }));
    const response = await retryRoute(req(), params());
    expect(response.status).toBe(409);
    expect(retryEbayFeedBatch).not.toHaveBeenCalled();
  });

  it("retries a genuinely failed batch and immediately runs one process tick, then returns fresh state", async () => {
    getEbayFeedBatch
      .mockResolvedValueOnce(failedBatch())
      .mockResolvedValueOnce({ ...failedBatch(), batch: { ...failedBatch().batch, status: "generating_csv", errorCode: null, errorMessage: null } });
    const response = await retryRoute(req(), params());
    expect(response.status).toBe(200);
    expect(retryEbayFeedBatch).toHaveBeenCalledWith("owner-1", BATCH_ID);
    expect(runEbayFeedBatchProcessTick).toHaveBeenCalledWith("owner-1", BATCH_ID);
    const body = await response.json();
    expect(body.status).toBe("generating_csv");
    expect(body.resumedFromTaskId).toBeNull();
  });

  it("REQUIREMENT: a concurrent-retry race reported by the lib layer surfaces as a clean 409, never a 500 or a silent duplicate", async () => {
    retryEbayFeedBatch.mockRejectedValue(new Error("This batch was already retried (by another request) or is no longer failed."));
    const response = await retryRoute(req(), params());
    expect(response.status).toBe(409);
    expect(runEbayFeedBatchProcessTick).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: a genuinely unexpected error never leaks raw detail to the browser", async () => {
    retryEbayFeedBatch.mockRejectedValue(new Error("raw internal database connection string leaked accidentally"));
    const response = await retryRoute(req(), params());
    expect(response.status).not.toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("connection string");
  });

  it("is rate-limited per owner", async () => {
    await retryRoute(req(), params());
    expect(enforceRateLimit).toHaveBeenCalledWith("owner-1", "ebay_feed_batch_retry", expect.any(Number), expect.any(Number));
  });
});
