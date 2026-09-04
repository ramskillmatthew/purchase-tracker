import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getValidEbayAccessToken, getFeedTask } = vi.hoisted(() => ({
  getValidEbayAccessToken: vi.fn(async (_ownerId: string) => ({ accessToken: "token-1", connection: {} as unknown })),
  getFeedTask: vi.fn(async (_accessToken: string, _taskId: string) => ({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null })),
}));
vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection: vi.fn(async () => null), getValidEbayAccessToken }));
vi.mock("@/lib/ebay-account/feed-client", () => ({
  getFeedTask,
  createFeedTask: vi.fn(), uploadFeedFile: vi.fn(), getFeedResultFile: vi.fn(), feedTaskHasInputFile: vi.fn(),
}));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft: vi.fn(), patchMarketplaceDraft: vi.fn(), listMarketplaceDraftsForProducts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/listing-studio/storage-rest", () => ({ createSignedDownloadUrl: vi.fn(), StorageBucketMissingError: class StorageBucketMissingError extends Error {} }));

type FakeBatch = { id: string; owner_id: string; status: string; ebay_task_id: string | null };
type FakeItem = { id: string; batch_id: string; status: string; error_code: string | null; error_message: string | null };

function makeRetryFakeDb(batch: FakeBatch, items: FakeItem[]) {
  const supabaseRequestAll = vi.fn(async (path: string) => {
    const m = path.match(/^ebay_feed_batches\?id=eq\.([^&]+)&owner_id=eq\.([^&]+)&select=/);
    if (m) return (batch.id === m[1] && batch.owner_id === m[2]) ? [{ id: batch.id, status: batch.status, ebay_task_id: batch.ebay_task_id }] : [];
    return [];
  });

  const supabaseRequest = vi.fn(async (path: string, init?: RequestInit) => {
    const batchPatch = path.match(/^ebay_feed_batches\?id=eq\.([^&]+)&owner_id=eq\.([^&]+)&status=eq\.([^&]+)$/);
    if (batchPatch) {
      const [, id, ownerId, expectedStatus] = batchPatch;
      if (batch.id !== id || batch.owner_id !== ownerId || batch.status !== expectedStatus) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      const patch = JSON.parse(init!.body as string);
      Object.assign(batch, patch);
      return new Response(JSON.stringify([{ id: batch.id }]), { status: 200 });
    }
    const itemsPatch = path.match(/^ebay_feed_batch_items\?batch_id=eq\.([^&]+)&status=eq\.([^&]+)$/);
    if (itemsPatch) {
      const [, batchId, expectedStatus] = itemsPatch;
      const patch = JSON.parse(init!.body as string);
      for (const item of items) if (item.batch_id === batchId && item.status === expectedStatus) Object.assign(item, patch);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  return { supabaseRequest, supabaseRequestAll };
}

async function withRetryFakeDb<T>(batch: FakeBatch, items: FakeItem[], fn: () => Promise<T>): Promise<T> {
  const db = makeRetryFakeDb(batch, items);
  vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
  vi.resetModules();
  return fn();
}

function fakeBatch(overrides: Partial<FakeBatch> = {}): FakeBatch {
  return { id: "batch-1", owner_id: "owner-1", status: "failed", ebay_task_id: null, ...overrides };
}
function fakeItem(overrides: Partial<FakeItem> = {}): FakeItem {
  return { id: "item-1", batch_id: "batch-1", status: "failed", error_code: "ebay_task_error", error_message: "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid.", ...overrides };
}

beforeEach(() => {
  getValidEbayAccessToken.mockClear();
  getFeedTask.mockReset();
  getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null });
});

describe("retryEbayFeedBatch — PHASE 7: deliberate retry of the SAME batch, never a fresh one", () => {
  it("REQUIREMENT: only a batch actually in status 'failed' can be retried", async () => {
    const batch = fakeBatch({ status: "processing" });
    await withRetryFakeDb(batch, [], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/Only a failed Seller Hub draft batch can be retried/);
    });
  });

  it("REQUIREMENT: a batch not found throws a clear, safe error", async () => {
    const batch = fakeBatch({ id: "other-batch" });
    await withRetryFakeDb(batch, [], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/could not be found/);
    });
  });

  it("REQUIREMENT: no ebay_task_id (createTask itself failed, e.g. the real SKU 1644 case) resumes fully fresh at 'queued', never calling getFeedTask", async () => {
    const batch = fakeBatch({ ebay_task_id: null });
    const item = fakeItem();
    await withRetryFakeDb(batch, [item], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const outcome = await retryEbayFeedBatch("owner-1", "batch-1");
      expect(outcome).toEqual({ resumedFromTaskId: null, resumedStatus: "queued" });
      expect(batch.status).toBe("queued");
      expect(item.status).toBe("queued");
      expect(item.error_code).toBeNull();
      expect(item.error_message).toBeNull();
      expect(getFeedTask).not.toHaveBeenCalled();
    });
  });

  it("REQUIREMENT: a real ebay_task_id that eBay now reports COMPLETED resumes at 'downloading_result', never re-creating or re-uploading", async () => {
    getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null });
    const batch = fakeBatch({ ebay_task_id: "task-1" });
    const item = fakeItem();
    await withRetryFakeDb(batch, [item], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const outcome = await retryEbayFeedBatch("owner-1", "batch-1");
      expect(outcome).toEqual({ resumedFromTaskId: "task-1", resumedStatus: "downloading_result" });
      expect(batch.status).toBe("downloading_result");
      expect(item.status).toBe("uploaded");
      expect(getFeedTask).toHaveBeenCalledWith("token-1", "task-1");
    });
  });

  it("REQUIREMENT: a real ebay_task_id still in progress (CREATED) resumes at 'processing', never re-creating or re-uploading", async () => {
    getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "CREATED", creationDate: null, completionDate: null });
    const batch = fakeBatch({ ebay_task_id: "task-1" });
    const item = fakeItem();
    await withRetryFakeDb(batch, [item], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const outcome = await retryEbayFeedBatch("owner-1", "batch-1");
      expect(outcome).toEqual({ resumedFromTaskId: "task-1", resumedStatus: "processing" });
      expect(batch.status).toBe("processing");
    });
  });

  it("REQUIREMENT: a real ebay_task_id eBay can no longer find/read resumes at 'processing' rather than guessing it is safe to re-create", async () => {
    getFeedTask.mockRejectedValue(new Error("404 not found"));
    const batch = fakeBatch({ ebay_task_id: "task-1" });
    const item = fakeItem();
    await withRetryFakeDb(batch, [item], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const outcome = await retryEbayFeedBatch("owner-1", "batch-1");
      expect(outcome.resumedStatus).toBe("processing");
    });
  });

  it("REQUIREMENT: never retries a SUCCEEDED row — only items still in status 'failed' are touched", async () => {
    const batch = fakeBatch({ ebay_task_id: null });
    const succeededItem = fakeItem({ id: "item-ok", status: "succeeded", error_code: null, error_message: null });
    const failedItem = fakeItem({ id: "item-bad" });
    await withRetryFakeDb(batch, [succeededItem, failedItem], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await retryEbayFeedBatch("owner-1", "batch-1");
      expect(succeededItem.status).toBe("succeeded");
      expect(failedItem.status).toBe("queued");
    });
  });

  it("REQUIREMENT: owner isolation — a batch belonging to a different owner cannot be retried", async () => {
    const batch = fakeBatch({ owner_id: "owner-OTHER" });
    await withRetryFakeDb(batch, [], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/could not be found/);
    });
  });

  it("REQUIREMENT: concurrency protection — a batch already retried by a concurrent request (no longer 'failed' by the time the PATCH runs) reports it cleanly rather than double-retrying", async () => {
    const batch = fakeBatch({ ebay_task_id: null });
    // Simulate the race: flip status away from 'failed' the moment the
    // conditional PATCH is evaluated, mirroring what a genuinely
    // concurrent second request would have already done.
    const db = makeRetryFakeDb(batch, []);
    const originalRequest = db.supabaseRequest.getMockImplementation()!;
    db.supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("ebay_feed_batches?id=eq.batch-1&owner_id=eq.owner-1&status=eq.failed")) {
        batch.status = "queued"; // another request "won" first
      }
      return originalRequest(path, init);
    });
    vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
    vi.resetModules();
    const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
    await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/already retried|no longer failed/);
  });
});
