// Marketplace-aware draft domain types (Stage 2). Pure types only — see
// lib/listing-studio/marketplace-drafts.ts for persistence and
// lib/listing-studio/marketplace-readiness.ts for readiness logic, matching
// lib/listing-studio/types.ts's own "pure types, no logic" convention.

// 'VINTED' is included for forward-compatibility even though, in this
// milestone, a Vinted draft is still represented by its listing_drafts row
// directly rather than a listing_marketplace_drafts row — see
// supabase-listing-studio-marketplace.sql's own header comment for why.
// Every NEW marketplace-draft row created by this milestone's code is
// 'EBAY_UK'.
export const marketplaces = ["VINTED", "EBAY_UK"] as const;
export type Marketplace = typeof marketplaces[number];

export const marketplaceLabels: Record<Marketplace, string> = {
  VINTED: "Vinted",
  EBAY_UK: "eBay UK",
};

// UI-only instruction meaning "create both marketplace drafts" — never
// itself a stored marketplace value (see marketplaceTargets' own comment
// at its one real use site, components/listing-studio/MarketplaceSelector.tsx).
export const generationTargets = ["EBAY_UK", "VINTED", "BOTH"] as const;
export type GenerationTarget = typeof generationTargets[number];

export function marketplacesForTarget(target: GenerationTarget): Marketplace[] {
  if (target === "BOTH") return ["VINTED", "EBAY_UK"];
  return [target];
}

export const marketplaceDraftSourceTypes = ["generated", "imported_ebay", "imported_vinted", "converted", "manual"] as const;
export type MarketplaceDraftSourceType = typeof marketplaceDraftSourceTypes[number];

export const contentModes = ["seo_optimised", "exact_copy"] as const;
export type ContentMode = typeof contentModes[number];

export const contentModeLabels: Record<ContentMode, string> = {
  seo_optimised: "SEO optimised",
  exact_copy: "Exact copy",
};

export const marketplaceDraftStatuses = ["draft", "needs_information", "ready", "failed", "archived"] as const;
export type MarketplaceDraftStatus = typeof marketplaceDraftStatuses[number];

// Deliberately never "Ready to publish" anywhere in the UI — live eBay
// publishing does not exist yet (account policies/OAuth are a later
// milestone). "Ready" here only ever means "draft details complete".
export const marketplaceDraftStatusLabels: Record<MarketplaceDraftStatus, string> = {
  draft: "Draft",
  needs_information: "Needs information",
  ready: "Ready for final eBay setup",
  failed: "Failed",
  archived: "Archived",
};

export const categorySources = ["ai", "manual"] as const;
export type CategorySource = typeof categorySources[number];

export const aspectConfidenceLevels = ["high", "medium", "low", "unknown"] as const;
export type AspectConfidenceLevel = typeof aspectConfidenceLevels[number];

export const listingFormats = ["buy_it_now"] as const;
export type ListingFormat = typeof listingFormats[number];

export const packageSizes = ["large_letter", "small_parcel", "medium_parcel", "custom"] as const;
export type PackageSize = typeof packageSizes[number];
export const packageSizeLabels: Record<PackageSize, string> = {
  large_letter: "Large letter",
  small_parcel: "Small parcel",
  medium_parcel: "Medium parcel",
  custom: "Custom / not set",
};

export const automationModes = ["fast", "balanced", "strict"] as const;
export type AutomationMode = typeof automationModes[number];
export const automationModeLabels: Record<AutomationMode, string> = {
  fast: "Fast",
  balanced: "Balanced",
  strict: "Strict",
};

/** Stage 3 settings — resolved from the 3-level hierarchy (see
 * lib/listing-studio/marketplace-settings.ts). Every field is always
 * present on a RESOLVED settings object, even though each storage layer
 * (account defaults, batch request, per-draft override) may only carry a
 * partial subset. */
export type MarketplaceDraftSettings = {
  contentMode: ContentMode;
  listingFormat: ListingFormat;
  quantity: number;
  allowOffers: boolean;
  postageProfileLabel: string | null;
  returnProfileLabel: string | null;
  paymentProfileLabel: string | null;
  packageSize: PackageSize | null;
  automationMode: AutomationMode;
};

// A partial settings object, as stored at any one level of the hierarchy —
// every field optional/omittable, since an absent key means "fall through
// to the next level", never "explicitly cleared".
export type PartialMarketplaceDraftSettings = Partial<MarketplaceDraftSettings>;

export type MarketplaceReadiness = {
  ready: boolean;
  completionPercent: number;
  requiredComplete: number;
  requiredTotal: number;
  recommendedComplete: number;
  recommendedTotal: number;
};

export type MarketplaceValidationMessage = {
  code: string;
  message: string;
  field: string | null;
  severity: "blocking" | "warning" | "suggestion";
};

/** One Stage 5 dynamic item-specific value, keyed by its eBay aspect name
 * inside listing_marketplace_drafts.dynamic_data_json. Mirrors
 * lib/listing-studio/types.ts's FieldValue<T> shape (value/confidence/
 * source/confirmed) but adds the two automation-relevant flags Stage 5
 * requires that FieldValue has no equivalent of. */
export type MarketplaceAspectValue = {
  value: string | string[] | null;
  confidence: AspectConfidenceLevel;
  source: string;
  appliedAutomatically: boolean;
  needsReview: boolean;
  userConfirmed: boolean;
  updatedAt: string;
};

export type MarketplaceDynamicData = Record<string, MarketplaceAspectValue>;

export type MarketplaceDraft = {
  id: string;
  productDraftId: string;
  ownerId: string;
  marketplace: Marketplace;
  sourceType: MarketplaceDraftSourceType;
  contentMode: ContentMode;
  title: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  categorySource: CategorySource | null;
  categoryConfidence: "high" | "medium" | "low" | null;
  conditionValue: string | null;
  pricePence: number | null;
  quantity: number | null;
  currency: string;
  status: MarketplaceDraftStatus;
  readiness: MarketplaceReadiness;
  validationMessages: MarketplaceValidationMessage[];
  aiGeneration: unknown;
  sourceDraftId: string | null;
  sourceEbayItemId: string | null;
  dynamicData: MarketplaceDynamicData;
  settings: PartialMarketplaceDraftSettings;
  createdAt: string;
  updatedAt: string;
};

/** Shared, marketplace-agnostic product facts with provenance (Stage 2) —
 * persisted in listing_drafts.shared_facts_json. Open-ended fact names
 * (unlike lib/listing-studio/types.ts's fixed ListingFieldName), since
 * eBay's per-category aspects and future marketplaces can each need facts
 * Vinted's own fixed field list has no slot for (ean/upc/mpn/set/
 * configuration/numberOfBoxes, etc). */
export const sharedFactSources = ["manual", "existing_product_data", "imported_marketplace_data", "photo_analysis", "title_analysis", "ai_suggestion", "ebay_catalogue_data", "saved_user_rule"] as const;
export type SharedFactSource = typeof sharedFactSources[number];

export type SharedFact = {
  value: string | null;
  source: SharedFactSource;
  confidence: AspectConfidenceLevel;
  confirmed: boolean;
};

// A representative, non-exhaustive starter set (Stage 2 spec's own list) —
// shared_facts_json is a jsonb map keyed by string, so an unlisted fact
// name is still perfectly storable/readable; this union only documents the
// names the application itself currently knows to look for.
export const sharedFactNames = [
  "brand", "model", "productType", "size", "colour", "material", "condition", "conditionNotes",
  "ean", "upc", "mpn", "language", "manufacturer", "set", "configuration", "numberOfBoxes",
] as const;
export type SharedFactName = typeof sharedFactNames[number];

export type SharedFacts = Partial<Record<string, SharedFact>>;
