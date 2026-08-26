import { z } from "zod";

export const MAX_EBAY_IMPORT_URLS = 50;

export type EbayImportStatus = "waiting" | "extracting" | "downloading_photos" | "processing" | "imported" | "failed";

export function normaliseEbayUkUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Enter an eBay UK item URL.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("This is not a valid URL."); }
  if (parsed.protocol !== "https:") throw new Error("eBay URLs must use https.");
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "ebay.co.uk") throw new Error("Only eBay UK item URLs are supported.");
  const itemId = extractEbayItemId(parsed.toString());
  if (!itemId) throw new Error("The eBay item number could not be found in this URL.");
  return `https://www.ebay.co.uk/itm/${itemId}`;
}

export function extractEbayItemId(value: string): string | null {
  const patterns = [/\/itm\/(?:[^/?#]+\/)?(\d{9,15})(?:[/?#]|$)/i, /[?&]item=(\d{9,15})(?:&|$)/i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export const createEbayImportSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(MAX_EBAY_IMPORT_URLS),
});

export function validateAndDedupeEbayUrls(urls: string[]): { urls: string[]; errors: { input: string; error: string }[] } {
  const valid: string[] = [];
  const seen = new Set<string>();
  const errors: { input: string; error: string }[] = [];
  for (const input of urls) {
    try {
      const url = normaliseEbayUkUrl(input);
      if (!seen.has(url)) { seen.add(url); valid.push(url); }
    } catch (error) { errors.push({ input, error: error instanceof Error ? error.message : "Invalid URL." }); }
  }
  return { urls: valid, errors };
}

export function isEbayImportMigrationMissing(error: unknown): boolean {
  return error instanceof Error && /ebay_import_(?:batches|items).*does not exist|could not find the table.*ebay_import_|schema cache.*ebay_import_/i.test(error.message);
}
