import "server-only";
import { supabaseRequest } from "@/lib/supabase";
import type { DeletePurchasesResult } from "@/lib/types";

/**
 * Shared by every purchase-deletion path — single delete, bulk delete, and
 * Clear All (see app/api/purchases/route.ts and
 * app/api/purchases/bulk-delete/route.ts) — so they can never drift into
 * three different, inconsistent implementations. Calls
 * rpc/safe_delete_purchases (supabase-safe-purchase-deletion.sql) exactly
 * once per batch: one atomic transaction that locks and classifies every
 * requested purchase, nulls out only the safely-inactive sale_items
 * references on what's eligible, deletes exactly that eligible set, and
 * leaves every purchase linked to an active or completed sale untouched.
 */
export async function safeDeletePurchases(ids: string[]): Promise<DeletePurchasesResult> {
  const rpcResponse = await supabaseRequest("rpc/safe_delete_purchases", {
    method: "POST",
    body: JSON.stringify({ p_purchase_ids: ids }),
  });
  const [row] = await rpcResponse.json() as {
    requested_count: number;
    deleted_count: number;
    protected_count: number;
    protected_ids: string[] | null;
    missing_count: number;
  }[];
  return {
    requestedCount: row.requested_count,
    deletedCount: row.deleted_count,
    protectedCount: row.protected_count,
    protectedIds: row.protected_ids ?? [],
    missingCount: row.missing_count,
  };
}

// Mirrors the RPC's own per-call ceiling (see supabase-safe-purchase-deletion.sql's
// TOO_MANY_PURCHASES check) — Clear All can face many thousands of
// purchases, so it must never send them all in one RPC call. Splitting into
// bounded batches (rather than one unsafe unbounded delete statement, or
// silently hitting any API/RPC row limit) keeps every batch inside the same
// ceiling the RPC itself enforces.
export const DELETE_PURCHASES_BATCH_SIZE = 500;

function emptyResult(): DeletePurchasesResult {
  return { requestedCount: 0, deletedCount: 0, protectedCount: 0, protectedIds: [], missingCount: 0 };
}

/**
 * Deletes an arbitrarily large set of purchase ids safely, in bounded
 * batches of DELETE_PURCHASES_BATCH_SIZE, aggregating every batch's result
 * into one combined report — used by Clear All. Each batch is still its own
 * fully atomic safe_delete_purchases call; a failure partway through still
 * leaves every already-completed batch's deletions in place (there is no
 * single all-or-nothing transaction spanning batches — an unbounded single
 * transaction is exactly what this batching exists to avoid).
 */
export async function safeDeletePurchasesInBatches(ids: string[], batchSize = DELETE_PURCHASES_BATCH_SIZE): Promise<DeletePurchasesResult> {
  if (ids.length === 0) return emptyResult();
  const total: DeletePurchasesResult = emptyResult();
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const result = await safeDeletePurchases(batch);
    total.requestedCount += result.requestedCount;
    total.deletedCount += result.deletedCount;
    total.protectedCount += result.protectedCount;
    total.protectedIds.push(...result.protectedIds);
    total.missingCount += result.missingCount;
  }
  return total;
}

/** True when the whole request was rejected — nothing at all got deleted, and at least one requested purchase was protected. The API layer reports this as a 409 conflict, never a bare 200 with a zero count. */
export function isFullyProtectedResult(result: DeletePurchasesResult): boolean {
  return result.deletedCount === 0 && result.protectedCount > 0;
}

export const PURCHASE_PROTECTED_MESSAGE = "This purchase belongs to a completed sale. Cancel the sale before deleting the purchase.";
export const PURCHASES_PROTECTED_MESSAGE = "These purchases cannot be deleted because they belong to completed sales. Cancel the related sales first.";
