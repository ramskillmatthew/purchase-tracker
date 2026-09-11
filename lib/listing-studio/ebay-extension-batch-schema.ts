import { z } from "zod";

/**
 * eBay Seller Hub extension drafter — pure, DB-free shape/limits for the
 * batch payload the eBay-specific extension queue receives. Deliberately a
 * SEPARATE schema from extension-batch-schema.ts (Vinted's own), not a
 * shared/discriminated one — the task's own "eBay-specific queue type...
 * do not let eBay messages enter the Vinted processing path or vice versa"
 * requirement is easiest to prove true when it's true at the schema level,
 * not just in application code (see tests/ebay-extension-*.test.ts's own
 * structural checks).
 *
 * Field names mirror the eBay Seller Hub Feed template's own vocabulary
 * where the same real data is meant (lib/listing-studio/ebay-feed/ —
 * category/conditionId/itemSpecifics/policies), since that pipeline
 * already established the verified eBay-side field shapes this payload
 * needs. This is a DIFFERENT delivery mechanism (a live browser form-fill,
 * not an asynchronous CSV task) but the same underlying eBay data.
 */

export const EBAY_EXTENSION_BATCH_SCHEMA_VERSION = "ebay-extension-batch-v1";
// This milestone sends exactly one listing per batch — see
// supabase-ebay-extension-batches.sql's own matching listing_count check.
export const MAX_EBAY_EXTENSION_BATCH_LISTINGS = 1;

// LIFECYCLE FIX (stale-batch review) — three deliberately-separate
// lifetimes (see supabase-ebay-extension-batches.sql's own matching
// section for the full reasoning):
//
//   EBAY_EXTENSION_BATCH_EXPIRY_SECONDS — the PAIRING-CODE CLAIM window
//   only. Stored as ebay_extension_batches.expires_at; enforced ONLY at
//   the claim boundary. Once a batch is claimed, this value is never used
//   to expire or cancel it again.
export const EBAY_EXTENSION_BATCH_EXPIRY_SECONDS = 10 * 60;
//
//   EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS — the AUTHENTICATED
//   EXTENSION-SESSION lifetime: how long the batch-scoped JWT issued at
//   claim time stays valid, so the mechanical fill (which includes a
//   human-scale manual condition-selection wait — see
//   shared/ebay-form-steps.js) can genuinely outlast the short pairing
//   window. Deliberately independent of expires_at. The payload / photo /
//   result / heartbeat routes gate on this (a valid token + a
//   claimed/in_progress status), never on expires_at.
export const EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS = 4 * 60 * 60;
//
//   The ACTIVE POPULATED-FORM lifetime ('waiting_for_review') is
//   INDEFINITE — no constant, no timer. Released only by an explicit user
//   Cancel or (a later milestone) a confirmed save.

// Mirrors EXTENSION_PHOTO_PATH_PATTERN exactly, scoped to this feature's
// own route namespace so an eBay batch's photo path can never be replayed
// against the Vinted photo route or vice versa (or accepted as a lookalike
// by either extension's own resolvePhotoUrl-equivalent).
export const EBAY_EXTENSION_PHOTO_PATH_PATTERN = /^\/api\/extension\/ebay-batch\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(0|[1-9][0-9]*)$/i;

export function buildEbayExtensionPhotoPath(itemId: string, position: number): string {
  return `/api/extension/ebay-batch/photos/${itemId}/${position}`;
}

const ebayExtensionBatchPhotoSchema = z.object({
  position: z.number().int().nonnegative(),
  path: z.string().regex(EBAY_EXTENSION_PHOTO_PATH_PATTERN, "path must be a relative /api/extension/ebay-batch/photos/<itemId>/<position> route"),
  fileName: z.string().min(1),
}).strict();
export type EbayExtensionBatchPhoto = z.infer<typeof ebayExtensionBatchPhotoSchema>;

// One entry per eBay item specific this listing has a real value for.
// Deliberately name/value pairs (not a free-form record) so a malformed
// payload fails cleanly at parse time, matching every other array here.
const ebayExtensionItemSpecificSchema = z.object({
  name: z.string().min(1).max(65), // eBay's own Item Specific name length limit
  value: z.string().min(1).max(65),
}).strict();

const ebayExtensionPolicySchema = z.object({
  ebayPolicyId: z.string().min(1),
  name: z.string().min(1),
}).strict();

const ebayExtensionBatchItemSchema = z.object({
  // itemId here is the eBay extension batch item's OWN id (the queue
  // identity the extension reports progress/results against) — see
  // service-worker.js's own convention, mirrored from Vinted's.
  itemId: z.string().uuid(),
  // The local listing this came from — BOTH ids, since the eBay-specific
  // fields live on the marketplace draft row but photos/SKU/brand live on
  // the product draft row.
  marketplaceDraftId: z.string().uuid(),
  productDraftId: z.string().uuid(),
  queuePosition: z.number().int().nonnegative(),

  sku: z.string().min(1), // eBay's Custom label (SKU) field — required by this payload, unlike Vinted's nullable sku
  marketplace: z.literal("EBAY_UK"),

  title: z.string().min(1).max(80), // eBay's own title length limit
  description: z.string().min(1),

  categoryId: z.string().min(1),
  categoryName: z.string().min(1),

  conditionValue: z.string().min(1), // e.g. "Used – Very Good" — the app's own display label
  conditionDescription: z.string().nullable(),

  brand: z.string().nullable(),
  size: z.string().nullable(),
  colour: z.string().nullable(),
  itemSpecifics: z.array(ebayExtensionItemSpecificSchema),

  pricePence: z.number().int().positive(),
  priceDisplay: z.string().min(1),
  quantity: z.number().int().positive(),

  photos: z.array(ebayExtensionBatchPhotoSchema).min(1),

  // Policies are OPTIONAL at the payload level — eBay's own Seller Hub
  // create-listing form lets the seller assign them there, and a legacy,
  // unpublished Inventory API offer having previously stored these on the
  // marketplace draft row (see lib/listing-studio/marketplace-drafts.ts)
  // must never become a REQUIRED gate for sending to the extension (the
  // whole "never let the legacy offer block extension eligibility"
  // requirement, applied to its own side-effect data, not just its own id).
  fulfillmentPolicy: ebayExtensionPolicySchema.nullable(),
  returnPolicy: ebayExtensionPolicySchema.nullable(),
  paymentPolicy: ebayExtensionPolicySchema.nullable(),
}).strict();
export type EbayExtensionBatchItem = z.infer<typeof ebayExtensionBatchItemSchema>;

const ebayExtensionBatchPayloadSchema = z.object({
  schemaVersion: z.literal(EBAY_EXTENSION_BATCH_SCHEMA_VERSION),
  batchId: z.string().uuid(),
  expiresAt: z.string().min(1),
  items: z.array(ebayExtensionBatchItemSchema).min(1).max(MAX_EBAY_EXTENSION_BATCH_LISTINGS),
}).strict();
export type EbayExtensionBatchPayload = z.infer<typeof ebayExtensionBatchPayloadSchema>;

export function validateEbayExtensionBatchItem(value: unknown): EbayExtensionBatchItem {
  return ebayExtensionBatchItemSchema.parse(value);
}
export function validateEbayExtensionBatchPayload(value: unknown): EbayExtensionBatchPayload {
  return ebayExtensionBatchPayloadSchema.parse(value);
}

// Narrower than Vinted's item-status vocabulary — see
// supabase-ebay-extension-batches.sql's own comment: this milestone never
// clicks Save Draft, so 'saving'/'completed' do not exist yet.
export const EBAY_EXTENSION_BATCH_ITEM_STATUSES = ["queued", "preparing", "filling", "waiting_for_review", "failed", "cancelled"] as const;
export type EbayExtensionBatchItemStatus = typeof EBAY_EXTENSION_BATCH_ITEM_STATUSES[number];

const TERMINAL_ITEM_STATUSES: readonly EbayExtensionBatchItemStatus[] = ["waiting_for_review", "failed", "cancelled"];
/** Answers "has this ITEM stopped making automated progress" — used for UI/step-detail purposes (clearing a stale "Uploading photo…" line once nothing more will happen automatically). Deliberately NOT the same question as isEbayExtensionBatchClosingStatus below — see that function's own comment for why conflating the two was a real bug. */
export function isTerminalEbayExtensionItemStatus(status: EbayExtensionBatchItemStatus): boolean {
  return (TERMINAL_ITEM_STATUSES as string[]).includes(status);
}

// CORRECTIVE PASS (safety review — Defect 2's application-layer half) — a
// SEPARATE, narrower question from isTerminalEbayExtensionItemStatus above:
// "has this item's protection against a duplicate send genuinely ended".
// The original code used isTerminalEbayExtensionItemStatus (which includes
// 'waiting_for_review') to decide when to mark the PARENT BATCH
// 'completed' — but a batch marked 'completed' falls out of the create-
// batch RPC's own `b.status not in ('completed', ...)` conflict filter,
// which would have silently reopened the exact duplicate-send hole the
// database-level unique index and the RPC's own conflict check both exist
// to close. Only 'failed' and 'cancelled' genuinely end an item's
// protection — 'waiting_for_review' means a real, populated Seller Hub tab
// is still open and must keep blocking a second send until the operation
// is explicitly cancelled or (a later milestone) confirmed saved.
const BATCH_CLOSING_ITEM_STATUSES: readonly EbayExtensionBatchItemStatus[] = ["failed", "cancelled"];
export function isEbayExtensionBatchClosingItemStatus(status: EbayExtensionBatchItemStatus): boolean {
  return (BATCH_CLOSING_ITEM_STATUSES as string[]).includes(status);
}

// CORRECTIVE PASS 5 (state-transition guard review) — 'cancelled' is
// deliberately EXCLUDED from what a result report may claim. Explicit
// cancellation must continue through the dedicated
// listing_studio_cancel_ebay_extension_batch RPC only (see
// supabase-ebay-extension-batches.sql's own matching top comment) — this
// request schema must never become a second path to the same effect. A
// request carrying status: "cancelled" is rejected here, at the HTTP
// boundary, with a clean validation error, rather than reaching the RPC at
// all.
export const EBAY_EXTENSION_REPORTABLE_ITEM_STATUSES = ["queued", "preparing", "filling", "waiting_for_review", "failed"] as const;

export const ebayExtensionItemResultRequestSchema = z.object({
  status: z.enum(EBAY_EXTENSION_REPORTABLE_ITEM_STATUSES),
  errorCode: z.string().max(100).nullable().optional(),
  errorMessage: z.string().max(500).nullable().optional(),
  currentStep: z.string().max(60).nullable().optional(),
  detail: z.string().max(200).nullable().optional(),
  // Photo progress — how many of the total were requested/uploaded/failed
  // (Phase 5's own "report the exact number requested, uploaded and
  // failed" requirement), reported alongside a 'filling' status update.
  photosRequested: z.number().int().nonnegative().nullable().optional(),
  photosUploaded: z.number().int().nonnegative().nullable().optional(),
  photosFailed: z.number().int().nonnegative().nullable().optional(),
}).strict();
export type EbayExtensionItemResultRequest = z.infer<typeof ebayExtensionItemResultRequestSchema>;

export const ebayExtensionClaimRequestSchema = z.object({
  pairingCode: z.string().min(4).max(32),
  extensionId: z.string().max(100).optional(),
  extensionVersion: z.string().max(50).optional(),
  browserLabel: z.string().max(40).optional(),
}).strict();
