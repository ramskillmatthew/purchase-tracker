import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { isBatchStatusNonterminal } from "@/lib/listing-studio/extension-batch-recovery";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string };

/**
 * Follow-up correction (orphaned extension batch recovery) — a bounded,
 * extension-reported heartbeat, distinct from every other extension-facing
 * route: those already touch last_extension_activity_at as a side effect
 * of doing real work (see the item-result route), but nothing previously
 * kept that timestamp fresh during a long stretch with no other activity —
 * most notably while an item is WAITING_FOR_MANUAL_RELOAD, which can
 * legitimately last minutes with no form-filling progress to report at
 * all. service-worker.js's own triggerTick() (the same ~1-minute
 * chrome.alarms cadence already used for the queue's own watchdog) calls
 * this once per tick whenever a batch is genuinely running — see that
 * function's own comment for why this is "bounded" (never more than once
 * per tick, never a tight poll loop).
 *
 * Deliberately writes NOTHING else and never advances any workflow state —
 * a no-op 200 for a batch that's already terminal (nothing left to keep
 * alive), never an error, since a heartbeat racing a batch's own
 * completion/cancellation is entirely expected and harmless.
 */
export async function POST(request: Request) {
  try {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return extensionCorsJson(request, { error: "Missing batch token." }, 401);

    let batchId: string;
    try {
      ({ batchId } = await verifyBatchToken(token));
    } catch (error) {
      if (error instanceof BatchTokenError) return extensionCorsJson(request, { error: error.message }, 401);
      throw error;
    }

    const batches = await supabaseRequestAll<BatchRow>(`vinted_extension_batches?id=eq.${batchId}&select=id,status`);
    const batch = batches[0];
    if (!batch) return extensionCorsJson(request, { error: "Batch not found." }, 404);

    if (isBatchStatusNonterminal(batch.status)) {
      await supabaseRequest(`vinted_extension_batches?id=eq.${batchId}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_extension_activity_at: new Date().toISOString() }),
      }).catch(() => {});
    }

    return extensionCorsJson(request, { ok: true });
  } catch (error) { return extensionSafeApiError(request, error, "Could not record extension activity."); }
}
