/**
 * Deterministic post-generation validation (and safe repair) for eBay
 * descriptions — never trusts the AI's own prompt compliance alone,
 * matching this codebase's established "validate the AI, don't just ask
 * nicely" convention (see lib/listing-studio/ebay-title-builder.ts's
 * equivalent for titles). Vinted's own promotional boilerplate is the
 * concrete, reported failure mode (Fault 1) this exists to make
 * structurally impossible to ship, not just discouraged in a prompt.
 */

export type EbayDescriptionValidationIssue = { code: string; message: string };

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

// Matched case-insensitively against the WHOLE description — each entry is
// a distinctive fragment of a real Vinted-boilerplate phrase (the exact
// wording the product spec quotes), not a broad word that could appear in
// a genuine product description.
const BANNED_PHRASES = [
  "always authentic & trusted seller", "always authentic and trusted seller",
  "discount for bundles", "have a look", "please look at my other items", "look at my other items",
  "everything sent same day", "sent same day or next day",
  "10-20% discount", "10–20% discount",
];
const EXTERNAL_LINK_PATTERN = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i;
const SCRIPT_PATTERN = /<script|javascript:|on\w+\s*=/i;
const HASHTAG_PATTERN = /#[a-z0-9_]{2,}/i;
// Problem 3's exact reported failure mode: markdown-style
// "**Key Details**"/"**Condition**" headers instead of the required plain
// text — the deterministic renderer (ebay-description-renderer.ts) can
// never produce these, but this check remains as a safety net for any
// text that reaches here by another path (e.g. a manual edit, or a future
// AI-authored field).
const MARKDOWN_MARKER_PATTERN = /\*\*[^*]+\*\*|^#{1,6}\s|^```|\[[^\]]+\]\([^)]+\)/m;

export function validateEbayDescription(description: string): EbayDescriptionValidationIssue[] {
  const issues: EbayDescriptionValidationIssue[] = [];
  if (!description.trim()) { issues.push({ code: "empty", message: "Description is empty." }); return issues; }

  if (EMOJI_PATTERN.test(description)) issues.push({ code: "emoji", message: "Description contains an emoji." });
  if (EXTERNAL_LINK_PATTERN.test(description)) issues.push({ code: "external_link", message: "Description contains an external link." });
  if (SCRIPT_PATTERN.test(description)) issues.push({ code: "active_content", message: "Description contains script/active content." });
  if (HASHTAG_PATTERN.test(description)) issues.push({ code: "hashtag", message: "Description contains a hashtag." });
  if (MARKDOWN_MARKER_PATTERN.test(description)) issues.push({ code: "markdown_markup", message: "Description contains markdown formatting (e.g. \"**bold**\" headers) — eBay descriptions must be plain text." });

  const lower = description.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) issues.push({ code: "vinted_boilerplate", message: `Description contains Vinted-style promotional wording ("${phrase}").` });
  }
  // Problem 3's exact required shape: the internal SKU is only ever
  // acceptable as the LAST bullet under a "Details" heading — a bare
  // "SKU:" mixed into ordinary prose, under any other heading, or
  // followed by further bullets is exactly the reported Fault 1 pattern
  // (and would misrepresent it as a manufacturer-facing detail).
  const skuMatch = description.match(/^[•\-*]\s*SKU\s*[:#]/im);
  if (skuMatch) {
    const matchIndex = skuMatch.index ?? 0;
    const precedingText = description.slice(0, matchIndex).trimEnd();
    const precedingLines = precedingText.split(/\n/).map(line => line.trim()).filter(Boolean);
    const lastHeading = [...precedingLines].reverse().find(line => line.length < 40 && !line.startsWith("•") && !line.startsWith("-") && !line.startsWith("*"));
    if (!lastHeading || !/^details$/i.test(lastHeading)) {
      issues.push({ code: "sku_leakage", message: "The internal SKU must appear only as the last bullet under a \"Details\" heading." });
    }
    const followingText = description.slice(matchIndex + skuMatch[0].length);
    const nextBulletLine = followingText.split(/\n/).find(line => /^\s*[•\-*]/.test(line));
    if (nextBulletLine) issues.push({ code: "sku_not_last", message: "The internal SKU must be the LAST bullet under \"Details\", not followed by further bullets." });
  } else if (/\bSKU\s*[:#]/i.test(description)) {
    issues.push({ code: "sku_leakage", message: "The internal SKU must appear only as a bullet (\"• SKU: ...\") under a \"Details\" heading." });
  }

  return issues;
}

/**
 * Strips any sentence/line containing a banned phrase, rather than
 * rejecting the whole description outright — a safety-net repair for the
 * rare case a validated-at-generation-time description still slips
 * through (e.g. a future direct edit), never a substitute for the AI
 * prompt's own instructions. Never invents replacement text; a stripped
 * sentence simply disappears.
 */
export function repairEbayDescription(description: string): string {
  const lines = description.split(/\n/);
  const keptLines = lines.filter(line => {
    const lower = line.toLowerCase();
    if (BANNED_PHRASES.some(phrase => lower.includes(phrase))) return false;
    if (EMOJI_PATTERN.test(line)) return false;
    if (HASHTAG_PATTERN.test(line)) return false;
    return true;
  });
  return keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
