import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { isBatchStatusNonterminal } from "@/lib/listing-studio/extension-batch-recovery";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string };

/** eBay Seller Hub extension drafter — mirrors app/api/extension/batch/heartbeat/route.ts exactly; isBatchStatusNonterminal is a pure status-string check, genuinely marketplace-agnostic, reused as-is. */
export async function POST(request: Request) {
  try {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return extensionCorsJson(request, { error: "Missing batch token." }, 401);
    let batchId: string;
    try { ({ batchId } = await verifyBatchToken(token)); }
    catch (error) { if (error instanceof BatchTokenError) return extensionCorsJson(request, { error: error.message }, 401); throw error; }

    const batches = await supabaseRequestAll<BatchRow>(`ebay_extension_batches?id=eq.${batchId}&select=id,status`);
    const batch = batches[0];
    if (!batch) return extensionCorsJson(request, { error: "Batch not found." }, 404);

    if (isBatchStatusNonterminal(batch.status)) {
      await supabaseRequest(`ebay_extension_batches?id=eq.${batchId}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_extension_activity_at: new Date().toISOString() }),
      }).catch(() => {});
    }

    return extensionCorsJson(request, { ok: true });
  } catch (error) { return extensionSafeApiError(request, error, "Could not record extension activity."); }
}
