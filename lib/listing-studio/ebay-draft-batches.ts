import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { getMarketplaceDraft, patchMarketplaceDraft, listMarketplaceDraftsForProducts } from "@/lib/listing-studio/marketplace-drafts";
import { getEbayConnection, listEbayPolicies, getValidEbayAccessToken } from "@/lib/ebay-account/client";
import { createOrReplaceInventoryItem, createOffer, getOffersForSku, getOffer, getInventoryItem, type EbayInventoryItemPayload } from "@/lib/ebay-account/inventory-client";
import { evaluateEbayDraftEligibility } from "@/lib/listing-studio/ebay-draft-eligibility";
import { toEbayInventoryCondition, type EbayInventoryConditionEnum } from "@/lib/listing-studio/ebay-condition";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { createSignedDownloadUrl, StorageBucketMissingError } from "@/lib/listing-studio/storage-rest";
import type { MarketplaceDynamicData, MarketplaceDraft } from "@/lib/listing-studio/marketplace-types";
import type { EbayDraftItemStatus, EbayDraftBatchStatus } from "@/lib/listing-studio/ebay-workflow-status";

/**
 * Stage 6 — eBay draft batches: persistence (mirrors
 * lib/listing-studio/marketplace-drafts.ts's own row<->domain conventions)
 * plus the batch PROCESSING orchestration itself. Mirrors the shape of
 * supabase-listing-studio.sql's vinted_extension_batches/_items as closely
 * as the two systems' real differences allow (see
 * supabase-ebay-draft-batches.sql's own header comment) — the one
 * structural difference is that there is no external actor to wait on:
 * this module calls eBay's own Inventory API directly, so batch
 * PROCESSING (not just batch/item bookkeeping) lives here too.
 *
 * CORRECTIVE PASS — the previous version of this file processed an entire
 * batch to completion inside one fire-and-forget, unawaited promise
 * (`processEbayDraftBatch`) started by the create route and never
 * revisited — correct only on a long-lived local `next dev` process,
 * never on a real serverless/edge deployment where the process can be
 * frozen or recycled the instant the HTTP response is sent. That function
 * no longer exists. Processing is now PERSISTENT, RESUMABLE, and BOUNDED:
 * the database (via rpc/listing_studio_claim_ebay_draft_batch_items) is
 * the only source of truth for "what has been claimed and by when", and
 * every invocation of runEbayDraftBatchProcessTick does a small, fixed
 * amount of work (claim up to a few items, advance each by exactly ONE
 * pipeline step, persist, return) rather than looping an entire batch to
 * completion in one request. See that function's own doc comment for the
 * full state machine and this file's exported PROCESS_TICK_LIMIT for the
 * per-invocation bound.
 */

export type EbayDraftBatchRecord = {
  id: string; ownerId: string; status: EbayDraftBatchStatus; listingCount: number; displayNumber: number;
  boxDismissedAt: string | null; activityDismissedAt: string | null; createdAt: string; completedAt: string | null;
};
export type EbayDraftBatchItemRecord = {
  id: string; batchId: string; marketplaceDraftId: string; productDraftId: string; queuePosition: number;
  status: EbayDraftItemStatus; attemptCount: number; errorCode: string | null; errorMessage: string | null;
  ebayOfferId: string | null; startedAt: string | null; completedAt: string | null;
  claimedAt: string | null; leaseExpiresAt: string | null;
  generatedTitle: string | null; sku: string | null;
};

type BatchRow = {
  id: string; owner_id: string; status: EbayDraftBatchStatus; listing_count: number; display_number: number;
  box_dismissed_at: string | null; activity_dismissed_at: string | null; created_at: string; completed_at: string | null;
};
type ItemRow = {
  id: string; batch_id: string; marketplace_draft_id: string; product_draft_id: string; queue_position: number;
  status: EbayDraftItemStatus; attempt_count: number; error_code: string | null; error_message: string | null;
  ebay_offer_id: string | null; started_at: string | null; completed_at: string | null;
  claimed_at: string | null; lease_expires_at: string | null;
};

const BATCH_SELECT = "id,owner_id,status,listing_count,display_number,box_dismissed_at,activity_dismissed_at,created_at,completed_at";
const ITEM_SELECT = "id,batch_id,marketplace_draft_id,product_draft_id,queue_position,status,attempt_count,error_code,error_message,ebay_offer_id,started_at,completed_at,claimed_at,lease_expires_at";

function mapBatch(row: BatchRow): EbayDraftBatchRecord {
  return {
    id: row.id, ownerId: row.owner_id, status: row.status, listingCount: row.listing_count, displayNumber: row.display_number,
    boxDismissedAt: row.box_dismissed_at, activityDismissedAt: row.activity_dismissed_at, createdAt: row.created_at, completedAt: row.completed_at,
  };
}

export async function createEbayDraftBatch(ownerId: string, marketplaceDraftIds: string[], productDraftIds: string[]): Promise<{ batchId: string; displayNumber: number }> {
  const response = await supabaseRequest("rpc/listing_studio_create_ebay_draft_batch", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_marketplace_draft_ids: marketplaceDraftIds, p_product_draft_ids: productDraftIds }),
  });
  const [row] = await response.json() as { batch_id: string; display_number: number }[];
  return { batchId: row.batch_id, displayNumber: row.display_number };
}

export async function getEbayDraftBatch(ownerId: string, batchId: string): Promise<{ batch: EbayDraftBatchRecord; items: EbayDraftBatchItemRecord[] } | null> {
  const batches = await supabaseRequestAll<BatchRow>(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&select=${BATCH_SELECT}`);
  const batch = batches[0];
  if (!batch) return null;
  const items = await supabaseRequestAll<ItemRow>(`ebay_draft_batch_items?batch_id=eq.${batchId}&select=${ITEM_SELECT}&order=queue_position.asc`);
  const productDraftIds = items.map(i => i.product_draft_id);
  const titles = productDraftIds.length
    ? await supabaseRequestAll<{ id: string; generated_title: string | null; sku: string | null }>(
      `listing_drafts?id=in.(${productDraftIds.join(",")})&owner_id=eq.${ownerId}&select=id,generated_title,sku`,
    )
    : [];
  const titlesById = new Map(titles.map(t => [t.id, t]));
  return {
    batch: mapBatch(batch),
    items: items.map(item => ({
      id: item.id, batchId: item.batch_id, marketplaceDraftId: item.marketplace_draft_id, productDraftId: item.product_draft_id,
      queuePosition: item.queue_position, status: item.status, attemptCount: item.attempt_count,
      errorCode: item.error_code, errorMessage: item.error_message, ebayOfferId: item.ebay_offer_id,
      startedAt: item.started_at, completedAt: item.completed_at,
      claimedAt: item.claimed_at, leaseExpiresAt: item.lease_expires_at,
      generatedTitle: titlesById.get(item.product_draft_id)?.generated_title ?? null, sku: titlesById.get(item.product_draft_id)?.sku ?? null,
    })),
  };
}

// Mirrors app/api/listing-studio/extension-batches/route.ts's GET — every
// batch still genuinely visible (non-terminal, or terminal but not yet
// dismissed) for the box grid, plus every non-terminal batch stuck for
// longer than STUCK_AFTER_MINUTES with no recent per-item progress, for
// the "Hidden active batch" / dismiss-X panel.
const STUCK_AFTER_MINUTES = 15;

export type OwnerEbayBatchSummary = {
  batchId: string; displayNumber: number; status: EbayDraftBatchStatus; listingCount: number;
  boxDismissedAt: string | null; createdAt: string;
};

export async function listOwnerEbayBatches(ownerId: string): Promise<{ visible: OwnerEbayBatchSummary[]; stuck: OwnerEbayBatchSummary[] }> {
  const rows = await supabaseRequestAll<BatchRow>(`ebay_draft_batches?owner_id=eq.${ownerId}&select=${BATCH_SELECT}&order=created_at.desc`);
  const now = Date.now();
  const visible = rows.filter(row => row.box_dismissed_at === null).map(row => ({
    batchId: row.id, displayNumber: row.display_number, status: row.status, listingCount: row.listing_count,
    boxDismissedAt: row.box_dismissed_at, createdAt: row.created_at,
  }));
  const stuck = rows
    .filter(row => (row.status === "pending" || row.status === "in_progress") && now - new Date(row.created_at).getTime() > STUCK_AFTER_MINUTES * 60_000)
    .map(row => ({ batchId: row.id, displayNumber: row.display_number, status: row.status, listingCount: row.listing_count, boxDismissedAt: row.box_dismissed_at, createdAt: row.created_at }));
  return { visible, stuck };
}

export async function dismissEbayDraftBatch(ownerId: string, batchId: string, action: "dismiss_box" | "dismiss_activity"): Promise<void> {
  const nowIso = new Date().toISOString();
  if (action === "dismiss_box") {
    await supabaseRequest(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&box_dismissed_at=is.null`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ box_dismissed_at: nowIso, activity_dismissed_at: nowIso }),
    });
  } else {
    await supabaseRequest(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&activity_dismissed_at=is.null`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ activity_dismissed_at: nowIso }),
    });
  }
}

/** Cooperative cancel, mirroring the Vinted extension-batch DELETE route:
 * only QUEUED items are cancelled; anything already mid-processing (i.e.
 * currently claimed, or in one of the in-flight statuses) is left alone —
 * the next process tick that claims it will simply finish (or itself
 * fail) that item naturally, never interrupted mid-API-call. */
export async function cancelEbayDraftBatch(ownerId: string, batchId: string): Promise<EbayDraftBatchStatus> {
  const batches = await supabaseRequestAll<{ id: string; status: EbayDraftBatchStatus }>(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&select=id,status`);
  const batch = batches[0];
  if (!batch) throw new Error("Batch not found.");
  if (batch.status === "completed" || batch.status === "cancelled") return batch.status;
  await supabaseRequest(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled", completed_at: new Date().toISOString() }),
  });
  await supabaseRequest(`ebay_draft_batch_items?batch_id=eq.${batchId}&status=eq.queued`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }),
  });
  return "cancelled";
}

// ---------------------------------------------------------------------
// Bulk eligibility resolution — the ONE place Create eBay drafts (and
// nothing else) decides, for many products at once, which have a real
// eBay preparation ready to batch and which don't (and why). Never trusts
// client-computed eligibility — every server route that creates a batch or
// reports "N eligible" calls this fresh. Photo reachability is
// deliberately NOT checked here (that would mean fetching every photo's
// signed URL for every candidate on every click) — a photo problem is
// instead caught and reported per-item during actual processing (see
// preparePhotos below), exactly like the product spec's own "track photo
// state through the normal row workflow" guidance.

export type EbayEligibilityByProduct = Map<string, { marketplaceDraftId: string | null; eligible: boolean; reasons: string[]; notes: string[] }>;

export async function resolveEbayDraftEligibilityForProducts(ownerId: string, productDraftIds: string[]): Promise<EbayEligibilityByProduct> {
  const result: EbayEligibilityByProduct = new Map();
  if (productDraftIds.length === 0) return result;

  const [draftsByProduct, connection, skuRows, imageRows] = await Promise.all([
    listMarketplaceDraftsForProducts(ownerId, productDraftIds),
    getEbayConnection(ownerId),
    supabaseRequestAll<{ id: string; sku: string | null }>(`listing_drafts?id=in.(${productDraftIds.join(",")})&owner_id=eq.${ownerId}&select=id,sku`),
    supabaseRequestAll<{ draft_id: string }>(`listing_draft_images?draft_id=in.(${productDraftIds.join(",")})&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=draft_id`),
  ]);
  const policies = connection ? await listEbayPolicies(connection.id) : [];
  const skuByProduct = new Map(skuRows.map(r => [r.id, r.sku]));
  const photoCountByProduct = new Map<string, number>();
  for (const row of imageRows) photoCountByProduct.set(row.draft_id, (photoCountByProduct.get(row.draft_id) ?? 0) + 1);
  const isStale = (type: "FULFILLMENT" | "RETURN" | "PAYMENT", id: string | null) =>
    id !== null && !policies.some(p => p.policyType === type && p.ebayPolicyId === id && p.available);

  for (const productDraftId of productDraftIds) {
    const ebayDraft = (draftsByProduct.get(productDraftId) ?? []).find(d => d.marketplace === "EBAY_UK") ?? null;
    if (!ebayDraft) { result.set(productDraftId, { marketplaceDraftId: null, eligible: false, reasons: ["No eBay preparation for this listing"], notes: [] }); continue; }
    const evaluation = evaluateEbayDraftEligibility({
      hasEbayPreparation: true,
      accountUsable: connection?.connectionStatus === "connected",
      alreadyHasOffer: ebayDraft.ebayOfferId !== null,
      contentReady: ebayDraft.readiness.ready,
      hasValidPrice: ebayDraft.pricePence != null && ebayDraft.pricePence > 0,
      hasPhoto: (photoCountByProduct.get(productDraftId) ?? 0) > 0,
      hasSku: Boolean(skuByProduct.get(productDraftId)),
      hasQuantity: ebayDraft.quantity != null,
      conditionValue: ebayDraft.conditionValue,
      fulfillmentPolicyId: ebayDraft.ebayFulfillmentPolicyId, fulfillmentPolicyStale: isStale("FULFILLMENT", ebayDraft.ebayFulfillmentPolicyId),
      returnPolicyId: ebayDraft.ebayReturnPolicyId, returnPolicyStale: isStale("RETURN", ebayDraft.ebayReturnPolicyId),
      paymentPolicyId: ebayDraft.ebayPaymentPolicyId, paymentPolicyStale: isStale("PAYMENT", ebayDraft.ebayPaymentPolicyId),
      merchantLocationKey: ebayDraft.ebayMerchantLocationKey,
    });
    result.set(productDraftId, { marketplaceDraftId: ebayDraft.id, eligible: evaluation.eligible, reasons: evaluation.reasons, notes: evaluation.notes });
  }
  return result;
}

// ---------------------------------------------------------------------
// Persistent, resumable, bounded processing (corrective pass)
//
// The database — via rpc/listing_studio_claim_ebay_draft_batch_items — is
// the ONLY source of truth for "what work exists and has anything already
// claimed it". There is no in-memory queue, no unawaited promise, and no
// assumption that the Node process stays alive after a response is sent.
// Each pipeline step is a single, small, resumable unit of work:
//
//   queued              -> re-verify eligibility fresh (no eBay call)
//   uploading_photos    -> verify photo reachability (no eBay call)
//   creating_inventory_item -> ONE createOrReplaceInventoryItem call
//   creating_draft      -> check-then-create ONE offer (getOffersForSku,
//                          then createOffer only if none already exists)
//   verifying_draft     -> ONE getOffer call
//
// Every transition is persisted (patchItem) before the function returns —
// "each external step persists progress before proceeding". A retry of a
// crashed/timed-out item always re-enters at its LAST PERSISTED status:
// createOrReplaceInventoryItem is a PUT (safe to repeat), and creating_draft
// always checks getOffersForSku BEFORE ever calling createOffer, so a
// retry can never create a second offer for the same SKU even if an
// earlier attempt's createOffer call actually succeeded remotely but the
// process died before persisting that fact locally.
//
// runEbayDraftBatchProcessTick is the ONE entry point every trigger uses
// (the create route's own first synchronous tick, the client's open-tab
// poll loop, and — see app/api/cron/ebay-draft-processing/route.ts — a
// scheduled sweep): it claims at most PROCESS_TICK_ITEM_LIMIT items
// atomically, advances each by exactly one step, and returns. It is
// always safe to call again immediately, from anywhere, any number of
// times — that IS how forward progress happens; there is no other driver.

export const PROCESS_TICK_ITEM_LIMIT = 3;
const CLAIM_LEASE_SECONDS = 120;

async function patchItem(itemId: string, patch: Record<string, unknown>): Promise<void> {
  await supabaseRequest(`ebay_draft_batch_items?id=eq.${itemId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
}

/** Releases a claim WITHOUT changing status — used only when a step
 * finishes but the item is still non-terminal (so the next tick, from
 * this invocation or any other, can claim it again for its next step). A
 * terminal patch (status completed/failed/cancelled) already makes the
 * item permanently unclaimable via the RPC's own `status not in (...)`
 * filter, so terminal transitions don't need this. */
async function releaseClaim(itemId: string): Promise<void> {
  await patchItem(itemId, { claimed_at: null, lease_expires_at: null, claimed_by: null });
}

type ClaimedItemRow = {
  item_id: string; batch_id: string; marketplace_draft_id: string; product_draft_id: string;
  status: EbayDraftItemStatus; attempt_count: number; queue_position: number;
};

/** Atomic claim — see rpc/listing_studio_claim_ebay_draft_batch_items's
 * own doc comment in supabase-ebay-draft-batches.sql for the full
 * `for update skip locked` + time-bounded lease guarantee. `batchId` is
 * optional: omit it to claim across every one of this owner's
 * non-terminal batches (the cron sweep's own use case). */
export async function claimEbayDraftBatchItems(ownerId: string, batchId: string | null, limit: number, claimedBy: string): Promise<ClaimedItemRow[]> {
  const response = await supabaseRequest("rpc/listing_studio_claim_ebay_draft_batch_items", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_batch_id: batchId, p_limit: limit, p_claimed_by: claimedBy, p_lease_seconds: CLAIM_LEASE_SECONDS }),
  });
  return response.json() as Promise<ClaimedItemRow[]>;
}

type ImageRow = { id: string; storage_path: string; sort_order: number };
type ProductDraftRow = { id: string; sku: string | null };
// Corrective pass — NEVER includes the signed URL itself (see this file's
// own "photo URL durability" comment on preparePhotos below): only the
// underlying image's own stable id plus a reachability verdict is ever
// persisted. A signed URL is a short-lived credential, not a photo's
// identity, and must never be written to the database or logged.
type EbayPhotoState = { status: "pending" | "uploading" | "uploaded" | "failed"; checkedAt: string; error?: string };

// Corrective pass — reduced from 3600s to 300s. eBay's Inventory API
// FETCHES AND STORES ("copies") the image the moment
// createOrReplaceInventoryItem is called — per eBay's own documented
// behaviour for hosted-image-URL inventory items, it does not need
// continuing access to the URL afterward. Signed URLs are therefore
// generated fresh, in-memory only, IMMEDIATELY before each use (once to
// verify reachability in the uploading_photos step, again right before
// the actual PUT in the creating_inventory_item step) — never generated
// far in advance and never persisted — so 5 minutes is already a generous
// margin for the single synchronous call it needs to survive, not a
// value chosen to let it linger.
const EBAY_IMAGE_URL_LIFETIME_SECONDS = 300;

/** Builds and verifies genuinely-reachable public HTTPS Supabase Storage
 * signed URLs for every uploaded photo of this product, in stored order
 * (first = main photo) — never a local filesystem path or a blob: URL.
 * "Verified reachable" means a real HEAD request to the signed URL itself
 * succeeded, not merely that Storage returned a signing response.
 *
 * The returned `imageUrls` are for THIS CALL's own immediate in-memory use
 * only (passed straight into an eBay API call by the caller within the
 * same tick) — never returned to a client, never logged, and never
 * included in `photoState` (which the caller persists) or any other
 * write. Never call this function and then hold its result across a
 * later, separate invocation/tick. */
export async function preparePhotos(ownerId: string, productDraftId: string): Promise<{ imageUrls: string[]; photoState: Record<string, EbayPhotoState> }> {
  const images = await supabaseRequestAll<ImageRow>(
    `listing_draft_images?draft_id=eq.${productDraftId}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=id,storage_path,sort_order&order=sort_order.asc`,
  );
  const imageUrls: string[] = [];
  const photoState: Record<string, EbayPhotoState> = {};
  for (const image of images) {
    try {
      const url = await createSignedDownloadUrl(LISTING_STUDIO_BUCKET, image.storage_path, EBAY_IMAGE_URL_LIFETIME_SECONDS);
      const check = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (check && check.ok) {
        imageUrls.push(url);
        photoState[image.id] = { status: "uploaded", checkedAt: new Date().toISOString() };
      } else {
        photoState[image.id] = { status: "failed", checkedAt: new Date().toISOString(), error: `Photo URL not reachable (HTTP ${check?.status ?? "network error"}).` };
      }
    } catch (error) {
      if (error instanceof StorageBucketMissingError) throw error;
      photoState[image.id] = { status: "failed", checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Could not prepare this photo." };
    }
  }
  return { imageUrls, photoState };
}

/** Builds the eBay `aspects` map from this draft's already-resolved
 * dynamic_data_json — only real, non-empty values; internal reserved
 * pseudo-aspect keys (see marketplace-types.ts's MarketplaceDynamicData —
 * "__productFacts"/"__contentGeneration"/"__packageSize" etc.) are never
 * sent to eBay as if they were genuine item specifics. */
export function buildAspectsPayload(dynamicData: MarketplaceDynamicData): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(dynamicData)) {
    if (name.startsWith("__")) continue;
    if (!entry || entry.value === null) continue;
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    if (values.length > 0) aspects[name] = values;
  }
  return aspects;
}

/**
 * Corrective pass (failed first draft) — pure, DB/network-free payload
 * builder, extracted from the "creating_inventory_item" pipeline step so
 * the exact outgoing shape can be asserted in a test without calling
 * eBay. Uses toEbayInventoryCondition (never the raw display label) for
 * `condition` — the one field the first real draft attempt failed on.
 * Returns `null` (never a payload with a guessed condition) when the
 * translation fails closed; the caller must treat that as a real blocker,
 * exactly like every other eligibility failure.
 */
export function buildInventoryItemPayload(
  draft: Pick<MarketplaceDraft, "conditionValue" | "title" | "description" | "dynamicData" | "quantity">,
  imageUrls: string[],
): { condition: EbayInventoryConditionEnum; product: EbayInventoryItemPayload["product"]; availability: EbayInventoryItemPayload["availability"] } | null {
  const condition = toEbayInventoryCondition(draft.conditionValue);
  if (!condition.ok) return null;
  return {
    condition: condition.enumValue,
    product: { title: draft.title ?? "", description: draft.description ?? "", aspects: buildAspectsPayload(draft.dynamicData), imageUrls },
    availability: { shipToLocationAvailability: { quantity: draft.quantity ?? 1 } },
  };
}

async function markItemFailed(itemId: string, ownerId: string, marketplaceDraftId: string, code: string, message: string): Promise<void> {
  await patchItem(itemId, { status: "failed", error_code: code, error_message: message, completed_at: new Date().toISOString(), claimed_at: null, lease_expires_at: null, claimed_by: null });
  await patchMarketplaceDraft(ownerId, marketplaceDraftId, { ebay_last_draft_error: message }).catch(() => {});
}

/**
 * Advances exactly ONE already-claimed item by exactly ONE pipeline step.
 * Never loops across steps — the caller (runEbayDraftBatchProcessTick)
 * decides whether to call this again for the same item on a LATER tick.
 * Every branch either persists a terminal status (failed/completed, which
 * also clears the claim) or persists the next non-terminal status AND
 * releases the claim (so it's immediately claimable again for its next
 * step, by this tick's own next iteration or a future one).
 */
async function advanceClaimedItem(ownerId: string, item: ClaimedItemRow): Promise<void> {
  const draft = await getMarketplaceDraft(ownerId, item.product_draft_id, "EBAY_UK");
  if (!draft) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "draft_missing", "This eBay preparation could not be found."); return; }

  switch (item.status) {
    case "queued": {
      const connection = await getEbayConnection(ownerId);
      const [productRows, policies, imageRows] = await Promise.all([
        supabaseRequestAll<ProductDraftRow>(`listing_drafts?id=eq.${item.product_draft_id}&owner_id=eq.${ownerId}&select=id,sku`),
        connection ? listEbayPolicies(connection.id) : Promise.resolve([]),
        supabaseRequestAll<{ draft_id: string }>(`listing_draft_images?draft_id=eq.${item.product_draft_id}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=draft_id`),
      ]);
      const sku = productRows[0]?.sku ?? null;
      const isStale = (type: "FULFILLMENT" | "RETURN" | "PAYMENT", id: string | null) =>
        id !== null && !policies.some(p => p.policyType === type && p.ebayPolicyId === id && p.available);

      const eligibility = evaluateEbayDraftEligibility({
        hasEbayPreparation: true,
        accountUsable: connection?.connectionStatus === "connected",
        alreadyHasOffer: draft.ebayOfferId !== null,
        contentReady: draft.readiness.ready,
        hasValidPrice: draft.pricePence != null && draft.pricePence > 0,
        hasPhoto: imageRows.length > 0,
        hasSku: Boolean(sku),
        hasQuantity: draft.quantity != null,
        conditionValue: draft.conditionValue,
        fulfillmentPolicyId: draft.ebayFulfillmentPolicyId, fulfillmentPolicyStale: isStale("FULFILLMENT", draft.ebayFulfillmentPolicyId),
        returnPolicyId: draft.ebayReturnPolicyId, returnPolicyStale: isStale("RETURN", draft.ebayReturnPolicyId),
        paymentPolicyId: draft.ebayPaymentPolicyId, paymentPolicyStale: isStale("PAYMENT", draft.ebayPaymentPolicyId),
        merchantLocationKey: draft.ebayMerchantLocationKey,
      });
      if (!eligibility.eligible) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "not_eligible", eligibility.reasons.join("; ")); return; }

      await patchItem(item.item_id, { status: "uploading_photos" });
      await releaseClaim(item.item_id);
      return;
    }

    case "uploading_photos": {
      try {
        const { imageUrls, photoState } = await preparePhotos(ownerId, item.product_draft_id);
        await patchMarketplaceDraft(ownerId, draft.id, { ebay_photo_state_json: photoState });
        if (imageUrls.length === 0) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "no_reachable_photos", "No photo could be verified as reachable."); return; }
        await patchItem(item.item_id, { status: "creating_inventory_item" });
        await releaseClaim(item.item_id);
      } catch (error) {
        await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "photo_error", error instanceof Error ? error.message : "Could not prepare this listing's photos.");
      }
      return;
    }

    case "creating_inventory_item": {
      const productRows = await supabaseRequestAll<ProductDraftRow>(`listing_drafts?id=eq.${item.product_draft_id}&owner_id=eq.${ownerId}&select=id,sku`);
      const sku = productRows[0]?.sku ?? null;
      if (!sku) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "not_eligible", "Missing SKU"); return; }
      try {
        const { imageUrls } = await preparePhotos(ownerId, item.product_draft_id);
        if (imageUrls.length === 0) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "no_reachable_photos", "No photo could be verified as reachable."); return; }
        // CORRECTIVE PASS (failed first draft, root cause) — the dangerous
        // `draft.conditionValue ?? "USED_EXCELLENT"` fallback is gone. That
        // line sent a UI-facing display label ("Used – Very Good") straight
        // into eBay's Inventory API `condition` field, which requires an
        // exact ConditionEnum token ("USED_VERY_GOOD"), and silently
        // substituted an unrelated enum whenever conditionValue was merely
        // absent — never a safe assumption about an item's actual
        // condition. buildInventoryItemPayload (above) uses
        // toEbayInventoryCondition, the SAME translator every eligibility
        // check already ran before this item was ever allowed into a
        // batch — this null case is not expected in the normal path, but
        // is a real, fail-closed blocker if it ever happens, never a
        // guessed payload.
        const payload = buildInventoryItemPayload(draft, imageUrls);
        if (!payload) {
          const condition = toEbayInventoryCondition(draft.conditionValue);
          await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "not_eligible", condition.ok ? "Missing or unsupported eBay condition." : condition.reason);
          return;
        }
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        await patchItem(item.item_id, { attempt_count: item.attempt_count + 1 });
        // A PUT keyed by SKU — safe to repeat on retry (idempotent).
        await createOrReplaceInventoryItem(accessToken, sku, payload);
        await patchItem(item.item_id, { status: "creating_draft" });
        await releaseClaim(item.item_id);
      } catch (error) {
        await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "ebay_inventory_item_error", error instanceof Error ? error.message : "This eBay inventory item could not be created.");
      }
      return;
    }

    case "creating_draft": {
      const productRows = await supabaseRequestAll<ProductDraftRow>(`listing_drafts?id=eq.${item.product_draft_id}&owner_id=eq.${ownerId}&select=id,sku`);
      const sku = productRows[0]?.sku ?? null;
      if (!sku) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "not_eligible", "Missing SKU"); return; }
      try {
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        // Idempotency guard — checked BEFORE every createOffer call,
        // including a retry whose earlier attempt's real remote outcome
        // is unknown (the process may have died between eBay confirming
        // the offer and this app persisting that fact). Reusing an
        // already-existing offer here is what makes "a retry continues
        // from the known remote state" and "completed offers are never
        // recreated" genuine guarantees rather than best-effort hopes.
        const existing = await getOffersForSku(accessToken, sku);
        const offer = existing[0] ?? await createOffer(accessToken, {
          sku, marketplaceId: "EBAY_GB", format: "FIXED_PRICE",
          categoryId: draft.categoryId!, listingDescription: draft.description ?? "",
          pricingSummary: { price: { value: (draft.pricePence! / 100).toFixed(2), currency: "GBP" } },
          listingPolicies: { fulfillmentPolicyId: draft.ebayFulfillmentPolicyId!, returnPolicyId: draft.ebayReturnPolicyId!, paymentPolicyId: draft.ebayPaymentPolicyId! },
          merchantLocationKey: draft.ebayMerchantLocationKey ?? undefined,
        });
        // Persisted immediately, BEFORE verification — "partial success
        // is persisted before proceeding": even if verifying_draft never
        // completes, this draft is already correctly marked as having a
        // real remote offer, so it's never re-created by a future batch.
        await patchMarketplaceDraft(ownerId, draft.id, { ebay_offer_id: offer.offerId, ebay_last_draft_error: null });
        await patchItem(item.item_id, { status: "verifying_draft", ebay_offer_id: offer.offerId });
        await releaseClaim(item.item_id);
      } catch (error) {
        await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "ebay_offer_error", error instanceof Error ? error.message : "This eBay offer could not be created.");
      }
      return;
    }

    case "verifying_draft": {
      if (!draft.ebayOfferId) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "verification_failed", "No offer id was recorded to verify."); return; }
      try {
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        const verified = await getOffer(accessToken, draft.ebayOfferId);
        if (!verified) { await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "verification_failed", "The created eBay offer could not be verified."); return; }
        await patchMarketplaceDraft(ownerId, draft.id, { ebay_inventory_synced_at: new Date().toISOString() });
        await patchItem(item.item_id, { status: "completed", completed_at: new Date().toISOString(), claimed_at: null, lease_expires_at: null, claimed_by: null });
      } catch (error) {
        await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "ebay_verification_error", error instanceof Error ? error.message : "This eBay offer could not be verified.");
      }
      return;
    }

    default:
      // Terminal statuses are never claimable (the RPC's own WHERE clause
      // excludes them) — reaching here would mean a logic error elsewhere,
      // not a real runtime path. Release defensively rather than leaving
      // a stray claim behind.
      await releaseClaim(item.item_id);
  }
}

export type ProcessTickResult = { claimedCount: number; batchStatus: EbayDraftBatchStatus | null; hasMoreWork: boolean };

/**
 * The ONE processing entry point — see this file's own header for the
 * full design. Claims up to PROCESS_TICK_ITEM_LIMIT items (scoped to
 * `batchId`), advances each by one step (in parallel — each item's own
 * advanceClaimedItem call is fully independent, so one item's failure
 * never blocks another's), updates the batch's own status (pending ->
 * in_progress on first work; -> completed once every item is terminal),
 * and returns. Always safe to call again immediately.
 */
export async function runEbayDraftBatchProcessTick(ownerId: string, batchId: string): Promise<ProcessTickResult> {
  const claimedBy = `tick-${randomUUID()}`;
  const claimed = await claimEbayDraftBatchItems(ownerId, batchId, PROCESS_TICK_ITEM_LIMIT, claimedBy);

  if (claimed.length > 0) {
    await supabaseRequest(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&status=eq.pending`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "in_progress" }),
    });
    await Promise.all(claimed.map(item => advanceClaimedItem(ownerId, item).catch(async () => {
      // advanceClaimedItem's own branches already catch every EXPECTED
      // failure and persist it as a normal 'failed' status — this is
      // defense in depth against a genuinely unexpected throw, so the
      // claim is never left dangling until its lease expires.
      await markItemFailed(item.item_id, ownerId, item.marketplace_draft_id, "unexpected_error", "An unexpected error occurred while processing this eBay draft.");
    })));
  }

  const items = await supabaseRequestAll<{ status: EbayDraftItemStatus }>(`ebay_draft_batch_items?batch_id=eq.${batchId}&select=status`);
  const allTerminal = items.length > 0 && items.every(i => i.status === "completed" || i.status === "failed" || i.status === "cancelled");
  let batchStatus: EbayDraftBatchStatus | null = null;
  if (allTerminal) {
    const response = await supabaseRequest(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&status=neq.cancelled&status=neq.completed`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "completed", completed_at: new Date().toISOString() }),
    });
    const rows = await response.json().catch(() => []) as { status: EbayDraftBatchStatus }[];
    batchStatus = rows[0]?.status ?? "completed";
  }

  return { claimedCount: claimed.length, batchStatus, hasMoreWork: !allTerminal };
}

// ---------------------------------------------------------------------
// Corrective pass (failed first draft) — genuine failed-draft retry.
//
// Deliberately NOT "click Create eBay drafts again": that path would
// re-verify eligibility (now correctly, with the condition-mapping fix)
// and re-attempt from scratch with no memory of the earlier failure or
// any reconciliation with what eBay itself already has for this SKU. A
// retry instead: (1) recalculates eligibility fresh with the SAME
// authoritative function every other call site uses, (2) reconciles
// against eBay by SKU BEFORE touching anything locally — an existing
// remote offer is reused, never recreated, and a remote-only inventory
// item is left to the pipeline's own idempotent PUT — (3) only then
// requeues the ORIGINAL item (never a new item/row — attempt_count and
// the batch's own history are preserved) and runs one bounded tick,
// exactly like every other forward-progress step in this file.

export type RetryEbayDraftItemResult =
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; itemStatus: EbayDraftItemStatus }
  | { outcome: "ineligible"; reasons: string[] }
  // Tripped only when two retry requests raced — the conditional PATCH
  // below (`status=eq.failed`) is the actual concurrency guard; this is
  // just how its failure is reported back.
  | { outcome: "already_in_progress" }
  | { outcome: "reconciled_existing_offer" | "requeued"; inventoryItemExists: boolean; offerExists: boolean; tick: ProcessTickResult };

/** Conditional PATCH — succeeds (and returns true) only if the row's
 * status still matches `expectedStatus` at the moment of the write, using
 * the exact same "PATCH with a status=eq.X filter, check whether any row
 * came back" pattern this codebase already uses for the Vinted extension
 * batch dismiss/cancel routes. This IS the concurrency guard: two
 * concurrent retry requests for the same item can both pass every earlier
 * check, but only the first PATCH here actually changes a `failed` row —
 * the second's WHERE clause matches zero rows once the first has already
 * moved it to `queued`/`verifying_draft`, so `Prefer: return=representation`
 * comes back empty and this returns false. Never relies on the caller
 * having any lock — the database's own row visibility is the guarantee. */
async function patchItemIfStatus(itemId: string, expectedStatus: EbayDraftItemStatus, patch: Record<string, unknown>): Promise<boolean> {
  const response = await supabaseRequest(`ebay_draft_batch_items?id=eq.${itemId}&status=eq.${expectedStatus}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
  });
  const rows = await response.json().catch(() => []) as unknown[];
  return rows.length > 0;
}

export async function retryFailedEbayDraftItem(ownerId: string, batchId: string, itemId: string): Promise<RetryEbayDraftItemResult> {
  const batches = await supabaseRequestAll<{ id: string }>(`ebay_draft_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&select=id`);
  if (!batches[0]) return { outcome: "not_found" };

  const items = await supabaseRequestAll<ItemRow>(`ebay_draft_batch_items?id=eq.${itemId}&batch_id=eq.${batchId}&select=${ITEM_SELECT}`);
  const item = items[0];
  if (!item) return { outcome: "not_found" };
  if (item.status !== "failed") return { outcome: "not_retryable", itemStatus: item.status };

  const draft = await getMarketplaceDraft(ownerId, item.product_draft_id, "EBAY_UK");
  if (!draft) return { outcome: "not_found" };

  const connection = await getEbayConnection(ownerId);
  const [productRows, policies, imageRows] = await Promise.all([
    supabaseRequestAll<ProductDraftRow>(`listing_drafts?id=eq.${item.product_draft_id}&owner_id=eq.${ownerId}&select=id,sku`),
    connection ? listEbayPolicies(connection.id) : Promise.resolve([]),
    supabaseRequestAll<{ draft_id: string }>(`listing_draft_images?draft_id=eq.${item.product_draft_id}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=draft_id`),
  ]);
  const sku = productRows[0]?.sku ?? null;
  const isStale = (type: "FULFILLMENT" | "RETURN" | "PAYMENT", id: string | null) =>
    id !== null && !policies.some(p => p.policyType === type && p.ebayPolicyId === id && p.available);

  // Requirement 4 (recalculate eligibility fresh) — the SAME authoritative
  // function the client button, the batch-creation route, and the queued
  // pipeline step all use. alreadyHasOffer is deliberately checked against
  // the LOCAL draft.ebayOfferId only here — the remote reconciliation
  // below is a separate, later step that can still find and reuse a
  // remote offer this local field doesn't yet know about.
  const eligibility = evaluateEbayDraftEligibility({
    hasEbayPreparation: true,
    accountUsable: connection?.connectionStatus === "connected",
    alreadyHasOffer: draft.ebayOfferId !== null,
    contentReady: draft.readiness.ready,
    hasValidPrice: draft.pricePence != null && draft.pricePence > 0,
    hasPhoto: imageRows.length > 0,
    hasSku: Boolean(sku),
    hasQuantity: draft.quantity != null,
    conditionValue: draft.conditionValue,
    fulfillmentPolicyId: draft.ebayFulfillmentPolicyId, fulfillmentPolicyStale: isStale("FULFILLMENT", draft.ebayFulfillmentPolicyId),
    returnPolicyId: draft.ebayReturnPolicyId, returnPolicyStale: isStale("RETURN", draft.ebayReturnPolicyId),
    paymentPolicyId: draft.ebayPaymentPolicyId, paymentPolicyStale: isStale("PAYMENT", draft.ebayPaymentPolicyId),
    merchantLocationKey: draft.ebayMerchantLocationKey,
  });
  if (!eligibility.eligible) return { outcome: "ineligible", reasons: eligibility.reasons };
  if (!sku) return { outcome: "ineligible", reasons: ["Missing SKU"] };

  // Requirements 5-6 — reconcile against eBay by SKU BEFORE any local
  // state change: getOffersForSku (already scoped to this SKU + EBAY_GB,
  // so any result is inherently for the right SKU/marketplace — no
  // further validation needed) and the new read-only getInventoryItem.
  // Both are GET-only; neither can create, replace, or publish anything.
  const { accessToken } = await getValidEbayAccessToken(ownerId);
  const [offers, inventoryItem] = await Promise.all([
    getOffersForSku(accessToken, sku, "EBAY_GB"),
    getInventoryItem(accessToken, sku),
  ]);
  const offerExists = offers.length > 0;
  const inventoryItemExists = inventoryItem !== null || offerExists; // an offer can only exist if its inventory item does

  const resetFields = { error_code: null, error_message: null, claimed_at: null, lease_expires_at: null, claimed_by: null, completed_at: null };
  if (offerExists) {
    // Requirement 7 — an offer already exists remotely: reconcile and
    // persist its id locally, never call createOffer again for this SKU.
    // Jumps straight to verifying_draft — the inventory item and offer
    // creation steps are both skipped, exactly because they're already
    // done.
    const offer = offers[0];
    await patchMarketplaceDraft(ownerId, draft.id, { ebay_offer_id: offer.offerId, ebay_last_draft_error: null });
    const patched = await patchItemIfStatus(itemId, "failed", { ...resetFields, status: "verifying_draft", ebay_offer_id: offer.offerId });
    if (!patched) return { outcome: "already_in_progress" };
    const tick = await runEbayDraftBatchProcessTick(ownerId, batchId);
    return { outcome: "reconciled_existing_offer", inventoryItemExists, offerExists, tick };
  }

  // Requirements 8-9 — no remote offer (whether or not an inventory item
  // exists): requeue through the normal, now-corrected pipeline from the
  // top. createOrReplaceInventoryItem is an idempotent PUT, so this is
  // always safe to repeat whether or not eBay already has this SKU's
  // inventory item — the corrected payload is what gets written either way.
  const patched = await patchItemIfStatus(itemId, "failed", { ...resetFields, status: "queued" });
  if (!patched) return { outcome: "already_in_progress" };
  const tick = await runEbayDraftBatchProcessTick(ownerId, batchId);
  return { outcome: "requeued", inventoryItemExists, offerExists, tick };
}
