import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, enforceRateLimit,
  createEbayDraftBatch, listOwnerEbayBatches, runEbayDraftBatchProcessTick, resolveEbayDraftEligibilityForProducts,
  getEbayDraftBatch, cancelEbayDraftBatch, dismissEbayDraftBatch,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  enforceRateLimit: vi.fn(async () => {}),
  createEbayDraftBatch: vi.fn(async () => ({ batchId: "batch-1", displayNumber: 1 })),
  listOwnerEbayBatches: vi.fn(async () => ({ visible: [] as unknown[], stuck: [] as unknown[] })),
  runEbayDraftBatchProcessTick: vi.fn(async (_ownerId: string, _batchId: string) => ({ claimedCount: 0, batchStatus: null as string | null, hasMoreWork: false })),
  resolveEbayDraftEligibilityForProducts: vi.fn(async (_ownerId: string, _ids: string[]) => new Map()),
  getEbayDraftBatch: vi.fn(async (_ownerId: string, _batchId: string) => null as unknown),
  cancelEbayDraftBatch: vi.fn(async (_ownerId: string, _batchId: string) => "cancelled" as const),
  dismissEbayDraftBatch: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/security/activity", () => ({ enforceRateLimit }));
vi.mock("@/lib/listing-studio/ebay-draft-batches", () => ({
  createEbayDraftBatch, listOwnerEbayBatches, runEbayDraftBatchProcessTick, resolveEbayDraftEligibilityForProducts,
  getEbayDraftBatch, cancelEbayDraftBatch, dismissEbayDraftBatch,
}));

const { GET: listRoute, POST: createRoute } = await import("@/app/api/listing-studio/ebay-draft-batches/route");
const { GET: getBatchRoute, DELETE: deleteBatchRoute, PATCH: patchBatchRoute } = await import("@/app/api/listing-studio/ebay-draft-batches/[batchId]/route");
const { POST: processRoute } = await import("@/app/api/listing-studio/ebay-draft-batches/[batchId]/process/route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_A = "22222222-2222-4222-8222-222222222222";
const PRODUCT_B = "33333333-3333-4333-8333-333333333333";
function params() { return { params: Promise.resolve({ batchId: BATCH_ID }) }; }
function jsonRequest(body: unknown, method = "POST") { return new Request("http://test", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

beforeEach(() => {
  requireOwner.mockClear(); enforceRateLimit.mockClear();
  createEbayDraftBatch.mockReset(); listOwnerEbayBatches.mockReset(); runEbayDraftBatchProcessTick.mockReset();
  resolveEbayDraftEligibilityForProducts.mockReset(); getEbayDraftBatch.mockReset(); cancelEbayDraftBatch.mockReset(); dismissEbayDraftBatch.mockReset();
  createEbayDraftBatch.mockResolvedValue({ batchId: BATCH_ID, displayNumber: 1 });
  listOwnerEbayBatches.mockResolvedValue({ visible: [], stuck: [] });
  runEbayDraftBatchProcessTick.mockResolvedValue({ claimedCount: 0, batchStatus: null, hasMoreWork: false });
  resolveEbayDraftEligibilityForProducts.mockResolvedValue(new Map());
  getEbayDraftBatch.mockResolvedValue(null);
  cancelEbayDraftBatch.mockResolvedValue("cancelled");
  dismissEbayDraftBatch.mockResolvedValue(undefined);
});

describe("GET /api/listing-studio/ebay-draft-batches", () => {
  it("reports visible and stuck batches from the lib layer, untouched", async () => {
    listOwnerEbayBatches.mockResolvedValue({
      visible: [{ batchId: "b1", displayNumber: 1 }],
      stuck: [{ batchId: "b2", displayNumber: 2, status: "in_progress", listingCount: 3, createdAt: "x" }],
    });
    const response = await listRoute();
    const body = await response.json();
    expect(body.available).toBe(true);
    expect(body.batchIds).toEqual([{ batchId: "b1", displayNumber: 1 }]);
    expect(body.stuck).toEqual([{ batchId: "b2", displayNumber: 2, status: "in_progress", listingCount: 3, createdAt: "x" }]);
  });

  describe("CORRECTIVE PASS — missing batch-migration schema degrades safely (never an uncontrolled 500)", () => {
    function schemaError(status: number, code: string, message: string): Error & { status: number } {
      const error = new Error(JSON.stringify({ code, message })) as Error & { status: number };
      error.status = status;
      return error;
    }

    it("REQUIREMENT 5: a missing ebay_draft_batches table (PGRST205, 404) never crashes Listings Review — returns 200 with available:false and empty lists", async () => {
      listOwnerEbayBatches.mockRejectedValue(schemaError(404, "PGRST205", "Could not find the table 'public.ebay_draft_batches' in the schema cache"));
      const response = await listRoute();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ available: false, batchIds: [], stuck: [] });
    });

    it("REQUIREMENT 7: an unrelated failure (auth/permission/network) still returns a real error response, never disguised as available:false", async () => {
      const error = new Error(JSON.stringify({ code: "42501", message: "permission denied" })) as Error & { status: number };
      error.status = 401;
      listOwnerEbayBatches.mockRejectedValue(error);
      const response = await listRoute();
      expect(response.status).not.toBe(200);
      const body = await response.json();
      expect(body).not.toHaveProperty("available");
    });
  });
});

describe("POST /api/listing-studio/ebay-draft-batches", () => {
  it("REQUIREMENT: skips ineligible listings and creates a batch only from the eligible ones — never all-or-nothing", async () => {
    resolveEbayDraftEligibilityForProducts.mockResolvedValue(new Map([
      [PRODUCT_A, { marketplaceDraftId: "mdraft-a", eligible: true, reasons: [] }],
      [PRODUCT_B, { marketplaceDraftId: null, eligible: false, reasons: ["Missing eBay selling price"] }],
    ]));
    const response = await createRoute(jsonRequest({ draftIds: [PRODUCT_A, PRODUCT_B] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.eligibleCount).toBe(1);
    expect(body.skippedCount).toBe(1);
    expect(body.skipped).toEqual([{ draftId: PRODUCT_B, reasons: ["Missing eBay selling price"] }]);
    expect(createEbayDraftBatch).toHaveBeenCalledWith("owner-1", ["mdraft-a"], [PRODUCT_A]);
    expect(runEbayDraftBatchProcessTick).toHaveBeenCalledWith("owner-1", BATCH_ID);
  });

  it("REQUIREMENT (corrective pass): runs exactly ONE bounded, awaited process tick — never a fire-and-forget unawaited call", async () => {
    resolveEbayDraftEligibilityForProducts.mockResolvedValue(new Map([[PRODUCT_A, { marketplaceDraftId: "mdraft-a", eligible: true, reasons: [] }]]));
    let tickResolved = false;
    runEbayDraftBatchProcessTick.mockImplementation(async () => { await Promise.resolve(); tickResolved = true; return { claimedCount: 1, batchStatus: null, hasMoreWork: true }; });
    await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    // If the route awaited the tick (rather than firing it and moving on),
    // this is true the instant the route handler itself has returned.
    expect(tickResolved).toBe(true);
    expect(runEbayDraftBatchProcessTick).toHaveBeenCalledTimes(1);
  });

  it("400s with no batch created when NOTHING selected is eligible", async () => {
    resolveEbayDraftEligibilityForProducts.mockResolvedValue(new Map([
      [PRODUCT_A, { marketplaceDraftId: null, eligible: false, reasons: ["No eBay preparation for this listing"] }],
    ]));
    const response = await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).toBe(400);
    expect(createEbayDraftBatch).not.toHaveBeenCalled();
    expect(runEbayDraftBatchProcessTick).not.toHaveBeenCalled();
  });

  it("applies the shared rate limit before creating anything", async () => {
    resolveEbayDraftEligibilityForProducts.mockResolvedValue(new Map([[PRODUCT_A, { marketplaceDraftId: "mdraft-a", eligible: true, reasons: [] }]]));
    await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(enforceRateLimit).toHaveBeenCalledWith("owner-1", "ebay_draft_batch_create", expect.any(Number), expect.any(Number));
  });

  it("REQUIREMENT 5/6: a missing ebay_draft_batches table returns a deliberate, clearly-worded 409 (available:false) instead of an uncontrolled 500 — batch creation genuinely cannot succeed without this table, so this is the one route where 'unavailable' IS the terminal response, not a fallback to empty success", async () => {
    resolveEbayDraftEligibilityForProducts.mockResolvedValue(new Map([[PRODUCT_A, { marketplaceDraftId: "mdraft-a", eligible: true, reasons: [] }]]));
    const error = new Error(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.ebay_draft_batches' in the schema cache" })) as Error & { status: number };
    error.status = 404;
    createEbayDraftBatch.mockRejectedValue(error);
    const response = await createRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.available).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(runEbayDraftBatchProcessTick).not.toHaveBeenCalled();
  });
});

describe("GET /api/listing-studio/ebay-draft-batches/[batchId]", () => {
  it("404s when the batch doesn't belong to this owner (or doesn't exist)", async () => {
    getEbayDraftBatch.mockResolvedValue(null);
    const response = await getBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("returns items with their real per-stage status, never Unpublished", async () => {
    getEbayDraftBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "in_progress", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, createdAt: "x", completedAt: null },
      items: [{ id: "item-1", batchId: BATCH_ID, marketplaceDraftId: "mdraft-1", productDraftId: PRODUCT_A, queuePosition: 0, status: "creating_draft", attemptCount: 1, errorCode: null, errorMessage: null, ebayOfferId: null, startedAt: "x", completedAt: null, generatedTitle: "Title", sku: "SKU-1" }],
    });
    const response = await getBatchRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.items[0].status).toBe("creating_draft");
    expect(JSON.stringify(body)).not.toMatch(/Unpublished/);
  });
});

describe("DELETE /api/listing-studio/ebay-draft-batches/[batchId]", () => {
  it("cancels the batch via the lib layer", async () => {
    const response = await deleteBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    expect(cancelEbayDraftBatch).toHaveBeenCalledWith("owner-1", BATCH_ID);
  });

  it("404s for a nonexistent batch", async () => {
    cancelEbayDraftBatch.mockRejectedValue(new Error("Batch not found."));
    const response = await deleteBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/listing-studio/ebay-draft-batches/[batchId] — dismiss", () => {
  it("dismiss_box works even for a still-non-terminal (stuck) batch — no pairing/extension concern applies to eBay batches", async () => {
    getEbayDraftBatch.mockResolvedValue({ batch: { id: BATCH_ID, ownerId: "owner-1", status: "in_progress", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, createdAt: "x", completedAt: null }, items: [] });
    const response = await patchBatchRoute(jsonRequest({ action: "dismiss_box" }, "PATCH"), params());
    expect(response.status).toBe(200);
    expect(dismissEbayDraftBatch).toHaveBeenCalledWith("owner-1", BATCH_ID, "dismiss_box");
  });

  it("404s dismissing a batch that isn't this owner's", async () => {
    getEbayDraftBatch.mockResolvedValue(null);
    const response = await patchBatchRoute(jsonRequest({ action: "dismiss_box" }, "PATCH"), params());
    expect(response.status).toBe(404);
    expect(dismissEbayDraftBatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/listing-studio/ebay-draft-batches/[batchId]/process — corrective pass: bounded, resumable tick endpoint", () => {
  it("REQUIREMENT: runs exactly one bounded tick and returns the batch's fresh full status", async () => {
    getEbayDraftBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "in_progress", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, createdAt: "x", completedAt: null },
      items: [{ id: "item-1", batchId: BATCH_ID, marketplaceDraftId: "mdraft-1", productDraftId: PRODUCT_A, queuePosition: 0, status: "creating_inventory_item", attemptCount: 1, errorCode: null, errorMessage: null, ebayOfferId: null, startedAt: "x", completedAt: null, generatedTitle: "Title", sku: "SKU-1" }],
    });
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(200);
    expect(runEbayDraftBatchProcessTick).toHaveBeenCalledWith("owner-1", BATCH_ID);
    const body = await response.json();
    expect(body.items[0].status).toBe("creating_inventory_item");
  });

  it("never calls the tick for an already-terminal batch — a completed/cancelled batch is never re-processed", async () => {
    getEbayDraftBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "completed", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, createdAt: "x", completedAt: "x" },
      items: [],
    });
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(200);
    expect(runEbayDraftBatchProcessTick).not.toHaveBeenCalled();
  });

  it("404s for a batch that doesn't belong to this owner", async () => {
    getEbayDraftBatch.mockResolvedValue(null);
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(404);
    expect(runEbayDraftBatchProcessTick).not.toHaveBeenCalled();
  });

  it("rejects an invalid batch id before touching the lib layer", async () => {
    const response = await processRoute(new Request("http://test", { method: "POST" }), { params: Promise.resolve({ batchId: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    expect(runEbayDraftBatchProcessTick).not.toHaveBeenCalled();
  });
});
