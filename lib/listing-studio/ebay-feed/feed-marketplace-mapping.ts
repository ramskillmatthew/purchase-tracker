/**
 * CORRECTIVE PASS (first real Seller Hub Feed submission — Batch #1
 * failed with "The X-EBAY-C-MARKETPLACE-ID header is missing or invalid.")
 * — ROOT CAUSE: lib/ebay-account/feed-client.ts's createFeedTask never
 * sent this header at all. Confirmed against eBay's own published Sell
 * Feed API documentation this session (developer.ebay.com/api-docs/sell/
 * feed/resources/task/methods/createTask): `X-EBAY-C-MARKETPLACE-ID` is
 * Required for createTask, and the canonical MarketplaceIdEnum value for
 * Great Britain is `EBAY_GB` (locale en-GB) — never the CSV template's
 * own `SiteID=UK`/`Country=GB` values, which describe a completely
 * different thing (the template file's own internal schema identifier,
 * read by Seller Hub when it parses the uploaded CSV) and were never
 * wrong. Every other Feed API operation this app calls (getTask, getTasks,
 * uploadFile, getResultFile, getInputFile) was individually checked
 * against the same documentation and does NOT require this header — see
 * this module's own tests for the full per-operation matrix. This file is
 * the ONE place that internal marketplace identifier is ever translated
 * into the value a Feed API request header actually needs, so the two
 * concepts (CSV template constants vs. REST marketplace header) can never
 * drift back into being confused with each other again.
 *
 * Deliberately NOT derived by string manipulation (e.g. "EBAY_" +
 * template.country) — that would silently "work" for EBAY_UK -> EBAY_GB
 * only by coincidence of this app currently supporting a single
 * marketplace, and would happily produce a wrong-but-plausible-looking
 * value for any future marketplace whose ISO country code doesn't match
 * its eBay site code (there are several real-world examples of this on
 * eBay's own platform). This is an explicit, exhaustive, fully type-safe
 * table instead — see resolveEbayFeedMarketplace's own fail-closed
 * behaviour for anything not literally "EBAY_UK".
 */

import type { Marketplace } from "@/lib/listing-studio/marketplace-types";

/** eBay's own MarketplaceIdEnum value this app has ever verified — see
 * this file's header. Adding a second real eBay marketplace to this
 * codebase must extend this union deliberately, never implicitly. */
export type FeedMarketplaceId = "EBAY_GB";

export type EbayFeedMarketplaceMapping = {
  /** This application's own internal marketplace identifier
   * (lib/listing-studio/marketplace-types.ts's own Marketplace union). */
  internalMarketplace: "EBAY_UK";
  /** The exact, case-sensitive value the Sell Feed API's
   * X-EBAY-C-MARKETPLACE-ID header requires for createTask. */
  feedMarketplaceId: FeedMarketplaceId;
  /** The CSV template's own Action-header SiteID token — a wholly
   * different eBay vocabulary (Trading API "site" naming, embedded in the
   * literal Action(...) column header text) that happens to share no
   * value with feedMarketplaceId ("UK" vs. "EBAY_GB") despite describing
   * the same real marketplace. See template-contract.ts's own
   * TEMPLATE_SITE — this mapping's templateSiteId is asserted equal to
   * that constant by this module's own test, so the two can never
   * silently disagree. */
  templateSiteId: "UK";
  templateCountry: "GB";
  templateCurrency: "GBP";
  /** Not required by any Feed API operation this app calls (confirmed —
   * see this module's own header), but recorded here as part of the one
   * complete, authoritative mapping in case a future operation needs it
   * (e.g. Accept-Language/Content-Language, as inventory-client.ts already
   * sends for the unrelated Inventory API). */
  locale: "en-GB";
};

const EBAY_FEED_MARKETPLACE_MAPPING: Readonly<Record<"EBAY_UK", EbayFeedMarketplaceMapping>> = Object.freeze({
  EBAY_UK: Object.freeze({
    internalMarketplace: "EBAY_UK",
    feedMarketplaceId: "EBAY_GB",
    templateSiteId: "UK",
    templateCountry: "GB",
    templateCurrency: "GBP",
    locale: "en-GB",
  }),
});

/**
 * The ONE place an internal Marketplace value is ever translated into a
 * real eBay Sell Feed API marketplace mapping. Fails closed (throws) for
 * anything that isn't literally "EBAY_UK" — including "VINTED" (not a
 * real eBay marketplace at all) and any future marketplace value this
 * mapping hasn't been deliberately extended to cover — so an unmapped
 * marketplace can never silently fall through to a wrong-but-plausible
 * eBay header value.
 */
export function resolveEbayFeedMarketplace(marketplace: Marketplace): EbayFeedMarketplaceMapping {
  if (marketplace !== "EBAY_UK") {
    throw new Error(`"${marketplace}" has no eBay Sell Feed API marketplace mapping — only EBAY_UK is a real eBay marketplace in this application.`);
  }
  return EBAY_FEED_MARKETPLACE_MAPPING.EBAY_UK;
}

/** Convenience accessor for the one value createFeedTask actually needs —
 * exists so a call site never has to know the field name inside
 * EbayFeedMarketplaceMapping just to send one header. */
export function feedMarketplaceHeaderValue(marketplace: Marketplace): FeedMarketplaceId {
  return resolveEbayFeedMarketplace(marketplace).feedMarketplaceId;
}
