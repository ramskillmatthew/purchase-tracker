/**
 * The ONE deterministic, marketplace-neutral footwear-department business
 * rule: any UK shoe size of 6.5 or below is always Women's — never Men's,
 * never Children's/Junior/Boys'/Girls'/Infant/Kids', regardless of what an
 * AI suggestion, a manufacturer's own model data, or eBay's own taxonomy
 * confidence says. This is an intentional application policy (reflecting
 * real UK resale buyer search behaviour for small-sized footwear), not an
 * AI inference — it is applied only to a shoe size the app already holds
 * as a confirmed fact, never guessed from anything else.
 *
 * This is deliberately the ONE shared primitive both eBay and Vinted
 * pathways call, so the two marketplaces can never disagree about
 * department for the same product. See ebay-aspect-service.ts's Department
 * candidate and ebay-category-review.ts's category-confidence resolution
 * for the two places eBay currently applies it.
 */

const WOMENS_MIN_UK_SIZE = 3;
const WOMENS_MAX_UK_SIZE = 6.5;
const MENS_MIN_UK_SIZE = 7;

export type FootwearDepartment = "Women" | "Men";

function parseUkShoeSize(ukShoeSize: string | null | undefined): number | null {
  if (!ukShoeSize) return null;
  const parsed = Number.parseFloat(ukShoeSize.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses a UK shoe size string ("4", "6.5", "6") and reports whether it
 * falls at or below the UK 6.5 boundary. A size that can't be parsed as a
 * plain number (null, empty, non-numeric) is never treated as "below 7" —
 * the rule only ever fires on a genuinely known, confirmed UK size. */
export function isFootwearSizeBelowUk7(ukShoeSize: string | null | undefined): boolean {
  const parsed = parseUkShoeSize(ukShoeSize);
  return parsed !== null && parsed >= WOMENS_MIN_UK_SIZE && parsed <= WOMENS_MAX_UK_SIZE;
}

/** The business' complete adult-footwear department rule. Children's is
 * never a valid footwear department in this app: UK 3–6.5 is Women's and
 * UK 7+ is Men's. Values below UK 3 or malformed values are left unresolved
 * rather than guessed, but children's categories are still excluded by the
 * category pipeline. */
export function requiredFootwearDepartment(itemFamily: string, ukShoeSize: string | null | undefined): FootwearDepartment | null {
  if (itemFamily !== "footwear") return null;
  const parsed = parseUkShoeSize(ukShoeSize);
  if (parsed === null) return null;
  if (parsed >= WOMENS_MIN_UK_SIZE && parsed <= WOMENS_MAX_UK_SIZE) return "Women";
  if (parsed >= MENS_MIN_UK_SIZE) return "Men";
  return null;
}

/** True when this item family/size combination is subject to the
 * mandatory-Women's rule. `itemFamily` gates it to footwear only — the
 * rule has no meaning for clothing/uncertain items. */
export function requiresWomensDepartment(itemFamily: string, ukShoeSize: string | null | undefined): boolean {
  return requiredFootwearDepartment(itemFamily, ukShoeSize) === "Women";
}

export function requiresMensDepartment(itemFamily: string, ukShoeSize: string | null | undefined): boolean {
  return requiredFootwearDepartment(itemFamily, ukShoeSize) === "Men";
}

/** Whether a category's own display text (name and/or full path) already
 * represents a genuinely Women's category — used both to recognise when
 * eBay's own top suggestion already satisfies the rule, and to find a
 * Women's alternative among eBay's other suggestions when it doesn't.
 * Deliberately simple case-insensitive substring matching, matching every
 * real eBay UK category path this app has seen (e.g. "Women's Shoes >
 * Women > Clothes, Shoes & Accessories > Trainers") — never a fabricated
 * category, only ever recognising real eBay text. */
export function categoryTextIndicatesWomens(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bwomen'?s\b|\bwomen\b/i.test(text);
}

export function categoryTextIndicatesMens(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bmen'?s\b|\bmen\b/i.test(text) && !categoryTextIndicatesWomens(text);
}

export function categoryTextIndicatesChildrens(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(?:children'?s?|kids?|junior'?s?|youth|boys?|girls?|infant|toddler)\b/i.test(text);
}

export function categoryTextMatchesFootwearDepartment(text: string | null | undefined, department: FootwearDepartment): boolean {
  if (categoryTextIndicatesChildrens(text)) return false;
  return department === "Women" ? categoryTextIndicatesWomens(text) : categoryTextIndicatesMens(text);
}
