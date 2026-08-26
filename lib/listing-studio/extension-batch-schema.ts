import { z } from "zod";

/**
 * Milestone 7 (Chrome extension draft queue) — pure, DB-free shape/limits
 * for the batch payload the extension receives, mirroring
 * vinted-export-schema.ts's own "pure half" convention exactly. Field
 * names deliberately match the export schema 1:1 wherever the same real
 * data is meant (title/description/brand/model/productType/condition/
 * ukSize/audience/colours/materials/price fields/vintedCategoryId/
 * vintedCategoryPath) — the "reuse the existing validated export schema"
 * instruction, applied as shared field naming/shape rather than literally
 * importing ExportedListing, since the photo representation is
 * fundamentally different (short-lived fetchable URLs here, ZIP-relative
 * paths there) and purchase price has no place in a Vinted form-fill
 * payload at all (deliberately omitted — least data exposure to the
 * extension).
 */

// Follow-up correction (photo origin-mismatch bug) — bumped from v1: the
// payload's per-photo `url` field (an ABSOLUTE URL built from
// NEXT_PUBLIC_APP_URL) is replaced by a RELATIVE `path`. The absolute-URL
// shape silently assumed the app's own build-time env var always matched
// whatever origin the extension was actually configured (and permitted)
// to talk to — it didn't, once the app happened to run on a different dev
// port than NEXT_PUBLIC_APP_URL named, and the extension hung waiting on
// a request to an origin nothing was ever listening in front of. A
// relative path removes that whole class of drift: the extension resolves
// it against its OWN configured App URL (see service-worker.js's
// resolvePhotoUrl), which is also the one origin its host_permissions and
// batch requests already use.
export const EXTENSION_BATCH_SCHEMA_VERSION = "vinted-extension-batch-v2";
export const MAX_EXTENSION_BATCH_LISTINGS = 5;

// Long enough for a user to read a pairing code off one screen and type it
// into the extension, short enough that a leaked/abandoned code is only
// ever a narrow window of risk. The batch (and the token issued for it)
// can never outlive this regardless of when it's claimed.
export const EXTENSION_BATCH_EXPIRY_SECONDS = 10 * 60;

/**
 * The ONLY shape a batch photo's `path` may ever take — anchored end to
 * end, so a match can contain no protocol, host, credentials, query
 * string, fragment, or (literal/encoded) ".." traversal; only the exact
 * `/api/extension/batch/photos/<item-uuid>/<position>` route. Mirrored
 * (hand-written, dependency-free) in
 * vinted-draft-queue-extension/service-worker.js's own PHOTO_PATH_PATTERN,
 * since that extension never imports app source directly.
 */
export const EXTENSION_PHOTO_PATH_PATTERN = /^\/api\/extension\/batch\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(0|[1-9][0-9]*)$/i;

/** Builds the one, canonical relative photo path for a batch item's photo — the single place this shape is ever constructed server-side, from already-validated values (a real item id, a non-negative position), never from user input. */
export function buildExtensionPhotoPath(itemId: string, position: number): string {
  return `/api/extension/batch/photos/${itemId}/${position}`;
}

const extensionBatchPhotoSchema = z.object({
  position: z.number().int().nonnegative(),
  path: z.string().regex(EXTENSION_PHOTO_PATH_PATTERN, "path must be a relative /api/extension/batch/photos/<itemId>/<position> route"),
  fileName: z.string().min(1),
}).strict();
export type ExtensionBatchPhoto = z.infer<typeof extensionBatchPhotoSchema>;

const extensionBatchItemSchema = z.object({
  itemId: z.string().uuid(),
  draftId: z.string().uuid(),
  queuePosition: z.number().int().nonnegative(),
  sku: z.string().nullable(),
  title: z.string().min(1),
  description: z.string().min(1),
  brand: z.string().min(1),
  model: z.string().nullable(),
  productType: z.string().min(1),
  condition: z.string().min(1),
  ukSize: z.string().nullable(),
  audience: z.string().min(1),
  colours: z.array(z.string()),
  materials: z.array(z.string()),
  pricePence: z.number().int().positive(),
  priceDisplay: z.string().min(1),
  vintedCategoryId: z.number().int().positive(),
  vintedCategoryPath: z.string().min(1),
  photos: z.array(extensionBatchPhotoSchema).min(1),
  coverPhotoPosition: z.number().int().nonnegative(),
}).strict();
export type ExtensionBatchItem = z.infer<typeof extensionBatchItemSchema>;

const extensionBatchPayloadSchema = z.object({
  schemaVersion: z.literal(EXTENSION_BATCH_SCHEMA_VERSION),
  batchId: z.string().uuid(),
  expiresAt: z.string().min(1),
  items: z.array(extensionBatchItemSchema).min(1).max(MAX_EXTENSION_BATCH_LISTINGS),
}).strict();
export type ExtensionBatchPayload = z.infer<typeof extensionBatchPayloadSchema>;

export function validateExtensionBatchItem(value: unknown): ExtensionBatchItem {
  return extensionBatchItemSchema.parse(value);
}
export function validateExtensionBatchPayload(value: unknown): ExtensionBatchPayload {
  return extensionBatchPayloadSchema.parse(value);
}

// Statuses the extension may report for one batch item — includes every
// value the item's queue_position/status column accepts server-side.
export const EXTENSION_BATCH_ITEM_STATUSES = ["queued", "preparing", "filling", "saving", "completed", "failed", "paused", "cancelled"] as const;
export type ExtensionBatchItemStatus = typeof EXTENSION_BATCH_ITEM_STATUSES[number];

const TERMINAL_ITEM_STATUSES: readonly ExtensionBatchItemStatus[] = ["completed", "failed", "cancelled"];
export function isTerminalItemStatus(status: ExtensionBatchItemStatus): boolean {
  return (TERMINAL_ITEM_STATUSES as string[]).includes(status);
}

// Listings Review redesign — currentStep/detail forward exactly what
// form-steps.js's report(status, { currentStep, detail }) already computes
// locally (step name / a short human-readable progress line), previously
// dropped by the extension's own postResultToApp. Free text, same trust
// level as errorCode/errorMessage below — never a token, URL, or secret.
export const itemResultRequestSchema = z.object({
  status: z.enum(EXTENSION_BATCH_ITEM_STATUSES),
  errorCode: z.string().max(100).nullable().optional(),
  errorMessage: z.string().max(500).nullable().optional(),
  vintedDraftId: z.string().max(200).nullable().optional(),
  currentStep: z.string().max(60).nullable().optional(),
  detail: z.string().max(200).nullable().optional(),
}).strict();
export type ItemResultRequest = z.infer<typeof itemResultRequestSchema>;

// Multi-batch support — a best-effort, safely-reportable display label
// only (e.g. "Chrome", "Brave", "Edge") — NEVER a security/identity
// boundary (that's the batch-scoped token alone, see
// extension-batch-tokens.ts). Purely cosmetic: which browser window a
// batch box/activity row is attributed to in the UI when more than one
// extension instance is paired across different batches at once.
export const claimRequestSchema = z.object({
  pairingCode: z.string().min(4).max(32),
  extensionId: z.string().max(100).optional(),
  extensionVersion: z.string().max(50).optional(),
  browserLabel: z.string().max(40).optional(),
}).strict();
