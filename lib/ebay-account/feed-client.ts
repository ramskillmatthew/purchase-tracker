import "server-only";
import { gunzipSync } from "node:zlib";
import { ebayApiBase, ebayEnvironment } from "@/lib/ebay-account/oauth";
import { assertAllowedFeedOperation, assertAllowedFeedAction, ONLY_ALLOWED_FEED_ACTION } from "@/lib/ebay-account/feed-allowlist";
import { parseEbayErrors, formatEbayErrorForUser, type SanitizedEbayError } from "@/lib/ebay-account/ebay-error";

/**
 * eBay Sell Feed API client — the ONLY mechanism in this codebase that can
 * produce a genuine, editable Seller Hub draft (Seller Hub → Listings →
 * Drafts), as opposed to lib/ebay-account/inventory-client.ts's Inventory
 * API objects, which are never visible in Seller Hub. See this repo's own
 * architecture notes: Trading API VerifyAddFixedPriceItem and the
 * LMS_VERIFY_* feed type both validate only and create nothing;
 * LMS_ADD_FIXED_PRICE_ITEM creates a real LIVE listing (wrong direction);
 * Inventory API createOffer creates an unpublished, API-only object,
 * invisible in Seller Hub (this app's old, retired mechanism). Only
 * FX_LISTING with Action=Draft, uploaded via this Feed API, produces the
 * thing the product spec actually requires.
 *
 * Every function here calls assertAllowedFeedOperation(...) with a
 * hardcoded string literal (never a caller-supplied name) before
 * constructing any request, mirroring inventory-client.ts's own
 * assertAllowedInventoryOperation gate exactly. There is no function here
 * (and no code path reachable from one) that can ever upload a row whose
 * Action is anything other than "Draft" — every CSV this app generates
 * already comes from lib/listing-studio/ebay-feed/csv-generator.ts, which
 * hardcodes ONLY_ALLOWED_ACTION, and uploadFeedFile below additionally
 * re-checks the CSV's own Action header value defensively before ever
 * sending it (see assertCsvOnlyContainsAllowedAction).
 *
 * PRODUCTION-ONLY, confirmed via eBay's own published documentation this
 * session: the Feed API does not support FX_LISTING/FX_FULFILLMENT
 * uploads in the Sandbox environment. Rather than let a sandbox-configured
 * connection make a call that would merely fail with a confusing remote
 * error, every function here refuses up front (assertProductionOnly) with
 * an honest, specific message.
 */

function assertProductionOnly(): void {
  if (ebayEnvironment() === "SANDBOX") {
    throw new Error("The eBay Sell Feed API does not support Seller Hub draft uploads in the Sandbox environment — this requires a PRODUCTION eBay connection.");
  }
}

/** Defence in depth, independent of csv-generator.ts's own guarantees: a
 * CSV about to be uploaded is re-parsed here just far enough to read the
 * Action column of its first data row and confirm it is exactly "Draft" —
 * never trusts that an upstream caller validated it correctly. This is a
 * cheap, deliberately minimal check (first line's first cell only), not a
 * full re-validation of the file; full validation already happened when
 * the file was generated. */
function assertCsvOnlyContainsAllowedAction(csv: string): void {
  const firstDataLine = csv.split(/\r\n|\n/).find((line, index) => index > 0 && line.trim().length > 0);
  if (!firstDataLine) throw new Error("Refusing to upload an empty eBay draft file.");
  const firstCell = firstDataLine.split(",")[0]?.replace(/^"|"$/g, "") ?? "";
  assertAllowedFeedAction(firstCell);
}

async function feedRequest(accessToken: string, method: "GET" | "POST", path: string, init?: { body?: BodyInit; contentType?: string; marketplaceId?: string }): Promise<Response> {
  assertProductionOnly();
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (init?.contentType) headers["Content-Type"] = init.contentType;
  // CORRECTIVE PASS (root cause of the first failed Seller Hub Feed
  // submission) — only ever set when a caller explicitly passes one.
  // Confirmed against eBay's own Sell Feed API documentation, per
  // operation, that X-EBAY-C-MARKETPLACE-ID is Required for createTask
  // and NOT documented as required (or even mentioned) for uploadFile,
  // getTask, getTasks, getResultFile, or getInputFile — so this is never
  // set unconditionally for every call. See createFeedTask below for the
  // one call site that actually passes marketplaceId.
  if (init?.marketplaceId) headers["X-EBAY-C-MARKETPLACE-ID"] = init.marketplaceId;
  let response: Response;
  try {
    response = await fetch(`${ebayApiBase("PRODUCTION")}${path}`, {
      method,
      headers,
      body: init?.body,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    const error = new Error("Could not reach eBay's Sell Feed API.") as Error & { cause?: unknown };
    error.cause = cause;
    throw error;
  }
  return response;
}

/** Mirrors inventory-client.ts's inventoryError exactly — never surfaces
 * eBay's raw response body, only a sanitised, length-bounded summary — plus
 * a Retry-After hint (in seconds) when eBay's own response header supplies
 * one, so a caller can back off correctly on a 429 instead of hammering. */
async function feedError(response: Response, fallbackMessage: string): Promise<Error & { status: number; ebayErrors: SanitizedEbayError[]; retryAfterSeconds: number | null }> {
  let ebayErrors: SanitizedEbayError[] = [];
  try {
    const body: unknown = await response.json();
    ebayErrors = parseEbayErrors(body);
  } catch { /* non-JSON or empty body — fall back to the generic message */ }
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
  const error = new Error(formatEbayErrorForUser(ebayErrors, fallbackMessage)) as Error & { status: number; ebayErrors: SanitizedEbayError[]; retryAfterSeconds: number | null };
  error.status = response.status;
  error.ebayErrors = ebayErrors;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

export type CreateFeedTaskResult = { taskId: string };

/** Creates one Feed API task for an FX_LISTING (Draft-only) upload. eBay's
 * documented response for this call is a 200/201 with an EMPTY body and the
 * new task's ID given only in the `Location` response header (e.g.
 * ".../sell/feed/v1/task/<taskId>") — this function reads the task ID from
 * that header and throws a clear, specific error if it is ever missing
 * rather than guessing at an undocumented body shape.
 *
 * CORRECTIVE PASS (root cause of the first failed Seller Hub Feed
 * submission — Batch #1 failed with "The X-EBAY-C-MARKETPLACE-ID header
 * is missing or invalid.") — `marketplaceId` is now a REQUIRED parameter
 * (never a guessed default), so this can never again be called without a
 * marketplace value the caller deliberately resolved (see
 * lib/listing-studio/ebay-feed/feed-marketplace-mapping.ts's own
 * resolveEbayFeedMarketplace — the caller, not this low-level client,
 * owns translating this application's internal "EBAY_UK" into eBay's own
 * canonical "EBAY_GB" MarketplaceIdEnum value, keeping this file decoupled
 * from lib/listing-studio's own marketplace vocabulary). Confirmed against
 * eBay's own documentation that this header is Required specifically for
 * createTask — see feedRequest's own comment for the full per-operation
 * matrix this app checked. */
export async function createFeedTask(accessToken: string, marketplaceId: string): Promise<CreateFeedTaskResult> {
  assertAllowedFeedOperation("createFeedTask");
  if (!marketplaceId) throw new Error("A marketplace ID is required to create an eBay Feed task.");
  const response = await feedRequest(accessToken, "POST", "/sell/feed/v1/task", {
    contentType: "application/json",
    marketplaceId,
    body: JSON.stringify({ schemaVersion: "1.0", feedType: "FX_LISTING" }),
  });
  if (!response.ok) throw await feedError(response, "eBay Feed task could not be created.");
  const location = response.headers.get("Location");
  const taskId = location?.split("/").filter(Boolean).pop();
  if (!taskId) throw new Error("eBay did not return a task ID for the new Feed task.");
  return { taskId };
}

/** Uploads the actual draft CSV to an already-created task. eBay requires
 * this as a multipart/form-data POST with the file as a single part named
 * "fileRequest" — no JSON metadata part is required for FX_LISTING (unlike
 * some other feed types). Content-Type (including the multipart boundary)
 * is left for `fetch`'s own FormData handling to set — it must NEVER be
 * set manually here, or the boundary eBay needs to parse the body would be
 * missing. Every CSV passed in must already have come from
 * lib/listing-studio/ebay-feed/csv-generator.ts's generateFeedDraftCsv —
 * this function re-checks the Action column defensively (see
 * assertCsvOnlyContainsAllowedAction) but does not re-validate the rest of
 * the file's structure. */
export async function uploadFeedFile(accessToken: string, taskId: string, csv: string): Promise<void> {
  assertAllowedFeedOperation("uploadFeedFile");
  if (!taskId || !/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new Error("Invalid eBay Feed task ID.");
  assertCsvOnlyContainsAllowedAction(csv);
  const form = new FormData();
  form.set("fileRequest", new Blob([csv], { type: "text/csv" }), `ebay-draft-upload-${taskId}.csv`);
  const response = await feedRequest(accessToken, "POST", `/sell/feed/v1/task/${encodeURIComponent(taskId)}/upload_file`, { body: form });
  if (!response.ok) throw await feedError(response, "eBay draft file could not be uploaded.");
}

/**
 * The full set of Feed API task status values is not exhaustively
 * confirmed against authoritative documentation this session — only
 * CREATED, COMPLETED, and COMPLETED_WITH_ERROR are directly confirmed.
 * Deliberately typed as a plain string (not a narrow union) so this
 * client never silently mis-categorises a real, valid status this app
 * simply hasn't seen documented yet. Callers must treat status as
 * "still in progress" unless it is one of the FEED_TASK_TERMINAL_STATUSES
 * below — fail-safe, never fail-open, exactly like every other
 * uncertain-vocabulary decision made this session.
 */
export const FEED_TASK_TERMINAL_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERROR", "FAILED", "ABORTED"] as const;

export type FeedTaskStatus = {
  taskId: string;
  feedType: string | null;
  status: string;
  creationDate: string | null;
  completionDate: string | null;
};

function parseFeedTaskBody(body: Record<string, unknown>): FeedTaskStatus {
  return {
    taskId: String(body.taskId ?? ""),
    feedType: typeof body.feedType === "string" ? body.feedType : null,
    status: typeof body.status === "string" ? body.status : "UNKNOWN",
    creationDate: typeof body.creationDate === "string" ? body.creationDate : null,
    completionDate: typeof body.completionDate === "string" ? body.completionDate : null,
  };
}

/** Read-only status poll for one task — used by the background processor to
 * discover when a task has left CREATED and reached a terminal status. */
export async function getFeedTask(accessToken: string, taskId: string): Promise<FeedTaskStatus> {
  assertAllowedFeedOperation("getFeedTask");
  if (!taskId || !/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new Error("Invalid eBay Feed task ID.");
  const response = await feedRequest(accessToken, "GET", `/sell/feed/v1/task/${encodeURIComponent(taskId)}`);
  if (!response.ok) throw await feedError(response, "eBay Feed task status could not be read.");
  const body = await response.json() as Record<string, unknown>;
  return parseFeedTaskBody(body);
}

/** Read-only — lists recent FX_LISTING tasks this connection created,
 * newest first, for crash-recovery reconciliation (Phase 7's requirement:
 * a background worker that crashed mid-poll must be able to discover a
 * task's real remote status again by task ID, never by guessing). Never
 * used to discover OTHER sellers' tasks — eBay itself scopes this to the
 * authenticated connection only. */
export async function getFeedTasks(accessToken: string, limit = 20): Promise<FeedTaskStatus[]> {
  assertAllowedFeedOperation("getFeedTasks");
  const boundedLimit = Math.min(Math.max(1, limit), 100);
  const response = await feedRequest(accessToken, "GET", `/sell/feed/v1/task?feed_type=FX_LISTING&limit=${boundedLimit}`);
  if (!response.ok) throw await feedError(response, "eBay Feed tasks could not be listed.");
  const body = await response.json() as { tasks?: Array<Record<string, unknown>> };
  return (body.tasks ?? []).map(parseFeedTaskBody);
}

const MAX_RESULT_FILE_BYTES = 20 * 1024 * 1024; // 20MB decompressed cap — defensive bound against a corrupt or hostile response, not a real expected size for a handful of draft rows.
// CORRECTIVE PASS (audit point 8) — the raw, POSSIBLY-COMPRESSED download
// itself must also be bounded, independently of MAX_RESULT_FILE_BYTES
// (which only bounds the DECOMPRESSED output). Before this fix,
// `response.arrayBuffer()` fully buffered the entire response body into
// memory with no size limit at all, before this function had any chance to
// even check whether it was gzipped — a corrupt or hostile response of
// unbounded size would be read to completion regardless. Slightly larger
// than the decompressed cap (compressed data is normally smaller than its
// decompressed form for real CSV-shaped content).
const MAX_RAW_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** Reads a Response body as a Buffer, aborting as soon as more than
 * `maxBytes` have been received rather than buffering an unbounded amount
 * first. Falls back to the simpler `arrayBuffer()` path only if the
 * runtime genuinely has no streaming body (defensive; every real fetch
 * Response in Node/edge does). */
async function readBoundedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.from(await response.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`eBay's Feed result file exceeded the ${maxBytes}-byte safety limit and was not fully downloaded.`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

/**
 * Downloads and returns the task's result file as plain text. eBay
 * compresses many Feed API result files server-side (Content-Type
 * application/gzip or similar) rather than relying on HTTP
 * Content-Encoding, which `fetch` would otherwise auto-decompress — this
 * was not confirmed one way or the other specifically for FX_LISTING
 * result files this session, so this function detects gzip by its actual
 * magic bytes (0x1f 0x8b) rather than trusting a header, and decompresses
 * only when those bytes are present; a genuinely plain-text CSV response
 * passes through unchanged either way. Bounded TWICE: the raw download
 * itself (MAX_RAW_DOWNLOAD_BYTES, streamed rather than buffered
 * unbounded) and the decompressed output (MAX_RESULT_FILE_BYTES) — see
 * readBoundedBuffer's own comment for why both bounds are needed.
 */
export async function getFeedResultFile(accessToken: string, taskId: string): Promise<string> {
  assertAllowedFeedOperation("getFeedResultFile");
  if (!taskId || !/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new Error("Invalid eBay Feed task ID.");
  const response = await feedRequest(accessToken, "GET", `/sell/feed/v1/task/${encodeURIComponent(taskId)}/download_result_file`);
  if (!response.ok) throw await feedError(response, "eBay Feed result file could not be downloaded.");
  const buffer = await readBoundedBuffer(response, MAX_RAW_DOWNLOAD_BYTES);
  const isGzip = buffer.length >= 2 && buffer.subarray(0, 2).equals(GZIP_MAGIC);
  if (!isGzip) return buffer.toString("utf-8");
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(buffer, { maxOutputLength: MAX_RESULT_FILE_BYTES });
  } catch (cause) {
    const error = new Error("eBay's Feed result file could not be decompressed.") as Error & { cause?: unknown };
    error.cause = cause;
    throw error;
  }
  return decompressed.toString("utf-8");
}

/** Read-only existence check for a task's already-uploaded input file —
 * the authoritative way to know "has a file already been uploaded to this
 * task" without re-uploading, used by the "uploading" pipeline stage to
 * avoid ever sending a second file to a task that already has one (audit
 * point 13: a crash between a successful upload and this app persisting
 * that fact must never cause a duplicate upload on retry). Returns true
 * for a 200 (a file exists), false for a 404 (no file uploaded yet); any
 * other non-2xx response is a real error, never silently treated as
 * either answer. */
export async function feedTaskHasInputFile(accessToken: string, taskId: string): Promise<boolean> {
  assertAllowedFeedOperation("getFeedInputFile");
  if (!taskId || !/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new Error("Invalid eBay Feed task ID.");
  const response = await feedRequest(accessToken, "GET", `/sell/feed/v1/task/${encodeURIComponent(taskId)}/download_input_file`);
  if (response.status === 404) return false;
  if (!response.ok) throw await feedError(response, "Could not check whether this eBay draft file was already uploaded.");
  // The body itself is never needed here — only whether one exists — but
  // it must still be drained (bounded) so the connection is released
  // cleanly rather than left half-read.
  await readBoundedBuffer(response, MAX_RAW_DOWNLOAD_BYTES).catch(() => {});
  return true;
}

/** Never used for a real network call — exists purely so a test can assert
 * which host a Feed API call would target, and that it is always the
 * production host regardless of EBAY_ENVIRONMENT, mirroring
 * inventory-client.ts's own inventoryApiHost export. */
export function feedApiHost(): string {
  return ebayApiBase("PRODUCTION");
}

export { ONLY_ALLOWED_FEED_ACTION };
