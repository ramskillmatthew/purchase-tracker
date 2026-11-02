import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ebay-account/oauth", () => ({ ebayEnvironment: () => "PRODUCTION" }));

import { fetchEbayTradingItem, parseGetItemResponse } from "@/lib/ebay-account/trading-item-client";

const responseXml = `<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item><ItemID>123456789012</ItemID><Title>Topps Williams &amp; Collection</Title><Description><![CDATA[<p>Original complete description</p>]]></Description><PrimaryCategory><CategoryID>212</CategoryID><CategoryName>Trading Card Boxes</CategoryName></PrimaryCategory><ConditionDisplayName>Pre-owned - Excellent</ConditionDisplayName><Quantity>2</Quantity><SellingStatus><CurrentPrice currencyID="GBP">30.00</CurrentPrice></SellingStatus><PictureDetails><PictureURL>https://i.ebayimg.com/a.jpg</PictureURL><PictureURL>https://i.ebayimg.com/b.jpg</PictureURL></PictureDetails><ItemSpecifics><NameValueList><Name>Brand</Name><Value>Topps</Value></NameValueList><NameValueList><Name>Set</Name><Value>Williams 2026</Value></NameValueList></ItemSpecifics></Item></GetItemResponse>`;

describe("eBay Trading GetItem importer", () => {
  it("maps original photos, content, category, condition, price and item specifics", () => {
    expect(parseGetItemResponse(responseXml, "https://www.ebay.co.uk/itm/123456789012")).toMatchObject({
      title: "Topps Williams & Collection",
      description: "<p>Original complete description</p>",
      categoryId: "212",
      category: "Trading Card Boxes",
      condition: "Pre-owned - Excellent",
      pricePence: 3000,
      currency: "GBP",
      quantity: 2,
      imageUrls: ["https://i.ebayimg.com/a.jpg", "https://i.ebayimg.com/b.jpg"],
      itemSpecifics: { Brand: "Topps", Set: "Williams 2026" },
    });
  });

  it("uses the OAuth Trading API headers and asks eBay for all item specifics", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      expect(init?.headers).toMatchObject({ "X-EBAY-API-CALL-NAME": "GetItem", "X-EBAY-API-SITEID": "3", "X-EBAY-API-IAF-TOKEN": "oauth-token" });
      expect(String(init?.body)).toContain("<IncludeItemSpecifics>true</IncludeItemSpecifics>");
      expect(String(init?.body)).toContain("<DetailLevel>ReturnAll</DetailLevel>");
      return new Response(responseXml, { status: 200 });
    }));
    await expect(fetchEbayTradingItem("oauth-token", "https://www.ebay.co.uk/itm/123456789012")).resolves.toMatchObject({ itemId: "123456789012" });
  });
});
