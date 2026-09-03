import "server-only";
import { supabaseRequestAll } from "@/lib/supabase";
import { resolveEbayAspects, type EbayAspectResolutionOutcome } from "@/lib/listing-studio/ebay-aspect-service";
import { isAspectValueFilled, isAspectCountableForReadiness } from "@/lib/listing-studio/ebay-aspect-matching";
import { readEbayProductFacts } from "@/lib/listing-studio/ebay-product-facts";
import { getMarketplaceDraft, patchMarketplaceDraft, getMarketplaceSettingsDefaults } from "@/lib/listing-studio/marketplace-drafts";
import { resolveMarketplaceSettings } from "@/lib/listing-studio/marketplace-settings";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { readContentGenerationState } from "@/lib/listing-studio/ebay-content-generation-state";
import { describeEbayAspectsFailure, type EbayErrorCode } from "@/lib/listing-studio/ebay-error-codes";
import { buildSellingSettingsMessages, withoutMessageCodes, withoutMessageCodePrefix, SELLING_SETTINGS_MESSAGE_CODES } from "@/lib/listing-studio/ebay-validation-messages";
import type { SharedFacts, MarketplaceValidationMessage, MarketplaceDraft, MarketplaceDynamicData } from "@/lib/listing-studio/marketplace-types";

/**
 * Shared "resolve + persist item specifics" logic — reused by BOTH the
 * explicit "Suggest item specifics" action
 * (app/api/listing-studio/groups/[draftId]/ebay-aspects/route.ts's POST)
 * AND automatic execution right after a category is auto-selected during
 * generation (app/api/listing-studio/groups/[draftId]/generate/route.ts),
 * so the two call sites can never drift apart (Fault 3/4 fix — item
 * specifics no longer require a manual click as the mandatory first step).
 */
export type EbayAspectAutomationOutcome =
  | { status: "applied"; readiness: ReturnType<typeof computeMarketplaceReadiness> }
  | { status: "failed"; reason: EbayAspectResolutionOutcome["status"]; code: EbayErrorCode; message: string };

type ProductRow = { brand: string | null; model: string | null; product_type: string | null; colours: string[] | null; material: string | null; shared_facts_json: SharedFacts | null; ai_result_json: { itemSpecifics?: Record<string, string> } | null };

function flattenSharedFacts(facts: SharedFacts | null): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, fact] of Object.entries(facts ?? {})) if (fact?.value) flat[name] = fact.value;
  return flat;
}

/**
 * Live-diagnostic follow-up fix (proven root cause of "package size
 * reverted to Not set after item specifics were saved") — the freshly
 * resolved aspect values are MERGED into the draft's EXISTING
 * dynamic_data_json here, never used to replace it wholesale. This is
 * what preserves the reserved pseudo-aspects (`__packageSize`,
 * `__contentGeneration`, `__productFacts` — none of which
 * resolveEbayAspects ever produces itself, so they simply pass through
 * untouched) AND any REAL aspect the owner has already manually
 * confirmed (`userConfirmed: true`) — "manual override always wins" is
 * enforced here explicitly, never overwritten by a fresh automatic
 * suggestion just because "Suggest item specifics" (or the automatic
 * post-category-selection run) happened to fire again.
 */
function mergeAspectDynamicData(existing: MarketplaceDynamicData, freshlyResolved: MarketplaceDynamicData): MarketplaceDynamicData {
  const merged: MarketplaceDynamicData = { ...existing };
  for (const [name, value] of Object.entries(freshlyResolved)) {
    if (existing[name]?.userConfirmed) continue; // manual override always wins
    merged[name] = value;
  }
  return merged;
}

export async function autoResolveAndPersistEbayAspects(ownerId: string, productDraftId: string, ebayDraft?: MarketplaceDraft): Promise<EbayAspectAutomationOutcome> {
  const resolvedDraft = ebayDraft ?? await getMarketplaceDraft(ownerId, productDraftId, "EBAY_UK");
  if (!resolvedDraft?.categoryId) return { status: "failed", reason: "not_configured", code: "EBAY_NOT_CONFIGURED", message: "This product needs a category before its eBay item specifics can be prepared." };

  const products = await supabaseRequestAll<ProductRow>(`listing_drafts?id=eq.${productDraftId}&owner_id=eq.${ownerId}&select=brand,model,product_type,colours,material,shared_facts_json,ai_result_json`);
  const product = products[0];

  const accountDefaults = await getMarketplaceSettingsDefaults(ownerId, "EBAY_UK");
  const settings = resolveMarketplaceSettings(accountDefaults, null, resolvedDraft.settings);

  const outcome = await resolveEbayAspects({
    categoryId: resolvedDraft.categoryId, brand: product?.brand ?? null, productType: product?.product_type ?? null, model: product?.model ?? null,
    title: resolvedDraft.title, importedItemSpecifics: product?.ai_result_json?.itemSpecifics ?? {},
    sharedFacts: flattenSharedFacts(product?.shared_facts_json ?? null), vintedColours: product?.colours ?? [], vintedMaterial: product?.material ?? null,
    // Live-diagnostic follow-up fix (proven root cause of "only Department
    // gets mapped") — the SAME verified structured facts already used to
    // compose this product's eBay title/description, so Brand/Type/
    // Colour/Upper Material/UK Shoe Size/Model/Department all have a
    // real, high-confidence fact to map from even when this product has
    // no Vinted draft at all (whose base-row columns brand/productType/
    // model above stay null in that case).
    productFacts: readEbayProductFacts(resolvedDraft.dynamicData),
    automationMode: settings.automationMode,
  });

  if (outcome.status !== "success") {
    const reason = outcome.status === "upstream_unavailable" ? outcome.reason : "not_configured";
    const { code, message } = describeEbayAspectsFailure(reason);
    return { status: "failed", reason: outcome.status, code, message };
  }

  const mergedDynamicData = mergeAspectDynamicData(resolvedDraft.dynamicData, outcome.dynamicData);

  const emptyValue = { value: null, confidence: "unknown" as const, source: "none", appliedAutomatically: false, needsReview: false, userConfirmed: false, updatedAt: "" };
  // Live-diagnostic follow-up fix (proven root cause of "0/18 recommended"
  // permanently under-counting) — an aspect resolveEbayAspects marked
  // "not_applicable" (US/AU/EU Shoe Size) is excluded from these arrays
  // entirely, never counted as a still-outstanding gap.
  const requiredAspectsFilled = outcome.grouped.required
    .filter(a => isAspectCountableForReadiness(mergedDynamicData[a.name]))
    .map(a => isAspectValueFilled(mergedDynamicData[a.name] ?? emptyValue));
  const recommendedAspectsFilled = outcome.grouped.recommended
    .filter(a => isAspectCountableForReadiness(mergedDynamicData[a.name]))
    .map(a => isAspectValueFilled(mergedDynamicData[a.name] ?? emptyValue));

  const hasGeneratedContent = readContentGenerationState(resolvedDraft.dynamicData, {
    sourceType: resolvedDraft.sourceType, contentMode: resolvedDraft.contentMode,
    hasTitle: Boolean(resolvedDraft.title), hasDescription: Boolean(resolvedDraft.description),
  }).state === "generated";
  const readiness = computeMarketplaceReadiness({
    hasCategory: true, hasCondition: !!resolvedDraft.conditionValue, hasTitle: !!resolvedDraft.title, hasDescriptionOrGenerationPath: !!resolvedDraft.description,
    hasPhoto: true, hasPrice: resolvedDraft.pricePence != null, hasQuantity: resolvedDraft.quantity != null,
    hasSufficientSellingSettings: true, hasGeneratedContent, requiredAspectsFilled, recommendedAspectsFilled,
  });

  let validationMessages = withoutMessageCodePrefix(resolvedDraft.validationMessages, "aspect_");
  validationMessages = withoutMessageCodes(validationMessages, SELLING_SETTINGS_MESSAGE_CODES);
  outcome.grouped.required.forEach(aspect => {
    if (isAspectCountableForReadiness(mergedDynamicData[aspect.name]) && !isAspectValueFilled(mergedDynamicData[aspect.name] ?? emptyValue)) {
      validationMessages.push({ code: `aspect_required_${aspect.name}`, message: `${aspect.name} is required for this eBay category.`, field: aspect.name, severity: "blocking" });
    }
  });
  outcome.grouped.recommended.forEach(aspect => {
    if (isAspectCountableForReadiness(mergedDynamicData[aspect.name]) && !isAspectValueFilled(mergedDynamicData[aspect.name] ?? emptyValue)) {
      validationMessages.push({ code: `aspect_recommended_${aspect.name}`, message: `${aspect.name} is not provided.`, field: aspect.name, severity: "suggestion" });
    }
  });
  validationMessages.push(...buildSellingSettingsMessages(resolvedDraft));

  await patchMarketplaceDraft(ownerId, resolvedDraft.id, {
    dynamic_data_json: mergedDynamicData,
    status: readiness.ready ? "ready" : "needs_information", readiness_json: readiness, validation_messages_json: validationMessages,
  });

  return { status: "applied", readiness };
}
