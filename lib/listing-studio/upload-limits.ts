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
