import type { EbaySummary, EbayCardStatus } from "@/lib/listing-studio/ebay-card-status";
import type { GenerationTarget } from "@/lib/listing-studio/marketplace-types";
import type { CardStatus, GeneratedListingSummary } from "@/components/listing-studio/ProductGroupCard";

/**
 * Regression fix (proven root cause of "eBay-only generation makes the
 * draft inaccessible") — `listing` is Vinted-only (populated only from
 * listing_drafts.generated_title/generated_description, which an
 * eBay-only generation deliberately never writes — see the marketplace-
 * isolation fix in app/api/listing-studio/groups/[draftId]/generate/route.ts).
 * ProductGroupCard.tsx used to gate its title/actions on `listing` alone,
 * making a perfectly real, generated EBAY_UK marketplace draft (`ebay`)
 * completely inaccessible whenever no Vinted draft happened to exist too.
 *
 * These two functions are the explicit, marketplace-aware, independently
 * testable decisions every display/action choice on the card is built
 * from — never one generic boolean blending both marketplaces. Extracted
 * into this plain (non-JSX) module specifically so they can be imported
 * and exercised with real inputs/outputs in tests — ProductGroupCard.tsx
 * itself is a "use client" JSX file this project's Vitest config cannot
 * transform (no @testing-library/react / React Vite plugin wired in), so
 * every other *.tsx file in Listing Studio is tested via source-text
 * assertions only; this module has zero JSX/React-hook dependency, so it
 * carries none of that risk.
 */
export type CardActionAvailability = {
  hasVintedDraft: boolean;
  hasEbayMarketplaceDraft: boolean;
  canPreviewVinted: boolean;
  canPreviewEbay: boolean;
  canEditSharedFields: boolean;
  canEditEbayDetails: boolean;
  canRetryEbayGeneration: boolean;
  selectedMarketplaceStatus: CardStatus | EbayCardStatus | null;
  showCardActions: boolean;
};

export function computeCardActionAvailability(
  listing: GeneratedListingSummary | null,
  ebay: EbaySummary | null,
  marketplaceView: GenerationTarget,
  status: CardStatus | null,
  ebayStatus: EbayCardStatus | null,
): CardActionAvailability {
  const hasVintedDraft = Boolean(listing);
  // A row in listing_marketplace_drafts exists for EBAY_UK — true for
  // generated, fallback, AND failed content (a fallback/failed attempt
  // still creates and updates the row; see ebay-content-generation-state.ts),
  // so a degraded draft never loses access to Preview/Retry.
  const hasEbayMarketplaceDraft = ebay !== null;
  const canPreviewVinted = hasVintedDraft;
  const canPreviewEbay = hasEbayMarketplaceDraft;
  // "Edit fields" edits the SHARED base product facts (brand/model/
  // colours/material/size/SKU/audience/category) — never Vinted-specific
  // marketplace copy — so its own availability follows the same "does
  // real product data exist for the marketplace(s) in view" rule as
  // Preview, not a separate concept.
  const canEditSharedFields = canPreviewVinted || canPreviewEbay;
  // "eBay details" (category/item specifics/parcel) is meaningful the
  // moment an EBAY_UK draft row exists, regardless of marketplaceView —
  // preserved from this card's own pre-existing Vinted-mode behaviour,
  // which already showed it whenever ANY listing existed.
  const canEditEbayDetails = canPreviewVinted || canPreviewEbay;
  const canRetryEbayGeneration = hasEbayMarketplaceDraft && ebayStatus === "generation_failed";
  // The ONE status this card's badge actually reflects for the currently
  // selected marketplace view — null in "Both" mode, where both statuses
  // are shown side by side instead, never a single blended value.
  const selectedMarketplaceStatus = marketplaceView === "EBAY_UK" ? ebayStatus : marketplaceView === "VINTED" ? status : null;
  // Marketplace-view-aware action availability — Vinted mode depends ONLY
  // on the Vinted draft (byte-for-byte the same condition this card used
  // before this fix, so "Preserve the existing Vinted card title, status
  // and actions exactly" holds); eBay UK mode depends ONLY on the eBay
  // draft (the actual fix); Both mode is available if EITHER exists, so
  // the absence of one marketplace's draft never hides access to the
  // other's.
  const showCardActions = marketplaceView === "EBAY_UK" ? canPreviewEbay
    : marketplaceView === "VINTED" ? canPreviewVinted
    : (canPreviewVinted || canPreviewEbay);
  return {
    hasVintedDraft, hasEbayMarketplaceDraft, canPreviewVinted, canPreviewEbay,
    canEditSharedFields, canEditEbayDetails, canRetryEbayGeneration, selectedMarketplaceStatus, showCardActions,
  };
}

// The card's own display name, per marketplace view. A structured-facts
// fallback (group.brand/group.model — the SHARED base columns, populated
// whenever EITHER marketplace's generation has run) sits between the
// marketplace's own generated title and the raw "Product N" placeholder,
// so a genuinely generated eBay title always wins over "Product N" the
// instant it exists — this is the exact DISPLAY-NAME FALLBACK ORDER
// required.
export function computeDisplayTitle(
  group: { brand: string | null; model: string | null; title: string | null },
  listing: GeneratedListingSummary | null,
  ebay: EbaySummary | null,
  marketplaceView: GenerationTarget,
): string {
  const structuredFallback = [group.brand, group.model].filter(Boolean).join(" ") || null;
  const vintedTitle = [listing?.brand ?? group.brand, listing?.model ?? group.model].filter(Boolean).join(" ") || null;
  const ebayTitle = ebay?.title || null;
  if (marketplaceView === "EBAY_UK") return ebayTitle || structuredFallback || vintedTitle || group.title || "Untitled group";
  if (marketplaceView === "VINTED") return vintedTitle || group.title || "Untitled group"; // unchanged from before this fix
  return vintedTitle || ebayTitle || structuredFallback || group.title || "Untitled group";
}
