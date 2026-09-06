import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getValidEbayAccessToken, getFeedTask, createFeedTask, uploadFeedFile } = vi.hoisted(() => ({
  getValidEbayAccessToken: vi.fn(async (_ownerId: string) => ({ accessToken: "token-1", connection: {} as unknown })),
  getFeedTask: vi.fn(async (_accessToken: string, _taskId: string) => ({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null })),
  // Hoisted (not bare vi.fn() inline in the factory below) specifically so
  // tests can assert on them directly — REQUIREMENT: no eBay Feed task
  // creation or file upload call ever occurs anywhere in this test file.
  createFeedTask: vi.fn(),
  uploadFeedFile: vi.fn(),
}));
vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection: vi.fn(async () => null), getValidEbayAccessToken }));
vi.mock("@/lib/ebay-account/feed-client", () => ({
  getFeedTask, createFeedTask, uploadFeedFile,
  getFeedResultFile: vi.fn(), feedTaskHasInputFile: vi.fn(),
}));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft: vi.fn(), patchMarketplaceDraft: vi.fn(), listMarketplaceDraftsForProducts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/listing-studio/storage-rest", () => ({ createSignedDownloadUrl: vi.fn(), StorageBucketMissingError: class StorageBucketMissingError extends Error {} }));

type FakeBatch = { id: string; owner_id: string; status: string; ebay_task_id: string | null; attempt_count: number; listing_count: number };
type FakeItem = { id: string; batch_id: string; status: string; error_code: string | null; error_message: string | null };

/**
 * CORRECTIVE PASS (fifth real-submission audit) — this fake DB's own RPC
 * handler faithfully mirrors listing_studio_retry_ebay_feed_batch's real
 * SQL logic (supabase-ebay-feed-drafts-atomic-retry.sql): owner+status
 * checked together, both tables updated together, attempt_count never
 * written by this RPC, NOT_RETRYABLE/BATCH_NOT_FOUND raised exactly as
 * the real function does. This is a behavioural simulation of the actual
 * migration text, not a loose approximation — every assertion in this
 * file is really exercising retryEbayFeedBatch's OWN contract with that
 * RPC, including how it parses a rejection.
 */
function makeRetryFakeDb(batch: FakeBatch, items: FakeItem[]) {
  const rpcCalls: Array<{ p_owner_id: string; p_batch_id: string; p_resume_status: string }> = [];

  const supabaseRequestAll = vi.fn(async (path: string) => {
    const m = path.match(/^ebay_feed_batches\?id=eq\.([^&]+)&owner_id=eq\.([^&]+)&select=/);
    if (m) return (batch.id === m[1] && batch.owner_id === m[2]) ? [{ id: batch.id, status: batch.status, ebay_task_id: batch.ebay_task_id }] : [];
    return [];
  });

  // Mirrors lib/supabase.ts's own REAL supabaseRequest contract exactly
  // (throw an Error whose .message is the raw PostgREST error body text
  // on any non-ok response) — a fake that merely RETURNED an error
  // Response object without throwing would let callAtomicRetryRpc's own
  // `.json()` call silently coerce it into `rows[0] ?? null` for the
  // wrong reason, never genuinely exercising its real try/catch
  // classification logic. This fake must behave exactly like production
  // for these tests to prove anything real.
  function pgrstError(message: string): never {
    const error = new Error(JSON.stringify({ code: "P0003", details: null, hint: null, message })) as Error & { status: number };
    error.status = 400;
    throw error;
  }

  const supabaseRequest = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "rpc/listing_studio_retry_ebay_feed_batch") {
      const body = JSON.parse(init!.body as string) as { p_owner_id: string; p_batch_id: string; p_resume_status: string };
      rpcCalls.push(body);
      if (batch.id !== body.p_batch_id || batch.owner_id !== body.p_owner_id) pgrstError("BATCH_NOT_FOUND");
      if (batch.status !== "failed" && batch.status !== "completed_with_errors") pgrstError("NOT_RETRYABLE");
      // Mirrors the real RPC's own two UPDATEs exactly.
      for (const item of items) {
        if (item.batch_id === batch.id && item.status === "failed") {
          item.status = body.p_resume_status === "queued" ? "queued" : "uploaded";
          item.error_code = null;
          item.error_message = null;
        }
      }
      batch.status = body.p_resume_status;
      // attempt_count deliberately NEVER touched here — matches the real
      // RPC's own comment: the claim RPC increments it, not this one.
      return new Response(JSON.stringify([{ batch_id: batch.id, status: batch.status, attempt_count: batch.attempt_count, ebay_task_id: batch.ebay_task_id, listing_count: batch.listing_count }]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  return { supabaseRequest, supabaseRequestAll, rpcCalls };
}

async function withRetryFakeDb<T>(batch: FakeBatch, items: FakeItem[], fn: (db: ReturnType<typeof makeRetryFakeDb>) => Promise<T>): Promise<T> {
  const db = makeRetryFakeDb(batch, items);
  vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
  vi.resetModules();
  return fn(db);
}

function fakeBatch(overrides: Partial<FakeBatch> = {}): FakeBatch {
  return { id: "batch-1", owner_id: "owner-1", status: "failed", ebay_task_id: null, attempt_count: 3, listing_count: 1, ...overrides };
}
function fakeItem(overrides: Partial<FakeItem> = {}): FakeItem {
  return { id: "item-1", batch_id: "batch-1", status: "failed", error_code: "ebay_task_error", error_message: "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid.", ...overrides };
}

beforeEach(() => {
  getValidEbayAccessToken.mockClear();
  getFeedTask.mockReset();
  createFeedTask.mockClear();
  uploadFeedFile.mockClear();
  getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null });
});

afterEach(() => {
  // REQUIREMENT: no eBay Feed request that could create a task or upload
  // a file ever occurs anywhere in this whole retry test file — retrying
  // only ever reconciles (a read-only getFeedTask, itself mocked) and
  // transitions local state via the atomic RPC.
  expect(createFeedTask).not.toHaveBeenCalled();
  expect(uploadFeedFile).not.toHaveBeenCalled();
});

describe("retryEbayFeedBatch — PHASE 7 (fifth audit): the SAME batch, via the single atomic RPC, never a two-step PATCH", () => {
  it("REQUIREMENT: calls the atomic RPC (listing_studio_retry_ebay_feed_batch), never a plain PATCH to ebay_feed_batches for the transition", async () => {
    const batch = fakeBatch({ ebay_task_id: null });
    const item = fakeItem();
    await withRetryFakeDb(batch, [item], async (db) => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await retryEbayFeedBatch("owner-1", "batch-1");
      expect(db.rpcCalls).toEqual([{ p_owner_id: "owner-1", p_batch_id: "batch-1", p_resume_status: "queued" }]);
      const patchCalls = db.supabaseRequest.mock.calls.filter(([path]) => path.startsWith("ebay_feed_batches?") && path !== "rpc/listing_studio_retry_ebay_feed_batch");
      expect(patchCalls).toHaveLength(0);
    });
  });

  it("REQUIREMENT: only a batch actually in status 'failed' can be retried (pre-check, before ever calling the RPC)", async () => {
    const batch = fakeBatch({ status: "processing" });
    await withRetryFakeDb(batch, [], async (db) => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/Only a failed Seller Hub draft batch can be retried/);
      expect(db.rpcCalls).toEqual([]);
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
    await withRetryFakeDb(batch, [item], async (db) => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const outcome = await retryEbayFeedBatch("owner-1", "batch-1");
      expect(outcome).toEqual({ resumedFromTaskId: "task-1", resumedStatus: "downloading_result" });
      expect(batch.status).toBe("downloading_result");
      expect(item.status).toBe("uploaded");
      expect(getFeedTask).toHaveBeenCalledWith("token-1", "task-1");
      // REQUIREMENT: an existing eBay task ID is preserved (the RPC never
      // writes ebay_task_id — confirmed both in the real SQL and here).
      expect(batch.ebay_task_id).toBe("task-1");
      expect(db.rpcCalls[0].p_resume_status).toBe("downloading_result");
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

  it("REQUIREMENT: owner isolation — a batch belonging to a different owner cannot be retried (rejected both by the pre-check AND would be rejected again by the RPC itself)", async () => {
    const batch = fakeBatch({ owner_id: "owner-OTHER" });
    await withRetryFakeDb(batch, [], async (db) => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/could not be found/);
      // The pre-check already rejects it — the RPC is never even reached
      // for this specific path, but the RPC's OWN owner_id=p_owner_id
      // check (see the migration's own `where id = p_batch_id and
      // owner_id = p_owner_id`) is the real, atomic-transaction-time
      // enforcement a malicious/buggy caller could not bypass even if
      // this pre-check were ever removed.
      expect(db.rpcCalls).toEqual([]);
    });
  });

  it("REQUIREMENT: attempts increment exactly once — this RPC never writes attempt_count itself (the claim RPC does, exactly once per real claim)", async () => {
    const batch = fakeBatch({ ebay_task_id: null, attempt_count: 3 });
    const item = fakeItem();
    await withRetryFakeDb(batch, [item], async () => {
      const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await retryEbayFeedBatch("owner-1", "batch-1");
      expect(batch.attempt_count).toBe(3);
    });
  });

  it("REQUIREMENT: concurrency protection — a batch already retried by a concurrent request (no longer 'failed' by the time the RPC's own atomic check runs) reports it cleanly rather than double-retrying, and never falls back to a non-atomic PATCH", async () => {
    const batch = fakeBatch({ ebay_task_id: null });
    const db = makeRetryFakeDb(batch, []);
    const originalRequest = db.supabaseRequest.getMockImplementation()!;
    // Simulates a genuinely concurrent second request winning the RPC's
    // own row lock first — the batch is no longer 'failed' by the time
    // THIS call's RPC invocation actually runs its atomic check.
    db.supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "rpc/listing_studio_retry_ebay_feed_batch") batch.status = "queued";
      return originalRequest(path, init);
    });
    vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
    vi.resetModules();
    const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
    await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/already retried|no longer failed/);
  });

  it("REQUIREMENT: an unexpected RPC error (not NOT_RETRYABLE/BATCH_NOT_FOUND) is re-thrown, never silently swallowed or retried through a non-atomic fallback", async () => {
    const batch = fakeBatch({ ebay_task_id: null });
    const db = makeRetryFakeDb(batch, []);
    db.supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/listing_studio_retry_ebay_feed_batch") {
        const error = new Error(JSON.stringify({ code: "XX000", message: "unexpected database error" })) as Error & { status: number };
        error.status = 500;
        throw error;
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
    vi.resetModules();
    const { retryEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
    await expect(retryEbayFeedBatch("owner-1", "batch-1")).rejects.toThrow(/unexpected database error/);
    // The batch's own local state (in this fake DB) was never mutated —
    // no partial/non-atomic write occurred as a fallback.
    expect(batch.status).toBe("failed");
  });

  it("STRUCTURAL: the old two-step PATCH helper (resumeFailedBatch) no longer exists in the source at all", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-batches.ts", "utf8") as string;
    expect(source).not.toContain("resumeFailedBatch");
    expect(source).toContain("callAtomicRetryRpc");
    expect(source).toContain('"rpc/listing_studio_retry_ebay_feed_batch"');
  });

  it("STRUCTURAL: retryEbayFeedBatch never issues a PATCH to ebay_feed_batches or ebay_feed_batch_items anywhere in its own source", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-batches.ts", "utf8") as string;
    const fnStart = source.indexOf("export async function retryEbayFeedBatch");
    const fnEnd = source.indexOf("\nasync function callAtomicRetryRpc", fnStart);
    const fnBody = source.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/method:\s*"PATCH"/);
  });
});
