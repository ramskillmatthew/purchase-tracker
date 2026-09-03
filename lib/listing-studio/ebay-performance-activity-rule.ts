/**
 * Deterministic Performance/Activity mapping for footwear that is explicitly
 * and confidently identified as running trainers.
 *
 * This is NOT an AI guess and NOT a vague-signal inference — it fires only
 * when the product's own structured facts (or its composed title, which for
 * an eBay draft always states the product type verbatim) contain an explicit
 * "running"/"jogging" token AND the item family is footwear. On that
 * evidence it offers a set of the phrasings eBay uses for this value across
 * its athletic-footwear categories, in preference order, at HIGH confidence.
 *
 * Nothing here invents a stored value: the caller feeds each phrasing
 * through matchAspectValue, which only ever accepts a candidate that
 * normalises to EXACTLY one of the selected category's own allowed values
 * (e.g. "Running & Jogging", or just "Running"). If this category's schema
 * offers none of them, no value is produced and the aspect keeps a genuine,
 * visible, actionable review requirement — never a hard-coded free-text
 * value eBay would reject.
 *
 * Mirrors footwear-department-rule.ts's "one small deterministic primitive,
 * applied only to a confirmed fact" shape.
 */

/** Preference order — the eBay-canonical "Running & Jogging" first, then the
 * shorter forms other categories use. matchAspectValue picks whichever one
 * this category actually allows. */
export const RUNNING_ACTIVITY_VALUE_CANDIDATES = [
  "Running & Jogging",
  "Running/Jogging",
  "Running",
  "Jogging",
  "Road Running",
] as const;

// Word-boundary match so "running trainers" / "running shoes" / "trail
// running" / "jogging" all count, but a substring like "scunning" never does.
const RUNNING_EVIDENCE = /\brunning\b|\bjogging\b/i;

/**
 * The ordered list of allowed-value phrasings to try for Performance/Activity,
 * or `[]` when the evidence is not an explicit running signal (in which case
 * the aspect is left to its ordinary heuristic / AI / review path).
 *
 * Only ever consulted for the "Performance/Activity" aspect itself, which
 * eBay only defines on athletic-footwear categories — so a `null`/uncertain
 * item family is not treated as disqualifying; an explicit `clothing` family
 * is (a running jacket's activity is not this aspect's concern here).
 */
export function runningActivityValueCandidates(
  facts: { itemFamily: string; productType: string | null } | null | undefined,
  title: string | null | undefined,
): string[] {
  if (facts?.itemFamily === "clothing") return [];
  const evidence = `${facts?.productType ?? ""} ${title ?? ""}`;
  if (!RUNNING_EVIDENCE.test(evidence)) return [];
  return [...RUNNING_ACTIVITY_VALUE_CANDIDATES];
}
