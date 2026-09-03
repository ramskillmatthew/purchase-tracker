import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, enforceRateLimit,
  createEbayDraftBatch, listOwnerEbayBatches, runEbayDraftBatchProcessTick, resolveEbayDraftEligibilityForProducts,
  getEbayDraftBatch, cancelEbayDraftBatch, dismissEbayDraftBatch, retryFailedEbayDraftItem,
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
  retryFailedEbayDraftItem: vi.fn(async (_ownerId: string, _batchId: string, _itemId: string) => ({ outcome: "not_found" }) as unknown),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/security/activity", () => ({ enforceRateLimit }));
vi.mock("@/lib/listing-studio/ebay-draft-batches", () => ({
  createEbayDraftBatch, listOwnerEbayBatches, runEbayDraftBatchProcessTick, resolveEbayDraftEligibilityForProducts,
  getEbayDraftBatch, cancelEbayDraftBatch, dismissEbayDraftBatch, retryFailedEbayDraftItem,
}));

const { GET: listRoute, POST: createRoute } = await import("@/app/api/listing-studio/ebay-draft-batches/route");
const { GET: getBatchRoute, DELETE: deleteBatchRoute, PATCH: patchBatchRoute } = await import("@/app/api/listing-studio/ebay-draft-batches/[batchId]/route");
const { POST: processRoute } = await import("@/app/api/listing-studio/ebay-draft-batches/[batchId]/process/route");
const { POST: retryRoute } = await import("@/app/api/listing-studio/ebay-draft-batches/[batchId]/items/[itemId]/retry/route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
function params() { return { params: Promise.resolve({ batchId: BATCH_ID }) }; }
function itemParams() { return { params: Promise.resolve({ batchId: BATCH_ID, itemId: ITEM_ID }) }; }
function jsonRequest(body: unknown, method = "POST") { return new Request("http://test", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

beforeEach(() => {
  requireOwner.mockClear(); enforceRateLimit.mockClear();
  createEbayDraftBatch.mockReset(); listOwnerEbayBatches.mockReset(); runEbayDraftBatchProcessTick.mockReset();
  resolveEbayDraftEligibilityForProducts.mockReset(); getEbayDraftBatch.mockReset(); cancelEbayDraftBatch.mockReset(); dismissEbayDraftBatch.mockReset();
  retryFailedEbayDraftItem.mockReset();
  requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  createEbayDraftBatch.mockResolvedValue({ batchId: BATCH_ID, displayNumber: 1 });
  listOwnerEbayBatches.mockResolvedValue({ visible: [], stuck: [] });
  runEbayDraftBatchProcessTick.mockResolvedValue({ claimedCount: 0, batchStatus: null, hasMoreWork: false });
  resolveEbayDraftEligibilityForProducts.mockResolvedValue(new Map());
  getEbayDraftBatch.mockResolvedValue(null);
  cancelEbayDraftBatch.mockResolvedValue("cancelled");
  dismissEbayDraftBatch.mockResolvedValue(undefined);
});

describe("GET /api/listing-studio/ebay-draft-batches — read-only history, untouched by retirement", () => {
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

  it("a missing ebay_draft_batches table never crashes Listings Review — returns 200 with available:false", async () => {
    const error = new Error(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.ebay_draft_batches' in the schema cache" })) as Error & { status: number };
    error.status = 404;
    listOwnerEbayBatches.mockRejectedValue(error);
    const response = await listRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ available: false, batchIds: [], stuck: [] });
  });
});

describe("PHASE 3 — POST /api/listing-studio/ebay-draft-batches is RETIRED", () => {
  it("returns 410 Gone, never creates a batch, never ticks the pipeline", async () => {
    const response = await createRoute(jsonRequest({ draftIds: ["22222222-2222-4222-8222-222222222222"] }));
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.retired).toBe(true);
    expect(createEbayDraftBatch).not.toHaveBeenCalled();
    expect(runEbayDraftBatchProcessTick).not.toHaveBeenCalled();
  });

  it("still requires the authenticated owner before revealing the retirement", async () => {
    await createRoute(jsonRequest({ draftIds: [] }));
    expect(requireOwner).toHaveBeenCalledTimes(1);
  });

  it("never even parses the request body — retirement is unconditional, not dependent on a valid payload", async () => {
    const response = await createRoute(new Request("http://test", { method: "POST", body: "not json at all" }));
    expect(response.status).toBe(410);
  });
});

describe("GET /api/listing-studio/ebay-draft-batches/[batchId] — read-only history, untouched", () => {
  it("404s when the batch doesn't belong to this owner (or doesn't exist)", async () => {
    getEbayDraftBatch.mockResolvedValue(null);
    const response = await getBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("returns items with their real per-stage status, using the corrected legacy label", async () => {
    getEbayDraftBatch.mockResolvedValue({
      batch: { id: BATCH_ID, ownerId: "owner-1", status: "in_progress", listingCount: 1, displayNumber: 1, boxDismissedAt: null, activityDismissedAt: null, createdAt: "x", completedAt: null },
      items: [{ id: "item-1", batchId: BATCH_ID, marketplaceDraftId: "mdraft-1", productDraftId: "product-a", queuePosition: 0, status: "creating_draft", attemptCount: 1, errorCode: null, errorMessage: null, ebayOfferId: null, startedAt: "x", completedAt: null, generatedTitle: "Title", sku: "SKU-1" }],
    });
    const response = await getBatchRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.items[0].status).toBe("creating_draft");
  });
});

describe("DELETE /api/listing-studio/ebay-draft-batches/[batchId] — cancel remains available (never writes to eBay)", () => {
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

describe("PATCH /api/listing-studio/ebay-draft-batches/[batchId] — dismiss remains available (never writes to eBay)", () => {
  it("dismiss_box works even for a still-non-terminal (stuck) batch", async () => {
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

describe("PHASE 3 — POST /api/listing-studio/ebay-draft-batches/[batchId]/process is RETIRED", () => {
  it("returns 410 Gone, never advances any legacy item, never calls the pipeline", async () => {
    const response = await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.retired).toBe(true);
    expect(runEbayDraftBatchProcessTick).not.toHaveBeenCalled();
    expect(getEbayDraftBatch).not.toHaveBeenCalled();
  });

  it("still requires the authenticated owner", async () => {
    await processRoute(new Request("http://test", { method: "POST" }), params());
    expect(requireOwner).toHaveBeenCalledTimes(1);
  });
});

describe("PHASE 3 — POST /api/listing-studio/ebay-draft-batches/[batchId]/items/[itemId]/retry is RETIRED", () => {
  it("returns 410 Gone, never retries any legacy item, never touches the Inventory API pipeline", async () => {
    const response = await retryRoute(new Request("http://test", { method: "POST" }), itemParams());
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.retired).toBe(true);
    expect(retryFailedEbayDraftItem).not.toHaveBeenCalled();
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it("still requires the authenticated owner", async () => {
    await retryRoute(new Request("http://test", { method: "POST" }), itemParams());
    expect(requireOwner).toHaveBeenCalledTimes(1);
  });
});
