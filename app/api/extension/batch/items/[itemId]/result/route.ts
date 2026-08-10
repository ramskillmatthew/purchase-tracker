import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { itemResultRequestSchema, isTerminalItemStatus, type ExtensionBatchItemStatus } from "@/lib/listing-studio/extension-batch-schema";
import { extensionCorsPreflight, extensionCorsJson, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string; expires_at: string; owner_id: string };
type ItemRow = {
  id: string; batch_id: string; draft_id: string; status: ExtensionBatchItemStatus; attempt_count: number;
  vinted_draft_id: string | null; started_at: string | null;
};

/**
 * Milestone 7 (Chrome extension draft queue) — the extension reports every
 * step transition for ONE item through here. Bearer-token scoped to
 * exactly one batch, so this route can NEVER touch another owner's batch
 * or item — the item lookup itself is filtered by `batch_id=eq.<the
 * token's own batchId>`, not merely by itemId, so an itemId belonging to
 * a different batch (even one the same extension previously handled)
 * simply doesn't match and 404s.
 *
 * Duplicate-save protection: a "completed" report for an item that is
 * ALREADY completed with a recorded vinted_draft_id is treated as a safe,
 * idempotent no-op — the stored result is returned as-is, nothing is
 * re-written, and vinted_draft_created_at is never touched a second time.
 * This is what makes a content-script retry after an ambiguous network
 * response (it saved the draft, but never heard back) safe rather than a
 * risk of duplicate bookkeeping.
 */
export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const { itemId } = await params;
    if (!uuidSchema.safeParse(itemId).success) return extensionCorsJson(request, { error: "Invalid item id." }, 400);

    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return extensionCorsJson(request, { error: "Missing batch token." }, 401);
    let batchId: string;
    try {
      ({ batchId } = await verifyBatchToken(token));
    } catch (error) {
      if (error instanceof BatchTokenError) return extensionCorsJson(request, { error: error.message }, 401);
      throw error;
    }

    const batches = await supabaseRequestAll<BatchRow>(`vinted_extension_batches?id=eq.${batchId}&select=id,status,expires_at,owner_id`);
    const batch = batches[0];
    if (!batch) return extensionCorsJson(request, { error: "Batch not found." }, 404);
    if (new Date(batch.expires_at).getTime() <= Date.now()) return extensionCorsJson(request, { error: "This batch has expired." }, 410);
    if (batch.status === "cancelled" || batch.status === "completed" || batch.status === "expired") {
      return extensionCorsJson(request, { error: "This batch is no longer active." }, 409);
    }

    const items = await supabaseRequestAll<ItemRow>(
      `vinted_extension_batch_items?id=eq.${itemId}&batch_id=eq.${batchId}&select=id,batch_id,draft_id,status,attempt_count,vinted_draft_id,started_at`,
    );
    const item = items[0];
    if (!item) return extensionCorsJson(request, { error: "This item does not belong to the active batch." }, 404);

    const body = itemResultRequestSchema.parse(await request.json());

    // Idempotent no-op — see this route's own doc comment.
    if (body.status === "completed" && item.status === "completed" && item.vinted_draft_id) {
      return extensionCorsJson(request, { itemId: item.id, status: item.status, vintedDraftId: item.vinted_draft_id, duplicate: true });
    }

    const nowIso = new Date().toISOString();
    const patchBody: Record<string, unknown> = { status: body.status };
    if (body.status === "preparing") patchBody.attempt_count = item.attempt_count + 1;
    if (!item.started_at && body.status !== "queued") patchBody.started_at = nowIso;
    if (isTerminalItemStatus(body.status)) patchBody.completed_at = nowIso;
    patchBody.error_code = body.status === "failed" ? (body.errorCode ?? null) : null;
    patchBody.error_message = body.status === "failed" ? (body.errorMessage ?? null) : null;
    if (body.status === "completed" && body.vintedDraftId) patchBody.vinted_draft_id = body.vintedDraftId;

    await supabaseRequest(`vinted_extension_batch_items?id=eq.${itemId}&batch_id=eq.${batchId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patchBody),
    });

    // Only ever set once Vinted has authoritatively confirmed a draft
    // exists (a real vintedDraftId reported back) — never merely because
    // a "saving" step was reached. Scoped to this batch's own owner, same
    // as every other write in this route.
    if (body.status === "completed" && body.vintedDraftId) {
      await supabaseRequest(`listing_drafts?id=eq.${item.draft_id}&owner_id=eq.${batch.owner_id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ vinted_draft_created_at: nowIso }),
      }).catch(() => {});
    }

    // Batch-level completion: every item has reached a terminal status
    // (completed, failed, or cancelled) — success/failure detail lives on
    // the items themselves; this just means "nothing left to process".
    const allItems = await supabaseRequestAll<{ status: ExtensionBatchItemStatus }>(`vinted_extension_batch_items?batch_id=eq.${batchId}&select=status`);
    if (allItems.length > 0 && allItems.every(i => isTerminalItemStatus(i.status))) {
      await supabaseRequest(`vinted_extension_batches?id=eq.${batchId}&status=neq.completed`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "completed", completed_at: nowIso }),
      }).catch(() => {});
    }

    return extensionCorsJson(request, { itemId: item.id, status: body.status, vintedDraftId: body.vintedDraftId ?? null, duplicate: false });
  } catch (error) { return extensionSafeApiError(request, error, "Could not report this item's result."); }
}
