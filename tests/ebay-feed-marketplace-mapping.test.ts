import { describe, expect, it } from "vitest";
import { resolveEbayFeedMarketplace, feedMarketplaceHeaderValue } from "@/lib/listing-studio/ebay-feed/feed-marketplace-mapping";
import { TEMPLATE_SITE, TEMPLATE_COUNTRY, TEMPLATE_CURRENCY } from "@/lib/listing-studio/ebay-feed/template-contract";

describe("resolveEbayFeedMarketplace — REQUIREMENT (Phase 3): one explicit, typed, exhaustive mapping", () => {
  it("EBAY_UK maps to the canonical Feed API marketplace ID EBAY_GB", () => {
    expect(resolveEbayFeedMarketplace("EBAY_UK").feedMarketplaceId).toBe("EBAY_GB");
  });

  it("feedMarketplaceHeaderValue is the same convenience accessor", () => {
    expect(feedMarketplaceHeaderValue("EBAY_UK")).toBe("EBAY_GB");
  });

  it("the mapping's templateSiteId/templateCountry/templateCurrency never drift from template-contract.ts's own constants", () => {
    const mapping = resolveEbayFeedMarketplace("EBAY_UK");
    expect(mapping.templateSiteId).toBe(TEMPLATE_SITE);
    expect(mapping.templateCountry).toBe(TEMPLATE_COUNTRY);
    expect(mapping.templateCurrency).toBe(TEMPLATE_CURRENCY);
  });

  it("the mapping's locale is en-GB", () => {
    expect(resolveEbayFeedMarketplace("EBAY_UK").locale).toBe("en-GB");
  });

  it("REQUIREMENT: an unknown/unmapped marketplace fails closed (throws) rather than falling through to a guessed value — VINTED is a valid internal Marketplace but not a real eBay one", () => {
    expect(() => resolveEbayFeedMarketplace("VINTED")).toThrow(/no eBay Sell Feed API marketplace mapping/i);
  });

  it("REQUIREMENT: a genuinely unknown string also fails closed", () => {
    // @ts-expect-error deliberately testing a runtime value outside the type
    expect(() => resolveEbayFeedMarketplace("EBAY_DE")).toThrow(/no eBay Sell Feed API marketplace mapping/i);
  });

  it("the returned mapping is frozen — a caller can never mutate the shared table", () => {
    const mapping = resolveEbayFeedMarketplace("EBAY_UK");
    expect(Object.isFrozen(mapping)).toBe(true);
  });
});
