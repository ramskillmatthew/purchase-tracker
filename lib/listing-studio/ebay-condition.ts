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
 * Enum values verified against eBay's own documentation — fetched twice,
 * independently, from developer.ebay.com/api-docs/user-guides/static/
 * mip-user-guide/mip-enum-conditions.html (the "Conditions enumerated
 * values" reference, which lists all 16 ConditionEnum tokens against
 * their numeric condition IDs and every display name eBay itself uses)
 * and cross-checked against
 * developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html
 * — both agree on the same 16 tokens. Never guessed from memory. Enum
 * VALIDITY (is this a real ConditionEnum token) is intentionally kept
 * separate from category ELIGIBILITY (does eBay's UK "Trainers" category
 * accept this specific value) — this file only proves the former; a
 * category-specific rejection would still need to surface eBay's own
 * error via lib/ebay-account/ebay-error.ts, never guessed here.
 *
 * SAFETY CORRECTION (this pass) — the previous version of this file's
 * LABEL_TO_ENUM dictionary copied eBay's own "condition ID -> every
 * display name eBay's OWN UI uses for that ID" table too literally,
 * including entries where a BARE, ungraded word (no explicit quality
 * descriptor at all) was treated as if it safely implied a specific
 * grade: "used" and "pre owned" mapped to USED_EXCELLENT — one of the
 * BETTER used grades — merely because that happens to be one of eBay's
 * own historical display synonyms for condition ID 3000. That is an
 * OPTIMISTIC upgrade of an ambiguous input, not a safe translation: a
 * value this application stores as bare "Used" (with no further detail)
 * carries no evidence it deserves "Excellent" specifically, and treating
 * it as if it does risks materially overstating a listing's condition to
 * a buyer. The same reasoning applies to bare "Good" (eBay's OWN table
 * has TWO different display names containing the word "Good" — plain
 * "Good" for USED_GOOD, and "Good - Refurbished" for GOOD_REFURBISHED —
 * so the bare word is genuinely ambiguous even within eBay's own
 * vocabulary) and to "Fair" (kept only in its one explicit, unambiguous
 * eBay-documented compound form). "Open Box" is similarly listed as a
 * display synonym for BOTH NEW_OTHER (id 1500) and USED_EXCELLENT
 * (id 3000, "Open Box/Used") in eBay's own table — the "…/Used" compound
 * form has been removed entirely rather than guessed at.
 *
 * The rule this file now follows: a label is only ever mapped when it
 * EXPLICITLY names its own grade (e.g. "Very Good", "Excellent",
 * "Acceptable", "Refurbished" + a grade word) — never when the grade is
 * merely implied by which numeric condition ID eBay's own UI happens to
 * default a bare word to. Every entry below is annotated with why it is
 * safe. Audited input-source note: as of this pass, the ONLY code path
 * that ever writes listing_marketplace_drafts.condition_value is
 * app/api/listing-studio/groups/[draftId]/generate/route.ts, which reads
 * it straight from conditionValueLabel() in
 * lib/listing-studio/ebay-draft-generation.ts — itself driven by the
 * internal canonical EbayConditionState ("new" / "very_good_preowned" /
 * "needs_review", the last of which is written as `null`). That function
 * can currently only ever produce "New", "Used – Very Good", or null —
 * both of which remain safely, unambiguously mapped below. No route lets
 * a client set this field directly (grep-confirmed). The broader
 * dictionary below exists defensively for a legacy/future value, never
 * because today's real data needs it to be broad.
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

const MISSING_OR_UNSUPPORTED = "Missing or unsupported eBay condition.";
const AMBIGUOUS = "Choose a specific eBay condition.";

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
 * Normalized labels that this application will NOT translate, even though
 * they resemble a real eBay condition, because eBay's own vocabulary
 * genuinely does not settle what grade they mean (bare "used"/"pre owned"
 * name no grade at all; bare "good" collides with "Good - Refurbished").
 * Checked BEFORE the real mapping table so an ambiguous term can never
 * accidentally match some other, unrelated entry — and reported with the
 * more specific AMBIGUOUS message rather than the generic
 * MISSING_OR_UNSUPPORTED one, so the UI can tell a user "pick a grade"
 * rather than "this text means nothing to us".
 */
const AMBIGUOUS_TERMS: ReadonlySet<string> = new Set([
  "used", "pre owned", "preowned",
  "good", "pre owned good",
  "fair",
  "open box used",
]);

/**
 * Every normalized label this file will translate, mapped to its correct
 * ConditionEnum token. Every entry below EXPLICITLY names its own grade —
 * see this file's own header for the full safety rationale on why a bare,
 * ungraded word is deliberately absent (listed in AMBIGUOUS_TERMS above
 * instead) rather than optimistically mapped.
 */
const LABEL_TO_ENUM: ReadonlyMap<string, EbayInventoryConditionEnum> = new Map([
  // NEW — every entry explicitly signals "unopened/original" (box, tags,
  // factory-sealed) or is eBay's own bare "New", which has no competing
  // eBay condition sharing that exact word.
  ["new", "NEW"], ["brand new", "NEW"], ["new with box", "NEW"], ["new with tags", "NEW"],
  ["new factory sealed", "NEW"], ["factory sealed", "NEW"], ["nwt", "NEW"], ["digital good", "NEW"],
  // NEW_OTHER — explicitly signals "no longer sealed/boxed" without
  // claiming used condition. The "…/Used" compound eBay separately lists
  // for condition ID 3000 is deliberately NOT included here (see
  // AMBIGUOUS_TERMS's "open box used").
  ["new other", "NEW_OTHER"], ["new other see details", "NEW_OTHER"], ["new without box", "NEW_OTHER"],
  ["new without tags", "NEW_OTHER"], ["nwot", "NEW_OTHER"], ["open box", "NEW_OTHER"], ["new open box", "NEW_OTHER"],
  // NEW_WITH_DEFECTS — explicit.
  ["new with defects", "NEW_WITH_DEFECTS"],
  // Refurbished family — every entry explicitly pairs a grade word with
  // "refurbished"; a bare grade word alone (e.g. "excellent") is never
  // accepted as implying refurbished condition.
  ["certified refurbished", "CERTIFIED_REFURBISHED"],
  ["excellent refurbished", "EXCELLENT_REFURBISHED"], ["refurbished excellent", "EXCELLENT_REFURBISHED"],
  ["very good refurbished", "VERY_GOOD_REFURBISHED"], ["refurbished very good", "VERY_GOOD_REFURBISHED"],
  ["good refurbished", "GOOD_REFURBISHED"], ["refurbished good", "GOOD_REFURBISHED"],
  ["seller refurbished", "SELLER_REFURBISHED"], ["remanufactured", "SELLER_REFURBISHED"],
  // LIKE_NEW — explicit, no competing eBay condition uses this phrase.
  ["like new", "LIKE_NEW"],
  // Pre-owned family — kept ONLY in the fully explicit compound form
  // (grade word present); bare "pre owned" is in AMBIGUOUS_TERMS instead.
  ["pre owned excellent", "PRE_OWNED_EXCELLENT"],
  ["pre owned fair", "PRE_OWNED_FAIR"],
  // USED_EXCELLENT — explicit grade word required. Bare "used" and bare/
  // confusingly-named "pre owned good" (eBay's own display synonym for
  // this id, despite containing the word "Good") are both in
  // AMBIGUOUS_TERMS instead — never silently upgraded here.
  ["used excellent", "USED_EXCELLENT"],
  // USED_VERY_GOOD — "very good" is itself a complete, unambiguous grade
  // phrase in eBay's own vocabulary (no other condition shares it) — this
  // is the confirmed SKU 1644 mapping ("Used – Very Good").
  ["used very good", "USED_VERY_GOOD"], ["very good", "USED_VERY_GOOD"],
  // USED_GOOD — requires the explicit "used" pairing; bare "good" is
  // ambiguous against "Good - Refurbished" (see AMBIGUOUS_TERMS).
  ["used good", "USED_GOOD"],
  // USED_ACCEPTABLE — "acceptable" has no competing eBay condition
  // sharing that word, so both the bare and paired forms are unambiguous.
  ["used acceptable", "USED_ACCEPTABLE"], ["acceptable", "USED_ACCEPTABLE"],
  // FOR_PARTS_OR_NOT_WORKING — explicit.
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
 * FAILS CLOSED: null/empty input, an ambiguous bare term (AMBIGUOUS_TERMS,
 * reported distinctly so the UI can say "choose a specific condition"),
 * or any string this dictionary doesn't recognise at all, all return
 * `{ ok: false, reason }` — never a guessed enum, and never the old
 * `?? "USED_EXCELLENT"` fallback (an absent or ambiguous condition is a
 * real blocker, never silently assumed to be a favourable grade).
 */
export function toEbayInventoryCondition(conditionValue: string | null | undefined): EbayConditionTranslation {
  if (!conditionValue || !conditionValue.trim()) {
    return { ok: false, reason: MISSING_OR_UNSUPPORTED };
  }
  const normalized = normalize(conditionValue);
  if (AMBIGUOUS_TERMS.has(normalized)) {
    return { ok: false, reason: AMBIGUOUS };
  }
  // Already a valid enum token (case/spacing-insensitive) — e.g. a value
  // some future generation path stores pre-translated.
  const asEnum = conditionValue.trim().toUpperCase() as EbayInventoryConditionEnum;
  if ((EBAY_CONDITION_ENUM_VALUES as readonly string[]).includes(asEnum)) {
    return { ok: true, enumValue: asEnum };
  }
  const mapped = LABEL_TO_ENUM.get(normalized);
  if (mapped) return { ok: true, enumValue: mapped };
  return { ok: false, reason: MISSING_OR_UNSUPPORTED };
}
