import type { VintedAudienceValue } from "@/lib/listing-studio/listing-generation-schemas";
import type { DraftItemFamily } from "@/lib/listing-studio/vinted-category-selection";

/**
 * Genuinely eBay-specific title composition and validation — deliberately
 * deterministic, mirroring lib/listing-studio/listing-template.ts's own
 * established pattern for Vinted: the AI never writes the final title
 * string itself — it only ever supplies (or, for brand/model/product
 * type/colour/material, the SAME shared structured facts Vinted's own
 * generation already extracted) the FACTS this module composes from. This
 * is what makes the title provably free of Vinted-style
 * quoting/padding/repetition/mis-ordering: there is no free-form AI prose
 * to sanitise, only a fixed set of verified fields assembled in a fixed,
 * family-appropriate order.
 *
 * Required ordering (product spec, "Problem 2"):
 *   Footwear: Brand -> Model -> Gender -> UK Size -> Colour -> Material ->
 *             Product type -> Style/product code.
 *   Clothing: Brand -> Model/Range -> Gender -> Colour -> Material/style ->
 *             Garment type -> Size -> Style/product code.
 * Gender is deliberately sourced from the SAME already-determined
 * `vintedAudience` (lib/listing-studio/vinted-category-selection.ts's
 * deriveDraftAudience/normaliseFootwearVintedAudience — the one field this
 * codebase has already hardened, via a real production bug fix, against
 * both a lazy "unknown" and a size-only guess) rather than asking the
 * eBay-specific AI call to guess it a second, independent, potentially
 * disagreeing way.
 */

export type EbayGender = Exclude<VintedAudienceValue, "unknown">;
export type EbayItemFamily = Exclude<DraftItemFamily, "uncertain"> | "uncertain";

const EBAY_GENDER_TITLE_WORD: Record<EbayGender, string> = {
  mens: "Mens", womens: "Womens", boys: "Boys", girls: "Girls", unisex: "Unisex",
};
export const EBAY_GENDER_POSSESSIVE_WORD: Record<EbayGender, string> = {
  mens: "Men's", womens: "Women's", boys: "Boys'", girls: "Girls'", unisex: "Unisex",
};

/** Maps the already-determined Vinted audience onto an eBay gender word —
 * "unknown" (genuinely undetermined) simply contributes no gender segment,
 * never a guessed one. */
export function mapVintedAudienceToEbayGender(audience: VintedAudienceValue | null): EbayGender | null {
  if (!audience || audience === "unknown") return null;
  return audience;
}

export type EbayTitleFacts = {
  brand: string | null;
  model: string | null;
  gender: EbayGender | null;
  /** Primary product type / garment noun, e.g. "Running Trainers", "Hoodie Jacket". */
  productType: string | null;
  /** Footwear only — a bare UK shoe-size value, e.g. "9". Rendered as "UK 9", never "Size UK 9". */
  ukShoeSize: string | null;
  /** Clothing only — a raw clothing size word/letter, e.g. "Large" or "L". Rendered as "Size Large". */
  clothingSize: string | null;
  primaryColour: string | null;
  secondaryColour: string | null;
  /** Material, or a defining style keyword when material isn't meaningful (e.g. "Full Zip"). */
  material: string | null;
  /** Manufacturer style/product code — ONLY ever passed when confidently
   * established from real evidence (a visible label, or a reliable
   * brand+model->code mapping). Never the seller's own internal SKU (see
   * ebay-description-renderer.ts's own header comment for that
   * distinction) and never invented — the caller is responsible for the
   * confidence gate; this module trusts whatever it's given. */
  styleCode: string | null;
  itemFamily: EbayItemFamily;
  /** Up to 4 short, evidenced buyer-search differentiators (e.g.
   * "Waterproof") — lowest priority, dropped first if the title runs long. */
  otherKeywords: string[];
};

export const EBAY_TITLE_MAX_LENGTH = 80;

type Segment = { key: string; text: string | null };

function normaliseWord(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Collapses only IMMEDIATELY-ADJACENT duplicate words WITHIN one field's
 * own text (e.g. a messy raw fact "Running Running Trainers" collapses to
 * "Running Trainers") — this is "accidental repetition within an
 * individual field", never a cross-field removal. A field's real content
 * is otherwise untouched.
 */
function collapseInternalRepeats(text: string): string {
  const kept: string[] = [];
  for (const word of words(text)) {
    const previous = kept[kept.length - 1];
    if (previous && normaliseWord(previous) === normaliseWord(word)) continue;
    kept.push(word);
  }
  return kept.join(" ");
}

function combineColours(primary: string | null, secondary: string | null, joiner = " "): string | null {
  if (primary && secondary) return `${primary}${joiner}${secondary}`;
  return primary ?? secondary ?? null;
}

/**
 * Composes the final eBay title from verified facts only, in the
 * documented family-appropriate priority order, and caps at
 * EBAY_TITLE_MAX_LENGTH by dropping the lowest-priority segments first
 * (style code, then other keywords) — never by cutting mid-word. Every
 * segment is optional; a fact that's null/empty simply contributes
 * nothing. Condition wording is deliberately never part of the title (see
 * the product spec: condition belongs in its own field/description only).
 *
 * Deduplication is deliberately scoped narrowly (the exact reported
 * over-eager-dedup bug): brand "On Running" and product type "Running
 * Trainers" are semantically DIFFERENT fields that legitimately share the
 * word "Running" — a global cross-field word-removal produced the wrong,
 * misleading title "On Running Cloud 5 ... Trainers" (silently dropping a
 * real product-type word). Only two narrower forms of deduplication
 * happen here: (1) collapseInternalRepeats, within one field's own text,
 * and (2) collapsing a duplicate word that lands at the boundary between
 * two ADJACENT assembled segments (e.g. a model field ending in the same
 * word the next segment starts with) — never a removal triggered by a
 * distant, non-adjacent field.
 */
/**
 * Live-diagnostic follow-up fix (proven root cause of the reported
 * "...Mesh Running Trainers Mesh Upper" regression) — an AI-supplied
 * `otherKeyword` is NOT a structured fact; it's the AI's own free-form
 * "differentiator" suggestion, several segments away from material/
 * productType, so collapseInternalRepeats (one field only) and
 * collapseAdjacentBoundaries (only touches the literal boundary between
 * two consecutive segments) never see it duplicate an EARLIER field's
 * concept. This drops (never trims — a half-kept keyword like bare
 * "Upper" would be meaningless) any otherKeyword that shares ANY
 * significant word with the structured facts already assembled ahead of
 * it, exactly the semantic-duplication case ("Mesh" material + "Mesh
 * Upper" keyword) the product spec calls out — while leaving the
 * structured segments themselves completely alone, so the Round 2 fix
 * (brand "On Running" and product type "Running Trainers" both keeping
 * their own real "Running") is entirely unaffected: this filter only ever
 * removes an AI keyword, never a structured field.
 */
function filterOtherKeywords(structuredWords: Set<string>, otherKeywords: string[]): string[] {
  return otherKeywords.filter(keyword => {
    const keywordWords = words(keyword).map(normaliseWord).filter(w => w.length > 2);
    if (keywordWords.length === 0) return false;
    return !keywordWords.some(word => structuredWords.has(word));
  });
}

export function buildEbayTitle(facts: EbayTitleFacts): string {
  function fieldSegment(key: string, raw: string | null): Segment {
    if (!raw?.trim()) return { key, text: null };
    const collapsed = collapseInternalRepeats(raw.trim());
    return collapsed ? { key, text: collapsed } : { key, text: null };
  }

  const genderText = facts.gender ? EBAY_GENDER_TITLE_WORD[facts.gender] : null;
  const colourText = combineColours(facts.primaryColour, facts.secondaryColour);

  const structuredSegments: Segment[] =
    facts.itemFamily === "footwear"
      ? [
          fieldSegment("brand", facts.brand),
          fieldSegment("model", facts.model),
          fieldSegment("gender", genderText),
          fieldSegment("size", facts.ukShoeSize ? `UK ${facts.ukShoeSize}` : null),
          fieldSegment("colour", colourText),
          fieldSegment("material", facts.material),
          fieldSegment("productType", facts.productType),
          fieldSegment("styleCode", facts.styleCode),
        ]
      : [
          fieldSegment("brand", facts.brand),
          fieldSegment("model", facts.model),
          fieldSegment("gender", genderText),
          fieldSegment("colour", colourText),
          fieldSegment("material", facts.material),
          fieldSegment("productType", facts.productType),
          fieldSegment("size", facts.clothingSize ? `Size ${facts.clothingSize}` : null),
          fieldSegment("styleCode", facts.styleCode),
        ];

  const structuredWords = new Set<string>();
  for (const seg of structuredSegments) if (seg.text) for (const word of words(seg.text)) structuredWords.add(normaliseWord(word));
  const keptKeywords = filterOtherKeywords(structuredWords, facts.otherKeywords);

  const segments: Segment[] = [...structuredSegments, ...keptKeywords.map((keyword, index) => fieldSegment(`other${index}`, keyword))];

  return assembleWithinLimit(collapseAdjacentBoundaries(segments));
}

/**
 * Walks the ALREADY-ORDERED active segments and, for each one after the
 * first, drops its leading word only if that exact word is also the
 * trailing word of the segment immediately before it in the final
 * assembly — e.g. brand "Nike" followed directly by a (hypothetically
 * messy) model "Nike Air Max" collapses to "Nike Air Max", not "Nike Nike
 * Air Max". A field several segments away (like productType, well after
 * colour/material) is never considered "adjacent" and is never touched,
 * however similar its wording is to an earlier field — this is the exact
 * distinction the reported bug required: "On Running" (brand) and
 * "Running Trainers" (product type) are five segments apart, so both
 * keep their own, independently real, "Running".
 */
function collapseAdjacentBoundaries(segments: Segment[]): Segment[] {
  const active = segments.filter((s): s is Segment & { text: string } => s.text !== null);
  const result: Segment[] = [];
  let previousLastWord: string | null = null;
  for (const seg of active) {
    const segWords = words(seg.text);
    if (previousLastWord && segWords.length > 0 && normaliseWord(segWords[0]) === previousLastWord) {
      segWords.shift();
    }
    const text = segWords.join(" ");
    if (!text) continue; // the whole segment WAS that one duplicate word
    result.push({ key: seg.key, text });
    const resultWords = words(text);
    previousLastWord = normaliseWord(resultWords[resultWords.length - 1]);
  }
  return result;
}

function assembleWithinLimit(segments: Segment[]): string {
  let active = segments.filter((s): s is Segment & { text: string } => s.text !== null);
  while (active.length > 0) {
    const joined = active.map(s => s.text).join(" ");
    if (joined.length <= EBAY_TITLE_MAX_LENGTH) return joined;
    // Drop the lowest-priority remaining segment (the last one in
    // priority order) and try again — never truncates mid-word/mid-segment.
    active = active.slice(0, -1);
  }
  return "";
}

export type EbayTitleValidationIssue = { code: string; message: string };

// A deliberately small, explicit list — matches the product spec's own
// forbidden-word list exactly, never a broad heuristic that could reject
// legitimate product wording.
const BANNED_MARKETING_WORDS = ["wow", "l@@k", "must see", "best", "cheap", "bargain", "look"];
const VINTED_PROMOTIONAL_PHRASES = [
  "bundle", "discount", "look at my other items", "authentic & trusted", "same day", "next day",
  "10-20%", "10–20%",
];
// Condition phrases don't belong in an eBay title at all (product spec,
// Problem 2) — condition lives in its own field/description only.
const CONDITION_PHRASE_PATTERN = /\b(brand new|new with tags|new without tags|nwt|nwot|pre-?owned|preloved|pre-loved|used|worn|excellent condition|good condition|very good condition)\b/i;

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/**
 * Deterministic post-generation validation — runs regardless of how
 * confident the composition was, exactly matching this codebase's
 * established "never trust a well-formed result alone" convention.
 * Returns every issue found (never stops at the first) so a caller can
 * decide whether to repair-and-revalidate or mark "needs review".
 */
export function validateEbayTitle(title: string, verifiedWords: Set<string>): EbayTitleValidationIssue[] {
  const issues: EbayTitleValidationIssue[] = [];

  if (!title.trim()) issues.push({ code: "empty", message: "Title is empty." });
  if (title.length > EBAY_TITLE_MAX_LENGTH) issues.push({ code: "too_long", message: `Title is ${title.length} characters, over the 80-character limit.` });
  if (EMOJI_PATTERN.test(title)) issues.push({ code: "emoji", message: "Title contains an emoji." });
  if (/["“”]/.test(title)) issues.push({ code: "quotation_marks", message: "Title contains unnecessary quotation marks." });
  if (/[!?]{1,}|[-–—]{2,}|[.]{2,}/.test(title)) issues.push({ code: "excessive_punctuation", message: "Title contains excessive punctuation." });
  if (title === title.toUpperCase() && /[A-Z]{4,}/.test(title)) issues.push({ code: "all_caps", message: "Title is written in all capitals." });
  if (/\bSKU\b|\b(?:ref|reference)[:#]/i.test(title)) issues.push({ code: "sku_leakage", message: "Title appears to contain an internal SKU/reference." });
  if (CONDITION_PHRASE_PATTERN.test(title)) issues.push({ code: "condition_in_title", message: "Title contains a condition phrase — condition belongs in its own field/description, not the title." });
  if (/\bsize\s+uk\b/i.test(title)) issues.push({ code: "size_uk_wording", message: "Title should read \"UK <n>\", not \"Size UK <n>\"." });

  const lowerTitle = title.toLowerCase();
  for (const phrase of VINTED_PROMOTIONAL_PHRASES) {
    if (lowerTitle.includes(phrase)) { issues.push({ code: "promotional_phrase", message: `Title contains a promotional phrase ("${phrase}").` }); break; }
  }
  for (const word of BANNED_MARKETING_WORDS) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title)) {
      issues.push({ code: "marketing_filler", message: `Title contains a forbidden marketing word ("${word}").` });
      break;
    }
  }

  // Repeated-word detection — genuinely ADJACENT repeats ("Running
  // Running") are flagged; buildEbayTitle's own collapseInternalRepeats/
  // collapseAdjacentBoundaries already prevent this by construction, so
  // this check exists to catch any future direct-string-edit path (e.g. a
  // manual title edit) that bypasses composition entirely. The same
  // significant word appearing 3+ times anywhere (a sign of keyword
  // stuffing) is ALSO flagged — this one deliberately fires even for
  // genuinely distinct, non-adjacent fields, since 3+ occurrences of one
  // word is excessive regardless of which fields produced them (two
  // occurrences, like "On Running" + "Running Trainers", is normal and
  // never flagged).
  const titleWords = words(title).map(normaliseWord).filter(Boolean);
  for (let i = 1; i < titleWords.length; i++) {
    if (titleWords[i] === titleWords[i - 1] && titleWords[i].length > 2) { issues.push({ code: "repeated_adjacent_word", message: "Title repeats the same word next to itself." }); break; }
  }
  const counts = new Map<string, number>();
  for (const word of titleWords) if (word.length > 3) counts.set(word, (counts.get(word) ?? 0) + 1);
  for (const [word, count] of counts) if (count >= 3) { issues.push({ code: "excessive_repetition", message: `The word "${word}" appears ${count} times.` }); break; }

  // Every significant word in the title must trace back to a verified
  // fact — catches a brand or model claim the structured facts never
  // actually supported (this can only happen via a manual edit, since
  // buildEbayTitle itself can never produce this — it only ever assembles
  // from the same verified facts).
  if (verifiedWords.size > 0) {
    const unverified = titleWords.filter(word => word.length > 3 && !verifiedWords.has(word) && !COMMON_TITLE_WORDS.has(word));
    if (unverified.length > 0) issues.push({ code: "unverified_claim", message: `Title contains wording not present in verified facts: ${unverified.join(", ")}.` });
  }

  return issues;
}

// Ordinary structural/connective words a title can legitimately contain
// without them tracing back to a specific "verified fact" (sizes/UK,
// condition vocabulary, common product-type words) — kept intentionally
// small; anything not here must trace back to a real component.
const COMMON_TITLE_WORDS = new Set([
  "uk", "new", "used", "sealed", "unopened", "unused", "boxed", "unboxed", "with", "without",
  "and", "for", "the", "size", "sneakers",
]);

/** Builds the verified-word set validateEbayTitle checks unverified claims
 * against, from the same facts buildEbayTitle used. */
export function verifiedWordsFromFacts(facts: EbayTitleFacts, extra: string[] = []): Set<string> {
  const set = new Set<string>();
  const genderText = facts.gender ? EBAY_GENDER_TITLE_WORD[facts.gender] : null;
  const values = [
    facts.brand, facts.model, facts.productType, genderText, facts.primaryColour, facts.secondaryColour,
    facts.material, facts.styleCode, ...facts.otherKeywords, ...extra,
  ];
  for (const value of values) {
    if (value) for (const word of words(value)) set.add(normaliseWord(word));
  }
  return set;
}
