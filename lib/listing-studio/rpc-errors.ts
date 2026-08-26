/**
 * Classifies an error raised by one of the Milestone 2 grouping RPCs
 * (listing_studio_move_images / _reorder_images / _split_group /
 * _merge_groups — see supabase-listing-studio.sql) as a known, expected
 * conflict with a safe user-facing message, or null for anything
 * unrecognized. Mirrors lib/purchase-import/rpc-errors.ts's convention
 * exactly: only a recognized code is ever reported back to the user —
 * anything else must propagate so the request fails safely and visibly
 * (via safeApiError) instead of being silently absorbed.
 */
export const LISTING_STUDIO_RPC_ERRORS: Record<string, string> = {
  NO_IMAGES: "Select at least one photo.",
  TARGET_DRAFT_NOT_FOUND: "The destination group could not be found.",
  SOURCE_DRAFT_NOT_FOUND: "The source group could not be found.",
  DRAFT_NOT_FOUND: "This group could not be found.",
  IMAGE_NOT_FOUND_OR_NOT_OWNED: "One or more of these photos could not be found.",
  IMAGE_NOT_IN_SOURCE_DRAFT: "One or more of these photos are not in the group you're splitting.",
  IMAGE_SET_MISMATCH: "The photo order doesn't match this group's current photos — please refresh and try again.",
  CANNOT_MERGE_GROUP_INTO_ITSELF: "A group can't be merged into itself.",
  INVALID_MODE: "Choose how to handle this group's photos before deleting it.",
  CANNOT_MOVE_UNSORTED_TO_ITSELF: "The Unsorted group can't move its own photos into itself — delete its photos instead if you want to remove it.",
  // listing_studio_apply_boundary_session (automatic AI product grouping,
  // full-session apply) — NO_IMAGES, SOURCE_DRAFT_NOT_FOUND, and
  // IMAGE_NOT_IN_SOURCE_DRAFT above are reused as-is; only these two are new.
  NO_GROUPS: "There are no groups to create.",
  INVALID_GROUP_TITLE: "One of these groups is missing a name.",
};

export function classifyListingStudioRpcError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  for (const [code, userMessage] of Object.entries(LISTING_STUDIO_RPC_ERRORS)) {
    if (message.includes(code)) return userMessage;
  }
  return null;
}
