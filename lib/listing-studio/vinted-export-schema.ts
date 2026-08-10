import { z } from "zod";

/**
 * Milestone 7 (revised) — Vinted Draft Export. Pure, DB-free, no AI call:
 * everything here is plain data shaping/validation, exactly like
 * vinted-category-selection.ts's own "pure half" convention. The actual
 * network I/O (downloading photo bytes, building the ZIP) lives in
 * vinted-export-photos.ts and the export route itself — kept separate so
 * this schema/shape logic stays trivially unit-testable against plain
 * fixtures.
 *
 * This export produces a package for a HUMAN (or another assistant, e.g.
 * ChatGPT/Claude Cowork operating a real logged-in browser) to manually
 * transfer a listing into Vinted's own Create Listing form and save it as
 * a Vinted draft themselves. Nothing in this feature ever talks to
 * Vinted, publishes anything, or creates a Vinted draft automatically.
 */

// Bump whenever the exported JSON SHAPE changes in a way a consumer must
// know about (a field renamed/removed/retyped) — never edited in place, so
// a future browser-transfer tool can safely reject an incompatible
// package rather than silently misreading it.
export const EXPORT_SCHEMA_VERSION = "vinted-export-v1";
export const EXPORT_SOURCE_LABEL = "Trotters Attire Listing Studio";

// A ZIP export does real per-listing work the lighter bulk actions in this
// feature don't: downloading every one of the listing's own photos from
// Storage, HEIC-converting where needed, and assembling everything into
// one archive — comfortably more expensive per item than e.g. bulk
// category assignment (MAX_BULK_CATEGORY_ASSIGNMENT = 50, no photo I/O at
// all). 10 keeps one export request's total photo I/O/CPU work well within
// a Vercel serverless function's practical time/memory budget even at a
// generous photo count per listing (see MAX_EXPORT_PHOTOS_PER_LISTING).
export const MAX_EXPORT_LISTINGS_PER_BATCH = 10;

// Reuses the SAME per-listing photo ceiling already established for AI
// listing generation (MAX_GENERATION_IMAGES_PER_GROUP) — a real product
// group is normally well under this, and there is no reason export should
// allow more photos through than generation itself ever analysed.
export const MAX_EXPORT_PHOTOS_PER_LISTING = 40;

// Total combined ORIGINAL photo bytes for one export request, checked
// BEFORE any photo is downloaded — fails fast and cheaply rather than
// starting a large download/conversion/zip run only to run out of the
// serverless function's memory partway through. 150MB comfortably covers
// MAX_EXPORT_LISTINGS_PER_BATCH (10) listings at a realistic photo count
// and size (e.g. 10 listings x 10 photos x ~1.5MB), with real margin below
// a default Vercel Node function's memory ceiling once ZIP/HEIC-decode
// working memory is accounted for too.
export const MAX_EXPORT_TOTAL_BYTES = 150 * 1024 * 1024;

const exportedListingSchema = z.object({
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  draftId: z.string().uuid(),
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
  purchasePricePence: z.number().int().nullable(),
  purchasePriceDisplay: z.string().nullable(),
  vintedCategoryId: z.number().int().positive(),
  vintedCategoryPath: z.string().min(1),
  photoFiles: z.array(z.string().min(1)).min(1),
}).strict();
export type ExportedListing = z.infer<typeof exportedListingSchema>;

const exportManifestSchema = z.object({
  exportSchemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  exportId: z.string().min(1),
  createdAt: z.string().min(1),
  listingCount: z.number().int().nonnegative(),
  source: z.literal(EXPORT_SOURCE_LABEL),
  listings: z.array(exportedListingSchema),
}).strict();
export type ExportManifest = z.infer<typeof exportManifestSchema>;

/** Re-validates an already-built listing entry against the exact export contract — a defensive belt-and-braces check right before writing bytes, never trusted merely because this process itself built the object. */
export function validateExportedListing(value: unknown): ExportedListing {
  return exportedListingSchema.parse(value);
}

/** Re-validates a fully-built manifest the same way. */
export function validateExportManifest(value: unknown): ExportManifest {
  return exportManifestSchema.parse(value);
}

export function buildExportManifest(exportId: string, createdAt: string, listings: ExportedListing[]): ExportManifest {
  return {
    exportSchemaVersion: EXPORT_SCHEMA_VERSION,
    exportId, createdAt,
    listingCount: listings.length,
    source: EXPORT_SOURCE_LABEL,
    listings,
  };
}

// Windows reserved device names — real risk here specifically (unlike a
// generic cross-platform library), since this app's own primary user
// extracts these ZIPs on Windows. A folder/file literally named "CON" or
// "COM1" (case-insensitive, with or without an extension) cannot be
// created at all on Windows.
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Sanitises one path SEGMENT (a single folder or file name component, never
 * a full multi-segment path) for safe use inside the exported ZIP. Never
 * trusts an uploaded filename, a SKU, or any other user/AI-controlled text
 * as a path on its own: strips directory separators and traversal
 * sequences (so "../../etc" can never escape the products/ tree),
 * collapses to a safe charset, trims Windows-unsafe trailing dots/spaces,
 * caps length, and falls back to `fallback` if nothing safe survives.
 */
export function sanitizeExportPathSegment(value: string, fallback: string): string {
  const withoutSeparators = value.replace(/[\\/]/g, "-");
  const collapsed = withoutSeparators.replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
  // A single "." is fine (and common — e.g. "AA.1711"); a RUN of 2+ dots is
  // exactly the traversal shape ("..") this must never allow through, so
  // it's collapsed to one dot rather than treated as a safe character run.
  const withoutDotRuns = collapsed.replace(/\.{2,}/g, ".");
  const trimmedEdges = withoutDotRuns.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  const capped = trimmedEdges.slice(0, 60);
  if (!capped) return fallback;
  if (WINDOWS_RESERVED_NAMES.test(capped)) return `${fallback}-${capped}`;
  return capped;
}

/**
 * `{3-digit index}-{SKU}` (falling back to the draft id when the SKU is
 * missing) — the leading, always-unique positional index means two
 * listings in the SAME export that happen to share a SKU (or both lack
 * one) still get two genuinely distinct folders ("001-AA1711",
 * "002-AA1711"), never a silent collision/overwrite.
 */
export function buildProductFolderName(positionInBatch: number, sku: string | null, draftId: string): string {
  const index = String(positionInBatch + 1).padStart(3, "0");
  const rawSegment = sku?.trim() || draftId;
  return `${index}-${sanitizeExportPathSegment(rawSegment, draftId)}`;
}

// Vinted-supported formats this app can actually produce: JPEG/PNG/WEBP
// pass through unchanged; HEIC/HEIF is converted to JPEG (see
// vinted-export-photos.ts) using this app's existing, already-verified
// server-side HEIC decode path (lib/listing-studio/listing-generation-image-input.ts) —
// never a new/second conversion approach.
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The file extension a photo should have INSIDE the export, given its stored mime type and whether it was HEIC-converted — always "jpg" once converted, since the bytes themselves are then genuinely JPEG. */
export function extensionForExportedPhoto(mimeType: string, wasConverted: boolean): string {
  if (wasConverted) return "jpg";
  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? "jpg";
}

/** `{2-digit position}.{ext}` — 1-indexed, cover photo (sort_order 0) is always "01". */
export function buildPhotoFileName(positionInListing: number, extension: string): string {
  return `${String(positionInListing + 1).padStart(2, "0")}.${extension}`;
}

/** `YYYY-MM-DD-HHmm`, always UTC (a Vercel function's own clock/timezone is UTC — deterministic regardless of where this runs) — e.g. "2026-08-04-1430". */
export function formatExportFolderTimestamp(createdAtIso: string): string {
  const date = new Date(createdAtIso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

/** The one top-level folder name every export's ZIP contents live under — e.g. "vinted-drafts-2026-08-04-1430" — and (with ".zip" appended) the downloaded file's own name too, so extracting it reproduces exactly that folder. */
export function buildExportRootFolderName(createdAtIso: string): string {
  return `vinted-drafts-${formatExportFolderTimestamp(createdAtIso)}`;
}

export function buildExportReadmeText(listingCount: number): string {
  return [
    "This package contains approved Vinted listing drafts exported from Trotters Attire Listing Studio.",
    "",
    `It contains ${listingCount} product${listingCount === 1 ? "" : "s"}, one folder per product under products/.`,
    "",
    "Photos are already in their required order — the cover photo is always \"01\" in each product's photos/ folder.",
    "",
    "listing.json (inside each product folder) is the source of truth for that product. manifest.json at the top level lists every product in this package with the same data, for a tool that wants everything in one file.",
    "",
    "The intended action for each product is to fill in Vinted's Create Listing form with this exact data and SAVE IT AS A DRAFT. Nothing in this package should ever be published, listed publicly, or made live.",
    "",
    "If any required Vinted option (category, brand, size, colour, material, etc.) cannot be matched exactly on Vinted, STOP for that product and report it — never guess or silently substitute a close-enough option, and never invent or fill in a field that is missing here.",
    "",
    "Report success or failure against each product's draftId and SKU (folder name) once done.",
    "",
  ].join("\n");
}
