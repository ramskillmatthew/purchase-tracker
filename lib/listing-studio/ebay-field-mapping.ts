import { VINTED_COLOURS, VINTED_MATERIALS, type VintedAudienceValue } from "./listing-generation-schemas";
import type { EbayExtractedListing } from "./ebay-extractor";

function specific(specifics: Record<string, string>, names: string[]): string | null {
  const wanted = new Set(names.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const [key, value] of Object.entries(specifics)) {
    if (wanted.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) && value.trim()) return value.trim();
  }
  return null;
}

function allowedValue(value: string | null, allowed: readonly string[]): string | null {
  if (!value) return null;
  const exact = allowed.find(option => option.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  return allowed.find(option => new RegExp(`\\b${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(value)) ?? null;
}

function mapAudience(value: string | null): VintedAudienceValue | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (/\b(women|women's|female|ladies|lady)\b/.test(text)) return "womens";
  if (/\b(men|men's|male)\b/.test(text)) return "mens";
  if (/\b(girl|girl's|girls)\b/.test(text)) return "girls";
  if (/\b(boy|boy's|boys)\b/.test(text)) return "boys";
  if (/\b(unisex|adult unisex)\b/.test(text)) return "unisex";
  return null;
}

export function mapEbayListingFields(listing: EbayExtractedListing) {
  const specifics = listing.itemSpecifics;
  const rawColours = listing.colours.length ? listing.colours : (specific(specifics, ["Colour", "Color", "Main Colour"])?.split(/\s*(?:,|&|\/| and )\s*/i) ?? []);
  const colours = [...new Set(rawColours.map(value => allowedValue(value, VINTED_COLOURS)).filter((value): value is string => Boolean(value)))].slice(0, 2);
  const material = allowedValue(listing.material ?? specific(specifics, ["Material", "Upper Material", "Main Material"]), VINTED_MATERIALS);
  const department = specific(specifics, ["Department", "Gender", "Audience", "Age Group"]);

  return {
    brand: listing.brand ?? specific(specifics, ["Brand", "Manufacturer"]),
    model: specific(specifics, ["Model", "Style", "Series", "Set", "Collection", "Product Line"]),
    productType: specific(specifics, ["Product Type", "Type", "Item Type", "Configuration"]) ?? listing.category,
    colours,
    material,
    size: listing.size ?? specific(specifics, ["UK Shoe Size", "Shoe Size", "Size", "Clothing Size"]),
    audience: mapAudience(department),
  };
}
