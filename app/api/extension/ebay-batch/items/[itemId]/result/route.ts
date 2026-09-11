import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { ebayExtensionItemResultRequestSchema, isTerminalEbayExtensionItemStatus, isEbayExtensionBatchClosingItemStatus, type EbayExtensionBatchItemStatus } from "@/lib/listing-studio/ebay-extension-batch-schema";
import { extensionCorsPreflight, extensionCorsJson, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string; owner_id: string };
type ItemRow = { id: string; batch_id: string; status: EbayExtensionBatchItemStatus; attempt_count: number; started_at: string | null };

/**
 * eBay Seller Hub extension drafter — mirrors
 * app/api/extension/batch/items/[itemId]/result/route.ts's own structure,
 * scoped to ebay_extension_batch_items. REQUIREMENT (Phase 8): this
 * milestone never marks a "confirmed" draft (that column,
 * ebay_seller_hub_draft_confirmed_at, is never written here at all — only
 * a later, genuine Save Draft milestone would write it, and only from a
 * real observed eBay confirmation, never from a "waiting_for_review"
 * report).
 */
export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const { itemId } = await params;
    if (!uuidSchema.safeParse(itemId).success) return extensionCorsJson(request, { error: "Invalid item id." }, 400);

    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return extensionCorsJson(request, { error: "Missing batch token." }, 401);
    let batchId: string;
    try { ({ batchId } = await verifyBatchToken(token)); }
    catch (error) { if (error instanceof BatchTokenError) return extensionCorsJson(request, { error: error.message }, 401); throw error; }

    const batches = await supabaseRequestAll<BatchRow>(`ebay_extension_batches?id=eq.${batchId}&select=id,status,owner_id`);
    const batch = batches[0];
    if (!batch) return extensionCorsJson(request, { error: "Batch not found." }, 404);
    // LIFECYCLE FIX (stale-batch review) — not gated on expires_at (the
    // pairing-code window); the token's own exp + the batch status are the
    // check. A terminal batch (cancelled/completed/expired) still rejects
    // here so a late report can't resurrect it. See
    // app/api/extension/ebay-batch/route.ts's own matching comment.
    if (batch.status === "cancelled" || batch.status === "completed" || batch.status === "expired") {
      return extensionCorsJson(request, { error: "This batch is no longer active." }, 409);
    }

    const items = await supabaseRequestAll<ItemRow>(`ebay_extension_batch_items?id=eq.${itemId}&batch_id=eq.${batchId}&select=id,batch_id,status,attempt_count,started_at`);
    const item = items[0];
    if (!item) return extensionCorsJson(request, { error: "This item does not belong to the active batch." }, 404);

    const body = ebayExtensionItemResultRequestSchema.parse(await request.json());

    // Idempotent no-op — a repeated report for an item already terminal
    // with the SAME status changes nothing (mirrors the Vinted route's own
    // duplicate-completion protection, generalised to every terminal
    // status here since none of them carry a unique draft id to key off
    // yet in this milestone).
    if (isTerminalEbayExtensionItemStatus(item.status) && item.status === body.status) {
      return extensionCorsJson(request, { itemId: item.id, status: item.status, duplicate: true });
    }

    const nowIso = new Date().toISOString();
    await supabaseRequest(`ebay_extension_batches?status=neq.completed&id=eq.${batchId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_extension_activity_at: nowIso }),
    }).catch(() => {});

    const patchBody: Record<string, unknown> = { status: body.status };
    if (body.status === "preparing") patchBody.attempt_count = item.attempt_count + 1;
    if (!item.started_at && body.status !== "queued") patchBody.started_at = nowIso;
    if (isTerminalEbayExtensionItemStatus(body.status)) patchBody.completed_at = nowIso;
    patchBody.error_code = body.status === "failed" ? (body.errorCode ?? null) : null;
    patchBody.error_message = body.status === "failed" ? (body.errorMessage ?? null) : null;
    patchBody.current_step = isTerminalEbayExtensionItemStatus(body.status) ? null : (body.currentStep ?? null);
    patchBody.step_detail = isTerminalEbayExtensionItemStatus(body.status) ? null : (body.detail ?? null);

    await supabaseRequest(`ebay_extension_batch_items?id=eq.${itemId}&batch_id=eq.${batchId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patchBody),
    });

    // CORRECTIVE PASS (safety review, Defect 2's application-layer half) —
    // deliberately isEbayExtensionBatchClosingItemStatus here, NEVER
    // isTerminalEbayExtensionItemStatus (which includes
    // 'waiting_for_review'). Marking the batch 'completed' the moment an
    // item merely reaches waiting_for_review would flip it out of the
    // create-batch RPC's own `status not in ('completed', ...)` conflict
    // filter — silently reopening the duplicate-send hole this migration's
    // database-level unique index and conflict check both exist to close.
    // A batch only auto-closes once every item is genuinely failed/
    // cancelled; a waiting_for_review item keeps its batch open (and
    // therefore keeps blocking a second send) until the operation is
    // explicitly cancelled or (a later milestone) confirmed saved.
    const allItems = await supabaseRequestAll<{ status: EbayExtensionBatchItemStatus }>(`ebay_extension_batch_items?batch_id=eq.${batchId}&select=status`);
    if (allItems.length > 0 && allItems.every(i => isEbayExtensionBatchClosingItemStatus(i.status))) {
      await supabaseRequest(`ebay_extension_batches?id=eq.${batchId}&status=in.(pending_claim,claimed,in_progress)`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "completed", completed_at: nowIso }),
      }).catch(() => {});
    }

    return extensionCorsJson(request, { itemId: item.id, status: body.status, duplicate: false });
  } catch (error) { return extensionSafeApiError(request, error, "Could not report this item's result."); }
}
