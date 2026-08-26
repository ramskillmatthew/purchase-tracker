import { describe, expect, it } from "vitest";
import { extractEbayItemId, normaliseEbayUkUrl, validateAndDedupeEbayUrls } from "@/lib/listing-studio/ebay-import";

describe("eBay UK import URL validation", () => {
  it("accepts common UK item URL shapes and canonicalises them", () => {
    expect(normaliseEbayUkUrl("https://www.ebay.co.uk/itm/Nike-shoes/123456789012?foo=bar")).toBe("https://www.ebay.co.uk/itm/123456789012");
    expect(extractEbayItemId("https://www.ebay.co.uk/itm/123456789012")).toBe("123456789012");
  });

  it("rejects arbitrary hosts, insecure URLs and non-item pages", () => {
    expect(() => normaliseEbayUkUrl("https://evil.example/itm/123456789012")).toThrow("Only eBay UK");
    expect(() => normaliseEbayUkUrl("http://www.ebay.co.uk/itm/123456789012")).toThrow("https");
    expect(() => normaliseEbayUkUrl("https://www.ebay.co.uk/sch/i.html")).toThrow("item number");
  });

  it("deduplicates canonical item URLs while retaining useful validation errors", () => {
    const result = validateAndDedupeEbayUrls([
      "https://www.ebay.co.uk/itm/Thing/123456789012",
      "https://ebay.co.uk/itm/123456789012?hash=x",
      "not a url",
    ]);
    expect(result.urls).toEqual(["https://www.ebay.co.uk/itm/123456789012"]);
    expect(result.errors).toHaveLength(1);
  });
});
