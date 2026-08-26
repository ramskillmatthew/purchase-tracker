// Storage layout: listing-drafts/{ownerId}/{draftId}/{imageId}-{safeFilename}
// (see supabase-listing-studio.sql for the bucket itself). Milestone 2 will
// use these to (a) build the exact path a signed upload URL is restricted
// to, and (b) verify a confirmed upload's path genuinely belongs to the
// authenticated owner and draft before trusting it — user-supplied
// filenames are never used as, or trusted as, a real path on their own.

export const LISTING_STUDIO_BUCKET = "listing-drafts";

// Matches the same RFC 4122 shape zod's z.string().uuid() enforces
// elsewhere in this feature (version nibble 1-8, variant nibble 8/9/a/b) —
// both layers must agree on what counts as a valid id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Strips directory components and anything outside a safe charset so a
 * malicious filename (e.g. "../../etc/passwd", "..\\..\\x", embedded nulls)
 * can never influence the actual storage path — only the ownerId/draftId/
 * imageId segments (all real UUIDs) do that. Falls back to "image" if
 * nothing safe survives.
 */
export function sanitizeFilenameForStorage(originalFilename: string): string {
  const base = originalFilename.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "image";
}

export function buildDraftImageStoragePath(ownerId: string, draftId: string, imageId: string, originalFilename: string): string {
  return `${ownerId}/${draftId}/${imageId}-${sanitizeFilenameForStorage(originalFilename)}`;
}

export type ParsedDraftImagePath = { ownerId: string; draftId: string; imageId: string; filename: string };

// A UUID string is always exactly this long ("33333333-3333-4333-8333-333333333333").
// The imageId itself contains hyphens, so the boundary between it and the
// filename must be located by fixed length — indexOf("-") would incorrectly
// match the first hyphen inside the UUID rather than the real separator.
const UUID_STRING_LENGTH = 36;

/**
 * The inverse of buildDraftImageStoragePath — returns null for anything that
 * doesn't match the exact expected 3-segment, UUID-prefixed shape, which
 * rejects path traversal attempts (a "../" segment can never parse as a
 * valid UUID) without needing separate traversal-specific checks.
 */
export function parseDraftImageStoragePath(path: string): ParsedDraftImagePath | null {
  const segments = path.split("/");
  if (segments.length !== 3) return null;
  const [ownerId, draftId, imageAndFilename] = segments;
  if (imageAndFilename.length <= UUID_STRING_LENGTH || imageAndFilename[UUID_STRING_LENGTH] !== "-") return null;
  const imageId = imageAndFilename.slice(0, UUID_STRING_LENGTH);
  const filename = imageAndFilename.slice(UUID_STRING_LENGTH + 1);
  if (!isUuid(ownerId) || !isUuid(draftId) || !isUuid(imageId) || !filename) return null;
  return { ownerId, draftId, imageId, filename };
}

/**
 * The authorization check Milestone 2's upload-confirmation route must run
 * before trusting any client-reported storage path — rejects a path that
 * doesn't parse, or that parses but belongs to a different owner/draft.
 */
export function isPathOwnedBy(path: string, ownerId: string, draftId: string): boolean {
  const parsed = parseDraftImageStoragePath(path);
  return Boolean(parsed && parsed.ownerId === ownerId && parsed.draftId === draftId);
}
