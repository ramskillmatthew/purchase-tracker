import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getMarketplaceDraft, patchMarketplaceDraft,
  getEbayConnection, listEbayPolicies, getValidEbayAccessToken,
  createOrReplaceInventoryItem, createOffer, getOffersForSku, getOffer, getInventoryItem, createSignedDownloadUrl, createEbayPhotoProxyUrl,
} = vi.hoisted(() => ({
  getMarketplaceDraft: vi.fn(async (_ownerId: string, _productDraftId: string, _marketplace: "EBAY_UK") => null as unknown),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
  getEbayConnection: vi.fn(async (_ownerId: string) => null as unknown),
  listEbayPolicies: vi.fn(async (_connectionId: string) => [] as unknown[]),
  getValidEbayAccessToken: vi.fn(async (_ownerId: string) => ({ accessToken: "token-1", connection: {} as unknown })),
  createOrReplaceInventoryItem: vi.fn(async (_accessToken: string, _sku: string, _payload: Record<string, unknown>) => {}),
  createOffer: vi.fn(async (_accessToken: string, _payload: Record<string, unknown>) => ({ offerId: "offer-1" })),
  getOffersForSku: vi.fn(async (_accessToken: string, _sku: string) => [] as Array<{ offerId: string }>),
  getOffer: vi.fn(async (_accessToken: string, _offerId: string) => ({ offerId: "offer-1", status: "UNPUBLISHED", sku: "SKU-1" }) as unknown),
  getInventoryItem: vi.fn(async (_accessToken: string, _sku: string) => null as unknown),
  createSignedDownloadUrl: vi.fn(async (_bucket: string, _path: string, _expiresInSeconds: number) => "https://project.supabase.co/storage/v1/object/sign/listing-drafts/x?token=abc"),
  createEbayPhotoProxyUrl: vi.fn((_imageId: string, _expiresAt: number) => "https://project.supabase.co/api/ebay/photo/img-1?exp=1&sig=abc"),
}));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft, patchMarketplaceDraft, listMarketplaceDraftsForProducts: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection, listEbayPolicies, getValidEbayAccessToken }));
vi.mock("@/lib/ebay-account/inventory-client", () => ({ createOrReplaceInventoryItem, createOffer, getOffersForSku, getOffer, getInventoryItem }));
vi.mock("@/lib/listing-studio/storage-rest", () => ({
  createSignedDownloadUrl,
  StorageBucketMissingError: class StorageBucketMissingError extends Error {},
}));
vi.mock("@/lib/listing-studio/ebay-photo-urls", () => ({ createEbayPhotoProxyUrl }));

// ---------------------------------------------------------------------
// A small, realistic IN-MEMORY simulation of the two tables this file's
// real RPCs/queries touch (ebay_draft_batches, ebay_draft_batch_items),
// driven through the SAME supabaseRequest/supabaseRequestAll surface the
// real lib/supabase.ts exposes — so the actual application code under
// test (claimEbayDraftBatchItems, runEbayDraftBatchProcessTick, and
// everything they call) runs unmodified against PERSISTED, mutating
// state across multiple separate calls, not one-shot canned responses.
// This is what makes the resume/concurrency/lease tests below genuine
// behavioural tests rather than source-text assertions.
//
// The claim step's own filter+mark logic mirrors
// rpc/listing_studio_claim_ebay_draft_batch_items's real WHERE clause
// (status not terminal AND (claimed_at is null OR lease_expires_at <
// now)) and is applied synchronously (no await in between reading and
// marking), which is what makes `Promise.all([tickA(), tickB()])`
// genuinely exercise "two concurrent claims can never overlap" the same
// way `for update skip locked` does in real Postgres — proven by the
// dedicated concurrency test below, not asserted by fiat.
type FakeItem = {
  id: string; batch_id: string; marketplace_draft_id: string; product_draft_id: string; queue_position: number;
  status: string; attempt_count: number; error_code: string | null; error_message: string | null; ebay_offer_id: string | null;
  started_at: string | null; completed_at: string | null; claimed_at: string | null; lease_expires_at: string | null; claimed_by: string | null;
};
type FakeBatch = { id: string; owner_id: string; status: string; listing_count: number; display_number: number; box_dismissed_at: string | null; activity_dismissed_at: string | null; created_at: string; completed_at: string | null };

function makeFakeDb(batch: FakeBatch, items: FakeItem[]) {
  const now = () => Date.now();

  function claim(ownerId: string, batchId: string | null, limit: number, claimedBy: string) {
    if (batch.owner_id !== ownerId) return [];
    const nowIso = new Date(now()).toISOString();
    const eligible = items
      .filter(i => (batchId === null || i.batch_id === batchId))
      .filter(i => !["completed", "failed", "cancelled"].includes(i.status))
      .filter(i => i.claimed_at === null || (i.lease_expires_at !== null && new Date(i.lease_expires_at).getTime() < now()))
      .sort((a, b) => a.queue_position - b.queue_position)
      .slice(0, limit);
    for (const item of eligible) {
      item.claimed_at = nowIso;
      item.lease_expires_at = new Date(now() + 120_000).toISOString();
      item.claimed_by = claimedBy;
      if (!item.started_at) item.started_at = nowIso;
    }
    return eligible.map(i => ({ item_id: i.id, batch_id: i.batch_id, marketplace_draft_id: i.marketplace_draft_id, product_draft_id: i.product_draft_id, status: i.status, attempt_count: i.attempt_count, queue_position: i.queue_position }));
  }

  const supabaseRequest = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "rpc/listing_studio_claim_ebay_draft_batch_items") {
      const body = JSON.parse((init!.body as string));
      const claimed = claim(body.p_owner_id, body.p_batch_id, body.p_limit, body.p_claimed_by);
      return new Response(JSON.stringify(claimed), { status: 200 });
    }
    // Corrective pass (retry) — patchItemIfStatus's own conditional PATCH
    // (id=eq.X&status=eq.Y). Genuinely conditional: only actually patches
    // (and returns the row) when the CURRENT status matches — this is
    // what makes the concurrency-guard tests below real, not asserted.
    const conditionalPatchMatch = path.match(/^ebay_draft_batch_items\?id=eq\.([^&]+)&status=eq\.([^&]+)$/);
    if (conditionalPatchMatch) {
      const [, id, expectedStatus] = conditionalPatchMatch;
      const item = items.find(i => i.id === id);
      if (item && item.status === expectedStatus) {
        Object.assign(item, JSON.parse(init!.body as string));
        return new Response(JSON.stringify([{ id: item.id }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 }); // status didn't match — 0 rows affected, exactly like a real filtered PATCH
    }
    const itemPatchMatch = path.match(/^ebay_draft_batch_items\?id=eq\.([^&]+)$/);
    if (itemPatchMatch) {
      const item = items.find(i => i.id === itemPatchMatch[1]);
      if (item) Object.assign(item, JSON.parse(init!.body as string));
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("ebay_draft_batches?") && path.includes("status=eq.pending")) {
      if (batch.status === "pending") batch.status = "in_progress";
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("ebay_draft_batches?") && path.includes("status=neq.cancelled")) {
      if (batch.status !== "cancelled" && batch.status !== "completed") { batch.status = "completed"; batch.completed_at = new Date().toISOString(); }
      return new Response(JSON.stringify([{ status: batch.status }]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  const supabaseRequestAll = vi.fn(async (path: string) => {
    if (path.startsWith("ebay_draft_batch_items?batch_id=eq.")) return items.map(i => ({ status: i.status }));
    // Corrective pass (retry) — retryFailedEbayDraftItem's own owner-scoped
    // batch lookup and item-by-id-within-batch lookup.
    const batchOwnerMatch = path.match(/^ebay_draft_batches\?id=eq\.([^&]+)&owner_id=eq\.([^&]+)&select=/);
    if (batchOwnerMatch) {
      const [, id, ownerId] = batchOwnerMatch;
      return batch.id === id && batch.owner_id === ownerId ? [{ id: batch.id }] : [];
    }
    const itemByIdMatch = path.match(/^ebay_draft_batch_items\?id=eq\.([^&]+)&batch_id=eq\.([^&]+)&select=/);
    if (itemByIdMatch) {
      const [, id, batchId] = itemByIdMatch;
      const item = items.find(i => i.id === id && i.batch_id === batchId);
      return item ? [item] : [];
    }
    if (path.startsWith("listing_drafts?id=eq.")) return [{ id: items[0]?.product_draft_id ?? "product-1", sku: "SKU-1" }];
    if (path.startsWith("listing_draft_images?draft_id=eq.")) return [{ draft_id: items[0]?.product_draft_id ?? "product-1", id: "img-1", storage_path: "owner-1/product-1/img-1-x.jpg", sort_order: 0 }];
    return [];
  });

  return { supabaseRequest, supabaseRequestAll, items, batch };
}

function fakeItem(overrides: Partial<FakeItem> = {}): FakeItem {
  return {
    id: "item-1", batch_id: "batch-1", marketplace_draft_id: "mdraft-1", product_draft_id: "product-1", queue_position: 0,
    status: "queued", attempt_count: 0, error_code: null, error_message: null, ebay_offer_id: null,
    started_at: null, completed_at: null, claimed_at: null, lease_expires_at: null, claimed_by: null,
    ...overrides,
  };
}
function fakeBatch(overrides: Partial<FakeBatch> = {}): FakeBatch {
  return { id: "batch-1", owner_id: "owner-1", status: "pending", listing_count: 1, display_number: 1, box_dismissed_at: null, activity_dismissed_at: null, created_at: new Date().toISOString(), completed_at: null, ...overrides };
}
function marketplaceDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdraft-1", productDraftId: "product-1", ownerId: "owner-1", marketplace: "EBAY_UK" as const,
    sourceType: "generated" as const, contentMode: "seo_optimised" as const,
    title: "On Running Cloud 5", description: "desc", categoryId: "183454", categoryName: "Trainers", categoryPath: "Shoes > Trainers",
    categorySource: "ai" as const, categoryConfidence: "high" as const, categoryAlternatives: [], categorySearchTerms: null,
    conditionValue: "Used – Very Good", pricePence: 2500, quantity: 1, currency: "GBP",
    status: "ready" as const, readiness: { ready: true, completionPercent: 100, requiredComplete: 8, requiredTotal: 8, recommendedComplete: 0, recommendedTotal: 0 },
    validationMessages: [], aiGeneration: null, sourceDraftId: null, sourceEbayItemId: null, dynamicData: {}, settings: {},
    ebayFulfillmentPolicyId: "FUL-1", ebayReturnPolicyId: "RET-1", ebayPaymentPolicyId: "PAY-1", ebayMerchantLocationKey: "LOC-1",
    ebayOfferId: null, ebayInventorySyncedAt: null, ebayLastDraftError: null, ebayPhotoState: {},
    ebayFeedDraftCreatedAt: null, ebayFeedLastError: null,
    createdAt: "x", updatedAt: "x",
    ...overrides,
  };
}
function connection(overrides: Record<string, unknown> = {}) { return { id: "conn-1", connectionStatus: "connected" as const, ...overrides }; }
function policy(type: "FULFILLMENT" | "RETURN" | "PAYMENT", id: string, available = true) {
  return { id: `p-${id}`, policyType: type, ebayPolicyId: id, name: id, marketplaceId: "EBAY_GB", available, firstSeenAt: "x", lastSeenAt: "x", lastSyncedAt: "x" };
}

beforeEach(() => {
  vi.resetModules();
  getMarketplaceDraft.mockReset(); patchMarketplaceDraft.mockReset();
  getEbayConnection.mockReset(); listEbayPolicies.mockReset(); getValidEbayAccessToken.mockReset();
  createOrReplaceInventoryItem.mockReset(); createOffer.mockReset(); getOffersForSku.mockReset(); getOffer.mockReset(); getInventoryItem.mockReset(); createSignedDownloadUrl.mockReset(); createEbayPhotoProxyUrl.mockReset();

  // Stateful — a "creating_draft" step's own patchMarketplaceDraft(ebay_offer_id: ...)
  // call must be visible to the VERY NEXT tick's getMarketplaceDraft read
  // (the "verifying_draft" step re-fetches the draft fresh), exactly like
  // the real database. A static mockResolvedValue would silently hide a
  // real bug in that hand-off, which is precisely what the first version
  // of this test file did.
  let currentDraft = marketplaceDraft();
  getMarketplaceDraft.mockImplementation(async () => currentDraft);
  patchMarketplaceDraft.mockImplementation(async (_ownerId: string, _id: string, patch: Record<string, unknown>) => {
    const mapped: Record<string, unknown> = {};
    if ("ebay_offer_id" in patch) mapped.ebayOfferId = patch.ebay_offer_id;
    if ("ebay_last_draft_error" in patch) mapped.ebayLastDraftError = patch.ebay_last_draft_error;
    if ("ebay_inventory_synced_at" in patch) mapped.ebayInventorySyncedAt = patch.ebay_inventory_synced_at;
    if ("ebay_photo_state_json" in patch) mapped.ebayPhotoState = patch.ebay_photo_state_json;
    currentDraft = { ...currentDraft, ...mapped };
  });
  getEbayConnection.mockResolvedValue(connection());
  listEbayPolicies.mockResolvedValue([policy("FULFILLMENT", "FUL-1"), policy("RETURN", "RET-1"), policy("PAYMENT", "PAY-1")]);
  getValidEbayAccessToken.mockResolvedValue({ accessToken: "token-1", connection: connection() });
  createOrReplaceInventoryItem.mockResolvedValue(undefined);
  createOffer.mockResolvedValue({ offerId: "offer-1" });
  getOffersForSku.mockResolvedValue([]);
  getOffer.mockResolvedValue({ offerId: "offer-1", status: "UNPUBLISHED", sku: "SKU-1" });
  getInventoryItem.mockResolvedValue(null);
  createSignedDownloadUrl.mockResolvedValue("https://project.supabase.co/storage/v1/object/sign/listing-drafts/x?token=abc");
  createEbayPhotoProxyUrl.mockReturnValue("https://project.supabase.co/api/ebay/photo/img-1?exp=1&sig=abc");
  global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
});

async function loadModule(db: ReturnType<typeof makeFakeDb>) {
  // Always a FRESH module instance, bound to THIS call's own db mock —
  // never reused from an earlier loadModule call within the same test
  // (which would silently bind to a stale/different db).
  vi.resetModules();
  vi.doMock("@/lib/supabase", () => ({ supabaseRequest: db.supabaseRequest, supabaseRequestAll: db.supabaseRequestAll }));
  return import("@/lib/listing-studio/ebay-draft-batches");
}

describe("runEbayDraftBatchProcessTick — bounded, persistent, resumable processing", () => {
  it("REQUIREMENT: never processes a whole batch in one call — a single-item batch takes multiple ticks to reach completed", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem()]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);

    const t1 = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.items[0].status).toBe("uploading_photos");
    expect(t1.hasMoreWork).toBe(true);
    expect(createOrReplaceInventoryItem).not.toHaveBeenCalled(); // no eBay call made yet at this early step

    const t2 = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.items[0].status).toBe("creating_inventory_item");
    expect(t2.hasMoreWork).toBe(true);

    const t3 = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(createOrReplaceInventoryItem).toHaveBeenCalledTimes(1);
    expect(db.items[0].status).toBe("creating_draft");

    const t4 = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(createOffer).toHaveBeenCalledTimes(1);
    expect(db.items[0].status).toBe("verifying_draft");
    expect(db.items[0].ebay_offer_id).toBe("offer-1");

    const t5 = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.items[0].status).toBe("completed");
    expect(t5.hasMoreWork).toBe(false);
    expect(t5.batchStatus).toBe("completed");
    expect(db.batch.status).toBe("completed");
  });

  it("REQUIREMENT: batch status moves pending -> in_progress on the very first claim", async () => {
    const db = makeFakeDb(fakeBatch({ status: "pending" }), [fakeItem()]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    expect(db.batch.status).toBe("pending");
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.batch.status).toBe("in_progress");
  });

  it("REQUIREMENT: an ineligible item (missing price) is marked failed on its very first tick, before any eBay call", async () => {
    getMarketplaceDraft.mockResolvedValue(marketplaceDraft({ pricePence: null }));
    const db = makeFakeDb(fakeBatch(), [fakeItem()]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.items[0].status).toBe("failed");
    expect(db.items[0].error_message).toMatch(/Missing eBay selling price/);
    expect(createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });

  it("SAFETY CORRECTION — an ambiguous condition ('Used', with no explicit grade) is rejected server-side on the very first tick, before any eBay write — never optimistically upgraded and sent as USED_EXCELLENT", async () => {
    getMarketplaceDraft.mockResolvedValue(marketplaceDraft({ conditionValue: "Used" }));
    const db = makeFakeDb(fakeBatch(), [fakeItem()]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.items[0].status).toBe("failed");
    expect(db.items[0].error_message).toMatch(/Choose a specific eBay condition\./);
    expect(createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(createOffer).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: one item's failure never blocks another item's own progress in the same tick", async () => {
    getMarketplaceDraft.mockImplementation(async (_owner: string, productId: string) =>
      productId === "product-bad" ? marketplaceDraft({ id: "mdraft-bad", productDraftId: "product-bad", pricePence: null }) : marketplaceDraft(),
    );
    const db = makeFakeDb(fakeBatch({ listing_count: 2 }), [
      fakeItem({ id: "item-good", marketplace_draft_id: "mdraft-1", product_draft_id: "product-1", queue_position: 0 }),
      fakeItem({ id: "item-bad", marketplace_draft_id: "mdraft-bad", product_draft_id: "product-bad", queue_position: 1 }),
    ]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.items.find(i => i.id === "item-bad")!.status).toBe("failed");
    expect(db.items.find(i => i.id === "item-good")!.status).toBe("uploading_photos");
  });

  it("REQUIREMENT: an unreachable photo fails the item at the uploading_photos step, never reaching an eBay call", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "uploading_photos", claimed_at: null })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(db.items[0].status).toBe("failed");
    expect(db.items[0].error_code).toBe("no_reachable_photos");
    expect(createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });

  it("REQUIREMENT (batch terminal state): a batch with one completed and one failed item still reaches 'completed' (partial-failure terminal state, never stuck)", async () => {
    const db = makeFakeDb(fakeBatch({ listing_count: 2 }), [
      fakeItem({ id: "item-done", status: "completed", completed_at: "x" }),
      fakeItem({ id: "item-failed", status: "failed", completed_at: "x" }),
    ]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    const result = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(result.batchStatus).toBe("completed");
    expect(result.hasMoreWork).toBe(false);
  });
});

describe("Claiming — concurrency, lease expiry, and resume (real behavioural tests, not source scans)", () => {
  it("REQUIREMENT: two concurrent ticks (Promise.all) never both process the SAME item — the claim is atomic", async () => {
    const db = makeFakeDb(fakeBatch({ listing_count: 2 }), [
      fakeItem({ id: "item-1", marketplace_draft_id: "mdraft-1", product_draft_id: "product-1", queue_position: 0 }),
      fakeItem({ id: "item-2", marketplace_draft_id: "mdraft-2", product_draft_id: "product-2", queue_position: 1 }),
    ]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);

    const [resultA, resultB] = await Promise.all([
      runEbayDraftBatchProcessTick("owner-1", "batch-1"),
      runEbayDraftBatchProcessTick("owner-1", "batch-1"),
    ]);
    // Together, exactly 2 items were claimed across the two concurrent
    // calls — never the same item claimed (and therefore advanced) twice.
    expect(resultA.claimedCount + resultB.claimedCount).toBe(2);
    expect(db.items.every(i => i.status === "uploading_photos")).toBe(true);
  });

  it("REQUIREMENT: an item already claimed (lease not yet expired) is never claimed again by a second call", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ claimed_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 60_000).toISOString(), claimed_by: "other-invocation" })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    const result = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(result.claimedCount).toBe(0);
    expect(db.items[0].status).toBe("queued"); // untouched — still held by the other invocation's lease
  });

  it("REQUIREMENT (lease expiry / reclaim): an item whose lease has already expired becomes claimable again automatically", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ claimed_at: new Date(Date.now() - 300_000).toISOString(), lease_expires_at: new Date(Date.now() - 180_000).toISOString(), claimed_by: "crashed-invocation" })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    const result = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(result.claimedCount).toBe(1);
    expect(db.items[0].status).toBe("uploading_photos");
    expect(db.items[0].claimed_by).not.toBe("crashed-invocation");
  });

  it("REQUIREMENT (resume after reload): a fresh tick call (simulating a brand-new page load with no in-memory state) continues an item exactly from its last persisted status", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "creating_draft" })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(createOffer).toHaveBeenCalledTimes(1);
    expect(createOrReplaceInventoryItem).not.toHaveBeenCalled(); // never re-runs an earlier, already-completed step
    expect(db.items[0].status).toBe("verifying_draft");
  });

  it("REQUIREMENT (duplicate processing request / idempotent retry): re-entering creating_draft after a crash checks for an existing offer BEFORE creating a new one", async () => {
    getOffersForSku.mockResolvedValue([{ offerId: "already-exists-1" }]);
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "creating_draft" })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(createOffer).not.toHaveBeenCalled();
    expect(db.items[0].ebay_offer_id).toBe("already-exists-1");
    expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-1", expect.objectContaining({ ebay_offer_id: "already-exists-1" }));
  });

  it("REQUIREMENT (partial remote success then retry): inventory item succeeds on tick 1, offer creation throws on tick 2 — never repeats creating_inventory_item on the failing tick", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "creating_inventory_item" })]);
    createOffer.mockRejectedValueOnce(new Error("Network timeout"));
    const { runEbayDraftBatchProcessTick } = await loadModule(db);

    await runEbayDraftBatchProcessTick("owner-1", "batch-1"); // creating_inventory_item -> creating_draft (the inventory PUT succeeds)
    expect(createOrReplaceInventoryItem).toHaveBeenCalledTimes(1);
    expect(db.items[0].status).toBe("creating_draft");

    await runEbayDraftBatchProcessTick("owner-1", "batch-1"); // creating_draft's own createOffer call is the one that fails
    expect(createOrReplaceInventoryItem).toHaveBeenCalledTimes(1); // never repeated
    expect(db.items[0].status).toBe("failed");
    // Corrective pass — error codes are now stage-specific (ebay_inventory_item_error/ebay_offer_error/ebay_verification_error) so the UI can say WHICH operation failed, not just "ebay_api_error" for all three.
    expect(db.items[0].error_code).toBe("ebay_offer_error");
  });

  it("REQUIREMENT (completed offer never recreated): an item already 'completed' can never be reclaimed by any later tick", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "completed", completed_at: "x" })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    const result = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(result.claimedCount).toBe(0);
    expect(createOffer).not.toHaveBeenCalled();
    expect(createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });

  it("REQUIREMENT (bounded invocation): claims at most PROCESS_TICK_ITEM_LIMIT items even when many more are queued", async () => {
    // Deliberately a placeholder batch/db to load the module once — the
    // REAL PROCESS_TICK_ITEM_LIMIT and runEbayDraftBatchProcessTick used
    // below both come from this SAME loadModule call (never a second,
    // separate import — an earlier version of this test imported the
    // constant before mocking @/lib/supabase for this test's own db,
    // which resolved to a DIFFERENT cached module instance and silently
    // tested against the wrong mock).
    const placeholderDb = makeFakeDb(fakeBatch(), []);
    const { PROCESS_TICK_ITEM_LIMIT } = await loadModule(placeholderDb);

    const manyItems = Array.from({ length: PROCESS_TICK_ITEM_LIMIT + 5 }, (_, i) => fakeItem({ id: `item-${i}`, marketplace_draft_id: `mdraft-${i}`, product_draft_id: `product-${i}`, queue_position: i }));
    const db = makeFakeDb(fakeBatch({ listing_count: manyItems.length }), manyItems);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    const result = await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    expect(result.claimedCount).toBe(PROCESS_TICK_ITEM_LIMIT);
    expect(db.items.filter(i => i.status === "uploading_photos").length).toBe(PROCESS_TICK_ITEM_LIMIT);
    expect(db.items.filter(i => i.status === "queued").length).toBe(5);
  });
});

describe("Photo URL durability and safety (corrective pass)", () => {
  it("REQUIREMENT: the signed photo URL is never persisted anywhere — only a status/timestamp/error is written to ebay_photo_state_json", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "uploading_photos" })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    const photoStatePatch = patchMarketplaceDraft.mock.calls.find(c => "ebay_photo_state_json" in (c[2] as Record<string, unknown>));
    expect(photoStatePatch).toBeTruthy();
    const photoState = (photoStatePatch![2] as Record<string, unknown>).ebay_photo_state_json as Record<string, unknown>;
    for (const entry of Object.values(photoState)) {
      expect(JSON.stringify(entry)).not.toContain("supabase.co");
      expect(JSON.stringify(entry)).not.toContain("token=");
      expect(entry).not.toHaveProperty("url");
    }
  });

  it("REQUIREMENT: photo order is preserved (first uploaded image becomes imageUrls[0])", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "creating_inventory_item" })]);
    db.supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_draft_images?draft_id=eq.")) {
        // Deliberately returned in sort_order order — mirrors what the
        // real query's own `&order=sort_order.asc` clause guarantees the
        // database will return, which is what preparePhotos trusts
        // (it never re-sorts client-side).
        return [
          { draft_id: "product-1", id: "img-1", storage_path: "owner-1/product-1/img-1.jpg", sort_order: 0 },
          { draft_id: "product-1", id: "img-2", storage_path: "owner-1/product-1/img-2.jpg", sort_order: 1 },
        ];
      }
      if (path.startsWith("listing_drafts?id=eq.")) return [{ id: "product-1", sku: "SKU-1" }];
      if (path.startsWith("ebay_draft_batch_items?batch_id=eq.")) return db.items.map(i => ({ status: i.status }));
      return [];
    });
    createSignedDownloadUrl.mockImplementation(async (_bucket: string, path: string) => `https://project.supabase.co/storage/v1/object/sign/listing-drafts/${path}?token=abc`);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    const [, , payload] = createOrReplaceInventoryItem.mock.calls[0];
    expect((payload as { product: { imageUrls: string[] } }).product.imageUrls[0]).toContain("/img-1?");
    expect(createEbayPhotoProxyUrl.mock.calls[0]?.[0]).toBe("img-1");
  });

  it("never sends a local filesystem path or blob: URL to eBay — every imageUrls entry is a real https:// Supabase Storage URL", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "creating_inventory_item" })]);
    const { runEbayDraftBatchProcessTick } = await loadModule(db);
    await runEbayDraftBatchProcessTick("owner-1", "batch-1");
    const [, , payload] = createOrReplaceInventoryItem.mock.calls[0];
    for (const url of (payload as { product: { imageUrls: string[] } }).product.imageUrls) {
      expect(url).toMatch(/^https:\/\//);
      expect(url).not.toMatch(/^blob:|^file:|localhost/);
    }
  });
});

describe("buildAspectsPayload", () => {
  it("excludes reserved __-prefixed pseudo-aspect keys and null-valued entries", async () => {
    const { buildAspectsPayload } = await import("@/lib/listing-studio/ebay-draft-batches");
    const aspects = buildAspectsPayload({
      colour: { value: "Blue", confidence: "high", source: "ai", appliedAutomatically: true, needsReview: false, userConfirmed: false, updatedAt: "x" },
      material: { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "x" },
      __productFacts: { value: null, confidence: "unknown", source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "x" },
    });
    expect(aspects).toEqual({ colour: ["Blue"] });
  });
});

describe("buildInventoryItemPayload — CORRECTIVE PASS (failed first draft): the exact outgoing payload for the real SKU 1644 case", () => {
  it("REQUIREMENT (Phase 5 developer/test-only payload preview): the real 'On Running Cloud 5' draft's condition value produces condition: \"USED_VERY_GOOD\" — never the raw label, never a fallback — never sent to eBay, only asserted here", async () => {
    const { buildInventoryItemPayload } = await import("@/lib/listing-studio/ebay-draft-batches");
    const payload = buildInventoryItemPayload(
      { conditionValue: "Used – Very Good", title: "On Running Cloud 5 Womens UK 4 Light blue Grey Mesh Running Trainers Lightweight", description: "Genuine On Running Cloud 5...", dynamicData: {}, quantity: 1 },
      ["https://signed.example/photo1.jpg"],
    );
    expect(payload).not.toBeNull();
    expect(payload?.condition).toBe("USED_VERY_GOOD");
    // No photo URL, title, or description is logged/asserted beyond this
    // in-memory object — this test never calls fetch, never contacts eBay.
  });

  it("returns null (a real blocker, never a guessed payload) when the condition doesn't translate", async () => {
    const { buildInventoryItemPayload } = await import("@/lib/listing-studio/ebay-draft-batches");
    const payload = buildInventoryItemPayload(
      { conditionValue: null, title: "x", description: "x", dynamicData: {}, quantity: 1 },
      ["https://signed.example/photo1.jpg"],
    );
    expect(payload).toBeNull();
  });

  it("defaults quantity to 1 only when genuinely absent, never overrides a real quantity", async () => {
    const { buildInventoryItemPayload } = await import("@/lib/listing-studio/ebay-draft-batches");
    const withQuantity = buildInventoryItemPayload({ conditionValue: "New", title: "x", description: "x", dynamicData: {}, quantity: 3 }, []);
    const withoutQuantity = buildInventoryItemPayload({ conditionValue: "New", title: "x", description: "x", dynamicData: {}, quantity: null }, []);
    expect(withQuantity?.availability.shipToLocationAvailability.quantity).toBe(3);
    expect(withoutQuantity?.availability.shipToLocationAvailability.quantity).toBe(1);
  });
});

describe("retryFailedEbayDraftItem — CORRECTIVE PASS (failed first draft): genuine reconciliation-first retry, real behavioural tests", () => {
  it("REQUIREMENT: not found for a wrong batch, wrong item, or wrong owner", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "failed" })]);
    const { retryFailedEbayDraftItem } = await loadModule(db);
    expect((await retryFailedEbayDraftItem("owner-1", "batch-1", "no-such-item")).outcome).toBe("not_found");
    expect((await retryFailedEbayDraftItem("owner-1", "no-such-batch", "item-1")).outcome).toBe("not_found");
    expect((await retryFailedEbayDraftItem("someone-else", "batch-1", "item-1")).outcome).toBe("not_found");
  });

  it("REQUIREMENT: not_retryable for an item that isn't actually failed", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "queued" })]);
    const { retryFailedEbayDraftItem } = await loadModule(db);
    const result = await retryFailedEbayDraftItem("owner-1", "batch-1", "item-1");
    expect(result).toEqual({ outcome: "not_retryable", itemStatus: "queued" });
  });

  it("REQUIREMENT 4: recalculates eligibility fresh — an item whose condition no longer maps is blocked, never silently requeued", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "failed" })]);
    getMarketplaceDraft.mockResolvedValue(marketplaceDraft({ conditionValue: "some made up condition" }));
    const { retryFailedEbayDraftItem } = await loadModule(db);
    const result = await retryFailedEbayDraftItem("owner-1", "batch-1", "item-1");
    expect(result.outcome).toBe("ineligible");
    if (result.outcome === "ineligible") expect(result.reasons).toContain("Missing or unsupported eBay condition.");
    expect(db.items[0].status).toBe("failed"); // untouched — no state change on an ineligible retry
    expect(getOffersForSku).not.toHaveBeenCalled(); // never even reaches reconciliation
  });

  it("REQUIREMENT 5-7: an existing remote offer is reconciled and reused — createOffer is never called, and the item jumps straight to verifying_draft", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "failed", error_code: "ebay_inventory_item_error", error_message: "Invalid request", attempt_count: 1 })]);
    getOffersForSku.mockResolvedValue([{ offerId: "existing-offer-99" }]);
    getInventoryItem.mockResolvedValue({ sku: "SKU-1", condition: "USED_VERY_GOOD", hasOffers: true });
    const { retryFailedEbayDraftItem } = await loadModule(db);

    const result = await retryFailedEbayDraftItem("owner-1", "batch-1", "item-1");
    expect(result.outcome).toBe("reconciled_existing_offer");
    if (result.outcome === "reconciled_existing_offer" || result.outcome === "requeued") {
      expect(result.offerExists).toBe(true);
      expect(result.inventoryItemExists).toBe(true);
    }
    expect(createOffer).not.toHaveBeenCalled();
    expect(createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-1", expect.objectContaining({ ebay_offer_id: "existing-offer-99" }));
    // error state cleared, but the ORIGINAL attempt_count is preserved (never reset to 0)
    expect(db.items[0].error_code).toBeNull();
    expect(db.items[0].attempt_count).toBe(1);
  });

  it("REQUIREMENT 8-9: nothing exists remotely — requeues through the corrected pipeline from the top (one tick advances it past 'queued')", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "failed", attempt_count: 1 })]);
    getOffersForSku.mockResolvedValue([]);
    getInventoryItem.mockResolvedValue(null);
    const { retryFailedEbayDraftItem } = await loadModule(db);

    const result = await retryFailedEbayDraftItem("owner-1", "batch-1", "item-1");
    expect(result.outcome).toBe("requeued");
    if (result.outcome === "requeued") { expect(result.offerExists).toBe(false); expect(result.inventoryItemExists).toBe(false); }
    expect(db.items[0].status).not.toBe("failed"); // the one bounded tick already advanced it past "queued"
    expect(db.items[0].attempt_count).toBe(1); // preserved, not reset
    expect(createOffer).not.toHaveBeenCalled(); // this tick only reaches the eligibility/photo step, not offer creation
  });

  it("REQUIREMENT 8: an inventory-item-only remote state (no offer) still requeues through the normal pipeline — the next real PUT is idempotent and will correct it", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "failed" })]);
    getOffersForSku.mockResolvedValue([]);
    getInventoryItem.mockResolvedValue({ sku: "SKU-1", condition: "USED_EXCELLENT", hasOffers: false }); // wrong condition from the earlier failed/partial attempt
    const { retryFailedEbayDraftItem } = await loadModule(db);
    const result = await retryFailedEbayDraftItem("owner-1", "batch-1", "item-1");
    expect(result.outcome).toBe("requeued");
    if (result.outcome === "requeued") { expect(result.inventoryItemExists).toBe(true); expect(result.offerExists).toBe(false); }
  });

  it("REQUIREMENT 10-11/23: two concurrent retries for the SAME item — only one wins; the second reports already_in_progress, never a duplicate requeue", async () => {
    const db = makeFakeDb(fakeBatch(), [fakeItem({ status: "failed" })]);
    getOffersForSku.mockResolvedValue([]);
    getInventoryItem.mockResolvedValue(null);
    const { retryFailedEbayDraftItem } = await loadModule(db);

    const [first, second] = await Promise.all([
      retryFailedEbayDraftItem("owner-1", "batch-1", "item-1"),
      retryFailedEbayDraftItem("owner-1", "batch-1", "item-1"),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already_in_progress", "requeued"].sort());
  });

  it("REQUIREMENT 24: Batch 1-style audit history is preserved — the SAME item row/id is reused, never a new item created, and the batch is never deleted", async () => {
    const db = makeFakeDb(fakeBatch({ id: "batch-1" }), [fakeItem({ id: "item-1", status: "failed" })]);
    getOffersForSku.mockResolvedValue([]);
    getInventoryItem.mockResolvedValue(null);
    const { retryFailedEbayDraftItem } = await loadModule(db);
    await retryFailedEbayDraftItem("owner-1", "batch-1", "item-1");
    expect(db.items).toHaveLength(1);
    expect(db.items[0].id).toBe("item-1");
    expect(db.batch.id).toBe("batch-1");
  });
});
