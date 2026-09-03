/**
 * Corrective pass (failed first eBay draft) — the strict separation this
 * file exists to enforce:
 *
 *   1. Internal canonical condition  — EbayConditionState, already defined
 *      in lib/listing-studio/ebay-description-renderer.ts ("new" /
 *      "very_good_preowned" / "needs_review"). Set once, at generation
 *      time, from real evidence.
 *   2. User-facing display label     — conditionValueLabel() in
 *      lib/listing-studio/ebay-draft-generation.ts ("New" / "Used – Very
 *      Good"). What the UI shows under "CONDITION". Never touched by this
 *      file — the label stays exactly as generated.
 *   3. eBay API condition enum       — EbayInventoryConditionEnum, below.
 *      The ONLY thing that may ever appear in the `condition` field of an
 *      outgoing createOrReplaceInventoryItem payload.
 *
 * ROOT CAUSE this file closes: lib/listing-studio/ebay-draft-batches.ts
 * previously sent (2) directly where (3) was required — literally
 * `condition: draft.conditionValue ?? "USED_EXCELLENT"` — with a display
 * label like "Used – Very Good" passed straight through, and an unrelated
 * enum used as a silent fallback for "no condition at all". eBay's own
 * Inventory API rejected the display label (it is not one of the 16
 * ConditionEnum tokens), producing a generic "Invalid request" — see
 * lib/ebay-account/inventory-client.ts's own corrective-pass comment on
 * why that generic message was all that got captured.
 *
 * Enum values verified against eBay's own documentation
 * (developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html,
 * the "Item condition ID and name values" page, which cross-references
 * every numeric condition ID AND its display names to the exact
 * ConditionEnum token the Inventory API expects) — never guessed from
 * memory.
 */

export const EBAY_CONDITION_ENUM_VALUES = [
  "NEW",
  "NEW_OTHER",
  "NEW_WITH_DEFECTS",
  "CERTIFIED_REFURBISHED",
  "EXCELLENT_REFURBISHED",
  "VERY_GOOD_REFURBISHED",
  "GOOD_REFURBISHED",
  "SELLER_REFURBISHED",
  "LIKE_NEW",
  "PRE_OWNED_EXCELLENT",
  "USED_EXCELLENT",
  "PRE_OWNED_FAIR",
  "USED_VERY_GOOD",
  "USED_GOOD",
  "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING",
] as const;

export type EbayInventoryConditionEnum = (typeof EBAY_CONDITION_ENUM_VALUES)[number];

export type EbayConditionTranslation =
  | { ok: true; enumValue: EbayInventoryConditionEnum }
  | { ok: false; reason: string };

/** Lowercases, replaces every dash-family character (hyphen, en dash "–",
 * em dash "—", minus sign) and any run of whitespace/punctuation with a
 * single space, then trims — so "Used – Very Good", "used - very good",
 * "USED_VERY_GOOD", "Used, Very Good" and "used   very  good" all collapse
 * to the same lookup key ("used very good"). */
function normalize(label: string): string {
  return label
    .toLowerCase()
    .replace(/[‐-―\-−]/g, " ") // hyphen, en/em dash, minus sign
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Every normalized human-readable/legacy label this application is known
 * to have generated or could plausibly have stored, mapped to its correct
 * ConditionEnum token — cross-referenced against eBay's own condition-ID
 * table (see this file's header). Deliberately broad (covers every form
 * named in the corrective-pass audit requirement) even though today's
 * generation pipeline only ever produces two of these ("new" and
 * "very_good_preowned") — a legacy or manually-entered value must still
 * resolve correctly, or fail closed, never crash or guess.
 */
const LABEL_TO_ENUM: ReadonlyMap<string, EbayInventoryConditionEnum> = new Map([
  // NEW
  ["new", "NEW"], ["brand new", "NEW"], ["new with box", "NEW"], ["new with tags", "NEW"],
  ["new factory sealed", "NEW"], ["factory sealed", "NEW"], ["nwt", "NEW"], ["digital good", "NEW"],
  // NEW_OTHER
  ["new other", "NEW_OTHER"], ["new other see details", "NEW_OTHER"], ["new without box", "NEW_OTHER"],
  ["new without tags", "NEW_OTHER"], ["nwot", "NEW_OTHER"], ["open box", "NEW_OTHER"], ["new open box", "NEW_OTHER"],
  // NEW_WITH_DEFECTS
  ["new with defects", "NEW_WITH_DEFECTS"],
  // Refurbished family
  ["certified refurbished", "CERTIFIED_REFURBISHED"],
  ["excellent refurbished", "EXCELLENT_REFURBISHED"], ["refurbished excellent", "EXCELLENT_REFURBISHED"],
  ["very good refurbished", "VERY_GOOD_REFURBISHED"], ["refurbished very good", "VERY_GOOD_REFURBISHED"],
  ["good refurbished", "GOOD_REFURBISHED"], ["refurbished good", "GOOD_REFURBISHED"],
  ["seller refurbished", "SELLER_REFURBISHED"], ["remanufactured", "SELLER_REFURBISHED"],
  // LIKE_NEW
  ["like new", "LIKE_NEW"],
  // Pre-owned family
  ["pre owned excellent", "PRE_OWNED_EXCELLENT"],
  ["pre owned fair", "PRE_OWNED_FAIR"],
  // USED_EXCELLENT — "Used"/"Pre-owned" alone (condition ID 3000) map here,
  // per eBay's own condition-ID table — never used as a fallback for an
  // absent/unmapped value (see toEbayInventoryCondition below).
  ["used", "USED_EXCELLENT"], ["pre owned", "USED_EXCELLENT"], ["pre owned good", "USED_EXCELLENT"],
  ["used excellent", "USED_EXCELLENT"], ["open box used", "USED_EXCELLENT"],
  // USED_VERY_GOOD — this app's own "very_good_preowned" state's label.
  ["used very good", "USED_VERY_GOOD"], ["very good", "USED_VERY_GOOD"],
  // USED_GOOD
  ["used good", "USED_GOOD"], ["good", "USED_GOOD"],
  // USED_ACCEPTABLE
  ["used acceptable", "USED_ACCEPTABLE"], ["acceptable", "USED_ACCEPTABLE"],
  // FOR_PARTS_OR_NOT_WORKING
  ["for parts or not working", "FOR_PARTS_OR_NOT_WORKING"], ["for parts not working", "FOR_PARTS_OR_NOT_WORKING"],
  ["parts only", "FOR_PARTS_OR_NOT_WORKING"], ["not working", "FOR_PARTS_OR_NOT_WORKING"],
]);

/**
 * The one authoritative translator from whatever condition value this
 * application has stored (a display label, or already a valid enum token)
 * to a real eBay Inventory API ConditionEnum value — used identically by
 * eligibility (lib/listing-studio/ebay-draft-eligibility.ts), the batch
 * processor's final payload construction, and the retry path, so none of
 * them can ever disagree about whether a listing's condition is usable.
 *
 * FAILS CLOSED: null/empty input, or any string this dictionary doesn't
 * recognise, returns `{ ok: false, reason }` — never a guessed enum, and
 * never the old `?? "USED_EXCELLENT"` fallback (an absent condition is a
 * real blocker, not a silently-assumed one).
 */
export function toEbayInventoryCondition(conditionValue: string | null | undefined): EbayConditionTranslation {
  if (!conditionValue || !conditionValue.trim()) {
    return { ok: false, reason: "Missing or unsupported eBay condition." };
  }
  const normalized = normalize(conditionValue);
  // Already a valid enum token (case/spacing-insensitive) — e.g. a value
  // some future generation path stores pre-translated.
  const asEnum = conditionValue.trim().toUpperCase() as EbayInventoryConditionEnum;
  if ((EBAY_CONDITION_ENUM_VALUES as readonly string[]).includes(asEnum)) {
    return { ok: true, enumValue: asEnum };
  }
  const mapped = LABEL_TO_ENUM.get(normalized);
  if (mapped) return { ok: true, enumValue: mapped };
  return { ok: false, reason: "Missing or unsupported eBay condition." };
}
