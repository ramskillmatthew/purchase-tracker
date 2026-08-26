import "server-only";
import { generateEbayTitle, generateEbayDescription, type EbayGeneratedListingFields } from "@/lib/listing-studio/ebay-listing-template";
import { computeMarketplaceReadiness } from "@/lib/listing-studio/marketplace-readiness";
import type { MarketplaceDraftStatus, MarketplaceValidationMessage, MarketplaceReadiness } from "@/lib/listing-studio/marketplace-types";
import type { ListingGenerationFields } from "@/lib/listing-studio/listing-generation-schemas";

/**
 * Stage 2 scaffold for building an eBay UK marketplace draft from the SAME
 * structured product fields the Vinted generator already extracted from
 * photos (lib/listing-studio/listing-generation-schemas.ts's
 * ListingGenerationFields) — no second AI call, no second photo upload.
 * Category and condition are deliberately left unset here: Stage 4 (eBay
 * category suggestion) and Stage 5 (dynamic item specifics, which is where
 * a real eBay condition value gets resolved against that category's own
 * allowed condition set) don't exist yet, so this never invents a
 * placeholder category or condition — readiness correctly reports
 * "needs information" until a later stage fills them in for real.
 */
export type EbayDraftGenerationResult = {
  title: string;
  description: string;
  conditionValue: string | null;
  status: MarketplaceDraftStatus;
  readiness: MarketplaceReadiness;
  validationMessages: MarketplaceValidationMessage[];
};

export function buildEbayDraftFromGeneratedFields(input: {
  fields: ListingGenerationFields;
  ukSize: string | null;
  hasPhoto: boolean;
  pricePence: number | null;
  quantity: number | null;
}): EbayDraftGenerationResult {
  const templateFields: EbayGeneratedListingFields = {
    brand: input.fields.brand.value, model: input.fields.model.value, productType: input.fields.productType.value,
    colours: input.fields.colours.value, material: input.fields.material.value, ukSize: input.ukSize, conditionLabel: null,
  };
  const title = generateEbayTitle(templateFields);
  const description = generateEbayDescription(templateFields);

  const readiness = computeMarketplaceReadiness({
    hasCategory: false, hasCondition: false, hasTitle: title.length > 0, hasDescriptionOrGenerationPath: description.length > 0,
    hasPhoto: input.hasPhoto, hasPrice: input.pricePence != null, hasQuantity: input.quantity != null,
    hasSufficientSellingSettings: true, requiredAspectsFilled: [], recommendedAspectsFilled: [],
  });

  const validationMessages: MarketplaceValidationMessage[] = [
    { code: "category_not_set", message: "This product needs a category before its eBay details can be prepared.", field: "category", severity: "blocking" },
    { code: "condition_not_set", message: "An eBay condition is required.", field: "condition", severity: "blocking" },
  ];
  if (input.pricePence == null) validationMessages.push({ code: "price_not_set", message: "A price is required.", field: "price", severity: "blocking" });
  if (input.quantity == null) validationMessages.push({ code: "quantity_not_set", message: "A quantity is required.", field: "quantity", severity: "blocking" });
  if (!templateFields.brand && !templateFields.model && !templateFields.productType) {
    validationMessages.push({ code: "no_identified_product", message: "No product details could be identified from the photos yet.", field: null, severity: "warning" });
  }

  return { title, description, conditionValue: null, status: readiness.ready ? "ready" : "needs_information", readiness, validationMessages };
}
