import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { extractEbayListing } from "@/lib/listing-studio/ebay-extractor";

afterEach(() => vi.unstubAllGlobals());

describe("eBay listing extractor", () => {
  it("extracts the title, original description, photos, price and item specifics from Product JSON-LD", async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "Nike Air Max 95 UK 9", description: "Original seller description",
      image: ["https://i.ebayimg.com/images/g/one/s-l1600.jpg", "https://i.ebayimg.com/images/g/two/s-l1600.jpg"],
      brand: { "@type": "Brand", name: "Nike" }, category: "Men's Trainers",
      offers: { price: "79.99", priceCurrency: "GBP", inventoryLevel: 2 },
      additionalProperty: [{ name: "UK Shoe Size", value: "9" }, { name: "Colour", value: "Black & Grey" }, { name: "Upper Material", value: "Mesh" }],
    })}</script></head></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await extractEbayListing("https://www.ebay.co.uk/itm/123456789012");
    expect(result).toMatchObject({ itemId: "123456789012", title: "Nike Air Max 95 UK 9", description: "Original seller description", brand: "Nike", category: "Men's Trainers", size: "9", colours: ["Black", "Grey"], material: "Mesh", pricePence: 7999, currency: "GBP", quantity: 2 });
    expect(result.imageUrls).toHaveLength(2);
  });

  it("fails clearly when eBay serves a human-verification page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Verify you are human captcha</html>", { status: 200 })));
    await expect(extractEbayListing("https://www.ebay.co.uk/itm/123456789012")).rejects.toThrow("human verification");
  });
});
