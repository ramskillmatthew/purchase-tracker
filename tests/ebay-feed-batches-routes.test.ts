import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, enforceRateLimit,
  createEbayFeedBatch, listOwnerEbayFeedBatches, runEbayFeedBatchProcessTick, driveEbayFeedBatchTicks, resolveEbayFeedDraftEligibilityForProducts,
  getEbayFeedBatch, cancelEbayFeedBatch, dismissEbayFeedBatch,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  enforceRateLimit: vi.fn(async () => {}),
  createEbayFeedBatch: vi.fn(async () => ({ batchId: "batch-1", displayNumber: 1 })),
  listOwnerEbayFeedBatches: vi.fn(async () => ({ visible: [] as unknown[], stuck: [] as unknown[] })),
  // Still used directly by [batchId]/process/route.ts (unchanged).
  runEbayFeedBatchProcessTick: vi.fn(async (_ownerId: string, _batchId: string) => ({ claimedCount: 0, batchStatus: null as string | null, hasMoreWork: false })),
  // CORRECTIVE PASS (fourth real-submission audit) — the CREATE route now
  // drives MULTIPLE bounded ticks (never just one) via
  // driveEbayFeedBatchTicks, so real progress happens within this same
  // request even if the browser closes right away.
  driveEbayFeedBatchTicks: vi.fn(async (_ownerId: string, _batchId: string) => ({ claimedCount: 0, batchStatus: null as string | null, hasMoreWork: false })),
  resolveEbayFeedDraftEligibilityForProducts: vi.fn(async (_ownerId: string, _ids: string[]) => new Map()),
  getEbayFeedBatch: vi.fn(async (_ownerId: string, _batchId: string) => null as unknown),
  cancelEbayFeedBatch: vi.fn(async (_ownerId: string, _batchId: string) => "cancelled" as const),
  dismissEbayFeedBatch: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/security/activity", () => ({ enforceRateLimit }));
vi.mock("@/lib/listing-studio/ebay-feed/feed-batches", () => ({
  createEbayFeedBatch, listOwnerEbayFeedBatches, runEbayFeedBatchProcessTick, driveEbayFeedBatchTicks, resolveEbayFeedDraftEligibilityForProducts,
  getEbayFeedBatch, cancelEbayFeedBatch, dismissEbayFeedBatch,
}));

const { GET: listRoute, POST: createRoute } = await import("@/app/api/listing-studio/ebay-feed-batches/route");
const { GET: getBatchRoute, DELETE: deleteBatchRoute, PATCH: patchBatchRoute } = await import("@/app/api/listing-studio/ebay-feed-batches/[batchId]/route");
const { POST: processRoute } = await import("@/app/api/listing-studio/ebay-feed-batches/[batchId]/process/route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_A = "22222222-2222-4222-8222-222222222222";
const PRODUCT_B = "33333333-3333-4333-8333-333333333333";
function params() { return { params: Promise.resolve({ batchId: BATCH_ID }) }; }
function jsonRequest(body: unknown, method = "POST") { return new Request("http://test", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

beforeEach(() => {
  requireOwner.mockClear(); enforceRateLimit.mockClear();
  createEbayFeedBatch.mockReset(); listOwnerEbayFeedBatches.mockReset(); runEbayFeedBatchProcessTick.mockReset(); driveEbayFeedBatchTicks.mockReset();
  resolveEbayFeedDraftEligibilityForProducts.mockReset(); getEbayFeedBatch.mockReset(); cancelEbayFeedBatch.mockReset(); dismissEbayFeedBatch.mockReset();
  createEbayFeedBatch.mockResolvedValue({ batchId: BATCH_ID, displayNumber: 1 });
  listOwnerEbayFeedBatches.mockResolvedValue({ visible: [], stuck: [] });
  runEbayFeedBatchProcessTick.mockResolvedValue({ claimedCount: 0, batchStatus: null, hasMoreWork: false });
  driveEbayFeedBatchTicks.mockResolvedValue({ claimedCount: 0, batchStatus: null, hasMoreWork: false });
  resolveEbayFeedDraftEligibilityForProducts.mockResolvedValue(new Map());
  getEbayFeedBatch.mockResolvedValue(null);
  cancelEbayFeedBatch.mockResolvedValue("cancelled");
  dismissEbayFeedBatch.mockResolvedValue(undefined);
});

describe("GET /api/listing-studio/ebay-feed-batches", () => {
  it("reports visible and stuck batches from the lib layer, untouched", async () => {
    listOwnerEbayFeedBatches.mockResolvedValue({
      visible: [{ batchId: "b1", displayNumber: 1 }],
      stuck: [{ batchId: "b2", displayNumber: 2, status: "processing", listingCount: 3, createdAt: "x" }],
    });
    const response = await listRoute();
    const body = await response.json();
    expect(body.available).toBe(true);
    expect(body.batchIds).toEqual([{ batchId: "b1", displayNumber: 1 }]);
  });

  it("a missing ebay_feed_batches table never crashes Listings Review — returns 200 with available:false", async () => {
    const error = new Error(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.ebay_feed_batches' in the schema cache" })) as Error & { status: number };
    error.status = 404;
    listOwnerEbayFeedBatches.mockRejectedValue(error);
    const response = await listRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ available: false, batchIds: [], stuck: [] });
  });
});

describe("POST /api/listing-studio/ebay-feed-batches", () => {
  it("skips ineligible listings and creates a batch only from the eligible ones — never all-or-nothing", async () => {
    resolveEbayFeedDraftEligibilityForProducts.mockResolvedValue(new Map([
      [PRODUCT_A, { marketplaceDraftId: "mdraft-a", sku: "SKU-A", eligible: true, reasons: [] }],
      [PRODUCT_B, { marketplaceDraftId: null, sku: null, eligible: false, reasons: ["Missing eBay selling price"] }],
    ]));
    const response = await createRoute(jsonRequest({ draftIds: [PRODUCT_A, PRODUCT_B] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.eligibleCount).toBe(1);
    expect(body.skippedCount).toBe(1);
    expect(body.skipped).toEqual([{ draftId: PRODUCT_B, reasons: ["Missing eBay selling price"] }]);
    expect(createEbayFeedBatch).toHaveBeenCalledWith("owner-1", ["mdraft-a"], [PRODUCT_A], ["SKU-A"]);
    expect(driveEbayFeedBatchTicks).toHaveBeenCalledWith("owner-1", BATCH_ID);
  });

  it("an eligible listing missing a resolved SKU is treated as not creatable (defence in depth — SKU is required to build the CSV row)", async () => {
    resolveEbayFeedDraftEligibilityForProducts.mockResolvedValue(new Map([
      [PRODUCT_A, { marketplaceDraftId: "mdraft-a", sku: null, eligible: true, reasons: [] }],
    ]));
    const response = await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).toBe(400);
    expect(createEbayFeedBatch).not.toHaveBeenCalled();
  });

  it("awaits the process-driving call before responding — never a fire-and-forget unawaited call", async () => {
    resolveEbayFeedDraftEligibilityForProducts.mockResolvedValue(new Map([[PRODUCT_A, { marketplaceDraftId: "mdraft-a", sku: "SKU-A", eligible: true, reasons: [] }]]));
    let tickResolved = false;
    driveEbayFeedBatchTicks.mockImplementation(async () => { await Promise.resolve(); tickResolved = true; return { claimedCount: 1, batchStatus: null, hasMoreWork: true }; });
    await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(tickResolved).toBe(true);
    expect(driveEbayFeedBatchTicks).toHaveBeenCalledTimes(1);
  });

  it("400s with no batch created when NOTHING selected is eligible", async () => {
    resolveEbayFeedDraftEligibilityForProducts.mockResolvedValue(new Map([
      [PRODUCT_A, { marketplaceDraftId: null, sku: null, eligible: false, reasons: ["No eBay preparation for this listing"] }],
    ]));
    const response = await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).toBe(400);
    expect(createEbayFeedBatch).not.toHaveBeenCalled();
    expect(driveEbayFeedBatchTicks).not.toHaveBeenCalled();
  });

  it("applies the shared rate limit before creating anything", async () => {
    resolveEbayFeedDraftEligibilityForProducts.mockResolvedValue(new Map([[PRODUCT_A, { marketplaceDraftId: "mdraft-a", sku: "SKU-A", eligible: true, reasons: [] }]]));
    await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(enforceRateLimit).toHaveBeenCalledWith("owner-1", "ebay_feed_batch_create", expect.any(Number), expect.any(Number));
  });

  it("a missing ebay_feed_batches table returns a deliberate 409 (available:false), never an uncontrolled 500", async () => {
    resolveEbayFeedDraftEligibilityForProducts.mockResolvedValue(new Map([[PRODUCT_A, { marketplaceDraftId: "mdraft-a", sku: "SKU-A", eligible: true, reasons: [] }]]));
    const error = new Error(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.ebay_feed_batches' in the schema cache" })) as Error & { status: number };
    error.status = 404;
    createEbayFeedBatch.mockRejectedValue(error);
    const response = await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.available).toBe(false);
    expect(driveEbayFeedBatchTicks).not.toHaveBeenCalled();
  });
});

describe("GET /api/listing-studio/ebay-feed-batches/[batchId]", () => {
  it("404s when the batch doesn't belong to this owner (or doesn't exist)", async () => {
    getEbayFeedBatch.mockResolvedValue(null);
    const response = await getBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("returns items with their real per-stage status, and the Seller Hub drafts URL, never a Published/Live claim", async () => {
    getEbayFeedBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "processing", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, ebayTaskId: "task-1", csvRowCount: 1, attemptCount: 1, errorCode: null, errorMessage: null, createdAt: "x", startedAt: "x", completedAt: null },
      items: [{ id: "item-1", batchId: BATCH_ID, marketplaceDraftId: "mdraft-1", productDraftId: PRODUCT_A, queuePosition: 0, sku: "1644", status: "awaiting_result", errorCode: null, errorMessage: null, startedAt: "x", completedAt: null, generatedTitle: "Title" }],
    });
    const response = await getBatchRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.items[0].status).toBe("awaiting_result");
    expect(body.sellerHubDraftsUrl).toBe("https://www.ebay.co.uk/sh/lst/drafts");
    expect(JSON.stringify(body)).not.toMatch(/\bpublished\b/i);
    expect(JSON.stringify(body)).not.toMatch(/\blive\b/i);
  });
});

describe("DELETE /api/listing-studio/ebay-feed-batches/[batchId]", () => {
  it("cancels the batch via the lib layer", async () => {
    const response = await deleteBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    expect(cancelEbayFeedBatch).toHaveBeenCalledWith("owner-1", BATCH_ID);
  });

  it("404s for a nonexistent batch", async () => {
    cancelEbayFeedBatch.mockRejectedValue(new Error("Batch not found."));
    const response = await deleteBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/listing-studio/ebay-feed-batches/[batchId] — dismiss", () => {
  it("dismiss_box works even for a still-non-terminal (stuck) batch", async () => {
    getEbayFeedBatch.mockResolvedValue({ batch: { id: BATCH_ID, ownerId: "owner-1", status: "processing", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, ebayTaskId: "task-1", csvRowCount: 1, attemptCount: 1, errorCode: null, errorMessage: null, createdAt: "x", startedAt: "x", completedAt: null }, items: [] });
    const response = await patchBatchRoute(jsonRequest({ action: "dismiss_box" }, "PATCH"), params());
    expect(response.status).toBe(200);
    expect(dismissEbayFeedBatch).toHaveBeenCalledWith("owner-1", BATCH_ID, "dismiss_box");
  });

  it("404s dismissing a batch that isn't this owner's", async () => {
    getEbayFeedBatch.mockResolvedValue(null);
    const response = await patchBatchRoute(jsonRequest({ action: "dismiss_box" }, "PATCH"), params());
    expect(response.status).toBe(404);
    expect(dismissEbayFeedBatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/listing-studio/ebay-feed-batches/[batchId]/process — bounded, resumable tick endpoint", () => {
  it("runs exactly one bounded tick and returns the batch's fresh full status", async () => {
    getEbayFeedBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "uploading", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, ebayTaskId: "task-1", csvRowCount: 1, attemptCount: 1, errorCode: null, errorMessage: null, createdAt: "x", startedAt: "x", completedAt: null },
      items: [{ id: "item-1", batchId: BATCH_ID, marketplaceDraftId: "mdraft-1", productDraftId: PRODUCT_A, queuePosition: 0, sku: "1644", status: "queued", errorCode: null, errorMessage: null, startedAt: "x", completedAt: null, generatedTitle: "Title" }],
    });
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(200);
    expect(runEbayFeedBatchProcessTick).toHaveBeenCalledWith("owner-1", BATCH_ID);
  });

  it("never calls the tick for an already-terminal batch", async () => {
    getEbayFeedBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "completed", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, ebayTaskId: "task-1", csvRowCount: 1, attemptCount: 1, errorCode: null, errorMessage: null, createdAt: "x", startedAt: "x", completedAt: "x" },
      items: [],
    });
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(200);
    expect(runEbayFeedBatchProcessTick).not.toHaveBeenCalled();
  });

  it("never calls the tick for a 'completed_with_errors' batch either — also terminal", async () => {
    getEbayFeedBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "completed_with_errors", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, ebayTaskId: "task-1", csvRowCount: 1, attemptCount: 1, errorCode: null, errorMessage: null, createdAt: "x", startedAt: "x", completedAt: "x" },
      items: [],
    });
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(200);
    expect(runEbayFeedBatchProcessTick).not.toHaveBeenCalled();
  });

  it("404s for a batch that doesn't belong to this owner", async () => {
    getEbayFeedBatch.mockResolvedValue(null);
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(404);
    expect(runEbayFeedBatchProcessTick).not.toHaveBeenCalled();
  });

  it("rejects an invalid batch id before touching the lib layer", async () => {
    const response = await processRoute(new Request("http://test", { method: "POST" }), { params: Promise.resolve({ batchId: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    expect(runEbayFeedBatchProcessTick).not.toHaveBeenCalled();
  });
});
