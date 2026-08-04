/**
 * Classifies an error raised by public.vinted_categories_apply_refresh
 * (see supabase-listing-studio.sql) as a known, expected, retry-safe
 * rejection with a safe user-facing message, or null for anything
 * unrecognized. Mirrors lib/listing-studio/rpc-errors.ts's convention
 * exactly: only a recognized code is ever reported back to the user —
 * anything else must propagate so the request fails safely and visibly
 * (via safeApiError) instead of being silently absorbed. Every one of
 * these rejections means the transaction rolled back and the previous
 * catalogue was left untouched — the message says so wherever relevant.
 */
export const VINTED_CATEGORY_RPC_ERRORS: Record<string, string> = {
  INVALID_SOURCE_MARKET: "Vinted category source market was not configured correctly.",
  INVALID_SOURCE_TYPE: "Vinted category source type was not configured correctly.",
  INVALID_CATEGORIES_PAYLOAD: "Vinted's category catalogue could not be applied — its shape was unexpected. The previous catalogue was kept.",
  EMPTY_CATALOGUE_REJECTED: "Vinted returned an empty category catalogue, which was rejected. The previous catalogue was kept.",
  REFRESH_ALREADY_IN_PROGRESS: "A Vinted category refresh is already running. Please wait for it to finish before trying again.",
  INVALID_CATEGORY_ID: "Vinted's category catalogue contained an invalid category id. The previous catalogue was kept.",
  DUPLICATE_CATEGORY_ID_IN_PAYLOAD: "Vinted's category catalogue contained a conflicting duplicate id. The previous catalogue was kept.",
  SUSPICIOUS_CATALOGUE_SHRINKAGE: "The new Vinted category catalogue lost an unexpectedly large share of categories, so it was not applied. The previous catalogue was kept.",
};

export function classifyVintedCategoryRpcError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  for (const [code, userMessage] of Object.entries(VINTED_CATEGORY_RPC_ERRORS)) {
    if (message.includes(code)) return userMessage;
  }
  return null;
}
