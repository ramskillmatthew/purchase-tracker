import "server-only";
import { supabaseRequest, supabaseRequestAll, isMissingSchemaError } from "@/lib/supabase";
import type {
  Marketplace, MarketplaceDraft, MarketplaceDraftSourceType, ContentMode, MarketplaceDraftStatus,
  CategorySource, MarketplaceReadiness, MarketplaceValidationMessage, MarketplaceDynamicData,
  PartialMarketplaceDraftSettings, EbayCategoryAlternative,
} from "@/lib/listing-studio/marketplace-types";

/**
 * Persistence for listing_marketplace_drafts (Stage 2) — see
 * supabase-listing-studio-marketplace.sql's own header comment for why this
 * is a separate table from listing_drafts rather than a replacement of it.
 * Centralised here (row<->domain mapping + reads/writes) so every Stage 3-5
 * route reuses the exact same shape instead of re-deriving it ad hoc.
 */

// Corrective pass — this now covers ONLY CORE_MARKETPLACE_DRAFT_SELECT's
// columns. The Stage 6 eBay batch/policy fields live in the separate
// EbayBatchFieldsRow type below and are merged in by rowToMarketplaceDraft.
type CoreMarketplaceDraftRow = {
  id: string; product_draft_id: string; owner_id: string; marketplace: Marketplace;
  source_type: MarketplaceDraftSourceType; content_mode: ContentMode;
  title: string | null; description: string | null;
  category_id: string | null; category_name: string | null; category_path: string | null;
  category_source: CategorySource | null; category_confidence: "high" | "medium" | "low" | null;
  category_alternatives_json: EbayCategoryAlternative[]; category_search_terms: string | null;
  condition_value: string | null;
  price_pence: number | null; quantity: number | null; currency: string;
  status: MarketplaceDraftStatus;
  readiness_json: Partial<MarketplaceReadiness>;
  validation_messages_json: MarketplaceValidationMessage[];
  ai_generation_json: unknown;
  source_draft_id: string | null; source_ebay_item_id: string | null;
  dynamic_data_json: MarketplaceDynamicData;
  settings_json: PartialMarketplaceDraftSettings;
  created_at: string; updated_at: string;
};

const EMPTY_READINESS: MarketplaceReadiness = { ready: false, completionPercent: 0, requiredComplete: 0, requiredTotal: 0, recommendedComplete: 0, recommendedTotal: 0 };

// Corrective pass — CORE_MARKETPLACE_DRAFT_SELECT covers every column that
// has existed since Stage 2 (supabase-listing-studio-marketplace.sql).
// Always queried, never wrapped in a schema-missing fallback: if this
// query fails, that's a genuine fault and must surface as one.
const CORE_MARKETPLACE_DRAFT_SELECT =
  "id,product_draft_id,owner_id,marketplace,source_type,content_mode,title,description,category_id,category_name,category_path,category_source,category_confidence,category_alternatives_json,category_search_terms,condition_value,price_pence,quantity,currency,status,readiness_json,validation_messages_json,ai_generation_json,source_draft_id,source_ebay_item_id,dynamic_data_json,settings_json,"
  + "created_at,updated_at";

// Stage 6 (eBay draft batches) columns — added only by the still-unapplied
// supabase-ebay-draft-batches.sql. Deliberately fetched in a SEPARATE
// query (see fetchEbayBatchFieldsByIds below) rather than folded into
// CORE_MARKETPLACE_DRAFT_SELECT above. The previous version of this file
// combined both sets of columns into one SELECT: on a database where the
// batch migration hasn't run, that one query 400s in its entirety, and the
// whole marketplace draft — including its perfectly real title,
// description, category, condition, price and photos, none of which need
// the missing migration at all — silently vanished from Listings Review.
// Splitting the query means only THESE specific fields ever degrade to
// their defaults; the rest of the row is never at risk.
const EBAY_BATCH_FIELD_SELECT =
  "id,ebay_fulfillment_policy_id,ebay_return_policy_id,ebay_payment_policy_id,ebay_merchant_location_key,ebay_offer_id,ebay_inventory_synced_at,ebay_last_draft_error,ebay_photo_state_json";

type EbayBatchFieldsRow = {
  id: string;
  ebay_fulfillment_policy_id: string | null; ebay_return_policy_id: string | null; ebay_payment_policy_id: string | null;
  ebay_merchant_location_key: string | null; ebay_offer_id: string | null; ebay_inventory_synced_at: string | null;
  ebay_last_draft_error: string | null; ebay_photo_state_json: MarketplaceDraft["ebayPhotoState"];
};
type EbayBatchFields = Omit<EbayBatchFieldsRow, "id">;
const EMPTY_EBAY_BATCH_FIELDS: EbayBatchFields = {
  ebay_fulfillment_policy_id: null, ebay_return_policy_id: null, ebay_payment_policy_id: null,
  ebay_merchant_location_key: null, ebay_offer_id: null, ebay_inventory_synced_at: null,
  ebay_last_draft_error: null, ebay_photo_state_json: {},
};

/**
 * Best-effort fetch of the Stage 6 eBay batch/policy columns for a set of
 * marketplace-draft ids, in one query (never per-row — this is the N+1
 * guard). On a database where the batch migration hasn't been applied,
 * returns an empty map so every id falls back to EMPTY_EBAY_BATCH_FIELDS
 * — but ONLY for the specific missing-schema error shapes above. Any other
 * failure is logged (name, status, message — never a row's data, and this
 * table never stores tokens/credentials in the first place) and re-thrown,
 * exactly like every other Supabase read in this codebase.
 */
async function fetchEbayBatchFieldsByIds(ids: string[]): Promise<Map<string, EbayBatchFields>> {
  const byId = new Map<string, EbayBatchFields>();
  if (!ids.length) return byId;
  try {
    const rows = await supabaseRequestAll<EbayBatchFieldsRow>(
      `listing_marketplace_drafts?id=in.(${ids.join(",")})&select=${EBAY_BATCH_FIELD_SELECT}`,
    );
    for (const { id, ...fields } of rows) byId.set(id, fields);
    return byId;
  } catch (error) {
    if (isMissingSchemaError(error)) return byId;
    if (error instanceof Error) {
      const status = "status" in error ? (error as Error & { status?: unknown }).status : undefined;
      console.error("[marketplace-drafts] Could not load eBay draft-batch fields (not a recognised missing-schema error)", error.name, status !== undefined ? `status=${status}` : "", error.message);
    } else {
      console.error("[marketplace-drafts] Could not load eBay draft-batch fields (not a recognised missing-schema error)", "UnknownError", error);
    }
    throw error;
  }
}

function rowToMarketplaceDraft(row: CoreMarketplaceDraftRow, ebayFields?: EbayBatchFields): MarketplaceDraft {
  const ebay = ebayFields ?? EMPTY_EBAY_BATCH_FIELDS;
  return {
    id: row.id, productDraftId: row.product_draft_id, ownerId: row.owner_id, marketplace: row.marketplace,
    sourceType: row.source_type, contentMode: row.content_mode,
    title: row.title, description: row.description,
    categoryId: row.category_id, categoryName: row.category_name, categoryPath: row.category_path,
    categorySource: row.category_source, categoryConfidence: row.category_confidence,
    categoryAlternatives: row.category_alternatives_json ?? [], categorySearchTerms: row.category_search_terms,
    conditionValue: row.condition_value,
    pricePence: row.price_pence, quantity: row.quantity, currency: row.currency,
    status: row.status,
    readiness: typeof row.readiness_json?.ready === "boolean" ? row.readiness_json as MarketplaceReadiness : EMPTY_READINESS,
    validationMessages: row.validation_messages_json ?? [],
    aiGeneration: row.ai_generation_json,
    sourceDraftId: row.source_draft_id, sourceEbayItemId: row.source_ebay_item_id,
    dynamicData: row.dynamic_data_json ?? {},
    settings: row.settings_json ?? {},
    ebayFulfillmentPolicyId: ebay.ebay_fulfillment_policy_id, ebayReturnPolicyId: ebay.ebay_return_policy_id, ebayPaymentPolicyId: ebay.ebay_payment_policy_id,
    ebayMerchantLocationKey: ebay.ebay_merchant_location_key, ebayOfferId: ebay.ebay_offer_id, ebayInventorySyncedAt: ebay.ebay_inventory_synced_at,
    ebayLastDraftError: ebay.ebay_last_draft_error, ebayPhotoState: ebay.ebay_photo_state_json ?? {},
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function listMarketplaceDraftsForProduct(ownerId: string, productDraftId: string): Promise<MarketplaceDraft[]> {
  const rows = await supabaseRequestAll<CoreMarketplaceDraftRow>(
    `listing_marketplace_drafts?product_draft_id=eq.${productDraftId}&owner_id=eq.${ownerId}&select=${CORE_MARKETPLACE_DRAFT_SELECT}&order=created_at.asc`,
  );
  const ebayFieldsById = await fetchEbayBatchFieldsByIds(rows.map(row => row.id));
  return rows.map(row => rowToMarketplaceDraft(row, ebayFieldsById.get(row.id)));
}

export async function listMarketplaceDraftsForProducts(ownerId: string, productDraftIds: string[]): Promise<Map<string, MarketplaceDraft[]>> {
  const byProduct = new Map<string, MarketplaceDraft[]>();
  if (!productDraftIds.length) return byProduct;
  // Two queries total for the whole batch, never per-row — the core rows
  // first, then one best-effort eBay-fields lookup keyed by the ids that
  // came back. A failure in the second query can only ever blank out the
  // eBay batch/policy fields (see fetchEbayBatchFieldsByIds); it can never
  // remove a row or its Vinted/core eBay content from the result.
  const rows = await supabaseRequestAll<CoreMarketplaceDraftRow>(
    `listing_marketplace_drafts?product_draft_id=in.(${productDraftIds.join(",")})&owner_id=eq.${ownerId}&select=${CORE_MARKETPLACE_DRAFT_SELECT}&order=created_at.asc`,
  );
  const ebayFieldsById = await fetchEbayBatchFieldsByIds(rows.map(row => row.id));
  for (const row of rows) {
    const draft = rowToMarketplaceDraft(row, ebayFieldsById.get(row.id));
    const list = byProduct.get(draft.productDraftId) ?? [];
    list.push(draft);
    byProduct.set(draft.productDraftId, list);
  }
  return byProduct;
}

export async function getMarketplaceDraft(ownerId: string, productDraftId: string, marketplace: Marketplace): Promise<MarketplaceDraft | null> {
  const rows = await supabaseRequestAll<CoreMarketplaceDraftRow>(
    `listing_marketplace_drafts?product_draft_id=eq.${productDraftId}&owner_id=eq.${ownerId}&marketplace=eq.${marketplace}&select=${CORE_MARKETPLACE_DRAFT_SELECT}`,
  );
  const row = rows[0];
  if (!row) return null;
  const ebayFieldsById = await fetchEbayBatchFieldsByIds([row.id]);
  return rowToMarketplaceDraft(row, ebayFieldsById.get(row.id));
}

export type MarketplaceDraftUpsertInput = {
  productDraftId: string; ownerId: string; marketplace: Marketplace;
  sourceType: MarketplaceDraftSourceType; contentMode: ContentMode;
  title?: string | null; description?: string | null;
  categoryId?: string | null; categoryName?: string | null; categoryPath?: string | null;
  categorySource?: CategorySource | null; categoryConfidence?: "high" | "medium" | "low" | null;
  conditionValue?: string | null;
  pricePence?: number | null; quantity?: number | null; currency?: string;
  status: MarketplaceDraftStatus;
  readiness: MarketplaceReadiness;
  validationMessages: MarketplaceValidationMessage[];
  aiGeneration?: unknown;
  sourceDraftId?: string | null; sourceEbayItemId?: string | null;
  dynamicData?: MarketplaceDynamicData;
  settings?: PartialMarketplaceDraftSettings;
};

/**
 * Idempotent create-or-update, keyed by the table's own
 * (product_draft_id, marketplace) unique constraint — a double-click or a
 * retried "Generate eBay drafts" request can never create two eBay drafts
 * for the same product; the second call simply updates the first result
 * (Stage 2's concurrency requirement). Returns the resulting row's id.
 */
export async function upsertMarketplaceDraft(input: MarketplaceDraftUpsertInput): Promise<string> {
  const body: Record<string, unknown> = {
    product_draft_id: input.productDraftId, owner_id: input.ownerId, marketplace: input.marketplace,
    source_type: input.sourceType, content_mode: input.contentMode,
    status: input.status, readiness_json: input.readiness, validation_messages_json: input.validationMessages,
    updated_at: new Date().toISOString(),
  };
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.categoryId !== undefined) body.category_id = input.categoryId;
  if (input.categoryName !== undefined) body.category_name = input.categoryName;
  if (input.categoryPath !== undefined) body.category_path = input.categoryPath;
  if (input.categorySource !== undefined) body.category_source = input.categorySource;
  if (input.categoryConfidence !== undefined) body.category_confidence = input.categoryConfidence;
  if (input.conditionValue !== undefined) body.condition_value = input.conditionValue;
  if (input.pricePence !== undefined) body.price_pence = input.pricePence;
  if (input.quantity !== undefined) body.quantity = input.quantity;
  if (input.currency !== undefined) body.currency = input.currency;
  if (input.aiGeneration !== undefined) body.ai_generation_json = input.aiGeneration;
  if (input.sourceDraftId !== undefined) body.source_draft_id = input.sourceDraftId;
  if (input.sourceEbayItemId !== undefined) body.source_ebay_item_id = input.sourceEbayItemId;
  if (input.dynamicData !== undefined) body.dynamic_data_json = input.dynamicData;
  if (input.settings !== undefined) body.settings_json = input.settings;

  const response = await supabaseRequest(
    "listing_marketplace_drafts?on_conflict=product_draft_id,marketplace",
    { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) },
  );
  const rows = (await response.json()) as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error("Marketplace draft upsert did not return a row id.");
  return id;
}

export async function patchMarketplaceDraft(ownerId: string, id: string, patch: Record<string, unknown>): Promise<void> {
  await supabaseRequest(`listing_marketplace_drafts?id=eq.${id}&owner_id=eq.${ownerId}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

export async function deleteMarketplaceDraft(ownerId: string, id: string): Promise<void> {
  await supabaseRequest(`listing_marketplace_drafts?id=eq.${id}&owner_id=eq.${ownerId}`, { method: "DELETE" });
}

type SettingsDefaultsRow = {
  content_mode: ContentMode | null; listing_format: PartialMarketplaceDraftSettings["listingFormat"];
  default_quantity: number; allow_offers: boolean;
  postage_profile_label: string | null; return_profile_label: string | null; payment_profile_label: string | null;
  package_size: PartialMarketplaceDraftSettings["packageSize"] | null;
  automation_mode: PartialMarketplaceDraftSettings["automationMode"];
};

/** The lowest-priority level of the 3-level settings hierarchy — see
 * lib/listing-studio/marketplace-settings.ts's resolveMarketplaceSettings.
 * Returns an empty object (never throws) when the owner has never saved
 * account-level defaults for this marketplace, so a fresh install always
 * falls straight through to FALLBACK_MARKETPLACE_DRAFT_SETTINGS. */
export async function getMarketplaceSettingsDefaults(ownerId: string, marketplace: Marketplace): Promise<PartialMarketplaceDraftSettings> {
  const rows = await supabaseRequestAll<SettingsDefaultsRow>(
    `listing_marketplace_settings_defaults?owner_id=eq.${ownerId}&marketplace=eq.${marketplace}&select=content_mode,listing_format,default_quantity,allow_offers,postage_profile_label,return_profile_label,payment_profile_label,package_size,automation_mode`,
  );
  const row = rows[0];
  if (!row) return {};
  const settings: PartialMarketplaceDraftSettings = {
    listingFormat: row.listing_format, quantity: row.default_quantity, allowOffers: row.allow_offers,
    postageProfileLabel: row.postage_profile_label, returnProfileLabel: row.return_profile_label,
    paymentProfileLabel: row.payment_profile_label, packageSize: row.package_size, automationMode: row.automation_mode,
  };
  if (row.content_mode) settings.contentMode = row.content_mode;
  return settings;
}
