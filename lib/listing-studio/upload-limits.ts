// Central, configurable limits for the Listing Studio upload/grouping
// workspace (Milestone 2 spec §14). These are internal safety/performance
// limits chosen for full-resolution iPhone product photos (typically
// 2-8MB each as HEIC, 3-12MB as JPEG) — none of these are a Vinted
// requirement or limit of any kind.

// A single upload-session request can register at most this many files —
// keeps one signed-URL-minting request (and its DB inserts) bounded.
export const MAX_FILES_PER_SELECTION = 60;

// Across the whole Create workspace at once (all groups combined) —
// generous enough for a large multi-product photography batch without
// letting a workspace grow unbounded.
export const MAX_TOTAL_ACTIVE_UPLOAD_FILES = 300;

// A single file above this is rejected before a signed URL is even minted.
// 35MB comfortably covers a full-resolution iPhone HEIC/ProRAW-adjacent
// JPEG capture with margin, while still bounding worst-case storage/time.
export const MAX_INDIVIDUAL_FILE_SIZE_BYTES = 35 * 1024 * 1024;

// Total size of one upload-session request's files combined.
export const MAX_BATCH_SIZE_BYTES = 500 * 1024 * 1024;

// How long a signed upload URL remains valid before the browser must
// request a fresh one. Generous enough for a slow mobile upload of a large
// batch without leaving a URL exploitable indefinitely.
export const SIGNED_UPLOAD_URL_LIFETIME_SECONDS = 60 * 30;

// Signed VIEW (download) URLs are re-minted on every workspace page load,
// so a short lifetime is enough — just long enough for the browser to
// actually fetch the image, not for the URL to remain valid indefinitely.
export const SIGNED_VIEW_URL_LIFETIME_SECONDS = 60 * 5;

// Maximum number of product groups (listing_drafts rows in non-terminal
// status) a single workspace may hold at once — guards against runaway
// group creation.
export const MAX_GROUPS_IN_WORKSPACE = 100;

export const ACCEPTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;
export type AcceptedImageMimeType = typeof ACCEPTED_IMAGE_MIME_TYPES[number];

export function isAcceptedImageMimeType(mimeType: string): mimeType is AcceptedImageMimeType {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

// Automatic AI product grouping (Milestone 3): how many Unsorted photos ONE
// server request (one Claude call) analyses. Chosen against this route's
// own `maxDuration = 60` (matching the ceiling already used elsewhere for
// AI-calling routes — see app/api/vinted/sync/route.ts, app/api/assistant/route.ts):
// downloading/decoding/resizing 40 images with bounded concurrency plus one
// vision call comfortably fits inside 60s with real margin, whereas a much
// larger single request risks the model call alone taking long enough to
// blow the ceiling.
//
// A full "Auto-group products" click is NOT limited to this many photos,
// though — components/listing-studio/GroupingWorkspace.tsx slices the
// whole eligible Unsorted set (up to MAX_AUTO_GROUP_SESSION_SIZE) into
// chunks of this size and calls the ANALYZE route once per chunk
// automatically, in sequence, behind the one click. This keeps every
// individual HTTP request small and safely bounded while still processing
// a full multi-product photography session without the user ever clicking
// twice. Each chunk is only ANALYSED independently — see
// app/api/listing-studio/groups/auto-group/apply-session/route.ts, which
// reconciles every chunk's result together and applies the whole session
// in one all-or-nothing transaction only once every chunk is done, so a
// physical product can never be split across a chunk boundary and left
// half-applied.
export const MAX_AUTO_GROUP_BATCH_SIZE = 40;

// The target for one full "Auto-group products" click: roughly 30 products
// worth of photos in a typical session. At MAX_AUTO_GROUP_BATCH_SIZE this is
// ⌈250/40⌉ = 7 sequential chunk requests. If Unsorted holds more than this
// many eligible photos, only the oldest (by sort_order) are analysed this
// run; the remainder is simply picked up by clicking "Auto-group products"
// again.
export const MAX_AUTO_GROUP_SESSION_SIZE = 250;

// How many photos from the tail of the previous chunk are shown again,
// read-only, as context for the next chunk — enough for the model to judge
// whether the new chunk's first photo continues the same physical product
// across the chunk boundary (see AUTO_GROUP_SYSTEM_PROMPT's
// `continuesFromPreviousChunk` instructions) without meaningfully growing
// request size.
export const CHUNK_OVERLAP_SIZE = 5;

// Resize ceiling for photos sent to Claude for grouping analysis — grouping
// only needs enough visual detail to tell products apart, not fine label
// text (that's a later, per-product pass), so this can be well under
// Anthropic's own ~1568px-per-side internal limit to keep both the
// server's own processing and the request payload smaller. Never applied
// to the stored original — only to the copy built in-memory for this one
// API call (lib/listing-studio/auto-group-image-input.ts).
export const AUTO_GROUP_IMAGE_MAX_DIMENSION_PX = 1024;
export const AUTO_GROUP_IMAGE_JPEG_QUALITY = 78;

// See lib/listing-studio/client-image-processing.ts — HEIC/HEIF genuinely
// cannot be decoded server-side by this app's stack (verified live during
// Milestone 2: sharp's bundled libheif reads HEIC container metadata but
// has no HEVC codec plugin built in — "Support for this compression format
// has not been built in"), so these files get a client-side conversion
// attempt instead, purely for local preview; the original file is always
// what gets uploaded regardless of whether that attempt succeeds.
export const HEIC_MIME_TYPES = ["image/heic", "image/heif"] as const;

export function isHeicMimeType(mimeType: string): boolean {
  return (HEIC_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}
