import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection: vi.fn(async () => null), getValidEbayAccessToken: vi.fn() }));
vi.mock("@/lib/ebay-account/feed-client", () => ({
  createFeedTask: vi.fn(), uploadFeedFile: vi.fn(), getFeedTask: vi.fn(), getFeedResultFile: vi.fn(), feedTaskHasInputFile: vi.fn(),
}));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft: vi.fn(), patchMarketplaceDraft: vi.fn(), listMarketplaceDraftsForProducts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/listing-studio/storage-rest", () => ({ createSignedDownloadUrl: vi.fn(), StorageBucketMissingError: class StorageBucketMissingError extends Error {} }));

type FakeBatch = { id: string; owner_id: string; status: string; ebay_task_id: string | null; error_code: string | null; error_message: string | null; attempt_count: number };
type FakeItem = { id: string; batch_id: string; status: string; error_code: string | null; error_message: string | null };

function makeFakeDb(batches: FakeBatch[], items: FakeItem[]) {
  const supabaseRequestAll = vi.fn(async (path: string) => {
    // ebay_feed_batches?owner_id=eq.X&status=eq.failed&ebay_task_id=is.null[&id=eq.Y]&select=...
    const batchQuery = path.match(/^ebay_feed_batches\?owner_id=eq\.([^&]+)&status=eq\.([^&]+)&ebay_task_id=is\.null(?:&id=eq\.([^&]+))?&select=/);
    if (batchQuery) {
      const [, ownerId, status, id] = batchQuery;
      return batches
        .filter(b => b.owner_id === ownerId && b.status === status && b.ebay_task_id === null && (!id || b.id === id))
        .map(b => ({ id: b.id, error_code: b.error_code, error_message: b.error_message }));
    }
    const itemQuery = path.match(/^ebay_feed_batch_items\?batch_id=eq\.([^&]+)&status=in\.\(([^)]+)\)&select=/);
    if (itemQuery) {
      const [, batchId, statusList] = itemQuery;
      const allowed = statusList.split(",");
      return items.filter(i => i.batch_id === batchId && allowed.includes(i.status)).map(i => ({ id: i.id }));
    }
    // getEbayFeedBatch's own queries (used by the route test file, not this one)
    const fullBatch = path.match(/^ebay_feed_batches\?id=eq\.([^&]+)&owner_id=eq\.([^&]+)&select=/);
    if (fullBatch) {
      const [, id, ownerId] = fullBatch;
      const b = batches.find(x => x.id === id && x.owner_id === ownerId);
      return b ? [{
        id: b.id, owner_id: b.owner_id, status: b.status, listing_count: 1, display_number: 1,
        box_dismissed_at: null, activity_dismissed_at: null, ebay_task_id: b.ebay_task_id, csv_row_count: 1, attempt_count: b.attempt_count,
        error_code: b.error_code, error_message: b.error_message, created_at: "x", started_at: "x", completed_at: "x",
      }] : [];
    }
    return [];
  });

  const supabaseRequest = vi.fn(async (path: string, init?: RequestInit) => {
    const itemsPatch = path.match(/^ebay_feed_batch_items\?batch_id=eq\.([^&]+)&status=in\.\(([^)]+)\)$/);
    if (itemsPatch) {
      const [, batchId, statusList] = itemsPatch;
      const allowed = statusList.split(",");
      const patch = JSON.parse(init!.body as string);
      for (const item of items) if (item.batch_id === batchId && allowed.includes(item.status)) Object.assign(item, patch);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  return { supabaseRequest, supabaseRequestAll };
}

async function withFakeDb<T>(batches: FakeBatch[], items: FakeItem[], fn: () => Promise<T>): Promise<T> {
  const db = makeFakeDb(batches, items);
  vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
  vi.resetModules();
  return fn();
}

function fakeBatch(overrides: Partial<FakeBatch> = {}): FakeBatch {
  return { id: "batch-1", owner_id: "owner-1", status: "failed", ebay_task_id: null, error_code: "ebay_task_error", error_message: "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid.", attempt_count: 3, ...overrides };
}
function fakeItem(overrides: Partial<FakeItem> = {}): FakeItem {
  return { id: "item-1", batch_id: "batch-1", status: "queued", error_code: null, error_message: null, ...overrides };
}

describe("reconcileInconsistentFailedFeedBatchItems — PHASE 4 (third real-submission audit): historical data repair", () => {
  it("REQUIREMENT (test 1/5): a failed parent + queued child + no task ID is detected and the child is changed to 'failed'", async () => {
    const batch = fakeBatch();
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const results = await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(results).toEqual([{ batchId: "batch-1", reconciledItemIds: ["item-1"], alreadyConsistent: false }]);
      expect(item.status).toBe("failed");
    });
  });

  it("REQUIREMENT (test 6): the reconciled item carries the parent's own safe error code/message, copied down", async () => {
    const batch = fakeBatch({ error_code: "ebay_task_error", error_message: "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid." });
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(item.error_code).toBe("ebay_task_error");
      expect(item.error_message).toContain("X-EBAY-C-MARKETPLACE-ID");
    });
  });

  it("REQUIREMENT (test 6): the parent batch row and its attempt_count are never touched by this repair", async () => {
    const batch = fakeBatch({ attempt_count: 3 });
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(batch.attempt_count).toBe(3);
      expect(batch.status).toBe("failed");
    });
  });

  it("REQUIREMENT (test 7): makes no eBay request — the eBay Feed client mock is never called", async () => {
    const batch = fakeBatch();
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const feedClient = await import("@/lib/ebay-account/feed-client");
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(feedClient.createFeedTask).not.toHaveBeenCalled();
      expect(feedClient.uploadFeedFile).not.toHaveBeenCalled();
      expect(feedClient.getFeedTask).not.toHaveBeenCalled();
      expect(feedClient.getFeedResultFile).not.toHaveBeenCalled();
    });
  });

  it("REQUIREMENT (test 8): idempotent — running it twice the second time reports alreadyConsistent, no further write", async () => {
    const batch = fakeBatch();
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const first = await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(first[0].alreadyConsistent).toBe(false);
      const second = await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(second).toEqual([{ batchId: "batch-1", reconciledItemIds: [], alreadyConsistent: true }]);
    });
  });

  it("REQUIREMENT (test 9): rejects a non-failed parent — a 'processing' batch is never touched", async () => {
    const batch = fakeBatch({ status: "processing" });
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const results = await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(results).toEqual([]);
      expect(item.status).toBe("queued");
    });
  });

  it("REQUIREMENT (test 10): rejects a batch with a recorded remote task ID — never blindly marks its children failed", async () => {
    const batch = fakeBatch({ ebay_task_id: "task-1" });
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const results = await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(results).toEqual([]);
      expect(item.status).toBe("queued");
    });
  });

  it("REQUIREMENT (test 11): never touches an item already 'succeeded' or 'cancelled'", async () => {
    const batch = fakeBatch();
    const succeeded = fakeItem({ id: "item-ok", status: "succeeded" });
    const cancelled = fakeItem({ id: "item-cancelled", status: "cancelled" });
    await withFakeDb([batch], [succeeded, cancelled], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const results = await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(results).toEqual([{ batchId: "batch-1", reconciledItemIds: [], alreadyConsistent: true }]);
      expect(succeeded.status).toBe("succeeded");
      expect(cancelled.status).toBe("cancelled");
    });
  });

  it("REQUIREMENT (test 12): owner isolation — a batch belonging to a different owner is never found or touched", async () => {
    const batch = fakeBatch({ owner_id: "owner-OTHER" });
    const item = fakeItem();
    await withFakeDb([batch], [item], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const results = await reconcileInconsistentFailedFeedBatchItems("owner-1", "batch-1");
      expect(results).toEqual([]);
      expect(item.status).toBe("queued");
    });
  });

  it("generic sweep (no batchId given) repairs every one of this owner's inconsistent failed batches, never another owner's", async () => {
    const batchA = fakeBatch({ id: "batch-a" });
    const batchB = fakeBatch({ id: "batch-b" });
    const batchOther = fakeBatch({ id: "batch-other", owner_id: "owner-OTHER" });
    const itemA = fakeItem({ id: "item-a", batch_id: "batch-a" });
    const itemB = fakeItem({ id: "item-b", batch_id: "batch-b" });
    const itemOther = fakeItem({ id: "item-other", batch_id: "batch-other" });
    await withFakeDb([batchA, batchB, batchOther], [itemA, itemB, itemOther], async () => {
      const { reconcileInconsistentFailedFeedBatchItems } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const results = await reconcileInconsistentFailedFeedBatchItems("owner-1");
      expect(results.map(r => r.batchId).sort()).toEqual(["batch-a", "batch-b"]);
      expect(itemA.status).toBe("failed");
      expect(itemB.status).toBe("failed");
      expect(itemOther.status).toBe("queued");
    });
  });

  it("REQUIREMENT (test 17): concurrency-safe — the PATCH's own WHERE clause re-evaluates at write time, never a stale snapshot (structural proof: uses status=in.(...) directly in the PATCH URL, not a pre-fetched id list)", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-batches.ts", "utf8") as string;
    const fnBody = source.slice(source.indexOf("export async function reconcileInconsistentFailedFeedBatchItems"), source.indexOf("export async function reconcileInconsistentFailedFeedBatchItems") + 2500);
    expect(fnBody).toContain("status=in.(queued,uploaded,awaiting_result)`, {");
    expect(fnBody).toMatch(/status=in\.\(queued,uploaded,awaiting_result\)`,\s*\{\s*\n\s*method: "PATCH"/);
  });
});
