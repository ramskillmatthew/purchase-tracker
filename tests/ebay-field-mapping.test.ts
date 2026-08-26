import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mapEbayListingFields } from "@/lib/listing-studio/ebay-field-mapping";
import type { EbayExtractedListing } from "@/lib/listing-studio/ebay-extractor";

function listing(overrides: Partial<EbayExtractedListing> = {}): EbayExtractedListing {
  return {
    itemId: "123456789012", url: "https://www.ebay.co.uk/itm/123456789012", title: "Example", description: "Example",
    imageUrls: ["https://i.ebayimg.com/example.jpg"], pricePence: 1299, currency: "GBP", condition: "New",
    category: "Collectables", brand: null, size: null, colours: [], material: null, quantity: 1, itemSpecifics: {}, ...overrides,
  };
}

describe("eBay item-specific field mapping", () => {
  it("fills the editable review fields from common eBay item-specific names", () => {
    expect(mapEbayListingFields(listing({ itemSpecifics: {
      Brand: "Topps", Type: "Sports Trading Card", Set: "Topps Chrome 2026", Colour: "Black & Red", Material: "Cardboard", Department: "Unisex Adults", Size: "One Size",
    } }))).toEqual({
      brand: "Topps", model: "Topps Chrome 2026", productType: "Sports Trading Card", colours: ["Black", "Red"], material: "Cardboard", size: "One Size", audience: "unisex",
    });
  });

  it("leaves unsupported or absent values blank instead of inventing data", () => {
    expect(mapEbayListingFields(listing({ itemSpecifics: { Colour: "Neon rainbow", Department: "Collectors" } }))).toMatchObject({ colours: [], audience: null, model: null });
  });
});
