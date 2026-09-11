import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { extensionCorsPreflight, extensionCorsJson, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; owner_id: string };

/**
 * eBay Seller Hub extension drafter — the extension-side (batch-token
 * authenticated) half of the user Cancel action (review requirement 7),
 * for the "Cancel this listing" control in the extension's own side
 * panel, where a 'waiting_for_review' operation is actually visible and
 * cancellable. The batch-scoped JWT can only ever address ITS OWN batch;
 * the owner is read from that batch's own row and passed to the SAME
 * service-role-only transactional RPC the owner-authenticated app route
 * uses (listing_studio_cancel_ebay_extension_batch) — one atomic
 * operation, parent + every live child (incl. waiting_for_review),
 * releasing the duplicate-lock. Never touches the listing, the legacy
 * offer, or the Feed batch (review requirement 8).
 */
export async function POST(request: Request) {
  try {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return extensionCorsJson(request, { error: "Missing batch token." }, 401);
    let batchId: string;
    try { ({ batchId } = await verifyBatchToken(token)); }
    catch (error) { if (error instanceof BatchTokenError) return extensionCorsJson(request, { error: error.message }, 401); throw error; }

    const batches = await supabaseRequestAll<BatchRow>(`ebay_extension_batches?id=eq.${batchId}&select=id,owner_id`);
    const batch = batches[0];
    if (!batch) return extensionCorsJson(request, { error: "Batch not found." }, 404);

    await supabaseRequest("rpc/listing_studio_cancel_ebay_extension_batch", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ p_owner_id: batch.owner_id, p_batch_id: batchId }),
    });

    return extensionCorsJson(request, { ok: true });
  } catch (error) { return extensionSafeApiError(request, error, "Could not cancel this eBay extension batch."); }
}
