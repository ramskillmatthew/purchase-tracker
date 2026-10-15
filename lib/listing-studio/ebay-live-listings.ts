import "server-only";
import { supabaseRequestAll } from "@/lib/supabase";
import { getMarketplaceDraft, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { getEbayConnection, listEbayPolicies, getValidEbayAccessToken } from "@/lib/ebay-account/client";
import { buildInventoryItemPayload, preparePhotos } from "@/lib/listing-studio/ebay-draft-batches";
import { createOffer, createOrReplaceInventoryItem, getEbayCategoryConditions, getOffer, getOffersForSku, publishOffer, updateOffer, type EbayCategoryCondition, type EbayOfferPayload } from "@/lib/ebay-account/inventory-client";
import { toEbayInventoryCondition, type EbayInventoryConditionEnum } from "@/lib/listing-studio/ebay-condition";

export const EBAY_LIVE_CONFIRMATION = "LIST LIVE ON EBAY";
export const MAX_EBAY_LIVE_LISTINGS = 30;

export type EbayLivePreviewItem = {
  productDraftId: string; marketplaceDraftId: string | null; sku: string | null;
  title: string | null; pricePence: number | null; categoryId: string | null;
  condition: string | null; photoCount: number; eligible: boolean; reasons: string[];
};

type EbayListingPolicies = {
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  merchantLocationKey: string | null;
};

function resolveEbayListingPolicies(
  draft: NonNullable<Awaited<ReturnType<typeof getMarketplaceDraft>>>,
  connection: NonNullable<Awaited<ReturnType<typeof getEbayConnection>>>,
  policies: Awaited<ReturnType<typeof listEbayPolicies>>,
): EbayListingPolicies {
  const usablePolicy = (type: "FULFILLMENT" | "RETURN" | "PAYMENT", id: string | null) =>
    Boolean(id && policies.some(policy => policy.policyType === type && policy.ebayPolicyId === id && policy.available));
  const choosePolicy = (type: "FULFILLMENT" | "RETURN" | "PAYMENT", override: string | null, fallback: string | null) =>
    usablePolicy(type, override) ? override : fallback;
  return {
    fulfillmentPolicyId: choosePolicy("FULFILLMENT", draft.ebayFulfillmentPolicyId, connection.defaultFulfillmentPolicyId),
    returnPolicyId: choosePolicy("RETURN", draft.ebayReturnPolicyId, connection.defaultReturnPolicyId),
    paymentPolicyId: choosePolicy("PAYMENT", draft.ebayPaymentPolicyId, connection.defaultPaymentPolicyId),
    merchantLocationKey: draft.ebayMerchantLocationKey ?? connection.defaultInventoryLocationKey,
  };
}

export async function previewEbayLiveListings(ownerId: string, productDraftIds: string[]): Promise<EbayLivePreviewItem[]> {
  const ids = [...new Set(productDraftIds)].slice(0, MAX_EBAY_LIVE_LISTINGS);
  const [connection, skuRows, imageRows] = await Promise.all([
    getEbayConnection(ownerId),
    ids.length ? supabaseRequestAll<{ id: string; sku: string | null }>(`listing_drafts?id=in.(${ids.join(",")})&owner_id=eq.${ownerId}&select=id,sku`) : [],
    ids.length ? supabaseRequestAll<{ draft_id: string }>(`listing_draft_images?draft_id=in.(${ids.join(",")})&owner_id=eq.${ownerId}&upload_state=eq.uploaded&select=draft_id`) : [],
  ]);
  const policies = connection ? await listEbayPolicies(connection.id) : [];
  const skuById = new Map(skuRows.map(row => [row.id, row.sku]));
  const photos = new Map<string, number>();
  for (const row of imageRows) photos.set(row.draft_id, (photos.get(row.draft_id) ?? 0) + 1);
  const available = (type: "FULFILLMENT" | "RETURN" | "PAYMENT", value: string | null) =>
    Boolean(value && policies.some(p => p.policyType === type && p.ebayPolicyId === value && p.available));

  return Promise.all(ids.map(async productDraftId => {
    const draft = await getMarketplaceDraft(ownerId, productDraftId, "EBAY_UK");
    const listingPolicies = draft && connection ? resolveEbayListingPolicies(draft, connection, policies) : null;
    const sku = skuById.get(productDraftId) ?? null;
    const photoCount = photos.get(productDraftId) ?? 0;
    const reasons: string[] = [];
    if (!draft) reasons.push("No eBay preparation");
    if (!connection || connection.connectionStatus !== "connected") reasons.push("eBay account is not connected");
    if (!sku) reasons.push("Missing SKU");
    if (!draft?.title || !draft.description) reasons.push("Missing title or description");
    if (!draft?.categoryId) reasons.push("Missing eBay category");
    if (!draft?.pricePence || draft.pricePence <= 0) reasons.push("Missing price");
    if (!draft?.quantity || draft.quantity <= 0) reasons.push("Missing quantity");
    if (!toEbayInventoryCondition(draft?.conditionValue ?? null).ok) reasons.push("Missing or unsupported condition");
    if (photoCount === 0) reasons.push("No uploaded photos");
    if (!listingPolicies?.merchantLocationKey) reasons.push("Missing eBay inventory location");
    if (!available("FULFILLMENT", listingPolicies?.fulfillmentPolicyId ?? null)) reasons.push("Missing or unavailable shipping policy");
    if (!available("RETURN", listingPolicies?.returnPolicyId ?? null)) reasons.push("Missing or unavailable return policy");
    if (!available("PAYMENT", listingPolicies?.paymentPolicyId ?? null)) reasons.push("Missing or unavailable payment policy");
    return { productDraftId, marketplaceDraftId: draft?.id ?? null, sku, title: draft?.title ?? null, pricePence: draft?.pricePence ?? null, categoryId: draft?.categoryId ?? null, condition: draft?.conditionValue ?? null, photoCount, eligible: reasons.length === 0, reasons };
  }));
}

function offerPayload(
  draft: NonNullable<Awaited<ReturnType<typeof getMarketplaceDraft>>>,
  sku: string,
  listingPolicies: EbayListingPolicies,
): EbayOfferPayload {
  return {
    sku, marketplaceId: "EBAY_GB", format: "FIXED_PRICE", categoryId: draft.categoryId!,
    listingDescription: draft.description ?? "",
    pricingSummary: { price: { value: (draft.pricePence! / 100).toFixed(2), currency: "GBP" } },
    quantityLimitPerBuyer: 1,
    listingPolicies: {
      fulfillmentPolicyId: listingPolicies.fulfillmentPolicyId!,
      returnPolicyId: listingPolicies.returnPolicyId!,
      paymentPolicyId: listingPolicies.paymentPolicyId!,
    },
    merchantLocationKey: listingPolicies.merchantLocationKey!,
  };
}

const CONDITION_ID_TO_ENUM: Readonly<Record<string, EbayInventoryConditionEnum>> = {
  "1000": "NEW", "1500": "NEW_OTHER", "1750": "NEW_WITH_DEFECTS", "2000": "CERTIFIED_REFURBISHED",
  "2010": "EXCELLENT_REFURBISHED", "2020": "VERY_GOOD_REFURBISHED", "2030": "GOOD_REFURBISHED",
  "2500": "SELLER_REFURBISHED", "2750": "LIKE_NEW", "3000": "USED_EXCELLENT", "4000": "USED_VERY_GOOD",
  "5000": "USED_GOOD", "6000": "USED_ACCEPTABLE", "7000": "FOR_PARTS_OR_NOT_WORKING",
};

export function resolveCategoryCondition(conditionValue: string | null, supported: EbayCategoryCondition[]): EbayInventoryConditionEnum | null {
  const translated = toEbayInventoryCondition(conditionValue);
  if (!translated.ok) return null;
  const supportedEnums = new Set(supported.map(item => CONDITION_ID_TO_ENUM[item.conditionId]).filter(Boolean));
  if (supportedEnums.has(translated.enumValue)) return translated.enumValue;
  // Clothing/footwear categories commonly expose condition id 3000 as a
  // generic "Pre-owned"/"Used" bucket rather than a quality grade. It is
  // safe to use only when eBay itself describes it generically; never
  // reinterpret an explicit "Excellent" grade as equivalent.
  if (translated.enumValue === "USED_VERY_GOOD") {
    const genericUsed = supported.find(item => item.conditionId === "3000" && /^(used|pre[- ]?owned)$/i.test(item.description.trim()));
    if (genericUsed) return "USED_EXCELLENT";
  }
  return null;
}

export async function publishOneEbayLiveListing(ownerId: string, productDraftId: string): Promise<{ listingId: string; offerId: string; alreadyLive: boolean }> {
  const [preview] = await previewEbayLiveListings(ownerId, [productDraftId]);
  if (!preview?.eligible || !preview.marketplaceDraftId || !preview.sku) throw new Error(preview?.reasons.join("; ") || "This listing is not ready for eBay.");
  const draft = await getMarketplaceDraft(ownerId, productDraftId, "EBAY_UK");
  if (!draft) throw new Error("The eBay preparation no longer exists.");
  const { accessToken, connection } = await getValidEbayAccessToken(ownerId);
  const policies = await listEbayPolicies(connection.id);
  const listingPolicies = resolveEbayListingPolicies(draft, connection, policies);
  const existing = await getOffersForSku(accessToken, preview.sku);
  const reads = (await Promise.all(existing.map(o => getOffer(accessToken, o.offerId)))).filter(Boolean);
  const live = reads.find(o => o!.status === "PUBLISHED" && o!.listingId);
  if (live?.listingId) return { listingId: live.listingId, offerId: live.offerId, alreadyLive: true };
  if (reads.length > 1) throw new Error("More than one unpublished eBay offer exists for this SKU. Resolve the duplicates before publishing.");

  const [{ imageUrls }, categoryConditions] = await Promise.all([
    preparePhotos(ownerId, productDraftId),
    getEbayCategoryConditions(accessToken, draft.categoryId!),
  ]);
  if (!imageUrls.length) throw new Error("No photo could be verified as reachable by eBay.");
  const categoryCondition = resolveCategoryCondition(draft.conditionValue, categoryConditions);
  if (!categoryCondition) throw new Error("This condition is not supported by the selected eBay category.");
  const inventoryPayload = buildInventoryItemPayload(draft, imageUrls, categoryCondition);
  if (!inventoryPayload) throw new Error("The eBay condition is missing or unsupported.");
  await createOrReplaceInventoryItem(accessToken, preview.sku, inventoryPayload);
  const payload = offerPayload(draft, preview.sku, listingPolicies);
  // Only reuse an offer eBay itself returned for this SKU. A locally stored
  // historical id may have been deleted remotely and must never be trusted
  // as the target of an update or publish.
  let offerId = reads[0]?.offerId ?? null;
  if (offerId) await updateOffer(accessToken, offerId, payload);
  else offerId = (await createOffer(accessToken, payload)).offerId;
  await patchMarketplaceDraft(ownerId, draft.id, { ebay_offer_id: offerId, ebay_last_draft_error: null });
  try {
    const published = await publishOffer(accessToken, offerId);
    await patchMarketplaceDraft(ownerId, draft.id, {
      ebay_inventory_synced_at: new Date().toISOString(), ebay_last_draft_error: null,
      dynamic_data_json: { ...draft.dynamicData, __ebayLiveListing: { value: published.listingId, confidence: "high", source: "ebay_inventory_api", appliedAutomatically: false, needsReview: false, userConfirmed: true, updatedAt: new Date().toISOString() } },
    });
    return { ...published, alreadyLive: false };
  } catch (error) {
    const reconciled = await getOffer(accessToken, offerId).catch(() => null);
    if (reconciled?.status === "PUBLISHED" && reconciled.listingId) return { listingId: reconciled.listingId, offerId, alreadyLive: true };
    await patchMarketplaceDraft(ownerId, draft.id, { ebay_last_draft_error: error instanceof Error ? error.message : "eBay could not publish this listing." }).catch(() => {});
    throw error;
  }
}
