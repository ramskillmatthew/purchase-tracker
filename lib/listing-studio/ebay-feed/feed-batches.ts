import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { getMarketplaceDraft, patchMarketplaceDraft, listMarketplaceDraftsForProducts } from "@/lib/listing-studio/marketplace-drafts";
import { getEbayConnection, getValidEbayAccessToken } from "@/lib/ebay-account/client";
import { createFeedTask, uploadFeedFile, getFeedTask, getFeedResultFile, feedTaskHasInputFile } from "@/lib/ebay-account/feed-client";
import { generateFeedDraftCsv, previewFeedDraftRow, type FeedDraftRowInput } from "@/lib/listing-studio/ebay-feed/csv-generator";
import { assertTemplateContractCurrent } from "@/lib/listing-studio/ebay-feed/template-contract";
import { parseFeedResultCsv } from "@/lib/listing-studio/ebay-feed/feed-result-parser";
import { evaluateEbayFeedDraftEligibility } from "@/lib/listing-studio/ebay-feed/feed-draft-eligibility";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { createSignedDownloadUrl, StorageBucketMissingError } from "@/lib/listing-studio/storage-rest";
import type { MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";
import { isEbayFeedBatchStatusTerminal, computeEbayFeedBatchBlockingState, type EbayFeedItemStatus, type EbayFeedBatchStatus, type EbayFeedBatchBlockingState } from "@/lib/listing-studio/ebay-feed/feed-workflow-status";
import { resolveEbayFeedMarketplace } from "@/lib/listing-studio/ebay-feed/feed-marketplace-mapping";

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
  // Defence in depth (this task's own explicit safety requirement) — the
  // caller (the create route) already rejects an empty eligible set with
  // a 400 before ever reaching this function, and
  // rpc/listing_studio_create_ebay_feed_batch itself independently raises
  // NO_DRAFTS for an empty array. This third, redundant check exists so
  // this function's own contract never depends on either of those staying
  // correct — it fails loudly and immediately for any future caller.
  if (marketplaceDraftIds.length === 0) throw new Error("Cannot create a Seller Hub draft batch with zero listings.");
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
// PHASE 7 — deliberate retry of an already-failed batch, via the single
// atomic RPC (fifth real-submission audit — REQUIREMENT: replace the
// older two-step parent/child PATCH transition entirely, never retain it
// as a fallback, since keeping it would preserve exactly the
// non-atomic-across-two-requests risk this migration exists to remove).
// See supabase-ebay-feed-drafts-atomic-retry.sql's own
// listing_studio_retry_ebay_feed_batch for the full transaction contract
// (row-locked, owner-checked, status-checked, both tables updated inside
// ONE function call). This module never calls that RPC's SQL directly
// over a raw connection — it goes through supabaseRequest exactly like
// every other RPC in this file, i.e. the server's own service-role
// client; the browser has no path to this RPC at all (it only ever talks
// to this app's own /retry route, which calls this function).

export type EbayFeedRetryOutcome = { resumedFromTaskId: string | null; resumedStatus: EbayFeedBatchStatus };

type AtomicRetryRpcRow = { batch_id: string; status: string; attempt_count: number; ebay_task_id: string | null; listing_count: number };

/**
 * Retries the SAME batch row — never creates a new one — preserving
 * Batch #N's own identity, created_at, and running attempt_count exactly
 * (this corrective task's own explicit requirement: "preserve Batch 1
 * history", "preserve attempt count"; the RPC itself never writes
 * attempt_count at all — the claim RPC increments it exactly once per
 * real claim, so a retry followed by the next tick's own claim bumps it
 * exactly once, never twice).
 *
 * RECONCILIATION (this corrective task's own explicit requirement — "will
 * first reconcile whether a remote task exists... will not create another
 * task if an existing task already accepted the upload") happens HERE, in
 * application code, BEFORE the atomic RPC is ever called — a Postgres
 * function cannot itself make the real, read-only getFeedTask network
 * call this decision depends on:
 *   - No ebay_task_id was ever persisted (createTask itself failed, e.g.
 *     SKU 1644's real Batch #1) -> nothing remote exists; safe to restart
 *     the WHOLE pipeline fresh from "queued" (a full re-check of
 *     eligibility, a fresh CSV, a fresh createTask call).
 *   - A real ebay_task_id WAS persisted before this batch failed (it
 *     failed at a LATER stage — uploading/processing/downloading_result/
 *     parsing_result) -> this function calls the real, read-only
 *     getFeedTask to find out what eBay itself currently believes about
 *     that task, and resumes from the correct stage without ever calling
 *     createTask or uploadFeedFile again for it:
 *       - eBay reports the task terminal (COMPLETED/COMPLETED_WITH_ERROR/
 *         FAILED/ABORTED) -> resume at "downloading_result" (re-download
 *         and parse the real result, never re-upload).
 *       - eBay reports the task still in progress, OR the task can no
 *         longer be found/read at all -> resume at "processing" (poll
 *         again; never re-upload, never re-create).
 * Once that decision is made, the ACTUAL state transition (both the
 * parent row and its failed children, atomically, in one transaction) is
 * delegated entirely to the RPC — this function never writes to
 * ebay_feed_batches/ebay_feed_batch_items directly for this operation.
 *
 * Never retries a batch that isn't currently 'failed' — a
 * 'completed_with_errors' batch (some rows succeeded) needs its own,
 * different "create a fresh batch for just the failed rows" flow, not
 * built here; a 'completed'/'cancelled' batch has nothing to retry. This
 * pre-check is a fast, informative-error read; the RPC re-verifies the
 * SAME condition atomically under its own row lock regardless — the
 * pre-check can never be trusted alone to make this operation safe, only
 * to produce a specific, helpful error message before ever making the
 * getFeedTask call.
 */
export async function retryEbayFeedBatch(ownerId: string, batchId: string): Promise<EbayFeedRetryOutcome> {
  const batches = await supabaseRequestAll<{ id: string; status: EbayFeedBatchStatus; ebay_task_id: string | null }>(
    `ebay_feed_batches?id=eq.${batchId}&owner_id=eq.${ownerId}&select=id,status,ebay_task_id`,
  );
  const batch = batches[0];
  if (!batch) throw new Error("This Seller Hub draft batch could not be found.");
  if (batch.status !== "failed") throw new Error(`Only a failed Seller Hub draft batch can be retried (this one is currently "${batch.status}").`);

  let resumeStatus: EbayFeedBatchStatus;
  let resumedFromTaskId: string | null = null;

  if (!batch.ebay_task_id) {
    resumeStatus = "queued";
  } else {
    const { accessToken } = await getValidEbayAccessToken(ownerId);
    let remoteStatus: Awaited<ReturnType<typeof getFeedTask>> | null = null;
    try {
      remoteStatus = await getFeedTask(accessToken, batch.ebay_task_id);
    } catch {
      remoteStatus = null; // task genuinely unreachable/expired — treat like "still in progress" below: never re-create, just resume polling
    }
    resumeStatus = remoteStatus && isTerminalFeedTaskStatus(remoteStatus.status) ? "downloading_result" : "processing";
    resumedFromTaskId = batch.ebay_task_id;
  }

  const result = await callAtomicRetryRpc(ownerId, batchId, resumeStatus);
  if (!result) throw new Error("This batch was already retried (by another request) or is no longer failed.");
  return { resumedFromTaskId, resumedStatus: result.status as EbayFeedBatchStatus };
}

/**
 * The ONE call site for listing_studio_retry_ebay_feed_batch — a single
 * atomic transaction (row-locked, owner-checked, status-checked, parent
 * and child updated together) performed entirely inside Postgres. Never
 * falls back to a non-atomic PATCH sequence on any error: an RPC failure
 * (including a genuine NOT_RETRYABLE/BATCH_NOT_FOUND rejection) always
 * propagates as either `null` (a clean, expected rejection the caller
 * treats as "nothing to do") or a re-thrown Error (a genuinely unexpected
 * fault) — never silently retried through a different, non-atomic path.
 *
 * Returns null for the two rejection reasons that mean "there was
 * genuinely nothing valid to retry, not a system fault" — BATCH_NOT_FOUND
 * (owner/id mismatch, or the row is gone) and NOT_RETRYABLE (a concurrent
 * request already won the race, or the batch is no longer in a retryable
 * status) — mirroring this function's own previous contract exactly, so
 * every existing caller's error handling keeps working unchanged.
 */
async function callAtomicRetryRpc(ownerId: string, batchId: string, resumeStatus: EbayFeedBatchStatus): Promise<AtomicRetryRpcRow | null> {
  try {
    const response = await supabaseRequest("rpc/listing_studio_retry_ebay_feed_batch", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: ownerId, p_batch_id: batchId, p_resume_status: resumeStatus }),
    });
    const rows = await response.json() as AtomicRetryRpcRow[];
    return rows[0] ?? null;
  } catch (error) {
    if (error instanceof Error && /NOT_RETRYABLE|BATCH_NOT_FOUND/.test(error.message)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------
// PHASE 4 (third real-submission audit — historical data repair) — a
// server-only, owner-protected reconciliation operation for a
// PRE-EXISTING inconsistency this application's own OLDER code could
// produce (before markBatchFailed's own item-cascade fix existed): a
// batch whose PARENT already reached a terminal 'failed' status, with NO
// remote eBay task ever recorded (nothing reached eBay), whose CHILD
// item(s) are still sitting in queued/uploaded/awaiting_result because
// the failure that terminated the batch happened before this
// application ever wrote a per-item outcome for it.
//
// NO NEW SQL/RPC — deliberately follows this exact module's own
// established "plain, conditional REST PATCH" pattern (see
// cancelEbayFeedBatch above) — unlike retryEbayFeedBatch (which now goes
// through the single atomic listing_studio_retry_ebay_feed_batch RPC
// precisely because it changes a REAL, in-progress attempt's own state),
// this reconciliation only ever repairs a row that is ALREADY known
// stale/inconsistent, so a plain conditional PATCH is sufficient here. A
// single PATCH request's WHERE clause is
// evaluated atomically by Postgres against the CURRENT row set at
// execution time (never a stale snapshot from an earlier SELECT), which
// is exactly the concurrency-safety property this repair needs — no RPC
// is required to get it. (A dedicated RPC exists elsewhere in this file
// only where atomic "claim ownership from a specific claimed_by token"
// semantics are needed, which this repair has no reason to need — it
// never claims anything, and only ever transitions a row PostgREST's own
// WHERE clause still finds in the exact state it expects.)
export type FeedBatchReconciliationResult = { batchId: string; reconciledItemIds: string[]; alreadyConsistent: boolean };

/**
 * Deliberately conservative and GENERIC (never hardcoded to one batch
 * id, though `batchId` may be passed to scope a single owner-owned
 * batch):
 *   - Only ever considers a batch whose status is EXACTLY 'failed'
 *     (never completed_with_errors/cancelled/any in-progress status —
 *     see this file's own header on why those already keep their own
 *     items in sync through different, already-correct paths).
 *   - Only ever considers a batch whose ebay_task_id IS NULL — if a
 *     remote task was ever recorded, this repair refuses to touch it at
 *     all (Phase 3's own invariant: "when a remote task exists, reconcile
 *     it with eBay first, never blindly mark children failed" — see
 *     retryEbayFeedBatch's own getFeedTask-based reconciliation for that
 *     separate, different case).
 *   - Only ever changes an item whose status is still
 *     queued/uploaded/awaiting_result — an item already 'succeeded' or
 *     'cancelled' is never touched, matching finishBatchItems's own
 *     guard exactly.
 *   - Never touches the parent batch row (it is already correctly
 *     'failed' — there is nothing wrong with it).
 *   - Never increments attempt_count (the batch row, the only place that
 *     column exists, is never written here at all).
 *   - Never calls eBay — every write here is a local Supabase PATCH.
 *   - Idempotent — a batch with nothing left to fix is reported as
 *     `alreadyConsistent: true` and receives no PATCH at all; running
 *     this twice in a row is harmless.
 *   - Owner-scoped — every query is filtered by owner_id; a batchId
 *     belonging to a different owner simply matches nothing and is
 *     silently absent from the result (never an error that would leak
 *     whether that id exists at all).
 */
export async function reconcileInconsistentFailedFeedBatchItems(ownerId: string, batchId?: string): Promise<FeedBatchReconciliationResult[]> {
  const batchFilter = batchId ? `&id=eq.${batchId}` : "";
  const candidateBatches = await supabaseRequestAll<{ id: string; error_code: string | null; error_message: string | null }>(
    `ebay_feed_batches?owner_id=eq.${ownerId}&status=eq.failed&ebay_task_id=is.null${batchFilter}&select=id,error_code,error_message`,
  );
  const results: FeedBatchReconciliationResult[] = [];
  for (const batch of candidateBatches) {
    const inconsistentItems = await supabaseRequestAll<{ id: string }>(
      `ebay_feed_batch_items?batch_id=eq.${batch.id}&status=in.(queued,uploaded,awaiting_result)&select=id`,
    );
    if (inconsistentItems.length === 0) {
      results.push({ batchId: batch.id, reconciledItemIds: [], alreadyConsistent: true });
      continue;
    }
    await supabaseRequest(`ebay_feed_batch_items?batch_id=eq.${batch.id}&status=in.(queued,uploaded,awaiting_result)`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "failed",
        error_code: batch.error_code ?? "reconciled_after_parent_failure",
        error_message: batch.error_message ?? "This listing's Seller Hub draft attempt failed before eBay was ever contacted, but its local record was left inconsistent — reconciled automatically.",
        completed_at: new Date().toISOString(),
      }),
    });
    results.push({ batchId: batch.id, reconciledItemIds: inconsistentItems.map(i => i.id), alreadyConsistent: false });
  }
  return results;
}

// ---------------------------------------------------------------------
// Bulk eligibility resolution — mirrors ebay-draft-batches.ts's own
// resolveEbayDraftEligibilityForProducts exactly, using the Feed
// pipeline's own evaluateEbayFeedDraftEligibility (no policy/location
// checks — see that function's own header for why).

export type EbayFeedEligibilityByProduct = Map<string, { marketplaceDraftId: string | null; sku: string | null; eligible: boolean; reasons: string[] }>;

/**
 * CORRECTIVE PASS (duplicate-submission defect, Phase 6) — the single
 * place this pipeline resolves "does this marketplace draft currently have
 * an in-flight or unretried-failed Seller Hub Feed batch item", queried
 * fresh from ebay_feed_batch_items/ebay_feed_batches directly (never via
 * the listings-review page's own read RPC, which this synchronous
 * eligibility gate has no reason to depend on). Bulk-capable (accepts many
 * marketplace draft IDs in one round trip) so both the single-listing
 * preview builder and the multi-listing batch-creation eligibility check
 * can share it. Uses computeEbayFeedBatchBlockingState — the SAME pure
 * function the listings-review route and the client both use — so this
 * server-side gate, the read-only display, and the client's own mirrored
 * eligibility check can never disagree about what counts as "active" vs.
 * "failed".
 */
// CORRECTIVE PASS (third real-submission audit) — priority order when,
// defensively, more than one blocking row is ever found for the same
// marketplace draft: a genuinely still-in-flight submission always wins
// (nothing else could be more urgently "don't submit again"), then an
// inconsistent stale row (needs attention before Retry even makes
// sense), then an ordinary retryable failure.
const BLOCKING_STATE_PRIORITY: Record<EbayFeedBatchBlockingState["kind"], number> = {
  active: 3, needs_reconciliation: 2, failed: 1, none: 0,
};

async function resolveFeedBatchBlockingStates(marketplaceDraftIds: string[]): Promise<Map<string, EbayFeedBatchBlockingState>> {
  const result = new Map<string, EbayFeedBatchBlockingState>();
  if (marketplaceDraftIds.length === 0) return result;
  const items = await supabaseRequestAll<{ marketplace_draft_id: string; batch_id: string; status: EbayFeedItemStatus }>(
    `ebay_feed_batch_items?marketplace_draft_id=in.(${marketplaceDraftIds.join(",")})&status=in.(queued,uploaded,awaiting_result,failed)&select=marketplace_draft_id,batch_id,status`,
  );
  if (items.length === 0) return result;
  const batchIds = [...new Set(items.map(i => i.batch_id))];
  // CORRECTIVE PASS (third real-submission audit) — batch_status and
  // ebay_task_id are now fetched alongside display_number, so
  // computeEbayFeedBatchBlockingState can recognise a stale item under an
  // already-terminal parent as "needs_reconciliation" rather than
  // wrongly reporting it as still "active".
  const batches = await supabaseRequestAll<{ id: string; display_number: number; status: EbayFeedBatchStatus; ebay_task_id: string | null }>(
    `ebay_feed_batches?id=in.(${batchIds.join(",")})&select=id,display_number,status,ebay_task_id`,
  );
  const displayNumberByBatchId = new Map(batches.map(b => [b.id, b.display_number]));
  const batchById = new Map(batches.map(b => [b.id, b]));
  for (const item of items) {
    const batch = batchById.get(item.batch_id);
    const state = computeEbayFeedBatchBlockingState(
      { batch_id: item.batch_id, item_status: item.status, batch_status: batch?.status, ebay_task_id: batch?.ebay_task_id },
      displayNumberByBatchId,
    );
    if (state.kind === "none") continue;
    const existing = result.get(item.marketplace_draft_id);
    if (!existing || BLOCKING_STATE_PRIORITY[state.kind] > BLOCKING_STATE_PRIORITY[existing.kind]) {
      result.set(item.marketplace_draft_id, state);
    }
  }
  return result;
}

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

  const ebayDraftIds = productDraftIds
    .map(id => (draftsByProduct.get(id) ?? []).find(d => d.marketplace === "EBAY_UK")?.id)
    .filter((id): id is string => Boolean(id));
  const feedBatchStates = await resolveFeedBatchBlockingStates(ebayDraftIds);

  for (const productDraftId of productDraftIds) {
    const sku = skuByProduct.get(productDraftId) ?? null;
    const ebayDraft = (draftsByProduct.get(productDraftId) ?? []).find(d => d.marketplace === "EBAY_UK") ?? null;
    if (!ebayDraft) { result.set(productDraftId, { marketplaceDraftId: null, sku, eligible: false, reasons: ["No eBay preparation for this listing"] }); continue; }
    const evaluation = evaluateEbayFeedDraftEligibility({
      hasEbayPreparation: true,
      accountUsable: connection?.connectionStatus === "connected",
      alreadyHasFeedDraft: ebayDraft.ebayFeedDraftCreatedAt !== null,
      feedBatchState: feedBatchStates.get(ebayDraft.id) ?? { kind: "none" },
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

export type FeedDraftPreviewRow = { draftId: string; fields: Record<string, string>; completeInSellerHub: string[] };
export type FeedDraftPreviewResult =
  | { ok: true; row: FeedDraftPreviewRow }
  | { ok: false; reason: string };

/**
 * CORRECTIVE PASS (first live preview attempt blocked every listing,
 * including a fully-valid SKU 1644 — see this file's own prepareFeedPrimaryPhoto
 * comment for the actual root cause) — this function is now:
 *   1. Never throws. Every failure mode — missing draft, already-drafted,
 *      already in an active batch, any single ineligibility reason, a
 *      photo-preparation failure, a template problem — returns a precise
 *      `{ ok: false, reason }`, never an uncaught exception that would
 *      previously crash the WHOLE multi-listing preview request (see the
 *      route's own Promise.all) and surface only a generic
 *      "Could not build a preview" with zero rows for every listing, not
 *      just the one that actually failed.
 *   2. Reuses evaluateEbayFeedDraftEligibility — the EXACT SAME function
 *      the real batch-creation path uses — for every ordinary blocking
 *      reason (missing price/photo/SKU/category/quantity/condition/
 *      content-not-ready/account-not-connected), so preview and creation
 *      can never disagree about why a listing is blocked.
 *   3. Explicitly checks "already has a genuine Seller Hub draft" and
 *      "already in an active (non-terminal) Seller Hub batch" BEFORE
 *      building anything — the legacy Inventory API's own ebay_offer_id
 *      is never consulted for either check (see this function's own
 *      "legacy offer never blocks" test).
 */
export async function buildFeedDraftPreviewForProduct(ownerId: string, productDraftId: string): Promise<FeedDraftPreviewResult> {
  try {
    return await buildFeedDraftPreviewForProductInner(ownerId, productDraftId);
  } catch (error) {
    // The outer never-throws boundary — every EXPECTED failure mode is
    // already handled with a precise reason inside the inner function
    // below; this only ever catches a genuinely UNEXPECTED exception
    // (a real infrastructure fault, a bug). Even then, this function must
    // still resolve rather than reject: the route calls this once per
    // requested listing inside a Promise.all, and one listing's genuinely
    // unexpected failure must never blank out every other listing's own
    // valid preview (the corrective-pass bug this whole function exists
    // to fix). The real error is logged server-side (safe: an Error's own
    // message/name only, never a raw response body, header, or secret)
    // for investigation; the browser only ever sees the generic reason.
    console.error("[buildFeedDraftPreviewForProduct] unexpected failure", productDraftId, error instanceof Error ? error.message : error);
    return { ok: false, reason: "This listing's preview could not be built due to an unexpected error." };
  }
}

async function buildFeedDraftPreviewForProductInner(ownerId: string, productDraftId: string): Promise<FeedDraftPreviewResult> {
  try {
    assertTemplateContractCurrent();
  } catch {
    return { ok: false, reason: "The Seller Hub draft template is unavailable." };
  }

  const draft = await getMarketplaceDraft(ownerId, productDraftId, "EBAY_UK");
  if (!draft) return { ok: false, reason: "The selected eBay listing could not be found." };
  if (draft.ebayFeedDraftCreatedAt !== null) return { ok: false, reason: "A Seller Hub draft already exists for this listing." };

  // Active/failed batch check — a listing already queued/uploaded/
  // awaiting a result in a still-live batch must not be offered again, and
  // a listing whose most recent batch FAILED must not silently become a
  // brand-new "Create" with no context either (Phase 6's explicit
  // requirement — use Retry Seller Hub draft instead) — independently of
  // (and never via) the legacy ebay_offer_id column.
  const feedBatchState = (await resolveFeedBatchBlockingStates([draft.id])).get(draft.id) ?? { kind: "none" as const };
  // CORRECTIVE PASS (third real-submission audit) — checked before
  // "active" so a stale, inconsistent row is never misreported as still
  // genuinely working.
  if (feedBatchState.kind === "needs_reconciliation") return { ok: false, reason: `Seller Hub Batch #${feedBatchState.displayNumber}'s local record for this listing is inconsistent and needs reconciliation before it can be retried.` };
  if (feedBatchState.kind === "active") return { ok: false, reason: `The selected listing is already in Seller Hub Batch #${feedBatchState.displayNumber}.` };
  if (feedBatchState.kind === "failed") return { ok: false, reason: `Seller Hub Batch #${feedBatchState.displayNumber} failed for this listing — use Retry Seller Hub draft instead of Create.` };

  const [skuRows, connection, imageRows] = await Promise.all([
    supabaseRequestAll<{ id: string; sku: string | null }>(`listing_drafts?id=eq.${productDraftId}&owner_id=eq.${ownerId}&select=id,sku`),
    getEbayConnection(ownerId),
    supabaseRequestAll<{ id: string }>(`listing_draft_images?draft_id=eq.${productDraftId}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=id`),
  ]);
  const sku = skuRows[0]?.sku ?? null;

  const evaluation = evaluateEbayFeedDraftEligibility({
    hasEbayPreparation: true,
    accountUsable: connection?.connectionStatus === "connected",
    alreadyHasFeedDraft: false, // already checked distinctly above
    contentReady: draft.readiness.ready,
    hasValidPrice: draft.pricePence != null && draft.pricePence > 0,
    hasPhoto: imageRows.length > 0,
    hasSku: Boolean(sku),
    hasQuantity: draft.quantity != null,
    hasCategoryId: Boolean(draft.categoryId),
    conditionValue: draft.conditionValue,
  });
  if (!evaluation.eligible) return { ok: false, reason: evaluation.reasons.join("; ") };

  let photoUrl: string | null;
  try {
    photoUrl = await prepareFeedPrimaryPhoto(ownerId, productDraftId);
  } catch (error) {
    if (error instanceof StorageBucketMissingError) return { ok: false, reason: "Photo storage is not available right now." };
    return { ok: false, reason: "The primary photo could not be prepared." };
  }
  if (!photoUrl) return { ok: false, reason: "The primary photo could not be prepared — it may not be reachable right now." };

  const aspects = flattenAspectsForFeedRow(draft.dynamicData);
  const multiValueAspectNames = Object.entries(draft.dynamicData)
    .filter(([name, entry]) => !name.startsWith("__") && entry && Array.isArray(entry.value) && entry.value.length > 1)
    .map(([name]) => name);

  const rowInput: FeedDraftRowInput = {
    sku: sku!, categoryId: draft.categoryId!, title: draft.title ?? "",
    pricePence: draft.pricePence!, quantity: draft.quantity!,
    primaryPhotoUrl: photoUrl, conditionValue: draft.conditionValue, description: draft.description ?? "",
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
  if (imageRows.length > 1) {
    completeInSellerHub.push(`${imageRows.length - 1} additional photo${imageRows.length - 1 === 1 ? "" : "s"} — only the main photo transfers (see this pipeline's own disclosed single-photo limitation)`);
  }
  if (multiValueAspectNames.length > 0) {
    completeInSellerHub.push(`Additional values for: ${multiValueAspectNames.join(", ")} — only the first value each transfers (see this pipeline's own disclosed limitation)`);
  }

  return { ok: true, row: { draftId: productDraftId, fields: preview, completeInSellerHub } };
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

/**
 * CORRECTIVE PASS (duplicate-submission defect — Phase 6) — ROOT CAUSE of
 * "the item stayed 'queued' and the bulk 'Create 1 Seller Hub draft'
 * button stayed enabled even after Batch #1 had already failed": this
 * pipeline's own design (see this file's own header — items are only ever
 * individually written once a real per-row RESULT exists, via
 * finishBatchItems) means a batch that fails at any EARLY stage (queued,
 * generating_csv, creating_task, uploading, processing,
 * downloading_result — before a real per-row result file was ever
 * downloaded and parsed) previously left every one of its own items
 * frozen at 'queued'/'uploaded'/'awaiting_result' forever, even though the
 * BATCH itself was already terminal. Both this function's own caller
 * (advanceClaimedBatch's error paths) and every eligibility check that
 * asks "is this listing still blocked by an in-flight submission" relied
 * on ITEM status, not batch status — so a failed-before-any-real-result
 * batch's items kept silently reporting "still active" indefinitely.
 *
 * Fixed here, once, at the single choke point every early-stage failure
 * already routes through: whenever a batch is marked failed, every one of
 * its own items still sitting in a non-terminal status is now marked
 * 'failed' too, carrying the SAME error onto each item (mirrors
 * finishBatchItems's own per-item error_code/error_message shape, and
 * cancelEbayFeedBatch's own existing "sync item status to the batch
 * decision" pattern for the cancel case). An item already 'succeeded' or
 * 'cancelled' — impossible before any result file existed, but checked
 * defensively — is never touched; only queued/uploaded/awaiting_result
 * items are ever affected, exactly like finishBatchItems's own guard.
 */
async function markBatchFailed(batchId: string, claimedBy: string, code: string, message: string): Promise<void> {
  await advanceBatch(batchId, claimedBy, "failed", { errorCode: code, errorMessage: message });
  await supabaseRequest(`ebay_feed_batch_items?batch_id=eq.${batchId}&status=in.(queued,uploaded,awaiting_result)`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "failed", error_code: code, error_message: message, completed_at: new Date().toISOString() }),
  });
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
 * wasn't actually verified with a real HEAD request.
 *
 * CORRECTIVE PASS (first live preview attempt) — ROOT CAUSE of "Could not
 * build a preview for these listings" / 0 rows for EVERY listing,
 * including SKU 1644 despite having valid title/category/price/quantity/
 * 8 uploaded photos: this query used to pass `&limit=1` straight into
 * supabaseRequestAll(), which lib/supabase.ts's own established,
 * documented regression guard explicitly THROWS on — that function's
 * entire contract is "fetch every matching row via its own Range-based
 * pagination", which is inherently incompatible with a caller-supplied
 * `limit`. Every unit test for this function used a MOCKED
 * supabaseRequestAll (a bare vi.fn()), so the mock never exercised the
 * real guard — this was only ever going to surface against genuine
 * Supabase data, which is exactly what this first live attempt was. Fixed
 * by using supabaseRequest() directly for this bounded, top-1 query, the
 * exact pattern this codebase already uses everywhere else for a
 * `limit=1` lookup (see e.g. lib/investments/refresh.ts,
 * app/api/yahoo/index/route.ts) — never supabaseRequestAll for a bounded
 * result. This same bug would equally have broken the real batch
 * pipeline's own "generating_csv"/"uploading" stages the first time a
 * real submission was attempted — never actually reached, since preview
 * caught it first. */
async function prepareFeedPrimaryPhoto(ownerId: string, productDraftId: string): Promise<string | null> {
  const imagesResponse = await supabaseRequest(
    `listing_draft_images?draft_id=eq.${productDraftId}&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=id,storage_path&order=sort_order.asc&limit=1`,
  );
  const images = await imagesResponse.json() as Array<{ id: string; storage_path: string }>;
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
        // CORRECTIVE PASS (root cause of Batch #1's real failure — "The
        // X-EBAY-C-MARKETPLACE-ID header is missing or invalid.") — this
        // pipeline only ever creates EBAY_UK Feed tasks (see this file's
        // own "EBAY_UK" literals throughout); resolveEbayFeedMarketplace
        // is the one place that gets translated into eBay's own canonical
        // EBAY_GB MarketplaceIdEnum value for the actual request header.
        const { feedMarketplaceId } = resolveEbayFeedMarketplace("EBAY_UK");
        const task = await createFeedTask(accessToken, feedMarketplaceId);
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

// CORRECTIVE PASS (fourth real-submission audit — "Consider processing
// safe immediate stages within the same server request until reaching a
// genuine remote waiting state, while respecting request timeouts") —
// these are the LOCAL, fast, should-resolve-in-one-tick stages: no eBay
// call has any reason to still be pending between two consecutive ticks
// (unlike "processing", which genuinely waits on eBay's own undocumented
// processing time and could legitimately need many ticks over real
// minutes — see FEED_IMAGE_URL_LIFETIME_SECONDS's own comment). Driving
// only through these stages synchronously, never "processing" itself,
// keeps this bounded and avoids hammering eBay's own task-status
// endpoint.
// "downloading_result"/"parsing_result" are included too — once a batch
// has reached "processing" and eBay's own task status is confirmed
// terminal, downloading and parsing the result file are both one-shot,
// non-waiting operations (the result is definitively ready; nothing
// about them could still be "pending" the way createTask/upload/
// processing-poll genuinely can be). Only "processing" itself — which
// polls eBay's own undocumented, open-ended processing time — is excluded.
const FAST_LOCAL_BATCH_STAGES: ReadonlySet<EbayFeedBatchStatus> = new Set([
  "queued", "generating_csv", "creating_task", "uploading", "downloading_result", "parsing_result",
]);
const DRIVE_MAX_TICKS = 6;
const DRIVE_TIME_BUDGET_MS = 20_000;

/**
 * Calls runEbayFeedBatchProcessTick repeatedly — never just once — until
 * EITHER the batch reaches a genuine remote-waiting or terminal stage,
 * OR a bounded tick count / time budget is exhausted, whichever comes
 * first. Exists specifically so a newly created or newly retried batch
 * makes REAL progress within the same HTTP request/response cycle,
 * rather than sitting exactly where a single tick left it until the
 * browser's own 4-second poll loop happens to notice — the confirmed
 * root cause of a real batch appearing "stuck" for minutes after a
 * genuine, successful Retry (its single post-retry tick correctly
 * advanced it to 'generating_csv', fully claimable, but nothing called
 * runEbayFeedBatchProcessTick again until this fix).
 *
 * Its own failure must never fail the caller's already-succeeded
 * create/retry — every call site wraps this in its own `.catch(() => {})`
 * exactly as before, this function does not change that contract.
 */
export async function driveEbayFeedBatchTicks(ownerId: string, batchId: string): Promise<FeedProcessTickResult> {
  const deadline = Date.now() + DRIVE_TIME_BUDGET_MS;
  let result = await runEbayFeedBatchProcessTick(ownerId, batchId);
  let ticks = 1;
  while (
    result.hasMoreWork
    && result.batchStatus !== null
    && FAST_LOCAL_BATCH_STAGES.has(result.batchStatus)
    && ticks < DRIVE_MAX_TICKS
    && Date.now() < deadline
  ) {
    result = await runEbayFeedBatchProcessTick(ownerId, batchId);
    ticks += 1;
  }
  return result;
}
