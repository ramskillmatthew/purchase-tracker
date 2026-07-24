/**
 * Classifies an error raised by calling rpc/import_purchase_order (see
 * supabase-purchase-import-v2.sql) as either a known, expected
 * candidate-state conflict, or something genuinely unexpected.
 *
 * Only a recognized conflict should ever be reported back as "this group
 * couldn't be imported right now" (a clear, distinct result — never lumped
 * in with ordinary already-imported/rejected "duplicates"). Anything else —
 * a missing migration/function, malformed input, a database outage, a
 * permission problem, or any other programming error — is NOT a duplicate
 * and must not be silently absorbed into a counter; the caller must rethrow
 * it so the whole request fails safely and visibly instead.
 */
export const KNOWN_RPC_CONFLICTS: Record<string, string> = {
  CANDIDATE_NOT_FOUND: "candidate_not_found",
  CANDIDATE_NOT_PENDING: "already_processed",
  CANDIDATE_MISSING_KEY: "missing_identity_key",
  POSSIBLE_DUPLICATE_ORDER: "possible_duplicate_order",
  INCOMPLETE_ORDER_SELECTION: "incomplete_selection",
  ORDER_TOTAL_MISMATCH: "order_total_mismatch",
  INCONSISTENT_ORDER_TOTAL: "inconsistent_order_total",
  INVALID_PRICE_PRECISION: "invalid_price_precision",
};

/** Returns the reason code for a known conflict, or null if the error is unrecognized (and must propagate). */
export function classifyRpcError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  for (const [code, reason] of Object.entries(KNOWN_RPC_CONFLICTS)) if (message.includes(code)) return reason;
  return null;
}
