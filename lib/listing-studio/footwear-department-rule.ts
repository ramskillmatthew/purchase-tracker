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

const BELOW_UK_7_THRESHOLD = 6.5;

/** Parses a UK shoe size string ("4", "6.5", "6") and reports whether it
 * falls at or below the UK 6.5 boundary. A size that can't be parsed as a
 * plain number (null, empty, non-numeric) is never treated as "below 7" —
 * the rule only ever fires on a genuinely known, confirmed UK size. */
export function isFootwearSizeBelowUk7(ukShoeSize: string | null | undefined): boolean {
  if (!ukShoeSize) return false;
  const parsed = Number.parseFloat(ukShoeSize.trim());
  if (!Number.isFinite(parsed)) return false;
  return parsed <= BELOW_UK_7_THRESHOLD;
}

/** True when this item family/size combination is subject to the
 * mandatory-Women's rule. `itemFamily` gates it to footwear only — the
 * rule has no meaning for clothing/uncertain items. */
export function requiresWomensDepartment(itemFamily: string, ukShoeSize: string | null | undefined): boolean {
  return itemFamily === "footwear" && isFootwearSizeBelowUk7(ukShoeSize);
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
