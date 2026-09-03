import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getMarketplaceDraft, patchMarketplaceDraft,
  getEbayConnection, getValidEbayAccessToken,
  createFeedTask, uploadFeedFile, getFeedTask, getFeedResultFile,
  createSignedDownloadUrl,
} = vi.hoisted(() => ({
  getMarketplaceDraft: vi.fn(async (_ownerId: string, _productDraftId: string, _marketplace: "EBAY_UK") => null as unknown),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
  getEbayConnection: vi.fn(async (_ownerId: string) => null as unknown),
  getValidEbayAccessToken: vi.fn(async (_ownerId: string) => ({ accessToken: "token-1", connection: {} as unknown })),
  createFeedTask: vi.fn(async (_accessToken: string) => ({ taskId: "task-1" })),
  uploadFeedFile: vi.fn(async (_accessToken: string, _taskId: string, _csv: string) => {}),
  getFeedTask: vi.fn(async (_accessToken: string, _taskId: string) => ({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null })),
  getFeedResultFile: vi.fn(async (_accessToken: string, _taskId: string) => 'Custom label (SKU),Status\r\n1644,Success\r\n'),
  createSignedDownloadUrl: vi.fn(async (_bucket: string, _path: string, _expiresInSeconds: number) => "https://project.supabase.co/storage/v1/object/sign/listing-drafts/x?token=abc"),
}));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft, patchMarketplaceDraft, listMarketplaceDraftsForProducts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection, getValidEbayAccessToken }));
vi.mock("@/lib/ebay-account/feed-client", () => ({ createFeedTask, uploadFeedFile, getFeedTask, getFeedResultFile }));
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
  createFeedTask.mockReset(); uploadFeedFile.mockReset(); getFeedTask.mockReset(); getFeedResultFile.mockReset();
  createSignedDownloadUrl.mockReset();

  getMarketplaceDraft.mockResolvedValue(marketplaceDraft());
  getEbayConnection.mockResolvedValue({ id: "conn-1", connectionStatus: "connected" });
  getValidEbayAccessToken.mockResolvedValue({ accessToken: "token-1", connection: {} });
  createFeedTask.mockResolvedValue({ taskId: "task-1" });
  uploadFeedFile.mockResolvedValue(undefined);
  getFeedTask.mockResolvedValue({ taskId: "task-1", feedType: "FX_LISTING", status: "COMPLETED", creationDate: null, completionDate: null });
  getFeedResultFile.mockResolvedValue('Custom label (SKU),Status\r\n1644,Success\r\n');
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

  it("uploadFeedFile is called with the already-persisted task ID, never a freshly re-created one", async () => {
    const batch = fakeBatch({ status: "uploading", ebay_task_id: "task-1" });
    const items = [fakeItem()];
    await withFakeDb(batch, items, async () => {
      const { runEbayFeedBatchProcessTick } = await import("@/lib/listing-studio/ebay-feed/feed-batches");
      await runEbayFeedBatchProcessTick("owner-1", "batch-1");
      expect(uploadFeedFile).toHaveBeenCalledWith("token-1", "task-1", expect.any(String));
      expect(createFeedTask).not.toHaveBeenCalled();
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
