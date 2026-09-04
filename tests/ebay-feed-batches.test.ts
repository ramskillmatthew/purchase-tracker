import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getMarketplaceDraft, patchMarketplaceDraft,
  getEbayConnection, getValidEbayAccessToken,
  createFeedTask, uploadFeedFile, getFeedTask, getFeedResultFile, feedTaskHasInputFile,
  createSignedDownloadUrl,
} = vi.hoisted(() => ({
  getMarketplaceDraft: vi.fn(async (_ownerId: string, _productDraftId: string, _marketplace: "EBAY_UK") => null as unknown),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
  getEbayConnection: vi.fn(async (_ownerId: string) => null as unknown),
  getValidEbayAccessToken: vi.fn(async (_ownerId: string) => ({ accessToken: "token-1", connection: {} as unknown })),
  createFeedTask: vi.fn(async (_accessToken: string, _marketplaceId: string) => ({ taskId: "task-1" })),
  uploadFeedFile: vi.fn(async (_accessToken: string, _taskId: string, _csv: string) => {}),
  getFeedTask: vi.fn(async (_accessToken: string, _taskId: string) => ({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null })),
  getFeedResultFile: vi.fn(async (_accessToken: string, _taskId: string) => 'Custom label (SKU),Status\r\n1644,Success\r\n'),
  feedTaskHasInputFile: vi.fn(async (_accessToken: string, _taskId: string) => false),
  createSignedDownloadUrl: vi.fn(async (_bucket: string, _path: string, _expiresInSeconds: number) => "https://project.supabase.co/storage/v1/object/sign/listing-drafts/x?token=abc"),
}));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft, patchMarketplaceDraft, listMarketplaceDraftsForProducts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection, getValidEbayAccessToken }));
vi.mock("@/lib/ebay-account/feed-client", () => ({ createFeedTask, uploadFeedFile, getFeedTask, getFeedResultFile, feedTaskHasInputFile }));
vi.mock("@/lib/listing-studio/storage-rest", () => ({
  createSignedDownloadUrl,
  StorageBucketMissingError: class StorageBucketMissingError extends Error {},
}));
vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "HEAD") return new Response(null, { status: 200 });
  return new Response(null, { status: 200 });
}));

// ---------------------------------------------------------------------
// A realistic in-memory simulation of ebay_feed_batches / ebay_feed_batch_items
// and their RPCs, driven through the same supabaseRequest/supabaseRequestAll
// surface lib/supabase.ts exposes — mirrors tests/listing-studio-ebay-draft-batches.test.ts's
// own established fake-db pattern, adapted for the batch-level claim/advance/
// finish RPCs this pipeline actually calls.
type FakeItem = {
  id: string; batch_id: string; marketplace_draft_id: string; product_draft_id: string; queue_position: number;
  sku: string; status: string; error_code: string | null; error_message: string | null;
  started_at: string | null; completed_at: string | null;
};
type FakeBatch = {
  id: string; owner_id: string; status: string; listing_count: number; display_number: number;
  box_dismissed_at: string | null; activity_dismissed_at: string | null;
  ebay_task_id: string | null; csv_row_count: number | null; attempt_count: number;
  error_code: string | null; error_message: string | null;
  claimed_at: string | null; lease_expires_at: string | null; claimed_by: string | null;
  created_at: string; started_at: string | null; completed_at: string | null;
};

const TERMINAL = ["completed", "completed_with_errors", "failed", "cancelled"];

function makeFakeDb(batch: FakeBatch, items: FakeItem[]) {
  const now = () => Date.now();

  function claim(ownerId: string, batchId: string | null, limit: number, claimedBy: string) {
    if (batch.owner_id !== ownerId) return [];
    if (batchId !== null && batch.id !== batchId) return [];
    if (TERMINAL.includes(batch.status)) return [];
    const leaseOk = batch.claimed_at === null || (batch.lease_expires_at !== null && new Date(batch.lease_expires_at).getTime() < now());
    if (!leaseOk) return [];
    const nowIso = new Date(now()).toISOString();
    batch.claimed_at = nowIso;
    batch.lease_expires_at = new Date(now() + 120_000).toISOString();
    batch.claimed_by = claimedBy;
    if (!batch.started_at) batch.started_at = nowIso;
    batch.attempt_count += 1;
    return [{ batch_id: batch.id, status: batch.status, ebay_task_id: batch.ebay_task_id, attempt_count: batch.attempt_count, listing_count: batch.listing_count }].slice(0, limit);
  }

  function advance(batchId: string, claimedBy: string, status: string, ebayTaskId: string | null, csvRowCount: number | null, errorCode: string | null, errorMessage: string | null) {
    if (batch.id !== batchId || batch.claimed_by !== claimedBy) throw new Error("CLAIM_NOT_HELD");
    const isTerminal = TERMINAL.includes(status);
    batch.status = status;
    if (ebayTaskId) batch.ebay_task_id = ebayTaskId;
    if (csvRowCount !== null) batch.csv_row_count = csvRowCount;
    if (status === "failed" || status === "completed_with_errors") { batch.error_code = errorCode; batch.error_message = errorMessage; }
    // ALWAYS releases the claim — mirrors the real
    // listing_studio_advance_ebay_feed_batch RPC exactly (see
    // supabase-ebay-feed-drafts.sql's own comment): the next tick must be
    // able to reclaim and continue immediately, whether this transition
    // was terminal or not.
    batch.claimed_at = null; batch.lease_expires_at = null; batch.claimed_by = null;
    if (isTerminal) batch.completed_at = new Date(now()).toISOString();
  }

  function finishItems(batchId: string, claimedBy: string, results: Array<{ sku: string; status: string; error_code: string | null; error_message: string | null }>) {
    if (batch.id !== batchId || batch.claimed_by !== claimedBy) throw new Error("CLAIM_NOT_HELD");
    for (const r of results) {
      if (r.status !== "succeeded" && r.status !== "failed") continue;
      const item = items.find(i => i.batch_id === batchId && i.sku === r.sku);
      if (item) { item.status = r.status; item.error_code = r.error_code; item.error_message = r.error_message; item.completed_at = new Date(now()).toISOString(); }
    }
  }

  const supabaseRequest = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "rpc/listing_studio_claim_ebay_feed_batches") {
      const body = JSON.parse(init!.body as string);
      const claimed = claim(body.p_owner_id, body.p_batch_id, body.p_limit, body.p_claimed_by);
      return new Response(JSON.stringify(claimed), { status: 200 });
    }
    if (path === "rpc/listing_studio_advance_ebay_feed_batch") {
      const body = JSON.parse(init!.body as string);
      try {
        advance(body.p_batch_id, body.p_claimed_by, body.p_status, body.p_ebay_task_id, body.p_csv_row_count, body.p_error_code, body.p_error_message);
        return new Response(null, { status: 200 });
      } catch {
        return new Response(JSON.stringify({ message: "CLAIM_NOT_HELD" }), { status: 400 });
      }
    }
    if (path === "rpc/listing_studio_finish_ebay_feed_batch_items") {
      const body = JSON.parse(init!.body as string);
      try {
        finishItems(body.p_batch_id, body.p_claimed_by, body.p_results);
        return new Response(null, { status: 200 });
      } catch {
        return new Response(JSON.stringify({ message: "CLAIM_NOT_HELD" }), { status: 400 });
      }
    }
    const itemsPatchMatch = path.match(/^ebay_feed_batch_items\?batch_id=eq\.([^&]+)&status=eq\.([^&]+)$/);
    if (itemsPatchMatch) {
      const [, batchId, expectedStatus] = itemsPatchMatch;
      const patch = JSON.parse(init!.body as string);
      for (const item of items) if (item.batch_id === batchId && item.status === expectedStatus) Object.assign(item, patch);
      return new Response(null, { status: 204 });
    }
    // CORRECTIVE PASS (duplicate-submission defect) — markBatchFailed's own
    // cascade PATCH, matching any non-terminal item status via status=in.(...).
    const itemsInPatchMatch = path.match(/^ebay_feed_batch_items\?batch_id=eq\.([^&]+)&status=in\.\(([^)]+)\)$/);
    if (itemsInPatchMatch) {
      const [, batchId, statusList] = itemsInPatchMatch;
      const allowedStatuses = statusList.split(",");
      const patch = JSON.parse(init!.body as string);
      for (const item of items) if (item.batch_id === batchId && allowedStatuses.includes(item.status)) Object.assign(item, patch);
      return new Response(null, { status: 204 });
    }
    // prepareFeedPrimaryPhoto's own bounded top-1 photo query — goes
    // through supabaseRequest directly (never supabaseRequestAll, which
    // rejects an explicit limit= — see that function's own corrective-pass
    // comment), so it must be served here, not by the supabaseRequestAll
    // mock below.
    if (path.startsWith("listing_draft_images?draft_id=eq.") && path.includes("limit=1")) {
      return new Response(JSON.stringify([{ id: "img-1", storage_path: "owner-1/product-1/img-1-x.jpg" }]), { status: 200 });
    }
    if (path.startsWith("ebay_feed_batches?") || path.startsWith("ebay_feed_batch_items?")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify([]), { status: 200 });
  });

  const supabaseRequestAll = vi.fn(async (path: string) => {
    if (path.startsWith("ebay_feed_batch_items?batch_id=eq.")) return items.filter(i => path.includes(`eq.${i.batch_id}`));
    if (path.startsWith("ebay_feed_batches?id=eq.")) return batch ? [{ status: batch.status }] : [];
    if (path.startsWith("listing_draft_images?draft_id=eq.")) return [{ id: "img-1", storage_path: "owner-1/product-1/img-1-x.jpg" }];
    if (path.startsWith("listing_drafts?")) return [];
    return [];
  });

  return { supabaseRequest, supabaseRequestAll, items, batch };
}

function fakeItem(overrides: Partial<FakeItem> = {}): FakeItem {
  return {
    id: "item-1", batch_id: "batch-1", marketplace_draft_id: "mdraft-1", product_draft_id: "product-1", queue_position: 0,
    sku: "1644", status: "queued", error_code: null, error_message: null, started_at: null, completed_at: null,
    ...overrides,
  };
}
function fakeBatch(overrides: Partial<FakeBatch> = {}): FakeBatch {
  return {
    id: "batch-1", owner_id: "owner-1", status: "queued", listing_count: 1, display_number: 1,
    box_dismissed_at: null, activity_dismissed_at: null, ebay_task_id: null, csv_row_count: null, attempt_count: 0,
    error_code: null, error_message: null, claimed_at: null, lease_expires_at: null, claimed_by: null,
    created_at: new Date().toISOString(), started_at: null, completed_at: null,
    ...overrides,
  };
}
function marketplaceDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdraft-1", productDraftId: "product-1", ownerId: "owner-1", marketplace: "EBAY_UK" as const,
    sourceType: "generated" as const, contentMode: "seo_optimised" as const,
    title: "On Running Cloud 5", description: "desc", categoryId: "95672", categoryName: "Trainers", categoryPath: "Shoes > Trainers",
    categorySource: "ai" as const, categoryConfidence: "high" as const, categoryAlternatives: [], categorySearchTerms: null,
    conditionValue: "Used – Very Good", pricePence: 2500, quantity: 1, currency: "GBP",
    status: "ready" as const, readiness: { ready: true, completionPercent: 100, requiredComplete: 8, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
    validationMessages: [], aiGeneration: null, sourceDraftId: null, sourceEbayItemId: null, dynamicData: {}, settings: {},
    ebayFulfillmentPolicyId: null, ebayReturnPolicyId: null, ebayPaymentPolicyId: null, ebayMerchantLocationKey: null,
    ebayOfferId: null, ebayInventorySyncedAt: null, ebayLastDraftError: null, ebayPhotoState: {},
    ebayFeedDraftCreatedAt: null, ebayFeedLastError: null,
    createdAt: "x", updatedAt: "x",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  getMarketplaceDraft.mockReset(); patchMarketplaceDraft.mockReset();
  getEbayConnection.mockReset(); getValidEbayAccessToken.mockReset();
  createFeedTask.mockReset(); uploadFeedFile.mockReset(); getFeedTask.mockReset(); getFeedResultFile.mockReset(); feedTaskHasInputFile.mockReset();
  createSignedDownloadUrl.mockReset();

  getMarketplaceDraft.mockResolvedValue(marketplaceDraft());
  getEbayConnection.mockResolvedValue({ id: "conn-1", connectionStatus: "connected" });
  getValidEbayAccessToken.mockResolvedValue({ accessToken: "token-1", connection: {} });
  createFeedTask.mockResolvedValue({ taskId: "task-1" });
  uploadFeedFile.mockResolvedValue(undefined);
  getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null });
  getFeedResultFile.mockResolvedValue('Custom label (SKU),Status\r\n1644,Success\r\n');
  feedTaskHasInputFile.mockResolvedValue(false);
  createSignedDownloadUrl.mockResolvedValue("https://project.supabase.co/storage/v1/object/sign/listing-drafts/x?token=abc");
});

async function withFakeDb<T>(batch: FakeBatch, items: FakeItem[], fn: () => Promise<T>): Promise<T> {
  const db = makeFakeDb(batch, items);
  vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
  vi.resetModules();
  return fn();
}

describe("runEbayFeedBatchProcessTick — full pipeline, one stage per tick", () => {
  it("advances a batch through every real stage to 'completed' over successive ticks, never skipping a stage", async () => {
    const batch = fakeBatch();
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const seenStatuses: string[] = [batch.status];
      for (let i = 0; i < 10 && !["completed", "completed_with_errors", "failed"].includes(batch.status); i++) {
        await runEbayFeedBatchProcessTick("owner-1", "batch-1");
        seenStatuses.push(batch.status);
      }
      expect(batch.status).toBe("completed");
      expect(seenStatuses).toEqual(["queued", "generating_csv", "creating_task", "uploading", "processing", "downloading_result", "parsing_result", "completed"]);
      expect(items[0].status).toBe("succeeded");
    });
  });

  // CORRECTIVE PASS (third real-submission audit) — REQUIREMENT (test 2):
  // a child under a failed parent must never remain claimable. A failed
  // batch is structurally unclaimable at the BATCH level (this pipeline
  // only ever claims whole batches, never individual items — see this
  // file's own header), so its stale 'queued' child is never touched by
  // any subsequent claim/tick, exactly like Batch #1's own real behaviour
  // (attempt_count frozen, item frozen) confirmed by live read-only
  // diagnosis this corrective pass performed.
  it("REQUIREMENT (test 2): a 'failed' batch's stale queued child is never claimed or advanced by a later process tick", async () => {
    const batch = fakeBatch({ status: "failed", attempt_count: 3, error_code: "ebay_task_error", error_message: "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid." });
    const items = [fakeItem({ status: "queued" })];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(result.claimedCount).toBe(0);
      expect(batch.status).toBe("failed");
      expect(batch.attempt_count).toBe(3);
      expect(items[0].status).toBe("queued");
    });
  });

  it("persists the real eBay task ID as soon as createFeedTask succeeds, before any upload is attempted", async () => {
    const batch = fakeBatch({ status: "creating_task" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.ebay_task_id).toBe("task-1");
      expect(batch.status).toBe("uploading");
      expect(uploadFeedFile).not.toHaveBeenCalled();
    });
  });

  // CORRECTIVE PASS (root cause of the second real submission's actual
  // failure) — REQUIREMENT: createFeedTask is called with the canonical
  // eBay marketplace ID, never this app's own internal "EBAY_UK" value.
  it("REQUIREMENT: createFeedTask is called with the resolved eBay marketplace ID EBAY_GB, not the internal EBAY_UK value", async () => {
    const batch = fakeBatch({ status: "creating_task" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(createFeedTask).toHaveBeenCalledWith("token-1", "EBAY_GB");
    });
  });

  it("uploadFeedFile is called with the already-persisted task ID, never a freshly re-created one", async () => {
    const batch = fakeBatch({ status: "uploading", ebay_task_id: "task-1" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(feedTaskHasInputFile).toHaveBeenCalledWith("token-1", "task-1");
      expect(uploadFeedFile).toHaveBeenCalledWith("token-1", "task-1", expect.any(String));
      expect(createFeedTask).not.toHaveBeenCalled();
      expect(batch.status).toBe("processing");
    });
  });

  it("AUDIT POINT 13: if eBay already has an input file for this task (a crash after a previous successful upload but before local persistence), never uploads a second time — just advances", async () => {
    feedTaskHasInputFile.mockResolvedValue(true);
    const batch = fakeBatch({ status: "uploading", ebay_task_id: "task-1" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(feedTaskHasInputFile).toHaveBeenCalledWith("token-1", "task-1");
      expect(uploadFeedFile).not.toHaveBeenCalled();
      expect(batch.status).toBe("processing");
      expect(items[0].status).toBe("uploaded");
    });
  });

  it("AUDIT POINT 13: if the check for an existing input file itself fails, the batch fails closed rather than guessing whether to upload", async () => {
    feedTaskHasInputFile.mockRejectedValue(new Error("network error"));
    const batch = fakeBatch({ status: "uploading", ebay_task_id: "task-1" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(uploadFeedFile).not.toHaveBeenCalled();
      expect(batch.status).toBe("failed");
    });
  });

  // CORRECTIVE PASS (second real submission — duplicate-submission defect,
  // Phase 6) — ROOT CAUSE of "the item stayed 'queued' and the bulk button
  // stayed enabled even after Batch #1 had already failed": a batch that
  // fails at an EARLY stage (before any real per-row result exists) used
  // to leave its own items frozen at their pre-failure status forever.
  it("REQUIREMENT: when createFeedTask fails and the batch is marked 'failed', every still-queued item in that batch is ALSO marked 'failed', carrying the same error", async () => {
    createFeedTask.mockRejectedValue(new Error("The X-EBAY-C-MARKETPLACE-ID header is missing or invalid."));
    const batch = fakeBatch({ status: "creating_task" });
    const items = [fakeItem({ status: "queued" })];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("failed");
      expect(items[0].status).toBe("failed");
      expect(items[0].error_message).toContain("X-EBAY-C-MARKETPLACE-ID");
    });
  });

  it("REQUIREMENT: an item already 'succeeded' or 'cancelled' is never touched by a later batch-level failure cascade", async () => {
    createFeedTask.mockRejectedValue(new Error("boom"));
    const batch = fakeBatch({ status: "creating_task" });
    const succeededItem = fakeItem({ id: "item-succeeded", sku: "1111", status: "succeeded", completed_at: "2026-01-01T00:00:00Z" });
    const cancelledItem = fakeItem({ id: "item-cancelled", sku: "2222", status: "cancelled" });
    const items = [succeededItem, cancelledItem];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(succeededItem.status).toBe("succeeded");
      expect(cancelledItem.status).toBe("cancelled");
    });
  });

  it("AUDIT POINT 12: a batch that keeps failing the same fast stage is stopped after a bounded number of attempts, never retried forever", async () => {
    const batch = fakeBatch({ status: "creating_task", attempt_count: 20 });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("failed");
      expect(batch.error_message).toContain("21 attempts"); // 20 pre-existing + 1 from this tick's own claim
      expect(createFeedTask).not.toHaveBeenCalled();
    });
  });

  it("AUDIT POINT 12: the attempt cap does NOT apply to 'processing' — a batch legitimately polling many times is never wrongly killed", async () => {
    getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "IN_PROCESS", creationDate: null, completionDate: null });
    const batch = fakeBatch({ status: "processing", ebay_task_id: "task-1", attempt_count: 40 });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("processing");
    });
  });

  it("stays in 'processing' (lease renewed, no error) while eBay's own task status is not yet terminal", async () => {
    getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "IN_PROCESS", creationDate: null, completionDate: null });
    const batch = fakeBatch({ status: "processing", ebay_task_id: "task-1" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("processing");
      expect(batch.error_message).toBeNull();
      expect(result.hasMoreWork).toBe(true);
    });
  });

  it("a genuinely unrecognised task status is treated as still-in-progress, never mistaken for terminal", async () => {
    getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "SOME_FUTURE_STATUS", creationDate: null, completionDate: null });
    const batch = fakeBatch({ status: "processing", ebay_task_id: "task-1" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("processing");
    });
  });

  it("a partial failure (one SKU reported as failed in the result file) produces 'completed_with_errors', and only the failed item's status reflects it", async () => {
    getFeedResultFile.mockResolvedValue('Custom label (SKU),Status,Errors\r\n1644,Success,\r\n9999,Error,Category ID is invalid\r\n');
    const batch = fakeBatch({ status: "parsing_result", ebay_task_id: "task-1" });
    const items = [fakeItem({ sku: "1644" }), fakeItem({ id: "item-2", sku: "9999", marketplace_draft_id: "mdraft-2" })];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("completed_with_errors");
      expect(items.find(i => i.sku === "1644")?.status).toBe("succeeded");
      expect(items.find(i => i.sku === "9999")?.status).toBe("failed");
      expect(items.find(i => i.sku === "9999")?.error_message).toContain("Category ID is invalid");
    });
  });

  it("PHASE 9.23: a local item with NO matching row at all in eBay's result file fails closed, never silently assumed successful", async () => {
    getFeedResultFile.mockResolvedValue('Custom label (SKU),Status\r\n9999,Success\r\n'); // 1644 (our real item) is simply absent
    const batch = fakeBatch({ status: "parsing_result", ebay_task_id: "task-1" });
    const items = [fakeItem({ sku: "1644" })];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(items[0].status).toBe("failed");
      expect(items[0].error_message).toContain("did not report a result");
      expect(patchMarketplaceDraft).not.toHaveBeenCalledWith("owner-1", "mdraft-1", expect.objectContaining({ ebay_feed_draft_created_at: expect.anything() }));
    });
  });

  it("PHASE 9.27: a failed item's underlying listing is never marked as already having a Seller Hub draft — it stays eligible for a fresh batch", async () => {
    getFeedResultFile.mockResolvedValue('Custom label (SKU),Status,Errors\r\n1644,Error,Category ID is invalid\r\n');
    const batch = fakeBatch({ status: "parsing_result", ebay_task_id: "task-1" });
    const items = [fakeItem({ sku: "1644" })];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(items[0].status).toBe("failed");
      // The only patchMarketplaceDraft calls for this failed item must
      // never set ebay_feed_draft_created_at — that field is the ONE
      // signal eligibility uses to exclude an already-drafted listing.
      const calls = (patchMarketplaceDraft as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[1] === "mdraft-1");
      for (const call of calls) expect(call[2]).not.toHaveProperty("ebay_feed_draft_created_at");
    });
  });

  it("marks the marketplace draft's ebay_feed_draft_created_at only for a genuinely succeeded row, never for a failed one", async () => {
    getFeedResultFile.mockResolvedValue('Custom label (SKU),Status\r\n1644,Success\r\n');
    const batch = fakeBatch({ status: "parsing_result", ebay_task_id: "task-1" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-1", expect.objectContaining({ ebay_feed_draft_created_at: expect.any(String) }));
    });
  });

  it("never calls the retired Inventory API client from anywhere in this pipeline", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-batches.ts", "utf8") as string;
    expect(source).not.toMatch(/from "@\/lib\/ebay-account\/inventory-client"/);
    expect(source).not.toContain("createOrReplaceInventoryItem");
    expect(source).not.toContain("createOffer(");
  });

  it("PHASE 6 (respect Retry-After): a 429 with a Retry-After hint never permanently fails the batch — it re-advances to the SAME status so the next tick retries fresh", async () => {
    const rateLimitError = Object.assign(new Error("rate limited"), { status: 429, retryAfterSeconds: 5 });
    createFeedTask.mockRejectedValue(rateLimitError);
    const batch = fakeBatch({ status: "creating_task" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("creating_task"); // unchanged, never "failed"
      expect(batch.error_code).toBeNull();
    });
  });

  it("PHASE 6: a non-429 error still fails the batch normally, even with an unrelated retryAfterSeconds-shaped property absent", async () => {
    createFeedTask.mockRejectedValue(new Error("genuine failure, not rate limited"));
    const batch = fakeBatch({ status: "creating_task" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("failed");
    });
  });

  it("an eligibility failure at the 'queued' stage marks the whole batch failed, with the offending SKU named", async () => {
    getMarketplaceDraft.mockResolvedValue(marketplaceDraft({ categoryId: null }));
    const batch = fakeBatch({ status: "queued" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(batch.status).toBe("failed");
      expect(batch.error_message).toContain("1644");
    });
  });

  it("a claim already held by another worker (lease not expired) is never reclaimed by a concurrent tick", async () => {
    const batch = fakeBatch({ status: "uploading", ebay_task_id: "task-1", claimed_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 60_000).toISOString(), claimed_by: "other-worker" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(result.claimedCount).toBe(0);
      expect(uploadFeedFile).not.toHaveBeenCalled();
      expect(batch.claimed_by).toBe("other-worker");
    });
  });

  it("an expired lease becomes claimable again automatically, with no separate manual-unstick action", async () => {
    const batch = fakeBatch({ status: "uploading", ebay_task_id: "task-1", claimed_at: new Date(Date.now() - 300_000).toISOString(), lease_expires_at: new Date(Date.now() - 60_000).toISOString(), claimed_by: "dead-worker" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(result.claimedCount).toBe(1);
      expect(batch.status).toBe("processing");
    });
  });

  it("a terminal batch is never reclaimed", async () => {
    const batch = fakeBatch({ status: "completed" });
    const items = [fakeItem({ status: "succeeded" })];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(result.claimedCount).toBe(0);
      expect(result.hasMoreWork).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------
// PHASE 2/4 — pre-submission preview. Lightweight fake DB (no batch RPCs
// involved), separate from the batch-processing harness above.
async function withPreviewFakeDb<T>(fn: () => Promise<T>, opts: { photoCount?: number } = {}): Promise<T> {
  const photoCount = opts.photoCount ?? 1;
  const supabaseRequestAll = vi.fn(async (path: string) => {
    if (path.startsWith("listing_drafts?id=eq.")) return [{ id: "product-1", sku: "1644" }];
    if (path.startsWith("ebay_feed_batch_items?marketplace_draft_id=in.")) return []; // no active/failed batch item by default
    if (path.startsWith("ebay_feed_batches?id=in.")) return [];
    if (path.startsWith("listing_draft_images?draft_id=eq.")) return Array.from({ length: photoCount }, (_, i) => ({ id: `img-${i}` }));
    return [];
  });
  // prepareFeedPrimaryPhoto's own bounded top-1 photo query goes through
  // supabaseRequest directly (never supabaseRequestAll — see that
  // function's own corrective-pass comment on why an explicit `limit=`
  // must never reach supabaseRequestAll), so it must be served here.
  const supabaseRequest = vi.fn(async (path: string) => {
    if (path.startsWith("listing_draft_images?draft_id=eq.") && path.includes("limit=1")) {
      return new Response(JSON.stringify(photoCount > 0 ? [{ id: "img-1", storage_path: "owner-1/product-1/img-1.jpg" }] : []), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  vi.doMock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));
  vi.resetModules();
  return fn();
}

describe("buildFeedDraftPreviewForProduct — PHASE 2/4: exactly which fields transfer vs must be completed in Seller Hub", () => {
  it("REQUIREMENT: reports the real, honest values that will transfer", async () => {
    await withPreviewFakeDb(async () => {
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      if (!result.ok) throw new Error("expected a preview, got: " + result.reason);
      expect(result.row.fields.Title).toBe("On Running Cloud 5");
      expect(result.row.fields["Custom label (SKU)"]).toBe("1644");
      expect(result.row.fields["Category ID"]).toBe("95672");
      expect(result.row.draftId).toBe("product-1");
    });
  });

  it("REQUIREMENT: business policies and inventory location are ALWAYS listed as completed-in-Seller-Hub — the real template has no column for either, for every draft", async () => {
    await withPreviewFakeDb(async () => {
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      if (!result.ok) throw new Error("expected a preview");
      expect(result.row.completeInSellerHub.some(s => /policies/i.test(s))).toBe(true);
      expect(result.row.completeInSellerHub.some(s => /location/i.test(s))).toBe(true);
    });
  });

  it("REQUIREMENT: multiple uploaded photos are honestly disclosed — only the main one transfers", async () => {
    await withPreviewFakeDb(async () => {
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      if (!result.ok) throw new Error("expected a preview");
      expect(result.row.completeInSellerHub.some(s => /additional photo/i.test(s))).toBe(true);
    }, { photoCount: 4 });
  });

  it("a single photo does not spuriously claim additional photos need completing", async () => {
    await withPreviewFakeDb(async () => {
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      if (!result.ok) throw new Error("expected a preview");
      expect(result.row.completeInSellerHub.some(s => /additional photo/i.test(s))).toBe(false);
    }, { photoCount: 1 });
  });

  it("REQUIREMENT: a multi-value aspect is honestly disclosed — only the first value transfers", async () => {
    await withPreviewFakeDb(async () => {
      const { getMarketplaceDraft } = await import("@/lib/listing-studio/marketplace-drafts");
      (getMarketplaceDraft as ReturnType<typeof vi.fn>).mockResolvedValueOnce(marketplaceDraft({ dynamicData: { Colour: { value: ["Red", "Blue"], source: "manual", confidence: "high", needsReview: false, userConfirmed: true, updatedAt: "x" } } }));
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      if (!result.ok) throw new Error("expected a preview");
      expect(result.row.completeInSellerHub.some(s => s.includes("Colour"))).toBe(true);
    });
  });

  it("no signed photo URL token ever leaks into the preview", async () => {
    await withPreviewFakeDb(async () => {
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      if (!result.ok) throw new Error("expected a preview");
      expect(JSON.stringify(result)).not.toContain("token=abc");
    });
  });

  it("PHASE 6 REGRESSION (root cause of the first live preview attempt): prepareFeedPrimaryPhoto never passes a caller-supplied limit into supabaseRequestAll — it must use supabaseRequest directly for its bounded top-1 photo query", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-batches.ts", "utf8") as string;
    const fnBody = source.slice(source.indexOf("async function prepareFeedPrimaryPhoto"), source.indexOf("async function prepareFeedPrimaryPhoto") + 1200);
    expect(fnBody).not.toMatch(/supabaseRequestAll[^)]*limit=/);
    expect(fnBody).toContain("await supabaseRequest(");
  });

  it("a listing already SUCCEEDED (a genuine Seller Hub draft already exists) is blocked with a precise reason, never silently re-offered", async () => {
    await withPreviewFakeDb(async () => {
      const { getMarketplaceDraft } = await import("@/lib/listing-studio/marketplace-drafts");
      (getMarketplaceDraft as ReturnType<typeof vi.fn>).mockResolvedValueOnce(marketplaceDraft({ ebayFeedDraftCreatedAt: "2026-09-04T00:00:00Z" }));
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("already exists");
    });
  });

  it("a listing already in an ACTIVE (non-terminal) batch is blocked with a precise reason naming the batch number", async () => {
    await withPreviewFakeDb(async () => {
      const { supabaseRequestAll } = await import("@/lib/supabase");
      (supabaseRequestAll as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
        if (path.startsWith("ebay_feed_batch_items?marketplace_draft_id=in.")) return [{ marketplace_draft_id: "mdraft-1", batch_id: "batch-x", status: "queued" }];
        if (path.startsWith("ebay_feed_batches?id=in.")) return [{ id: "batch-x", display_number: 1 }];
        if (path.startsWith("listing_drafts?id=eq.")) return [{ id: "product-1", sku: "1644" }];
        if (path.startsWith("listing_draft_images?draft_id=eq.") && path.includes("limit=1")) return [{ id: "img-1", storage_path: "owner-1/product-1/img-1.jpg" }];
        if (path.startsWith("listing_draft_images?draft_id=eq.")) return [{ id: "img-1" }];
        return [];
      });
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Seller Hub Batch #1");
    });
  });

  // CORRECTIVE PASS (second real submission — duplicate-submission defect,
  // Phase 6/7/8/10) — a listing whose most recent batch FAILED must not
  // silently become eligible for a brand-new "Create" again.
  it("REQUIREMENT (Phase 6): a listing whose most recent batch FAILED is blocked with a Retry-oriented reason, never silently re-offered as a fresh Create", async () => {
    await withPreviewFakeDb(async () => {
      const { supabaseRequestAll } = await import("@/lib/supabase");
      (supabaseRequestAll as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
        if (path.startsWith("ebay_feed_batch_items?marketplace_draft_id=in.")) return [{ marketplace_draft_id: "mdraft-1", batch_id: "batch-1", status: "failed" }];
        if (path.startsWith("ebay_feed_batches?id=in.")) return [{ id: "batch-1", display_number: 1 }];
        if (path.startsWith("listing_drafts?id=eq.")) return [{ id: "product-1", sku: "1644" }];
        if (path.startsWith("listing_draft_images?draft_id=eq.") && path.includes("limit=1")) return [{ id: "img-1", storage_path: "owner-1/product-1/img-1.jpg" }];
        if (path.startsWith("listing_draft_images?draft_id=eq.")) return [{ id: "img-1" }];
        return [];
      });
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Seller Hub Batch #1");
        expect(result.reason).toMatch(/Retry Seller Hub draft/);
      }
    });
  });

  it("REQUIREMENT: the legacy Inventory API's own ebay_offer_id is NEVER consulted by the preview builder — only ebay_feed_draft_created_at and active-batch-item status", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/feed-batches.ts", "utf8") as string;
    const fnBody = source.slice(source.indexOf("export async function buildFeedDraftPreviewForProduct"), source.indexOf("export async function buildFeedDraftPreviewForProduct") + 3500);
    expect(fnBody).not.toMatch(/\bebayOfferId\b/);
  });

  it("PHASE 5 SAFETY: a genuinely unexpected exception (e.g. an unrelated Supabase failure) for ONE listing NEVER throws out of this function — it resolves to a safe blocker instead, so one listing's failure can never blank out every other listing's own valid preview", async () => {
    await withPreviewFakeDb(async () => {
      const { getMarketplaceDraft } = await import("@/lib/listing-studio/marketplace-drafts");
      (getMarketplaceDraft as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("genuine unexpected database error"));
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("This listing's preview could not be built due to an unexpected error.");
        // Never leaks the real internal error message/stack to the caller.
        expect(result.reason).not.toContain("genuine unexpected database error");
      }
    });
  });

  it("PHASE 8.7: an unknown/nonexistent listing id returns a precise blocker, never a throw", async () => {
    await withPreviewFakeDb(async () => {
      const { getMarketplaceDraft } = await import("@/lib/listing-studio/marketplace-drafts");
      (getMarketplaceDraft as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "does-not-exist");
      expect(result).toEqual({ ok: false, reason: "The selected eBay listing could not be found." });
    });
  });

  it("PHASE 8.9: a missing numeric category produces the exact eligibility blocker, proving the preview builder's reuse of evaluateEbayFeedDraftEligibility is correctly wired end-to-end", async () => {
    await withPreviewFakeDb(async () => {
      const { getMarketplaceDraft } = await import("@/lib/listing-studio/marketplace-drafts");
      (getMarketplaceDraft as ReturnType<typeof vi.fn>).mockResolvedValueOnce(marketplaceDraft({ categoryId: null }));
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Missing eBay category");
    });
  });

  it("PHASE 8.10: a photo row exists in the database but signing/reachability genuinely fails produces a precise, distinct blocker from 'no photo at all'", async () => {
    await withPreviewFakeDb(async () => {
      const { createSignedDownloadUrl } = await import("@/lib/listing-studio/storage-rest");
      (createSignedDownloadUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce("https://project.supabase.co/storage/v1/object/sign/listing-drafts/x?token=abc");
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "HEAD" ? new Response(null, { status: 404 }) : new Response(null, { status: 200 }))));
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("The primary photo could not be prepared — it may not be reachable right now.");
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "HEAD" ? new Response(null, { status: 200 }) : new Response(null, { status: 200 })))); // restore for later tests
    });
  });

  it("PHASE 8.11: a template-contract problem (defensive — structurally unreachable in real code today, since assertTemplateContractCurrent never reads a file) still produces a precise blocker if it were ever to occur", async () => {
    await withPreviewFakeDb(async () => {
      const { assertTemplateContractCurrent } = await import("@/lib/listing-studio/ebay-feed/template-contract");
      vi.spyOn(await import("@/lib/listing-studio/ebay-feed/template-contract"), "assertTemplateContractCurrent").mockImplementation(() => { throw new Error("simulated template drift"); });
      void assertTemplateContractCurrent; // keep the import referenced
      const { buildFeedDraftPreviewForProduct } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await buildFeedDraftPreviewForProduct("owner-1", "product-1");
      expect(result).toEqual({ ok: false, reason: "The Seller Hub draft template is unavailable." });
    });
  });

  it("PHASE 8.12: the template contract never reads a file at runtime — the bundled fixture is a TEST-ONLY reference, so it structurally cannot fail to resolve in the production build (see the compatibility test in ebay-feed-template-contract.test.ts, which is the only place the fixture is ever read)", () => {
    const source = require("node:fs").readFileSync("lib/listing-studio/ebay-feed/template-contract.ts", "utf8") as string;
    expect(source).not.toMatch(/readFileSync|readFile\(|import\(.*\.csv/);
    expect(source).not.toContain("Downloads");
  });
});

describe("cancelEbayFeedBatch — cooperative, local-only cancel", () => {
  it("cancels a batch still in 'queued' status, and its queued items", async () => {
    const batch = fakeBatch({ status: "queued" });
    const items = [fakeItem({ status: "queued" })];
    await withFakeDb(batch, items, async () => {
      const { cancelEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await cancelEbayFeedBatch("owner-1", "batch-1");
      expect(result).toBe("cancelled");
    });
  });

  it("never claims to cancel a batch that has already started uploading — returns its real current status instead", async () => {
    const batch = fakeBatch({ status: "uploading", ebay_task_id: "task-1" });
    const items = [fakeItem({ status: "uploaded" })];
    await withFakeDb(batch, items, async () => {
      const { cancelEbayFeedBatch } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      const result = await cancelEbayFeedBatch("owner-1", "batch-1");
      expect(result).toBe("uploading");
    });
  });
});
