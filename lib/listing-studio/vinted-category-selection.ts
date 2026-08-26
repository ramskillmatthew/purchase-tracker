import type { VintedCategoryRow } from "./vinted-categories-data";

/**
 * Milestone 7 (Vinted category catalogue sync) — the pure, DB-free half of
 * AI category selection. Kept separate from
 * vinted-category-selection-ai.ts (the Anthropic call) and the generate
 * route (the DB-touching orchestration) so the actual safety rules —
 * "which audience/item-family does this product deterministically belong
 * to", "is this AI answer actually safe to persist" — stay independently
 * unit-testable against plain fixtures, with no network or database
 * involved at all.
 *
 * Follow-up correction (2026-08-03): "current automatic drafter scope" —
 * the business only needs automatic category selection for clothing and
 * footwear, scoped to 8 verified branches, never the full 3,049-category
 * catalogue. `DraftAudience`/`DraftItemFamily` below are a narrower,
 * purpose-built vocabulary for THIS scoping decision — deliberately
 * distinct from vinted_categories.audience/item_family (the general,
 * whole-catalogue columns populated by vinted-catalogue.ts's
 * deriveVerifiedRootMetadata, which use a different, broader vocabulary
 * for a different purpose: tagging every category, not just these 8
 * branches).
 */

export type DraftAudience = "women" | "men" | "girls" | "boys" | "unknown";
export type DraftItemFamily = "clothing" | "footwear" | "uncertain";
// The raw listing_drafts.vinted_audience value shape — named so
// normaliseFootwearVintedAudience's overloads below don't need to repeat
// the literal union three times.
export type VintedAudienceLiteral = "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown";

/**
 * Follow-up correction (2026-08-04): this used to derive audience from the
 * main generation stage's sourceSize.gender — a real production bug (a
 * New Balance 9060 Trainers listing) traced to exactly that: most
 * footwear size tags print no gender marker at all, so sourceSize.gender
 * is very commonly null/"unisex", which silently produced ZERO automatic
 * category candidates with no failure record to explain why. Audience is
 * now its own independently-AI-determined field
 * (lib/listing-studio/listing-generation-schemas.ts's vintedAudience,
 * persisted as listing_drafts.vinted_audience) — sourceSize.gender is
 * used ONLY for size-system conversion from here on, never audience.
 *
 * "unisex" and "unknown" both map to DraftAudience "unknown" — there is
 * no unisex branch among the 8 verified clothing/footwear branches
 * automatic selection is scoped to, so guessing men's vs women's for a
 * unisex/unclear item would be exactly the kind of invented assignment
 * this whole feature exists to avoid. Both cases now surface as the
 * `audience_missing` outcome (see vinted-category-assignment.ts), with an
 * explicit "Select whether this item should be listed under Men or
 * Women" UI prompt rather than a vague generic warning.
 */
export function deriveDraftAudience(vintedAudience: "mens" | "womens" | "boys" | "girls" | "unisex" | "unknown" | null): DraftAudience {
  if (vintedAudience === "mens") return "men";
  if (vintedAudience === "womens") return "women";
  if (vintedAudience === "boys") return "boys";
  if (vintedAudience === "girls") return "girls";
  return "unknown"; // "unisex" | "unknown" | null (older drafts predating this field)
}

// Fixed, explicit keyword lists — a deterministic "does this word appear"
// check against the AI's own already-extracted productType text, never a
// fuzzy/approximate match and never free-form guessing. Matches the
// example words this milestone's own spec gave for each family.
const FOOTWEAR_PRODUCT_TYPE_KEYWORDS = ["trainer", "running shoe", "hiking shoe", "football boot", "boot", "sandal", "clog", "loafer", "shoe", "sneaker", "heel", "flip flop", "slipper"];
const CLOTHING_PRODUCT_TYPE_KEYWORDS = ["coat", "jacket", "shirt", "trouser", "dress", "jean", "jumper", "sweater", "hoodie", "skirt", "top", "blouse", "cardigan", "legging", "short"];

/** Deterministic clothing-vs-footwear classification from the AI's own productType text — "uncertain" (never guessed) when neither list matches. */
export function deriveDraftItemFamily(productType: string | null): DraftItemFamily {
  if (!productType) return "uncertain";
  const text = productType.toLowerCase();
  if (FOOTWEAR_PRODUCT_TYPE_KEYWORDS.some((keyword) => text.includes(keyword))) return "footwear";
  if (CLOTHING_PRODUCT_TYPE_KEYWORDS.some((keyword) => text.includes(keyword))) return "clothing";
  return "uncertain";
}

/**
 * Business-rule follow-up correction: footwear must never be listed under
 * a children's Vinted audience for this app — a boys'/girls' FOOTWEAR
 * item is always treated as Women's instead, full stop. This is a fixed
 * business decision, not a size-based inference (never reads
 * ukSize/sourceSize — only the already-determined audience + item
 * family), and it never applies outside footwear: a boys'/girls'
 * CLOTHING item keeps its own audience completely untouched, since
 * Vinted's own Kids clothing branches remain a real, valid destination
 * there.
 *
 * The single shared normalisation point — every place audience affects
 * category selection or persistence (listing generation, text/photo
 * audience reassessment, single/bulk Assign Category, Edit Fields saving,
 * Listings Review data, Ready validation) calls this SAME function rather
 * than re-implementing the boys/girls → womens mapping. mens/womens/
 * unisex/unknown, and boys/girls for any non-footwear item family, are
 * always returned completely unchanged.
 *
 * Deliberately does not persist or expose the original boys/girls value
 * anywhere — no separate "detected audience" field, no audit trail of the
 * discarded value; this function's return IS the only value that is ever
 * saved, searched, displayed, or validated against.
 */
export function normaliseFootwearVintedAudience(audience: VintedAudienceLiteral, itemFamily: DraftItemFamily): VintedAudienceLiteral;
export function normaliseFootwearVintedAudience(audience: VintedAudienceLiteral | null, itemFamily: DraftItemFamily): VintedAudienceLiteral | null;
export function normaliseFootwearVintedAudience(audience: VintedAudienceLiteral | null, itemFamily: DraftItemFamily): VintedAudienceLiteral | null {
  if (itemFamily !== "footwear") return audience;
  if (audience === "boys" || audience === "girls") return "womens";
  return audience;
}

// The exact terms this business rule removes, case-insensitively, from
// customer-facing footwear text once the listing is Women's — the literal
// list given by the rule, including the possessive forms that most
// naturally occur ("Kid's", "Boy's", "Girl's", "Children's"). Bare
// plurals/singulars (kids, kid, boys, boy, ...) are listed too since a
// possessive apostrophe is often dropped or appears the other way round
// ("Kids'") — that stray trailing apostrophe is swept up afterward by
// stripChildrensAudienceWording's own punctuation cleanup, so every real
// possessive spelling is covered without enumerating each one here.
const CHILDRENS_AUDIENCE_WORDING_TERMS = [
  "children's", "children", "child",
  "kid's", "kids", "kid",
  "junior's", "juniors", "junior",
  "boy's", "boys", "boy",
  "girl's", "girls", "girl",
  "youth",
] as const;

// \b...\b enforces WHOLE-WORD matching only — a boundary requires an
// actual transition between a word character and a non-word character, so
// "kid" never matches inside "Skidmore" (no boundary between the S and the
// k) and "boy" never matches inside "Cowboy" (no boundary between the w
// and the b). This is what "never remove text merely because it contains
// the same letters inside another legitimate word" is built on — not a
// denylist of specific words to protect, but the boundary rule itself.
const CHILDRENS_AUDIENCE_WORDING_REGEX = new RegExp(
  `\\b(?:${CHILDRENS_AUDIENCE_WORDING_TERMS.map((term) => term.replace(/'/g, "['’]")).join("|")})\\b`,
  "gi",
);

/**
 * The raw text transform: removes every standalone children's-audience
 * term from `value`, case-insensitively, then cleans up whatever
 * whitespace/punctuation the removal left behind (collapsed runs of
 * spaces; a lone leftover apostrophe from a plural-possessive like "Kids'"
 * once the bare "Kids" is removed; stray leading/trailing punctuation).
 * Pure and deterministic — no AI call, no randomness. Exported separately
 * from normaliseFootwearListingText below so the text transform itself is
 * directly testable against exact before/after examples, independent of
 * the business-rule gating.
 */
export function stripChildrensAudienceWording(value: string | null): string | null {
  if (value === null) return null;
  let result = value.replace(CHILDRENS_AUDIENCE_WORDING_REGEX, " ");
  result = result.replace(/\s+/g, " ");
  // A lone apostrophe now stranded between whitespace (or at either end)
  // once its word was removed — e.g. "Kids' Trainers" loses "Kids",
  // leaving "' Trainers" — is punctuation noise, not part of any word.
  result = result.replace(/(^|\s)['’](?=\s|$)/g, "$1");
  result = result.replace(/\s+/g, " ").trim();
  result = result.replace(/^[-,.;:'’\s]+/, "").replace(/[-,.;:'’\s]+$/, "");
  return result || null;
}

/**
 * Business rule: footwear listed under the Women's Vinted audience must
 * never carry children's audience wording (Youth/Kids/Junior/Boys/Girls/
 * Child/Children, any case, including possessive forms) in customer-facing
 * text — even though the listing itself is correctly Women's, e.g. a UK 3
 * trainer whose printed model name literally includes "Youth". Gated
 * exactly like normaliseFootwearVintedAudience above: only footwear items
 * that are (already-normalised) Women's are touched at all — a Men's,
 * Unisex, Unknown, or non-footwear value is always returned completely
 * unchanged, and the title never has to (and doesn't) say "Women"/"Women's"
 * either — it just stays neutral once the children's wording is gone.
 *
 * The single shared normalisation point for this rule — every place
 * customer-facing footwear text is generated or persisted (listing
 * generation, Edit Fields saving, deterministic title/description
 * regeneration, the existing-draft "Refresh listing text" repair action,
 * Preview Listing, Listings Review) calls this SAME function rather than
 * re-implementing the term list or the gating condition.
 */
export function normaliseFootwearListingText(value: string | null, itemFamily: DraftItemFamily, vintedAudience: VintedAudienceLiteral | null): string | null {
  if (itemFamily !== "footwear" || vintedAudience !== "womens") return value;
  return stripChildrensAudienceWording(value);
}

// Words that appear in virtually every leaf's own full_path within a
// scoped branch, since the branch segment itself IS this word (every
// footwear leaf's path contains "Shoes", every clothing leaf's contains
// "Clothing") — including them in a keyword search would provide zero
// real narrowing signal, only noise.
const CANDIDATE_SEARCH_STOPWORDS = new Set(["shoe", "shoes", "clothing"]);

/**
 * Follow-up correction (2026-08-07) — root cause of the "audience resolves
 * correctly but category assignment still returns no_candidates for every
 * generated draft" production bug: searchAutomaticSelectionCandidates used
 * to AND the productType field's ENTIRE raw text (e.g. "Running Trainers")
 * onto the branch query as one literal full_path substring. Vinted's own
 * catalogue vocabulary almost never matches an AI-generated productType
 * phrase verbatim — e.g. the real, active, selectable leaves are labelled
 * "Trainers" and "Running shoes", and neither contains the substring
 * "Running Trainers" — so that filter silently excluded every real
 * candidate under the correct branch, every time, for any multi-word
 * productType.
 *
 * Splits productType into its individual significant words instead, each
 * matched independently (OR'd, not AND'd as one phrase) against
 * full_path/label — "Running Trainers" now matches BOTH "Trainers" and
 * "Running shoes", which is exactly the ambiguous-but-genuinely-candidate
 * set the bounded AI selector exists to arbitrate between. Words under 3
 * characters and branch-name stopwords are dropped (no narrowing signal).
 * Returns [] (meaning: no keyword narrowing at all, branch scope only)
 * when productType is null or has no meaningful words left after
 * filtering — callers must always be prepared to fall back to the
 * unnarrowed branch scope when this returns [].
 */
export function extractCategorySearchKeywords(productType: string | null): string[] {
  if (!productType) return [];
  const words = productType.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const meaningful = words.filter((word) => word.length >= 3 && !CANDIDATE_SEARCH_STOPWORDS.has(word));
  return [...new Set(meaningful)];
}

/**
 * The verified 8 branches (2026-08-03) automatic category selection is
 * currently scoped to — see this milestone's completion report. Kids'
 * shoe branches (1255/1256) are themselves descendants of the broader
 * Kids clothing branches (1195/1194); selectAutomaticSelectionBranches
 * below can return both for an "uncertain" item family, and the DB query
 * that consumes this list is responsible for deduplicating by category id
 * (a leaf under 1255 matches both branches' path prefixes) — never
 * double-counted as two different candidates.
 */
export type AutomaticSelectionBranch = { id: number; fullPath: string; audience: Exclude<DraftAudience, "unknown">; itemFamily: Exclude<DraftItemFamily, "uncertain"> };
export const AUTOMATIC_SELECTION_BRANCHES: AutomaticSelectionBranch[] = [
  { id: 4, fullPath: "Women > Clothing", audience: "women", itemFamily: "clothing" },
  { id: 16, fullPath: "Women > Shoes", audience: "women", itemFamily: "footwear" },
  { id: 2050, fullPath: "Men > Clothing", audience: "men", itemFamily: "clothing" },
  { id: 1231, fullPath: "Men > Shoes", audience: "men", itemFamily: "footwear" },
  { id: 1195, fullPath: "Kids > Girls clothing", audience: "girls", itemFamily: "clothing" },
  { id: 1255, fullPath: "Kids > Girls clothing > Shoes", audience: "girls", itemFamily: "footwear" },
  { id: 1194, fullPath: "Kids > Boys clothing", audience: "boys", itemFamily: "clothing" },
  { id: 1256, fullPath: "Kids > Boys clothing > Shoes", audience: "boys", itemFamily: "footwear" },
];

/**
 * "unknown" audience yields no branches at all — automatic selection is
 * simply not attempted (the manual picker remains available). An
 * "uncertain" item family with a KNOWN audience returns both of that
 * audience's branches (clothing AND footwear) rather than none — audience
 * alone is still a genuine, deterministic narrowing signal even without a
 * confident clothing/footwear split.
 */
export function selectAutomaticSelectionBranches(audience: DraftAudience, itemFamily: DraftItemFamily): AutomaticSelectionBranch[] {
  if (audience === "unknown") return [];
  return AUTOMATIC_SELECTION_BRANCHES.filter((branch) => branch.audience === audience && (itemFamily === "uncertain" || branch.itemFamily === itemFamily));
}

/**
 * Whether an already-assigned category still belongs under the given
 * audience — used when the user changes Vinted Audience in Edit Fields
 * (an existing category from the wrong audience must be cleared, since a
 * "Women > Shoes > Trainers" pick is categorically wrong for a listing
 * now marked Men's; see vinted-category-assignment.ts's
 * clearIncompatibleCategoryIfNeeded). "unknown" audience is never
 * compatible with anything, matching selectAutomaticSelectionBranches's
 * own "no branches at all" rule.
 */
export function isCategoryCompatibleWithAudience(categoryFullPath: string, audience: DraftAudience): boolean {
  if (audience === "unknown") return false;
  return selectAutomaticSelectionBranches(audience, "uncertain").some((branch) => categoryFullPath.startsWith(branch.fullPath));
}

export type VintedCategorySelectionCandidate = { id: number };

export type VintedCategorySelectionValidation =
  | { valid: true; categoryId: null }
  | { valid: true; categoryId: number; category: VintedCategoryRow }
  | { valid: false; reason: string };

/**
 * The one gate a Claude-chosen category id must pass before it can ever be
 * written to a listing draft: null is always accepted (the AI declining to
 * guess is a valid, safe outcome); any non-null id must (a) have actually
 * been one of the candidates supplied to the AI — never trust the id back
 * on its own, since a model can echo an out-of-set number even when
 * instructed not to — and (b) still be active, selectable, and a leaf in
 * a FRESH catalogue lookup (not the possibly-stale candidate list), since
 * a concurrent refresh could have deactivated it in between. This is
 * deliberately the only path that may ever set vinted_category_source =
 * 'ai' — never fuzzy-matched, never inferred from free text.
 */
export function validateSelectedVintedCategory(
  vintedCategoryId: number | null,
  candidates: VintedCategorySelectionCandidate[],
  freshCategory: VintedCategoryRow | null,
): VintedCategorySelectionValidation {
  if (vintedCategoryId === null) return { valid: true, categoryId: null };
  if (!candidates.some((candidate) => candidate.id === vintedCategoryId)) {
    return { valid: false, reason: "The AI selected a category id that was not in the supplied candidate list." };
  }
  if (!freshCategory || freshCategory.id !== vintedCategoryId) {
    return { valid: false, reason: "The selected category could not be found in the catalogue." };
  }
  if (!freshCategory.is_active || !freshCategory.is_selectable || !freshCategory.is_leaf) {
    return { valid: false, reason: "The selected category is no longer active and selectable." };
  }
  return { valid: true, categoryId: vintedCategoryId, category: freshCategory };
}
