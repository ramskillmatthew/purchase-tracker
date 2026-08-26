import { supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { prepareSinglePhoto, ExportPhotoError } from "@/lib/listing-studio/vinted-export-photos";
import { extensionCorsPreflight, extensionCorsJson, extensionSafeApiError, corsHeaders } from "@/lib/listing-studio/extension-cors";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string; expires_at: string; owner_id: string };
type ItemRow = { id: string; batch_id: string; draft_id: string };
type ImageRow = { id: string; storage_path: string; mime_type: string; sort_order: number };

/**
 * Milestone 7 (Chrome extension draft queue) — serves ONE photo, converted
 * exactly like the ZIP export (heic-convert, never resized), re-validated
 * against the bearer batch token on EVERY fetch — not merely a redirect to
 * a Storage signed URL, which would keep working even after the batch
 * finished/expired at the token layer as long as the URL's own separate
 * lifetime hadn't elapsed. Bytes are proxied here specifically because
 * HEIC conversion has to happen server-side; every other photo-serving
 * route in this app can safely redirect precisely because it never needs
 * to touch the bytes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ itemId: string; position: string }> }) {
  try {
    const { itemId, position: positionParam } = await params;
    if (!uuidSchema.safeParse(itemId).success) return extensionCorsJson(request, { error: "Invalid item id." }, 400);
    const position = Number.parseInt(positionParam, 10);
    if (!Number.isInteger(position) || position < 0) return extensionCorsJson(request, { error: "Invalid photo position." }, 400);

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
    if (batch.status !== "claimed" && batch.status !== "in_progress") return extensionCorsJson(request, { error: "This batch is no longer active." }, 409);

    const items = await supabaseRequestAll<ItemRow>(`vinted_extension_batch_items?id=eq.${itemId}&batch_id=eq.${batchId}&select=id,batch_id,draft_id`);
    const item = items[0];
    if (!item) return extensionCorsJson(request, { error: "This photo does not belong to the active batch." }, 404);

    const images = await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=eq.${item.draft_id}&owner_id=eq.${batch.owner_id}&upload_state=eq.uploaded&select=id,storage_path,mime_type,sort_order&order=sort_order.asc`,
    );
    const image = images[position];
    if (!image) return extensionCorsJson(request, { error: "Photo not found at this position." }, 404);

    let prepared;
    try {
      prepared = await prepareSinglePhoto({ imageId: image.id, storagePath: image.storage_path, mimeType: image.mime_type, fileSize: 0 }, position, LISTING_STUDIO_BUCKET);
    } catch (error) {
      if (error instanceof ExportPhotoError) return extensionCorsJson(request, { error: error.message }, 502);
      throw error;
    }

    return new Response(new Uint8Array(prepared.bytes), {
      status: 200,
      headers: {
        "Content-Type": prepared.contentType,
        "Cache-Control": "private, no-store",
        ...corsHeaders(request.headers.get("origin")),
      },
    });
  } catch (error) { return extensionSafeApiError(request, error, "Could not load this photo."); }
}
