import type { EbayGender, EbayItemFamily } from "@/lib/listing-studio/ebay-title-builder";
import { EBAY_GENDER_POSSESSIVE_WORD } from "@/lib/listing-studio/ebay-title-builder";

/**
 * Deterministic eBay description RENDERER (product spec, "Problem 3") —
 * the AI must never freely invent the final description's formatting; this
 * module is the one place that assembles the exact required plain-text
 * template from structured facts, mirroring listing-template.ts's own
 * "AI supplies facts, code composes the final string" discipline for
 * Vinted. Required shape (verbatim from the product spec):
 *
 *   {Brand} {Model} {Gender}'s {ProductType} – UK {Size}
 *
 *   Genuine {Brand} {Model} {productType lowercase} in {colour lowercase}, UK size {Size}.
 *
 *   Condition: {condition sentence}
 *
 *   Details
 *   • Model: {Model}
 *   • Size: UK {Size}
 *   • Colour: {Colour}
 *   • Material: {Material}          (omitted when unknown)
 *   • Style code: {StyleCode}       (omitted when unknown)
 *   • Includes: {Includes}
 *   • SKU: {InternalSku}            (omitted when unreadable — see below;
 *                                     ALWAYS the last bullet when present)
 *
 *   Please review all photographs carefully as they form part of the
 *   condition description.
 *
 *   Orders are securely packaged and dispatched promptly.
 *
 * Every logical section is separated by exactly one blank line. No
 * markdown markers, no emojis, no bundle/discount language, no "look at
 * my other listings" — this renderer can never produce any of those by
 * construction, since it only ever assembles from a fixed set of plain
 * strings in a fixed shape.
 *
 * IMPORTANT — SKU vs style code, and where the SKU comes from: the
 * internal SKU bullet must be read from the SAME evidence pipeline the
 * working Vinted drafter already uses (the shared vision analysis's own
 * `sku` field — lib/listing-studio/listing-generation-schemas.ts's own
 * prompt: reads the white inventory sticker inside the shoe, searches
 * every photo, returns null on disagreement or if none is found, never
 * invents one). This module does not re-implement that extraction — the
 * caller (ebay-draft-generation.ts) passes the SAME `fields.sku.value`
 * Vinted's own generated_description already used. The manufacturer
 * style/product code is a completely separate fact and must never be
 * confused with it.
 */

export type EbayConditionState = "very_good_preowned" | "new" | "needs_review";

export const EBAY_STANDARD_PREOWNED_CONDITION_TEXT =
  "Very good pre-owned condition. Light signs of previous wear as shown in the photographs.";

const NEW_CONDITION_SIGNAL_PATTERN = /\b(brand new|deadstock|unworn|unused|new with tags|new without tags|nwt|nwot|factory sealed|still sealed)\b/i;
// Genuine defect/damage language the standard "light signs of previous
// wear" sentence would understate or misrepresent — never silently
// smoothed over into the standard wording; flagged for a human to write
// accurate condition text instead (per the product spec: "never use
// evasive text ... when the standard wording IS supported by evidence" —
// the corollary is equally true: never use the standard wording when it
// ISN'T supported).
const DAMAGE_SIGNAL_PATTERN = /\b(damage[d]?|stain(?:ed)?|hole[sd]?|tear(?:s|ed|ing)?|torn|crack(?:ed|s)?|scuff(?:ed|s)?|repair(?:ed)?|missing|broken|fault(?:y)?|defect(?:ive)?)\b/i;

export type EbayConditionResolution = { text: string | null; state: EbayConditionState };

/**
 * Resolves the condition sentence deterministically from whatever honest
 * evidence text the shared vision analysis produced (`fields.notes`, or
 * the eBay AI call's own `conditionSummary` — either is acceptable
 * evidence, never required). Defaults to the standard pre-owned sentence,
 * matching this business's own established Vinted default
 * (LISTING_CONDITION_TEXT) for the overwhelmingly common case: an
 * ordinary used item with no notable defects. Only deviates when the
 * evidence itself signals something materially different — a genuinely
 * new/unworn item, or a flagged defect that sentence would misrepresent —
 * and a flagged defect is never silently smoothed into the standard
 * sentence: it comes back `needs_review` with no fabricated wording.
 */
export function resolveEbayConditionText(evidence: string | null): EbayConditionResolution {
  const trimmed = evidence?.trim() || null;
  if (trimmed && NEW_CONDITION_SIGNAL_PATTERN.test(trimmed) && !DAMAGE_SIGNAL_PATTERN.test(trimmed)) {
    const clean = trimmed.replace(/\.+$/, "");
    return { text: `Brand new condition. ${clean}.`, state: "new" };
  }
  if (trimmed && DAMAGE_SIGNAL_PATTERN.test(trimmed)) {
    return { text: null, state: "needs_review" };
  }
  return { text: EBAY_STANDARD_PREOWNED_CONDITION_TEXT, state: "very_good_preowned" };
}

export type EbayDescriptionFacts = {
  brand: string | null;
  model: string | null;
  gender: EbayGender | null;
  productType: string | null;
  ukShoeSize: string | null;
  clothingSize: string | null;
  primaryColour: string | null;
  secondaryColour: string | null;
  material: string | null;
  styleCode: string | null;
  /** The seller's own internal inventory SKU — read via the SAME evidence
   * pipeline as Vinted's own `fields.sku.value`. Never invented; omitted
   * from the rendered description entirely when null. */
  internalSku: string | null;
  /** What's physically included with the sale, when known to differ from
   * "just the item" (e.g. "Trainers and original box"). Defaults to
   * "{ProductType} only" when null and productType is known — a safe,
   * non-invented default describing what's being sold, not an assumption
   * about condition or extras. */
  includesText: string | null;
  itemFamily: EbayItemFamily;
  conditionText: string;
};

function combineColours(primary: string | null, secondary: string | null, joiner = " "): string | null {
  if (primary && secondary) return `${primary}${joiner}${secondary}`;
  return primary ?? secondary ?? null;
}

function sizeLabel(facts: EbayDescriptionFacts): string | null {
  return facts.itemFamily === "footwear"
    ? (facts.ukShoeSize ? `UK ${facts.ukShoeSize}` : null)
    : (facts.clothingSize ? `Size ${facts.clothingSize}` : null);
}

/** Renders the exact required plain-text eBay description from structured
 * facts alone — no AI-authored prose anywhere in the output. */
export function renderEbayDescription(facts: EbayDescriptionFacts): string {
  const genderWord = facts.gender ? EBAY_GENDER_POSSESSIVE_WORD[facts.gender] : null;
  const size = sizeLabel(facts);

  const headlineParts = [facts.brand, facts.model, genderWord, facts.productType].filter((v): v is string => Boolean(v));
  let headline = headlineParts.join(" ");
  if (size) headline += headline ? ` – ${size}` : size;

  const namePart = [facts.brand, facts.model].filter(Boolean).join(" ");
  const productTypeLower = facts.productType ? facts.productType.toLowerCase() : null;
  // "and" reads as natural prose for two colours ("in blue and white");
  // the Details bullet below uses "&" instead, which suits a label better.
  const colourLower = combineColours(facts.primaryColour, facts.secondaryColour, " and ")?.toLowerCase() ?? null;
  let genuineSentence = namePart ? `Genuine ${namePart}` : "Genuine item";
  if (productTypeLower) genuineSentence += ` ${productTypeLower}`;
  const trailingClauses: string[] = [];
  if (colourLower) trailingClauses.push(`in ${colourLower}`);
  if (size) trailingClauses.push(facts.itemFamily === "footwear" ? `UK size ${facts.ukShoeSize}` : `size ${facts.clothingSize}`);
  if (trailingClauses.length) genuineSentence += ` ${trailingClauses.join(", ")}`;
  genuineSentence += ".";

  const conditionLine = `Condition: ${facts.conditionText}`;

  const detailBullets: string[] = [];
  if (facts.model) detailBullets.push(`Model: ${facts.model}`);
  if (size) detailBullets.push(`Size: ${size}`);
  const colourBullet = combineColours(facts.primaryColour, facts.secondaryColour, " & ");
  if (colourBullet) detailBullets.push(`Colour: ${colourBullet}`);
  if (facts.material) detailBullets.push(`Material: ${facts.material}`);
  if (facts.styleCode) detailBullets.push(`Style code: ${facts.styleCode}`);
  const includes = facts.includesText ?? (facts.productType ? `${facts.productType} only` : null);
  if (includes) detailBullets.push(`Includes: ${includes}`);
  // The internal SKU is deliberately appended LAST, after every other
  // Details bullet — the product spec's own explicit requirement — never
  // interleaved with manufacturer facts.
  if (facts.internalSku) detailBullets.push(`SKU: ${facts.internalSku}`);

  const blocks = [headline, genuineSentence, conditionLine];
  if (detailBullets.length > 0) blocks.push(["Details", ...detailBullets.map(bullet => `• ${bullet}`)].join("\n"));
  blocks.push("Please review all photographs carefully as they form part of the condition description.");
  blocks.push("Orders are securely packaged and dispatched promptly.");

  return blocks.filter(block => block.trim().length > 0).join("\n\n");
}
