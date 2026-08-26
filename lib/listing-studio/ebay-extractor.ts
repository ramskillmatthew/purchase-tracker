import "server-only";
import { extractEbayItemId, normaliseEbayUkUrl } from "./ebay-import";

export type EbayExtractedListing = {
  itemId: string;
  url: string;
  title: string;
  description: string;
  imageUrls: string[];
  pricePence: number | null;
  currency: string | null;
  condition: string | null;
  category: string | null;
  brand: string | null;
  size: string | null;
  colours: string[];
  material: string | null;
  quantity: number | null;
  itemSpecifics: Record<string, string>;
};

const PAGE_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 5_000_000;
const MAX_IMAGES = 24;

function decodeHtml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).trim();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = decodeHtml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function meta(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) { const match = html.match(pattern); if (match) return cleanText(match[1]); }
  return null;
}

function collectJsonLd(html: string): unknown[] {
  const values: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try { values.push(JSON.parse(match[1].trim())); } catch { /* malformed third-party JSON-LD is ignored */ }
  }
  return values;
}

function findProduct(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) { for (const child of value) { const found = findProduct(child); if (found) return found; } return null; }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const type = row["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return row;
  for (const key of ["@graph", "mainEntity", "itemListElement"]) { const found = findProduct(row[key]); if (found) return found; }
  return null;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return strings(row.url ?? row.contentUrl ?? row.image);
  }
  return [];
}

function specificsFrom(product: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const properties = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  for (const property of properties) {
    if (!property || typeof property !== "object") continue;
    const row = property as Record<string, unknown>;
    const name = cleanText(row.name);
    const value = cleanText(row.value);
    if (name && value) result[name] = value;
  }
  return result;
}

function specific(specifics: Record<string, string>, names: string[]): string | null {
  for (const [key, value] of Object.entries(specifics)) if (names.some(name => key.toLowerCase() === name)) return value;
  return null;
}

export async function extractEbayListing(rawUrl: string): Promise<EbayExtractedListing> {
  const url = normaliseEbayUkUrl(rawUrl);
  const itemId = extractEbayItemId(url)!;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", cache: "no-store", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; TrottersAttireListingImporter/1.0)", "Accept-Language": "en-GB,en;q=0.9", Accept: "text/html,application/xhtml+xml" } });
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`eBay returned status ${response.status}. Try the URL again shortly.`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_PAGE_BYTES) throw new Error("The eBay page was too large to import safely.");
  const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
  if (/captcha|verify you are human|pardon our interruption/i.test(html)) throw new Error("eBay asked for human verification. Retry this listing later.");

  const product = collectJsonLd(html).map(findProduct).find(Boolean) ?? {};
  const title = cleanText(product.name) ?? meta(html, "og:title");
  if (!title) throw new Error("The listing title could not be extracted. Check that the item is still available.");
  const description = cleanText(product.description) ?? meta(html, "og:description") ?? meta(html, "description") ?? "";
  const specifics = specificsFrom(product);
  const offers = product.offers && typeof product.offers === "object" ? product.offers as Record<string, unknown> : {};
  const price = Number(offers.price ?? meta(html, "og:price:amount"));
  const imageUrls = [...new Set([...strings(product.image), meta(html, "og:image") ?? ""].filter(value => /^https:\/\//i.test(value)))].slice(0, MAX_IMAGES);
  if (!imageUrls.length) throw new Error("No listing photos could be extracted.");
  const colour = specific(specifics, ["colour", "color"]);
  return {
    itemId, url, title, description, imageUrls,
    pricePence: Number.isFinite(price) ? Math.round(price * 100) : null,
    currency: cleanText(offers.priceCurrency) ?? meta(html, "og:price:currency"),
    condition: cleanText(product.itemCondition) ?? specific(specifics, ["condition"]),
    category: cleanText(product.category),
    brand: cleanText(typeof product.brand === "object" && product.brand ? (product.brand as Record<string, unknown>).name : product.brand) ?? specific(specifics, ["brand"]),
    size: specific(specifics, ["uk shoe size", "shoe size", "size"]),
    colours: colour ? colour.split(/\s*(?:,|&|\/| and )\s*/i).filter(Boolean).slice(0, 2) : [],
    material: specific(specifics, ["upper material", "material"]),
    quantity: Number.isFinite(Number(offers.inventoryLevel)) ? Number(offers.inventoryLevel) : null,
    itemSpecifics: specifics,
  };
}
