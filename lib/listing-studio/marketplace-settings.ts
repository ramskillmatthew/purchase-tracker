import type {
  MarketplaceDraftSettings, PartialMarketplaceDraftSettings, MarketplaceDraftSourceType, ContentMode,
} from "@/lib/listing-studio/marketplace-types";

/**
 * Stage 3 settings hierarchy: account/default settings (lowest priority) ->
 * batch settings (chosen once for a whole "Generate eBay drafts" run) ->
 * per-draft override (highest priority, once a draft has its own). Each
 * layer is a PartialMarketplaceDraftSettings — only the keys someone
 * actually set — and this function is the ONE place they're folded
 * together into a complete, always-fully-populated settings object.
 * Mirrors the plain object-spread-in-priority-order pattern already used
 * throughout this codebase (e.g. getSettings() in
 * vinted-draft-queue-extension/service-worker.js) rather than a bespoke
 * merge algorithm.
 */
export const FALLBACK_MARKETPLACE_DRAFT_SETTINGS: MarketplaceDraftSettings = {
  contentMode: "seo_optimised",
  listingFormat: "buy_it_now",
  quantity: 1,
  allowOffers: false,
  postageProfileLabel: null,
  returnProfileLabel: null,
  paymentProfileLabel: null,
  packageSize: null,
  automationMode: "balanced",
};

export function resolveMarketplaceSettings(
  accountDefaults: PartialMarketplaceDraftSettings | null | undefined,
  batchSettings: PartialMarketplaceDraftSettings | null | undefined,
  draftSettings: PartialMarketplaceDraftSettings | null | undefined,
): MarketplaceDraftSettings {
  return {
    ...FALLBACK_MARKETPLACE_DRAFT_SETTINGS,
    ...stripUndefined(accountDefaults),
    ...stripUndefined(batchSettings),
    ...stripUndefined(draftSettings),
  };
}

function stripUndefined(value: PartialMarketplaceDraftSettings | null | undefined): PartialMarketplaceDraftSettings {
  if (!value) return {};
  const result: PartialMarketplaceDraftSettings = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (result as Record<string, unknown>)[key] = entry;
  }
  return result;
}

/**
 * The content-mode default depends on how a draft comes to exist, not on
 * the 3-level settings hierarchy above — a fresh photo-generated draft
 * defaults to seo_optimised, an eBay-imported draft defaults to exact_copy
 * (preserving the seller's original listing unless the owner explicitly
 * opts into rewriting it). This is only ever the STARTING value for a
 * brand-new draft; once set (by this default or a manual choice), later
 * generation calls never silently flip it back — see
 * lib/listing-studio/marketplace-drafts.ts's upsert, which only writes
 * content_mode when the caller explicitly passes it.
 */
export function defaultContentModeForSourceType(sourceType: MarketplaceDraftSourceType): ContentMode {
  return sourceType === "imported_ebay" ? "exact_copy" : "seo_optimised";
}
