/**
 * Stage 2/3 scaffold for eBay UK "SEO optimised" title/description
 * generation. Deliberately deterministic (no AI call) for the same reason
 * lib/listing-studio/listing-template.ts is deterministic for Vinted: the
 * structured facts are the canonical, editable source of truth, and
 * text is always *derived* from them, never independently generated
 * free-form. This keeps Stage 2-3 genuinely usable/demonstrable without
 * requiring Stage 4's category service or a second bespoke AI prompt to
 * exist first — a category-aware AI copywriting pass can replace this
 * function's body later without changing anything about how eBay drafts
 * are stored, since callers only ever see its title/description output.
 *
 * Tone is deliberately professional (no emoji, no casual marketing
 * filler) — distinct from the Vinted template's casual Vinted-marketplace
 * voice, matching this feature's "professional eBay UK drafts" goal.
 * Never invents a fact that isn't in `fields` — see this module's own
 * tests for the exact "leave it out, don't guess" behaviour.
 */

export type EbayGeneratedListingFields = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  colours: string[];
  material: string | null;
  ukSize: string | null;
  conditionLabel: string | null;
};

// eBay's own real title limit — never exceeded, even by truncating a
// composed title mid-word where a whole-word truncation is possible.
export const EBAY_TITLE_MAX_LENGTH = 80;

function normalizePart(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function truncateAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const slice = value.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

/**
 * Exact format: `Brand Model Product Type - Colour - Size UK X`. Any
 * missing field is simply omitted from its segment (never a malformed
 * double space or empty label) — same graceful-degradation rule as the
 * Vinted template. Capped at EBAY_TITLE_MAX_LENGTH, truncating at the last
 * whole word that fits rather than mid-word.
 */
export function generateEbayTitle(fields: EbayGeneratedListingFields): string {
  const namePart = [normalizePart(fields.brand), normalizePart(fields.model), normalizePart(fields.productType)]
    .filter((part): part is string => part !== null)
    .join(" ");
  const colour = fields.colours.length ? fields.colours.join(" ") : null;
  const ukSize = normalizePart(fields.ukSize);

  const segments = [namePart || null, colour, ukSize ? `Size UK ${ukSize}` : null]
    .filter((segment): segment is string => segment !== null);
  return truncateAtWordBoundary(segments.join(" - "), EBAY_TITLE_MAX_LENGTH);
}

/**
 * A short, factual, professional-toned paragraph built only from supplied
 * fields — never a fabricated claim about condition, authenticity, or
 * included accessories. Genuinely blank fields simply don't produce a
 * sentence about them (unlike the Vinted template, which fills every
 * section with fixed text regardless of what's known) since the whole
 * point of "exact copy vs SEO optimised" content mode is that SEO-optimised
 * copy still only ever states verified facts.
 */
export function generateEbayDescription(fields: EbayGeneratedListingFields): string {
  const namePart = [normalizePart(fields.brand), normalizePart(fields.model), normalizePart(fields.productType)]
    .filter((part): part is string => part !== null)
    .join(" ");
  const sentences: string[] = [];
  if (namePart) sentences.push(`${namePart}.`);
  if (fields.colours.length) sentences.push(`Colour: ${fields.colours.join(", ")}.`);
  if (fields.material) sentences.push(`Material: ${fields.material}.`);
  if (fields.ukSize) sentences.push(`Size: UK ${fields.ukSize}.`);
  if (fields.conditionLabel) sentences.push(`Condition: ${fields.conditionLabel}.`);
  return sentences.join(" ");
}
