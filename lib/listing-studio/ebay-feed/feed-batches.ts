import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { getMarketplaceDraft, patchMarketplaceDraft, listMarketplaceDraftsForProducts } from "@/lib/listing-studio/marketplace-drafts";
import { getEbayConnection, getValidEbayAccessToken } from "@/lib/ebay-account/client";
import { createFeedTask, uploadFeedFile, getFeedTask, getFeedResultFile, feedTaskHasInputFile } from "@/lib/ebay-account/feed-client";
import { generateFeedDraftCsv, previewFeedDraftRow, type FeedDraftRowInput } from "@/lib/listing-studio/ebay-feed/csv-generator";
import { parseFeedResultCsv } from "@/lib/listing-studio/ebay-feed/feed-result-parser";
import { evaluateEbayFeedDraftEligibility } from "@/lib/listing-studio/ebay-feed/feed-draft-eligibility";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { createSignedDownloadUrl, StorageBucketMissingError } from "@/lib/listing-studio/storage-rest";
import type { MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";
import { isEbayFeedBatchStatusTerminal, type EbayFeedItemStatus, type EbayFeedBatchStatus } from "@/lib/listing-studio/ebay-feed/feed-workflow-status";

/**
 * The Sell Feed API pipeline's own persistence + orchestration — the new,
 * additive replacement for lib/listing-studio/ebay-draft-batches.ts's
 * Inventory-API-driven processing, for the reasons documented at length in
 * lib/ebay-account/feed-client.ts's own header and this app's architecture
 * notes. The legacy file is untouched; this is a wholly separate module
 * driving wholly separate tables (supabase-ebay-feed-drafts.sql).
 *
 * PROCESSING SHAPE — genuinely different from the legacy per-item claim
 * model, because a Feed upload is one serial pipeline per BATCH (one CSV
 * -> one task -> one result file), not independently parallelisable rows.
 * runEbayFeedBatchProcessTick claims and advances a WHOLE BATCH by exactly
 * one stage per call, mirroring the legacy file's own "each invocation
 * does a small, fixed amount of work, persists, returns" discipline — just
 * at the batch level instead of the item level:
 *
 *   queued             -> re-verify eligibility for every item (no eBay call)
 *   generating_csv     -> build the CSV once, to validate it CAN be built
 *                         (no eBay call yet; the built text is discarded —
 *                         see below for why it's never cached across ticks)
 *   creating_task      -> ONE createFeedTask call; persists the real task ID
 *                         immediately, before any upload is attempted
 *   uploading          -> rebuilds the CSV fresh, then ONE uploadFeedFile
 *                         call against the already-persisted task ID
 *   processing         -> ONE getFeedTask poll; stays here (lease renewed,
 *                         no eBay-side terminal status yet) until eBay's
 *                         own task status becomes terminal
 *   downloading_result -> ONE getFeedResultFile call, to confirm the file
 *                         is retrievable (discarded — see below)
 *   parsing_result      -> re-downloads the result file (idempotent GET,
 *                         cheap) and actually parses + persists it
 *
 * DELIBERATE DESIGN CHOICE — no in-memory value (the generated CSV text,
 * the downloaded result text) is ever cached across a stage boundary. Two
 * consecutive ticks for the SAME batch are not guaranteed to run in the
 * same server process (this is a real serverless deployment, not a
 * long-lived local `next dev` process — see ebay-draft-batches.ts's own
 * corrective-pass comment on exactly this class of mistake). Every stage
 * therefore either does self-contained work from already-persisted data,
 * or re-derives/re-fetches whatever it needs (regenerating a CSV from
 * persisted draft rows, or re-downloading eBay's own result file) rather
 * than trusting an in-process cache to survive until the next tick. This
 * costs a little redundant work (the CSV is built twice; the result file
 * is downloaded twice) in exchange for genuine correctness under a
 * process that can be recycled between any two ticks.
 */

export type EbayFeedBatchRecord = {
  id: string; ownerId: string; status: EbayFeedBatchStatus; listingCount: number; displayNumber: number;
  boxDismissedAt: string | null; activityDismissedAt: string | null;
  ebayTaskId: string | null; csvRowCount: number | null; attemptCount: number;
  errorCode: string | null; errorMessage: string | null;
  createdAt: string; startedAt: string | null; completedAt: string | null;
};
export type EbayFeedBatchItemRecord = {
  id: string; batchId: string; marketplaceDraftId: string; productDraftId: string; queuePosition: number;
  sku: string; status: EbayFeedItemStatus; errorCode: string | null; errorMessage: string | null;
  startedAt: string | null; completedAt: string | null;
  generatedTitle: string | null;
};

type BatchRow = {
  id: string; owner_id: string; status: EbayFeedBatchStatus; listing_count: number; display_number: number;
  box_dismissed_at: string | null; activity_dismissed_at: string | null;
  ebay_task_id: string | null; csv_row_count: number | null; attempt_count: number;
  error_code: string | null; error_message: string | null;
  created_at: string; started_at: string | null; completed_at: string | null;
};
type ItemRow = {
  id: string; batch_id: string; marketplace_draft_id: string; product_draft_id: string; queue_position: number;
  sku: string; status: EbayFeedItemStatus; error_code: string | null; error_message: string | null;
  started_at: string | null; completed_at: string | null;
};

const BATCH_SELECT = "id,owner_id,status,listing_count,display_number,box_dismissed_at,activity_dismissed_at,ebay_task_id,csv_row_count,attempt_count,error_code,error_message,created_at,started_at,completed_at";
const ITEM_SELECT = "id,batch_id,marketplace_draft_id,product_draft_id,queue_position,sku,status,error_code,error_message,started_at,completed_at";

function mapBatch(row: BatchRow): EbayFeedBatchRecord {
  return {
    id: row.id, ownerId: row.owner_id, status: row.status, listingCount: row.listing_count, displayNumber: row.display_number,
    boxDismissedAt: row.box_dismissed_at, activityDismissedAt: row.activity_dismissed_at,
    ebayTaskId: row.ebay_task_id, csvRowCount: row.csv_row_count, attemptCount: row.attempt_count,
    errorCode: row.error_code, errorMessage: row.error_message,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
  };
}

export async function createEbayFeedBatch(ownerId: string, marketplaceDraftIds: string[], productDraftIds: string[], skus: string[]): Promise<{ batchId: string; displayNumber: number }> {
  const response = await supabaseRequest("rpc/listing_studio_create_ebay_feed_batch", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_marketplace_draft_ids: marketplaceDraftIds, p_product_draft_ids: productDraftIds, p_skus: skus }),
  });
  const [row] = await response.json() as { batch_id: string; display_number: number }[];
  return { batchId: row.batch_id, displayNumber: row.display_number };
}

export async function getEbayFeedBatch(ownerId: string, batchId: string): Promise<{ batch: EbayFeedBatchRecord; items: EbayFeedBatchItemRecord[] } | null> {
  const batches = await supabaseRequestAll<BatchRow>(`ebay_feed_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&select=${BATCH_SELECT}`);
  const batch = batches[0];
  if (!batch) return null;
  const items = await supabaseRequestAll<ItemRow>(`ebay_feed_batch_items?batch_id=eq.${batchId}&select=${ITEM_SELECT}&order=queue_position.asc`);
  const productDraftIds = items.map(i => i.product_draft_id);
  const titles = productDraftIds.length
    ? await supabaseRequestAll<{ id: string; generated_title: string | null }>(`listing_drafts?id=in.(${productDraftIds.join(",")})&owner_id=eq.${ownerId}&select=id,generated_title`)
    : [];
  const titlesById = new Map(titles.map(t => [t.id, t]));
  return {
    batch: mapBatch(batch),
    items: items.map(item => ({
      id: item.id, batchId: item.batch_id, marketplaceDraftId: item.marketplace_draft_id, productDraftId: item.product_draft_id,
      queuePosition: item.queue_position, sku: item.sku, status: item.status,
      errorCode: item.error_code, errorMessage: item.error_message,
      startedAt: item.started_at, completedAt: item.completed_at,
      generatedTitle: titlesById.get(item.product_draft_id)?.generated_title ?? null,
    })),
  };
}

const STUCK_AFTER_MINUTES = 15;

export type OwnerEbayFeedBatchSummary = {
  batchId: string; displayNumber: number; status: EbayFeedBatchStatus; listingCount: number;
  boxDismissedAt: string | null; createdAt: string;
};

export async function listOwnerEbayFeedBatches(ownerId: string): Promise<{ visible: OwnerEbayFeedBatchSummary[]; stuck: OwnerEbayFeedBatchSummary[] }> {
  const rows = await supabaseRequestAll<BatchRow>(`ebay_feed_batches?owner_id=eq.${ownerId}&select=${BATCH_SELECT}&order=created_at.desc`);
  const now = Date.now();
  const toSummary = (row: BatchRow): OwnerEbayFeedBatchSummary => ({
    batchId: row.id, displayNumber: row.display_number, status: row.status, listingCount: row.listing_count,
    boxDismissedAt: row.box_dismissed_at, createdAt: row.created_at,
  });
  const visible = rows.filter(row => row.box_dismissed_at === null).map(toSummary);
  const stuck = rows.filter(row => !isEbayFeedBatchStatusTerminal(row.status) && now - new Date(row.created_at).getTime() > STUCK_AFTER_MINUTES * 60_000).map(toSummary);
  return { visible, stuck };
}

export async function dismissEbayFeedBatch(ownerId: string, batchId: string, action: "dismiss_box" | "dismiss_activity"): Promise<void> {
  const nowIso = new Date().toISOString();
  if (action === "dismiss_box") {
    await supabaseRequest(`ebay_feed_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&box_dismissed_at=is.null`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ box_dismissed_at: nowIso, activity_dismissed_at: nowIso }),
    });
  } else {
    await supabaseRequest(`ebay_feed_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&activity_dismissed_at=is.null`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ activity_dismissed_at: nowIso }),
    });
  }
}

/** Cooperative cancel — genuinely different from the legacy per-item cancel
 * (see ebay-draft-batches.ts's own comment): because this pipeline is a
 * single serial batch-level task, only a batch that hasn't started
 * uploading yet (status still 'queued') can be cleanly cancelled locally.
 * Once eBay has actually been sent the file (creating_task or later),
 * there is no Feed API operation to abort a task in flight — the safest,
 * most honest thing this app can do is let it run to its own natural
 * completion and simply record that this was requested, never pretend a
 * remote task was stopped when it wasn't. */
export async function cancelEbayFeedBatch(ownerId: string, batchId: string): Promise<EbayFeedBatchStatus> {
  const batches = await supabaseRequestAll<{ id: string; status: EbayFeedBatchStatus }>(`ebay_feed_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&select=id,status`);
  const batch = batches[0];
  if (!batch) throw new Error("Batch not found.");
  if (isEbayFeedBatchStatusTerminal(batch.status)) return batch.status;
  if (batch.status !== "queued") return batch.status; // already past the point of local-only cancellation
  await supabaseRequest(`ebay_feed_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&status=eq.queued`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled", completed_at: new Date().toISOString() }),
  });
  await supabaseRequest(`ebay_feed_batch_items?batch_id=eq.${batchId}&status=eq.queued`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }),
  });
  return "cancelled";
}

// ---------------------------------------------------------------------
// Bulk eligibility resolution — mirrors ebay-draft-batches.ts's own
// resolveEbayDraftEligibilityForProducts exactly, using the Feed
// pipeline's own evaluateEbayFeedDraftEligibility (no policy/location
// checks — see that function's own header for why).

export type EbayFeedEligibilityByProduct = Map<string, { marketplaceDraftId: string | null; sku: string | null; eligible: boolean; reasons: string[] }>;

export async function resolveEbayFeedDraftEligibilityForProducts(ownerId: string, productDraftIds: string[]): Promise<EbayFeedEligibilityByProduct> {
  const result: EbayFeedEligibilityByProduct = new Map();
  if (productDraftIds.length === 0) return result;

  const [draftsByProduct, connection, skuRows, imageRows] = await Promise.all([
    listMarketplaceDraftsForProducts(ownerId, productDraftIds),
    getEbayConnection(ownerId),
    supabaseRequestAll<{ id: string; sku: string | null }>(`listing_drafts?id=in.(${productDraftIds.join(",")})&owner_id=eq.${ownerId}&select=id,sku`),
    supabaseRequestAll<{ draft_id: string }>(`listing_draft_images?draft_id=in.(${productDraftIds.join(",")})&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=draft_id`),
  ]);
  const skuByProduct = new Map(skuRows.map(r => [r.id, r.sku]));
  const photoCountByProduct = new Map<string, number>();
  for (const row of imageRows) photoCountByProduct.set(row.draft_id, (photoCountByProduct.get(row.draft_id) ?? 0) + 1);

  for (const productDraftId of productDraftIds) {
    const sku = skuByProduct.get(productDraftId) ?? null;
    const ebayDraft = (draftsByProduct.get(productDraftId) ?? []).find(d => d.marketplace === "EBAY_UK") ?? null;
    if (!ebayDraft) { result.set(productDraftId, { marketplaceDraftId: null, sku, eligible: false, reasons: ["No eBay preparation for this listing"] }); continue; }
    const evaluation = evaluateEbayFeedDraftEligibility({
      hasEbayPreparation: true,
      accountUsable: connection?.connectionStatus === "connected",
      alreadyHasFeedDraft: ebayDraft.ebayFeedDraftCreatedAt !== null,
      contentReady: ebayDraft.readiness.ready,
      hasValidPrice: ebayDraft.pricePence != null && ebayDraft.pricePence > 0,
      hasPhoto: (photoCountByProduct.get(productDraftId) ?? 0) > 0,
      hasSku: Boolean(sku),
      hasQuantity: ebayDraft.quantity != null,
      hasCategoryId: Boolean(ebayDraft.categoryId),
      conditionValue: ebayDraft.conditionValue,
    });
    result.set(productDraftId, { marketplaceDraftId: ebayDraft.id, sku, eligible: evaluation.eligible, reasons: evaluation.reasons });
  }
  return result;
}

// ---------------------------------------------------------------------
// PHASE 2/4 — pre-submission preview: exactly which values transfer to the
// Seller Hub draft, and which fields the real template structurally has no
// column for at all (so the user must complete them in Seller Hub
// themselves, after the draft exists). Every entry here is a FACT derived
// from this application's own confirmed data (the real template's exact 11
// headers — see template-contract.ts — and this product's own persisted
// photo/aspect counts), never an invented or approximate claim.

export type FeedDraftPreview = { fields: Record<string, string>; completeInSellerHub: string[] };

export async function buildFeedDraftPreviewForProduct(ownerId: string, productDraftId: string): Promise<FeedDraftPreview | { error: string }> {
  const draft = await getMarketplaceDraft(ownerId, productDraftId, "EBAY_UK");
  if (!draft) return { error: "No eBay preparation for this listing." };
  const skuRows = await supabaseRequestAll<{ id: string; sku: string | null }>(`listing_drafts?id=eq.${productDraftId}&owner_id=eq.${ownerId}&select=id,sku`);
  const sku = skuRows[0]?.sku ?? null;
  if (!sku) return { error: "Missing SKU." };

  const photoUrl = await prepareFeedPrimaryPhoto(ownerId, productDraftId);
  const totalPhotos = await supabaseRequestAll<{ id: string }>(`listing_draft_images?draft_id=eq.${productDraftId}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=id`);
  const aspects = flattenAspectsForFeedRow(draft.dynamicData);
  const multiValueAspectNames = Object.entries(draft.dynamicData)
    .filter(([name, entry]) => !name.startsWith("__") && entry && Array.isArray(entry.value) && entry.value.length > 1)
    .map(([name]) => name);

  const rowInput: FeedDraftRowInput = {
    sku, categoryId: draft.categoryId ?? "", title: draft.title ?? "",
    pricePence: draft.pricePence ?? 0, quantity: draft.quantity ?? 1,
    primaryPhotoUrl: photoUrl ?? "", conditionValue: draft.conditionValue, description: draft.description ?? "",
    aspects,
  };
  const preview = previewFeedDraftRow(rowInput);

  // FACTS, not guesses — see template-contract.ts's own BASE_HEADERS: this
  // real template has no column for business policies or a merchant
  // location at all (confirmed directly from the downloaded file's 11
  // headers, nothing to research or guess here), so these are ALWAYS
  // true, for every draft this pipeline ever creates.
  const completeInSellerHub: string[] = [
    "Shipping, returns, and payment policies (not part of this template — Seller Hub applies your account defaults, or you choose them when you publish)",
    "Inventory/warehouse location (not part of this template)",
  ];
  if (totalPhotos.length > 1) {
    completeInSellerHub.push(`${totalPhotos.length - 1} additional photo${totalPhotos.length - 1 === 1 ? "" : "s"} — only the main photo transfers (see this pipeline's own disclosed single-photo limitation)`);
  } else if (totalPhotos.length === 0) {
    completeInSellerHub.push("Photo — none could be verified as reachable; this draft will be blocked until one is");
  }
  if (multiValueAspectNames.length > 0) {
    completeInSellerHub.push(`Additional values for: ${multiValueAspectNames.join(", ")} — only the first value each transfers (see this pipeline's own disclosed limitation)`);
  }

  return { fields: preview, completeInSellerHub };
}

// ---------------------------------------------------------------------
// Persistent, resumable, batch-level processing.

export const PROCESS_TICK_BATCH_LIMIT = 1;
const CLAIM_LEASE_SECONDS = 120;
// eBay's own processing time for an uploaded Feed task is not documented
// as a fixed bound (confirmed not found in authoritative docs this
// session) — the signed photo URL(s) written into the CSV must therefore
// survive from upload until whenever eBay actually fetches them, not just
// the single synchronous call the legacy Inventory API pipeline needed
// (see ebay-draft-batches.ts's own EBAY_IMAGE_URL_LIFETIME_SECONDS
// comment for that different, shorter-lived case). A generous, disclosed
// margin is used here instead of a guessed short one, because a URL that
// expires before eBay fetches it would silently produce a draft with a
// broken photo.
const FEED_IMAGE_URL_LIFETIME_SECONDS = 3600;

type ClaimedBatchRow = { batch_id: string; status: EbayFeedBatchStatus; ebay_task_id: string | null; attempt_count: number; listing_count: number };

export async function claimEbayFeedBatches(ownerId: string, batchId: string | null, limit: number, claimedBy: string): Promise<ClaimedBatchRow[]> {
  const response = await supabaseRequest("rpc/listing_studio_claim_ebay_feed_batches", {
    method: "POST",
    body: JSON.stringify({ p_owner_id: ownerId, p_batch_id: batchId, p_limit: limit, p_claimed_by: claimedBy, p_lease_seconds: CLAIM_LEASE_SECONDS }),
  });
  return response.json() as Promise<ClaimedBatchRow[]>;
}

async function advanceBatch(batchId: string, claimedBy: string, status: EbayFeedBatchStatus, extra?: { ebayTaskId?: string; csvRowCount?: number; errorCode?: string; errorMessage?: string }): Promise<void> {
  await supabaseRequest("rpc/listing_studio_advance_ebay_feed_batch", {
    method: "POST",
    body: JSON.stringify({
      p_batch_id: batchId, p_claimed_by: claimedBy, p_status: status,
      p_ebay_task_id: extra?.ebayTaskId ?? null, p_csv_row_count: extra?.csvRowCount ?? null,
      p_error_code: extra?.errorCode ?? null, p_error_message: extra?.errorMessage ?? null,
      p_lease_seconds: CLAIM_LEASE_SECONDS,
    }),
  });
}

async function finishBatchItems(batchId: string, claimedBy: string, results: Array<{ sku: string; status: "succeeded" | "failed"; error_code: string | null; error_message: string | null }>): Promise<void> {
  await supabaseRequest("rpc/listing_studio_finish_ebay_feed_batch_items", {
    method: "POST",
    body: JSON.stringify({ p_batch_id: batchId, p_claimed_by: claimedBy, p_results: results }),
  });
}

async function markBatchFailed(batchId: string, claimedBy: string, code: string, message: string): Promise<void> {
  await advanceBatch(batchId, claimedBy, "failed", { errorCode: code, errorMessage: message });
}

/**
 * PHASE 6 (background processing — "respect Retry-After") — the one place
 * every stage's catch block routes a real eBay API error through. A 429
 * carrying eBay's own Retry-After hint (see feed-client.ts's own
 * retryAfterSeconds) is NEVER treated as a permanent batch failure — it
 * re-advances to the SAME status (releasing the claim, per
 * listing_studio_advance_ebay_feed_batch's own always-release design —
 * see supabase-ebay-feed-drafts.sql's own corrective-pass comment), so
 * the next tick (this app's own poll cadence, or the cron sweep) retries
 * the exact same stage fresh rather than abandoning the batch.
 *
 * DISCLOSED LIMITATION — this does not make the NEXT tick wait exactly
 * `retryAfterSeconds`; it only ensures a rate-limited attempt is retried
 * rather than permanently failed. A precise per-batch "not claimable
 * until timestamp X" delay would need its own schema column; the
 * existing claim/lease mechanism cannot express "delay the next claim"
 * without ALSO risking the "stuck between ticks" bug the always-release
 * design (see Phase 1's own audit) exists specifically to prevent. Every
 * OTHER (non-429) error still fails the batch normally, exactly as
 * before.
 */
async function handleStageError(batchId: string, claimedBy: string, error: unknown, fallbackCode: string, fallbackMessage: string): Promise<void> {
  const retryAfterSeconds = error && typeof error === "object" && "retryAfterSeconds" in error ? (error as { retryAfterSeconds: unknown }).retryAfterSeconds : null;
  if (typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    // Read the batch's own CURRENT status back so this stage is retried
    // from exactly where it was — never advances past a rate-limited step.
    const rows = await supabaseRequestAll<{ status: EbayFeedBatchStatus }>(`ebay_feed_batches?id=eq.${batchId}&select=status`);
    const currentStatus = rows[0]?.status;
    if (currentStatus) { await advanceBatch(batchId, claimedBy, currentStatus); return; }
  }
  await markBatchFailed(batchId, claimedBy, fallbackCode, error instanceof Error ? error.message : fallbackMessage);
}

/** Builds and verifies ONE reachable HTTPS photo URL for a product's first
 * (main) uploaded photo — this pipeline supports a single primary photo
 * per row (see csv-generator.ts's own header on why multi-photo support is
 * deliberately not implemented). Never returns a photo whose reachability
 * wasn't actually verified with a real HEAD request. */
async function prepareFeedPrimaryPhoto(ownerId: string, productDraftId: string): Promise<string | null> {
  const images = await supabaseRequestAll<{ id: string; storage_path: string }>(
    `listing_draft_images?draft_id=eq.${productDraftId}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=id,storage_path&order=sort_order.asc&limit=1`,
  );
  const image = images[0];
  if (!image) return null;
  try {
    const url = await createSignedDownloadUrl(LISTING_STUDIO_BUCKET, image.storage_path, FEED_IMAGE_URL_LIFETIME_SECONDS);
    const check = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(10_000) }).catch(() => null);
    return check && check.ok ? url : null;
  } catch (error) {
    if (error instanceof StorageBucketMissingError) throw error;
    return null;
  }
}

/** Flattens dynamic-data aspects to one value per name (a flat "C:Name"
 * CSV column can only hold one cell value) — only the FIRST value of a
 * multi-value aspect is used; the exact multi-value separator syntax for
 * this template's C: columns was not confirmed against authoritative
 * documentation this session (see csv-generator.ts's own disclosed-gap
 * convention), so this is a deliberate, disclosed simplification rather
 * than a guess at a separator that could corrupt the column. */
function flattenAspectsForFeedRow(dynamicData: MarketplaceDynamicData): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, entry] of Object.entries(dynamicData)) {
    if (name.startsWith("__")) continue;
    if (!entry || entry.value === null) continue;
    const first = Array.isArray(entry.value) ? entry.value[0] : entry.value;
    if (first) flat[name] = String(first);
  }
  return flat;
}

/** Rebuilds every item's FeedDraftRowInput plus the batch's own stable
 * aspect-column set, fresh from persisted data — used by BOTH
 * generating_csv (to validate) and uploading (to actually send), so the
 * two never need to share an in-memory value (see this file's own header).
 * Returns null (with the failure already persisted) if any item's data has
 * become unbuildable since the batch was created. */
async function buildFeedCsvForBatch(ownerId: string, batchId: string, claimedBy: string, items: ItemRow[]): Promise<{ csv: string; rowCount: number } | null> {
  const rowInputs: FeedDraftRowInput[] = [];
  const aspectNameSet = new Set<string>();
  for (const item of items) {
    const draft = await getMarketplaceDraft(ownerId, item.product_draft_id, "EBAY_UK");
    if (!draft) { await markBatchFailed(batchId, claimedBy, "draft_missing", "One of this batch's eBay preparations could not be found."); return null; }
    const photoUrl = await prepareFeedPrimaryPhoto(ownerId, item.product_draft_id);
    if (!photoUrl) { await markBatchFailed(batchId, claimedBy, "no_reachable_photo", `SKU ${item.sku}: no photo could be verified as reachable.`); return null; }
    const aspects = flattenAspectsForFeedRow(draft.dynamicData);
    for (const name of Object.keys(aspects)) aspectNameSet.add(name);
    rowInputs.push({
      sku: item.sku, categoryId: draft.categoryId ?? "", title: draft.title ?? "",
      pricePence: draft.pricePence ?? 0, quantity: draft.quantity ?? 1,
      primaryPhotoUrl: photoUrl, conditionValue: draft.conditionValue, description: draft.description ?? "",
      aspects,
    });
  }
  try {
    return generateFeedDraftCsv(rowInputs, [...aspectNameSet]);
  } catch (error) {
    await markBatchFailed(batchId, claimedBy, "csv_generation_error", error instanceof Error ? error.message : "This eBay draft file could not be built.");
    return null;
  }
}

/**
 * Advances exactly ONE already-claimed batch by exactly ONE pipeline
 * stage. Never loops across stages — the caller (runEbayFeedBatchProcessTick)
 * decides whether to call this again on a LATER tick.
 */
// CORRECTIVE PASS (audit point 12) — a crash between createFeedTask
// succeeding at eBay and this app persisting the returned task ID leaves
// the batch stuck in "creating_task" with no record of that real, now
// orphaned task; the next claim naturally re-enters "creating_task" and
// calls createFeedTask AGAIN. eBay's Feed API createTask has no documented
// idempotency key, so this exact race cannot be fully eliminated — but it
// CAN be bounded: attempt_count increments on every claim of this batch
// (see the claim RPC), so a batch that keeps crashing at the same point
// forever is cut off after a small number of tries instead of silently
// creating an unbounded number of orphaned tasks. This trades "possibly a
// few wasted orphaned tasks, then a visible, investigable failure" for
// "unlimited silent orphans" — a real, disclosed limitation, not a full
// fix (a full fix would require eBay providing an idempotency key, which
// is not documented as available for this call).
//
// Deliberately EXCLUDES "processing": that stage is a legitimate,
// expected-to-be-long-running poll loop (eBay's own processing time is
// undocumented — see FEED_IMAGE_URL_LIFETIME_SECONDS's own comment) that
// can genuinely need many ticks with no problem at all; attempt_count
// keeps climbing during normal polling too (it counts every claim, not
// every failure), so applying this cap there would kill a perfectly
// healthy batch that simply took a while. Every OTHER stage is a fast,
// should-resolve-in-one-try operation where repetition really does mean
// "this keeps failing", never "this is legitimately still working".
const MAX_BATCH_ATTEMPTS = 15;

async function advanceClaimedBatch(ownerId: string, claimedBatch: ClaimedBatchRow, claimedBy: string): Promise<void> {
  const batchId = claimedBatch.batch_id;
  if (claimedBatch.status !== "processing" && claimedBatch.attempt_count > MAX_BATCH_ATTEMPTS) {
    await markBatchFailed(batchId, claimedBy, "too_many_attempts", `This eBay draft upload failed repeatedly (${claimedBatch.attempt_count} attempts) and has been stopped — please review and try again as a fresh batch.`);
    return;
  }
  const items = await supabaseRequestAll<ItemRow>(`ebay_feed_batch_items?batch_id=eq.${batchId}&select=${ITEM_SELECT}&order=queue_position.asc`);

  switch (claimedBatch.status) {
    case "queued": {
      // Re-verify eligibility fresh for every item, no eBay call yet — a
      // listing that stopped being ready between batch creation and now
      // (content edited, photo removed, connection lost) must not proceed.
      const connection = await getEbayConnection(ownerId);
      for (const item of items) {
        const draft = await getMarketplaceDraft(ownerId, item.product_draft_id, "EBAY_UK");
        if (!draft) { await markBatchFailed(batchId, claimedBy, "draft_missing", "One of this batch's eBay preparations could not be found."); return; }
        const imageRows = await supabaseRequestAll<{ draft_id: string }>(`listing_draft_images?draft_id=eq.${item.product_draft_id}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=draft_id`);
        const evaluation = evaluateEbayFeedDraftEligibility({
          hasEbayPreparation: true,
          accountUsable: connection?.connectionStatus === "connected",
          alreadyHasFeedDraft: false, // already checked at batch-creation time; re-checking here would wrongly block a batch's own in-flight item
          contentReady: draft.readiness.ready,
          hasValidPrice: draft.pricePence != null && draft.pricePence > 0,
          hasPhoto: imageRows.length > 0,
          hasSku: Boolean(item.sku),
          hasQuantity: draft.quantity != null,
          hasCategoryId: Boolean(draft.categoryId),
          conditionValue: draft.conditionValue,
        });
        if (!evaluation.eligible) { await markBatchFailed(batchId, claimedBy, "not_eligible", `SKU ${item.sku}: ${evaluation.reasons.join("; ")}`); return; }
      }
      await advanceBatch(batchId, claimedBy, "generating_csv");
      return;
    }

    case "generating_csv": {
      // Built once here purely to validate it CAN be built (catching a
      // photo/condition/template problem as early as possible) — the
      // result is deliberately discarded; "uploading" rebuilds it fresh
      // rather than relying on this call's output (see file header).
      const built = await buildFeedCsvForBatch(ownerId, batchId, claimedBy, items);
      if (!built) return; // failure already persisted inside buildFeedCsvForBatch
      await advanceBatch(batchId, claimedBy, "creating_task", { csvRowCount: built.rowCount });
      return;
    }

    case "creating_task": {
      try {
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        const task = await createFeedTask(accessToken);
        await advanceBatch(batchId, claimedBy, "uploading", { ebayTaskId: task.taskId });
      } catch (error) {
        await handleStageError(batchId, claimedBy, error, "ebay_task_error", "The eBay upload task could not be created.");
      }
      return;
    }

    case "uploading": {
      if (!claimedBatch.ebay_task_id) { await markBatchFailed(batchId, claimedBy, "missing_task_id", "No eBay task was recorded to upload to."); return; }
      try {
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        // CORRECTIVE PASS (audit point 13) — check eBay's own authoritative
        // record of whether a file was ALREADY uploaded to this task before
        // ever uploading again. Protects a crash between a successful
        // uploadFeedFile call and this app persisting "uploading -> processing"
        // from causing a second file to be sent to the same task on retry —
        // this app has no idea whether the earlier attempt's upload actually
        // reached eBay or not, so it must ask eBay rather than assume either way.
        const alreadyUploaded = await feedTaskHasInputFile(accessToken, claimedBatch.ebay_task_id);
        if (!alreadyUploaded) {
          const built = await buildFeedCsvForBatch(ownerId, batchId, claimedBy, items);
          if (!built) return;
          await uploadFeedFile(accessToken, claimedBatch.ebay_task_id, built.csv);
        }
        await supabaseRequest(`ebay_feed_batch_items?batch_id=eq.${batchId}&status=eq.queued`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "uploaded" }) });
        await advanceBatch(batchId, claimedBy, "processing");
      } catch (error) {
        await handleStageError(batchId, claimedBy, error, "ebay_upload_error", "This eBay draft file could not be uploaded.");
      }
      return;
    }

    case "processing": {
      if (!claimedBatch.ebay_task_id) { await markBatchFailed(batchId, claimedBy, "missing_task_id", "No eBay task was recorded to check."); return; }
      try {
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        const task = await getFeedTask(accessToken, claimedBatch.ebay_task_id);
        if (!isTerminalFeedTaskStatus(task.status)) {
          // Still processing remotely — extend the lease without changing
          // status, so the next tick (from anywhere) polls again rather
          // than treating this as stuck.
          await advanceBatch(batchId, claimedBy, "processing");
          return;
        }
        await supabaseRequest(`ebay_feed_batch_items?batch_id=eq.${batchId}&status=eq.uploaded`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "awaiting_result" }) });
        await advanceBatch(batchId, claimedBy, "downloading_result");
      } catch (error) {
        await handleStageError(batchId, claimedBy, error, "ebay_task_poll_error", "This eBay upload's status could not be checked.");
      }
      return;
    }

    case "downloading_result": {
      // Downloaded once here purely to confirm the result is retrievable
      // — deliberately discarded; "parsing_result" re-downloads fresh
      // (see file header on why nothing is cached across a stage boundary).
      if (!claimedBatch.ebay_task_id) { await markBatchFailed(batchId, claimedBy, "missing_task_id", "No eBay task was recorded to download results for."); return; }
      try {
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        await getFeedResultFile(accessToken, claimedBatch.ebay_task_id);
        await advanceBatch(batchId, claimedBy, "parsing_result");
      } catch (error) {
        await handleStageError(batchId, claimedBy, error, "ebay_result_download_error", "This eBay upload's result file could not be downloaded.");
      }
      return;
    }

    case "parsing_result": {
      if (!claimedBatch.ebay_task_id) { await markBatchFailed(batchId, claimedBy, "missing_task_id", "No eBay task was recorded to download results for."); return; }
      try {
        const { accessToken } = await getValidEbayAccessToken(ownerId);
        const resultCsv = await getFeedResultFile(accessToken, claimedBatch.ebay_task_id);
        const parsed = parseFeedResultCsv(resultCsv);
        const bySku = new Map(parsed.rows.map(r => [r.sku, r]));
        const results = items.map(item => {
          const outcome = bySku.get(item.sku);
          return {
            sku: item.sku,
            status: (outcome?.ok ? "succeeded" : "failed") as "succeeded" | "failed",
            error_code: outcome?.ok ? null : "ebay_row_error",
            error_message: outcome?.ok ? null : (outcome?.message ?? "eBay did not report a result for this row."),
          };
        });
        await finishBatchItems(batchId, claimedBy, results);
        for (const result of results) {
          const item = items.find(i => i.sku === result.sku);
          if (!item) continue;
          if (result.status === "succeeded") {
            await patchMarketplaceDraft(ownerId, item.marketplace_draft_id, { ebay_feed_draft_created_at: new Date().toISOString(), ebay_feed_last_error: null });
          } else {
            await patchMarketplaceDraft(ownerId, item.marketplace_draft_id, { ebay_feed_last_error: result.error_message }).catch(() => {});
          }
        }
        const anyFailed = results.some(r => r.status === "failed");
        await advanceBatch(batchId, claimedBy, anyFailed ? "completed_with_errors" : "completed");
      } catch (error) {
        await handleStageError(batchId, claimedBy, error, "ebay_result_parse_error", "This eBay upload's result file could not be read.");
      }
      return;
    }

    default:
      // Terminal statuses are never claimable (the RPC's own WHERE clause
      // excludes them) — reaching here would mean a logic error elsewhere.
      return;
  }
}

// Only CREATED is confirmed non-terminal (see feed-client.ts's own
// FEED_TASK_TERMINAL_STATUSES comment on the incomplete vocabulary) — any
// status THIS APPLICATION recognises as terminal is treated as terminal;
// anything else (including a genuinely unrecognised future status) is
// treated as still in progress, fail-safe.
function isTerminalFeedTaskStatus(status: string): boolean {
  return status === "COMPLETED" || status === "COMPLETED_WITH_ERROR" || status === "FAILED" || status === "ABORTED";
}

export type FeedProcessTickResult = { claimedCount: number; batchStatus: EbayFeedBatchStatus | null; hasMoreWork: boolean };

export async function runEbayFeedBatchProcessTick(ownerId: string, batchId: string): Promise<FeedProcessTickResult> {
  const claimedBy = `feed-tick-${randomUUID()}`;
  const claimed = await claimEbayFeedBatches(ownerId, batchId, PROCESS_TICK_BATCH_LIMIT, claimedBy);

  if (claimed.length > 0) {
    await Promise.all(claimed.map(batch => advanceClaimedBatch(ownerId, batch, claimedBy).catch(async () => {
      await markBatchFailed(batch.batch_id, claimedBy, "unexpected_error", "An unexpected error occurred while creating this eBay draft.");
    })));
  }

  // CORRECTIVE PASS (audit point 2) — this read was previously missing
  // `owner_id=eq.${ownerId}`, meaning the returned batchStatus could (in a
  // future caller that doesn't pre-check ownership, e.g. a cron sweep
  // iterating many owners) leak another owner's batch status if a
  // mismatched ownerId/batchId pair were ever passed in. Every route that
  // calls this function today already re-checks ownership first via
  // getEbayFeedBatch, so this was not independently exploitable through
  // the current API surface — but this function's own contract is
  // "scoped to ownerId", and this read silently wasn't. Fixed to match
  // every other query in this file.
  const batches = await supabaseRequestAll<{ status: EbayFeedBatchStatus }>(`ebay_feed_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&select=status`);
  const batchStatus = batches[0]?.status ?? null;
  const hasMoreWork = batchStatus !== null && !isEbayFeedBatchStatusTerminal(batchStatus);
  return { claimedCount: claimed.length, batchStatus, hasMoreWork };
}
