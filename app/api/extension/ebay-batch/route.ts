import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { verifyBatchToken, extractBearerToken, BatchTokenError } from "@/lib/listing-studio/extension-batch-tokens";
import {
  EBAY_EXTENSION_BATCH_SCHEMA_VERSION, validateEbayExtensionBatchPayload, buildEbayExtensionPhotoPath, type EbayExtensionBatchItem,
} from "@/lib/listing-studio/ebay-extension-batch-schema";
import { extensionCorsJson, extensionCorsPreflight, extensionSafeApiError } from "@/lib/listing-studio/extension-cors";
import { getEbayConnection, listEbayPolicies } from "@/lib/ebay-account/client";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) { return extensionCorsPreflight(request); }

type BatchRow = { id: string; status: string; expires_at: string; owner_id: string };
type ItemRow = { id: string; marketplace_draft_id: string; product_draft_id: string; queue_position: number };
type MarketplaceDraftRow = {
  id: string; product_draft_id: string; title: string | null; description: string | null;
  category_id: string | null; category_name: string | null; condition_value: string | null;
  price_pence: number | null; quantity: number | null; dynamic_data_json: Record<string, { value: string | string[] | null }> | null;
  ebay_fulfillment_policy_id: string | null; ebay_return_policy_id: string | null; ebay_payment_policy_id: string | null;
};
type ProductDraftRow = { id: string; sku: string | null; brand: string | null; uk_size: string | null; colours: string[] | null };
type ImageRow = { id: string; draft_id: string; mime_type: string; sort_order: number };

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

/**
 * eBay Seller Hub extension drafter — mirrors app/api/extension/batch/route.ts
 * exactly in structure and safety contract (bearer-token-scoped photo
 * paths, first-fetch flips claimed -> in_progress) but builds its payload
 * from listing_marketplace_drafts (EBAY_UK) + listing_draft_images, never
 * listing_drafts' own Vinted-oriented fields.
 *
 * REQUIREMENT (legacy-offer/blocker audit, carried forward): this route
 * never reads ebay_offer_id at all — a legacy, unpublished Inventory API
 * offer must never block or alter what the extension receives.
 */
export async function GET(request: Request) {
  try {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return extensionCorsJson(request, { error: "Missing batch token." }, 401);
    let batchId: string;
    try { ({ batchId } = await verifyBatchToken(token)); }
    catch (error) { if (error instanceof BatchTokenError) return extensionCorsJson(request, { error: error.message }, 401); throw error; }

    const batches = await supabaseRequestAll<BatchRow>(`ebay_extension_batches?id=eq.${batchId}&select=id,status,expires_at,owner_id`);
    const batch = batches[0];
    if (!batch) return extensionCorsJson(request, { error: "Batch not found." }, 404);
    // LIFECYCLE FIX (stale-batch review) — deliberately NOT gated on
    // expires_at: that is the PAIRING-CODE window only, and this route is
    // only ever reached with a valid batch-scoped JWT (verifyBatchToken
    // above already rejects an expired token — the AUTHENTICATED
    // EXTENSION-SESSION lifetime). Whether the batch is still active is the
    // status column's job, not a re-check of the short pairing window a
    // claimed, mid-fill batch has long since left behind. expires_at is
    // still SELECTed purely for the informational `expiresAt` payload
    // field below (it marks when the pairing code stops working for a
    // fresh claim — never a lifecycle gate here).
    if (batch.status !== "claimed" && batch.status !== "in_progress") {
      return extensionCorsJson(request, { error: `This batch is no longer active (${batch.status}).` }, 409);
    }

    const items = await supabaseRequestAll<ItemRow>(
      `ebay_extension_batch_items?batch_id=eq.${batchId}&select=id,marketplace_draft_id,product_draft_id,queue_position&order=queue_position.asc`,
    );
    const marketplaceDraftIds = items.map(i => i.marketplace_draft_id);
    const marketplaceDrafts = marketplaceDraftIds.length ? await supabaseRequestAll<MarketplaceDraftRow>(
      `listing_marketplace_drafts?id=in.(${marketplaceDraftIds.join(",")})&owner_id=eq.${batch.owner_id}`
      + `&select=id,product_draft_id,title,description,category_id,category_name,condition_value,price_pence,quantity,dynamic_data_json,ebay_fulfillment_policy_id,ebay_return_policy_id,ebay_payment_policy_id`,
    ) : [];
    const marketplaceDraftsById = new Map(marketplaceDrafts.map(d => [d.id, d]));

    const productDraftIds = items.map(i => i.product_draft_id);
    const productDrafts = productDraftIds.length ? await supabaseRequestAll<ProductDraftRow>(
      `listing_drafts?id=in.(${productDraftIds.join(",")})&owner_id=eq.${batch.owner_id}&select=id,sku,brand,uk_size,colours`,
    ) : [];
    const productDraftsById = new Map(productDrafts.map(d => [d.id, d]));

    const images = productDraftIds.length ? await supabaseRequestAll<ImageRow>(
      `listing_draft_images?draft_id=in.(${productDraftIds.join(",")})&owner_id=eq.${batch.owner_id}&upload_state=eq.uploaded&select=id,draft_id,mime_type,sort_order&order=sort_order.asc`,
    ) : [];
    const imagesByDraftId = new Map<string, ImageRow[]>();
    for (const image of images) {
      const list = imagesByDraftId.get(image.draft_id);
      if (list) list.push(image); else imagesByDraftId.set(image.draft_id, [image]);
    }

    const connection = await getEbayConnection(batch.owner_id);
    const policies = connection ? await listEbayPolicies(connection.id).catch(() => []) : [];
    const policyByTypeAndId = new Map(policies.map(p => [`${p.policyType}:${p.ebayPolicyId}`, p]));

    const payloadItems: EbayExtensionBatchItem[] = items.map(item => {
      const marketplaceDraft = marketplaceDraftsById.get(item.marketplace_draft_id);
      if (!marketplaceDraft) throw new Error(`Batch item ${item.id} references a marketplace draft that no longer exists.`);
      const productDraft = productDraftsById.get(item.product_draft_id);
      const draftImages = imagesByDraftId.get(item.product_draft_id) ?? [];

      const dynamicData = marketplaceDraft.dynamic_data_json ?? {};
      const itemSpecifics = Object.entries(dynamicData)
        .filter(([name, entry]) => !name.startsWith("__") && entry?.value != null && entry.value !== "")
        .map(([name, entry]) => ({ name, value: Array.isArray(entry.value) ? entry.value.join(", ") : String(entry.value) }))
        .filter(specific => specific.value.length > 0 && specific.value.length <= 65);

      const fulfillmentPolicy = marketplaceDraft.ebay_fulfillment_policy_id
        ? policyByTypeAndId.get(`FULFILLMENT:${marketplaceDraft.ebay_fulfillment_policy_id}`) ?? null : null;
      const paymentPolicy = marketplaceDraft.ebay_payment_policy_id
        ? policyByTypeAndId.get(`PAYMENT:${marketplaceDraft.ebay_payment_policy_id}`) ?? null : null;
      const returnPolicy = marketplaceDraft.ebay_return_policy_id
        ? policyByTypeAndId.get(`RETURN:${marketplaceDraft.ebay_return_policy_id}`) ?? null : null;

      return {
        itemId: item.id, marketplaceDraftId: marketplaceDraft.id, productDraftId: item.product_draft_id, queuePosition: item.queue_position,
        sku: productDraft?.sku ?? "", marketplace: "EBAY_UK" as const,
        title: marketplaceDraft.title ?? "", description: marketplaceDraft.description ?? "",
        categoryId: marketplaceDraft.category_id ?? "", categoryName: marketplaceDraft.category_name ?? "",
        conditionValue: marketplaceDraft.condition_value ?? "", conditionDescription: null,
        brand: productDraft?.brand ?? null, size: productDraft?.uk_size ?? null,
        colour: productDraft?.colours?.length ? productDraft.colours.join(", ") : null,
        itemSpecifics,
        pricePence: marketplaceDraft.price_pence ?? 0,
        priceDisplay: marketplaceDraft.price_pence ? `£${(marketplaceDraft.price_pence / 100).toFixed(2)}` : "",
        quantity: marketplaceDraft.quantity ?? 1,
        photos: draftImages.map((image, position) => ({
          position, fileName: `${String(position + 1).padStart(2, "0")}.${extensionForMime(image.mime_type)}`,
          path: buildEbayExtensionPhotoPath(item.id, position),
        })),
        fulfillmentPolicy: fulfillmentPolicy ? { ebayPolicyId: fulfillmentPolicy.ebayPolicyId, name: fulfillmentPolicy.name } : null,
        returnPolicy: returnPolicy ? { ebayPolicyId: returnPolicy.ebayPolicyId, name: returnPolicy.name } : null,
        paymentPolicy: paymentPolicy ? { ebayPolicyId: paymentPolicy.ebayPolicyId, name: paymentPolicy.name } : null,
      };
    });

    const payload = validateEbayExtensionBatchPayload({
      schemaVersion: EBAY_EXTENSION_BATCH_SCHEMA_VERSION, batchId, expiresAt: batch.expires_at, items: payloadItems,
    });

    if (batch.status === "claimed") {
      await supabaseRequest(`ebay_extension_batches?id=eq.${batchId}&status=eq.claimed`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "in_progress" }),
      }).catch(() => {});
    }

    return extensionCorsJson(request, payload);
  } catch (error) { return extensionSafeApiError(request, error, "Could not load this eBay batch."); }
}
