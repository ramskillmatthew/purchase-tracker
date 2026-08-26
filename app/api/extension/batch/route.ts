import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import { getVintedCategoriesByIds } from "@/lib/listing-studio/vinted-categories-data";
import { normaliseFootwearVintedAudience, deriveDraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";
import { EXTENSION_BATCH_SCHEMA_VERSION, validateExtensionBatchPayload, buildExtensionPhotoPath, type ExtensionBatchItem } from "@/lib/listing-studio/extension-batch-schema";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string; expires_at: string; owner_id: string };
type ItemRow = { id: string; draft_id: string; queue_position: number; status: string };
type DraftRow = {
  id: string;
  brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null;
  uk_size: string | null; sku: string | null; condition: string | null;
  generated_title: string | null; generated_description: string | null;
  vinted_audience: VintedAudienceValue | null;
  vinted_category_id: number | null; vinted_category_path: string | null;
  confirmed_price_pence: number | null;
};
type ImageRow = { id: string; draft_id: string; mime_type: string; sort_order: number };

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg"; // JPEG, and every HEIC/HEIF source (always converted to jpg on delivery — see the photos route)
}

/**
 * Milestone 7 (Chrome extension draft queue) — returns the full, validated
 * batch payload for the ONE batch this bearer token is scoped to. Each
 * photo's `path` is a RELATIVE reference to this app's own
 * /api/extension/batch/photos/[itemId]/[position] route (bearer-token-gated
 * again there, independently, on every single fetch) rather than a raw
 * Supabase signed URL — genuinely "batch-restricted" access, not merely
 * "restricted at the moment this payload was issued".
 *
 * Follow-up correction (photo origin-mismatch bug): this used to return an
 * ABSOLUTE url built from NEXT_PUBLIC_APP_URL (`appOrigin()`, now removed).
 * That silently assumed this build-time env var always matched whichever
 * origin the extension was actually configured to talk to — it didn't
 * once the app happened to be running on a different dev port, and the
 * extension hung fetching a photo from an origin nothing was listening on.
 * A relative path has no origin to get wrong: the extension resolves it
 * against its OWN configured App URL (the same origin its batch/claim
 * requests already use) — see vinted-draft-queue-extension/service-worker.js's
 * resolvePhotoUrl. This route no longer reads NEXT_PUBLIC_APP_URL at all.
 *
 * The first successful fetch of a claimed batch's payload flips its
 * status from "claimed" to "in_progress" — a purely informational
 * transition for the owner's own polling UI; re-fetching the payload
 * again (e.g. after a service-worker restart) is always safe and returns
 * the exact same data.
 */
export async function GET(request: Request) {
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

    const batches = await supabaseRequestAll<BatchRow>(`vinted_extension_batches?id=eq.${batchId}&select=id,status,expires_at,owner_id`);
    const batch = batches[0];
    if (!batch) return extensionCorsJson(request, { error: "Batch not found." }, 404);
    if (new Date(batch.expires_at).getTime() <= Date.now()) return extensionCorsJson(request, { error: "This batch has expired." }, 410);
    if (batch.status !== "claimed" && batch.status !== "in_progress") {
      return extensionCorsJson(request, { error: `This batch is no longer active (${batch.status}).` }, 409);
    }

    const items = await supabaseRequestAll<ItemRow>(
      `vinted_extension_batch_items?batch_id=eq.${batchId}&select=id,draft_id,queue_position,status&order=queue_position.asc`,
    );
    const draftIds = items.map(i => i.draft_id);
    const drafts = draftIds.length ? await supabaseRequestAll<DraftRow>(
      `listing_drafts?id=in.(${draftIds.join(",")})&owner_id=eq.${batch.owner_id}`
      + `&select=id,brand,model,product_type,colours,material,uk_size,sku,condition,generated_title,generated_description,vinted_audience,vinted_category_id,vinted_category_path,confirmed_price_pence`,
    ) : [];
    const draftsById = new Map(drafts.map(d => [d.id, d]));

    const images = draftIds.length ? await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=in.(${draftIds.join(",")})&owner_id=eq.${batch.owner_id}&upload_state=eq.uploaded`
      + `&select=id,draft_id,mime_type,sort_order&order=sort_order.asc`,
    ) : [];
    const imagesByDraftId = new Map<string, ImageRow[]>();
    for (const image of images) {
      const list = imagesByDraftId.get(image.draft_id);
      if (list) list.push(image); else imagesByDraftId.set(image.draft_id, [image]);
    }

    const categoryIds = drafts.map(d => d.vinted_category_id).filter((id): id is number => id !== null);
    const categoriesById = await getVintedCategoriesByIds(categoryIds);

    const payloadItems: ExtensionBatchItem[] = items.map(item => {
      const draft = draftsById.get(item.draft_id);
      if (!draft) throw new Error(`Batch item ${item.id} references a draft that no longer exists.`);
      const draftImages = imagesByDraftId.get(item.draft_id) ?? [];
      const itemFamily = deriveDraftItemFamily(draft.product_type);
      const audience = normaliseFootwearVintedAudience(draft.vinted_audience, itemFamily);
      const category = draft.vinted_category_id ? categoriesById.get(draft.vinted_category_id) : undefined;

      return {
        itemId: item.id, draftId: draft.id, queuePosition: item.queue_position,
        sku: draft.sku, title: draft.generated_title ?? "", description: draft.generated_description ?? "",
        brand: draft.brand ?? "", model: draft.model, productType: draft.product_type ?? "", condition: draft.condition ?? "",
        ukSize: draft.uk_size, audience: audience ?? "unknown",
        colours: draft.colours ?? [], materials: draft.material ? [draft.material] : [],
        pricePence: draft.confirmed_price_pence ?? 0,
        priceDisplay: draft.confirmed_price_pence ? `£${(draft.confirmed_price_pence / 100).toFixed(2)}` : "",
        vintedCategoryId: draft.vinted_category_id ?? 0, vintedCategoryPath: category?.full_path ?? draft.vinted_category_path ?? "",
        photos: draftImages.map((image, position) => ({
          position, fileName: `${String(position + 1).padStart(2, "0")}.${extensionForMime(image.mime_type)}`,
          path: buildExtensionPhotoPath(item.id, position),
        })),
        coverPhotoPosition: 0,
      };
    });

    const payload = validateExtensionBatchPayload({
      schemaVersion: EXTENSION_BATCH_SCHEMA_VERSION, batchId, expiresAt: batch.expires_at, items: payloadItems,
    });

    if (batch.status === "claimed") {
      await supabaseRequest(`vinted_extension_batches?id=eq.${batchId}&status=eq.claimed`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "in_progress" }),
      }).catch(() => {});
    }

    return extensionCorsJson(request, payload);
  } catch (error) { return extensionSafeApiError(request, error, "Could not load this batch."); }
}
