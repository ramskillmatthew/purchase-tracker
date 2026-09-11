import { supabaseRequest } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { ebayExtensionItemResultRequestSchema, type EbayExtensionBatchItemStatus } from "@/lib/listing-studio/ebay-extension-batch-schema";
import { extensionCorsPreflight, extensionCorsJson, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type RpcResultRow = { item_id: string; item_status: EbayExtensionBatchItemStatus; batch_status: string; applied: boolean; duplicate: boolean };

/**
 * eBay Seller Hub extension drafter — mirrors
 * app/api/extension/batch/items/[itemId]/result/route.ts's own structure,
 * scoped to ebay_extension_batch_items. REQUIREMENT (Phase 8): this
 * milestone never marks a "confirmed" draft (that column,
 * ebay_seller_hub_draft_confirmed_at, is never written here at all — only
 * a later, genuine Save Draft milestone would write it, and only from a
 * real observed eBay confirmation, never from a "waiting_for_review"
 * report).
 *
 * CORRECTIVE PASS 4 (cancellation race review) — this route used to read
 * the batch (plain SELECT, no lock) and later PATCH the item independently
 * — a result report racing a concurrent Cancel could read the batch while
 * still active, then overwrite an already-cancelled child back to a LIVE
 * status. All of that locking, the "only while claimed/in_progress",
 * "never change an already-cancelled child", and batch-auto-close logic
 * now lives inside the single transactional
 * listing_studio_report_ebay_extension_item_result RPC (see
 * supabase-ebay-extension-batches.sql's own top comment). This route is now
 * a THIN wrapper: verify the token, validate the body, call the RPC once,
 * map its outcome to a response. It never reads or writes
 * ebay_extension_batches / ebay_extension_batch_items directly any more.
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

    const body = ebayExtensionItemResultRequestSchema.parse(await request.json());

    let row: RpcResultRow | undefined;
    try {
      const rpcResponse = await supabaseRequest("rpc/listing_studio_report_ebay_extension_item_result", {
        method: "POST",
        body: JSON.stringify({
          p_batch_id: batchId,
          p_item_id: itemId,
          p_status: body.status,
          p_error_code: body.status === "failed" ? (body.errorCode ?? null) : null,
          p_error_message: body.status === "failed" ? (body.errorMessage ?? null) : null,
          p_current_step: body.currentStep ?? null,
          p_step_detail: body.detail ?? null,
        }),
      });
      [row] = await rpcResponse.json() as RpcResultRow[];
    } catch (error) {
      if (error instanceof Error && error.message.includes("BATCH_NOT_FOUND")) return extensionCorsJson(request, { error: "Batch not found." }, 404);
      if (error instanceof Error && error.message.includes("ITEM_NOT_FOUND")) return extensionCorsJson(request, { error: "This item does not belong to the active batch." }, 404);
      throw error;
    }

    if (!row) return extensionCorsJson(request, { error: "This item does not belong to the active batch." }, 404);

    // Always the item's OWN current status as the RPC left it — honest even
    // when the requested transition was refused (a concurrent Cancel, a
    // closed batch, or a same-status replay), never a lie that the
    // requested status applied when it didn't.
    return extensionCorsJson(request, { itemId: row.item_id, status: row.item_status, duplicate: row.duplicate });
  } catch (error) { return extensionSafeApiError(request, error, "Could not report this item's result."); }
}
