import "server-only";
import type { EbayExtractedListing } from "@/lib/listing-studio/ebay-extractor";
import { extractEbayItemId, normaliseEbayUkUrl } from "@/lib/listing-studio/ebay-import";
import { ebayEnvironment } from "@/lib/ebay-account/oauth";

const COMPATIBILITY_LEVEL = "1423";

function decodeXml(value: string): string {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .trim();
}

function element(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : null;
}

function elements(source: string, tag: string): string[] {
  return [...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi"))]
    .map(match => decodeXml(match[1]));
}

function text(value: string | null): string | null {
  if (!value) return null;
  const cleaned = decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function itemSpecifics(itemXml: string): Record<string, string> {
  const container = element(itemXml, "ItemSpecifics") ?? "";
  const specifics: Record<string, string> = {};
  for (const row of elements(container, "NameValueList")) {
    const name = text(element(row, "Name"));
    const values = elements(row, "Value").map(text).filter((value): value is string => Boolean(value));
    if (name && values.length) specifics[name] = values.join(", ");
  }
  return specifics;
}

function specific(specifics: Record<string, string>, names: string[]): string | null {
  for (const [name, value] of Object.entries(specifics)) {
    if (names.some(candidate => candidate === name.toLowerCase())) return value;
  }
  return null;
}

function parsePricePence(itemXml: string): { pence: number | null; currency: string | null } {
  const priceMatch = itemXml.match(/<CurrentPrice(?:\s[^>]*)?>([\s\S]*?)<\/CurrentPrice>/i)
    ?? itemXml.match(/<BuyItNowPrice(?:\s[^>]*)?>([\s\S]*?)<\/BuyItNowPrice>/i);
  const numeric = priceMatch ? Number(decodeXml(priceMatch[1])) : Number.NaN;
  const currency = priceMatch?.[0].match(/currencyID=["']([^"']+)["']/i)?.[1] ?? null;
  return { pence: Number.isFinite(numeric) ? Math.round(numeric * 100) : null, currency };
}

export function parseGetItemResponse(xml: string, rawUrl: string): EbayExtractedListing {
  const ack = text(element(xml, "Ack"));
  if (!ack || !["Success", "Warning"].includes(ack)) {
    const message = text(element(xml, "LongMessage")) ?? text(element(xml, "ShortMessage")) ?? "eBay could not return this listing.";
    throw new Error(`eBay could not import this listing: ${message}`);
  }
  const item = element(xml, "Item");
  if (!item) throw new Error("eBay returned no listing details for this item.");
  const itemId = text(element(item, "ItemID")) ?? extractEbayItemId(rawUrl);
  const title = text(element(item, "Title"));
  if (!itemId || !title) throw new Error("eBay returned an incomplete listing.");
  const specifics = itemSpecifics(item);
  const price = parsePricePence(item);
  const pictureContainer = element(item, "PictureDetails") ?? "";
  const imageUrls = [...new Set(elements(pictureContainer, "PictureURL").filter(value => /^https:\/\//i.test(value)))].slice(0, 24);
  if (!imageUrls.length) throw new Error("eBay returned no photos for this listing.");
  const colour = specific(specifics, ["colour", "color"]);
  const quantityAvailableText = text(element(item, "QuantityAvailable"));
  const quantityText = text(element(item, "Quantity"));
  const quantityAvailable = quantityAvailableText === null ? Number.NaN : Number(quantityAvailableText);
  const quantity = Number.isFinite(quantityAvailable) && quantityAvailable >= 0
    ? quantityAvailable
    : quantityText === null ? Number.NaN : Number(quantityText);
  return {
    itemId,
    url: normaliseEbayUkUrl(rawUrl),
    title,
    // Preserve the seller's complete original description. The editor can
    // change it later; importing must not rewrite or AI-summarise it.
    description: element(item, "Description") ?? "",
    imageUrls,
    pricePence: price.pence,
    currency: price.currency ?? "GBP",
    condition: text(element(item, "ConditionDisplayName")),
    category: text(element(element(item, "PrimaryCategory") ?? "", "CategoryName")),
    categoryId: text(element(element(item, "PrimaryCategory") ?? "", "CategoryID")),
    brand: specific(specifics, ["brand"]),
    size: specific(specifics, ["uk shoe size", "shoe size", "size"]),
    colours: colour ? colour.split(/\s*(?:,|&|\/| and )\s*/i).filter(Boolean).slice(0, 2) : [],
    material: specific(specifics, ["upper material", "material"]),
    quantity: Number.isFinite(quantity) ? Math.max(1, Math.trunc(quantity)) : 1,
    itemSpecifics: specifics,
  };
}

/** Reads the seller's original listing directly from eBay using the
 * connected account. No browser extension or page scraping is involved. */
export async function fetchEbayTradingItem(accessToken: string, rawUrl: string): Promise<EbayExtractedListing> {
  const url = normaliseEbayUkUrl(rawUrl);
  const itemId = extractEbayItemId(url);
  if (!itemId) throw new Error("This is not a supported eBay UK item URL.");
  const endpoint = ebayEnvironment() === "SANDBOX" ? "https://api.sandbox.ebay.com/ws/api.dll" : "https://api.ebay.com/ws/api.dll";
  const body = `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><DetailLevel>ReturnAll</DetailLevel><ItemID>${escapeXml(itemId)}</ItemID><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-CALL-NAME": "GetItem",
      "X-EBAY-API-SITEID": "3",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPATIBILITY_LEVEL,
      "X-EBAY-API-IAF-TOKEN": accessToken,
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const xml = await response.text();
  if (!response.ok) throw new Error(`eBay could not return the listing (${response.status}).`);
  return parseGetItemResponse(xml, url);
}
