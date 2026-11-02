import "server-only";
import type { EbayExtractedListing } from "@/lib/listing-studio/ebay-extractor";
import type { MarketplaceDynamicData, MarketplaceValidationMessage } from "@/lib/listing-studio/marketplace-types";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import { getMarketplaceSettingsDefaults, upsertMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { resolveMarketplaceSettings } from "@/lib/listing-studio/marketplace-settings";

function importedSpecifics(listing: EbayExtractedListing): MarketplaceDynamicData {
  const now = new Date().toISOString();
  const result: MarketplaceDynamicData = {};
  for (const [name, rawValue] of Object.entries(listing.itemSpecifics)) {
    const value = rawValue.trim();
    if (!name.trim() || !value) continue;
    result[name] = {
      value,
      confidence: "high",
      source: "ebay_import",
      appliedAutomatically: true,
      needsReview: false,
      userConfirmed: true,
      updatedAt: now,
    };
  }
  return result;
}

export async function upsertImportedEbayMarketplaceDraft(input: {
  ownerId: string;
  draftId: string;
  listing: EbayExtractedListing;
  hasPhoto: boolean;
}): Promise<string> {
  const { listing } = input;
  const defaults = await getMarketplaceSettingsDefaults(input.ownerId, "EBAY_UK").catch(() => ({}));
  const settings = resolveMarketplaceSettings(defaults, { contentMode: "exact_copy", quantity: listing.quantity ?? 1 }, null);
  const checks = {
    hasCategory: Boolean(listing.categoryId),
    hasCondition: Boolean(listing.condition),
    hasTitle: Boolean(listing.title.trim()),
    hasDescriptionOrGenerationPath: Boolean(listing.description.trim()),
    hasPhoto: input.hasPhoto,
    hasPrice: listing.pricePence !== null,
    hasQuantity: Boolean(listing.quantity),
    hasSufficientSellingSettings: true,
  };
  const readiness = computeMarketplaceReadiness({
    ...checks,
    hasGeneratedContent: true,
    requiredAspectsFilled: [],
    recommendedAspectsFilled: Object.values(listing.itemSpecifics).map(value => Boolean(value.trim())),
  });
  const validationMessages: MarketplaceValidationMessage[] = [];
  if (!checks.hasCategory) validationMessages.push({ code: "category_not_set", message: "The original eBay category was not returned. Choose a category.", field: "category", severity: "blocking" });
  if (!checks.hasCondition) validationMessages.push({ code: "condition_not_set", message: "The original eBay condition was not returned. Choose a condition.", field: "condition", severity: "blocking" });
  if (!checks.hasDescriptionOrGenerationPath) validationMessages.push({ code: "description_missing", message: "The original listing has no description. Add one before publishing.", field: "description", severity: "blocking" });
  if (!checks.hasPhoto) validationMessages.push({ code: "photos_missing", message: "No eBay photos were saved for this listing.", field: "photos", severity: "blocking" });

  return upsertMarketplaceDraft({
    productDraftId: input.draftId,
    ownerId: input.ownerId,
    marketplace: "EBAY_UK",
    sourceType: "imported_ebay",
    contentMode: "exact_copy",
    title: listing.title,
    description: listing.description,
    categoryId: listing.categoryId ?? null,
    categoryName: listing.category,
    categoryPath: listing.category,
    categorySource: listing.categoryId ? "manual" : null,
    categoryConfidence: listing.categoryId ? "high" : null,
    conditionValue: listing.condition,
    pricePence: listing.pricePence,
    quantity: listing.quantity ?? 1,
    currency: listing.currency ?? "GBP",
    status: readiness.ready ? "ready" : "needs_information",
    readiness,
    validationMessages,
    aiGeneration: { source: "ebay_import", generated: false, importedAt: new Date().toISOString() },
    sourceDraftId: input.draftId,
    sourceEbayItemId: listing.itemId,
    dynamicData: importedSpecifics(listing),
    settings,
  });
}
