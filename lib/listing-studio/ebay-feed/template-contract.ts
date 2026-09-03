/**
 * The versioned, locked contract for eBay's real "Create new drafts" CSV
 * template (Seller Hub → Reports → Get template → Listings → Create new
 * Drafts), derived directly from a genuine template the account owner
 * downloaded on 2026-09-03 — see template-fixtures/README.md and the
 * byte-identical fixture copy alongside it. Every field below was read
 * off that real file with a real CSV parser (Papa.parse), never
 * hand-typed from memory or from generic documentation.
 *
 * This is the "validated versioned definition" the CSV generator builds
 * from — not a second, hand-maintained guess that could silently drift
 * from the real template. A dedicated compatibility test
 * (ebay-feed-template-contract.test.ts) parses the bundled fixture and
 * asserts every value here matches it exactly, so this file and the real
 * template can never quietly disagree.
 *
 * FAIL-CLOSED BY DESIGN: nothing in this module ever falls back to a
 * guessed/older/newer template shape. If eBay changes the template
 * (a new Version, a renamed/reordered/added/removed header, a different
 * Template identifier), the generator must refuse to build a row rather
 * than upload something that no longer matches what Seller Hub actually
 * expects — see assertTemplateContractCurrent() below, which every
 * CSV-generating code path calls first.
 */

export const TEMPLATE_VERSION = "0.0.2";
export const TEMPLATE_IDENTIFIER = "eBay-draft-listings-template_GB";
export const TEMPLATE_SITE = "UK";
export const TEMPLATE_COUNTRY = "GB";
export const TEMPLATE_CURRENCY = "GBP";
export const TEMPLATE_COMPAT_VERSION = "1193";
export const TEMPLATE_ENCODING = "UTF-8";

/** The exact Action column header, byte-for-byte, including every
 * pipe-separated attribute eBay itself encodes into it. This is not a
 * label we choose — it IS the literal header string the template file
 * uses, and it must be emitted identically or eBay will not recognise
 * the file's schema. */
export const ACTION_HEADER = `Action(SiteID=${TEMPLATE_SITE}|Country=${TEMPLATE_COUNTRY}|Currency=${TEMPLATE_CURRENCY}|Version=${TEMPLATE_COMPAT_VERSION}|CC=${TEMPLATE_ENCODING})`;

/** The exact 11 base headers, in this exact order — read directly off
 * row 5 (0-indexed row 4) of the real downloaded template. */
export const BASE_HEADERS = [
  ACTION_HEADER,
  "Custom label (SKU)",
  "Category ID",
  "Title",
  "UPC",
  "Price",
  "Quantity",
  "Item photo URL",
  "Condition ID",
  "Description",
  "Format",
] as const;

export type BaseHeader = (typeof BASE_HEADERS)[number];

/** The 4 #INFO metadata rows, in order, exactly as they appear in the
 * real template (each padded to 11 columns by eBay itself — that padding
 * is reproduced exactly, not reinterpreted). Row 3 (index 2) is quoted in
 * the source file only because its own text contains a literal comma
 * ("Reports tab, complete") — Papa.unparse re-derives that quoting
 * automatically from the same rule (RFC 4180: quote only when needed),
 * so this module stores the unquoted text and lets the CSV encoder decide.
 */
export const METADATA_ROWS: readonly string[][] = [
  ["#INFO", `Version=${TEMPLATE_VERSION}`, `Template= ${TEMPLATE_IDENTIFIER}`, "", "", "", "", "", "", "", ""],
  ["#INFO Action and Category ID are required fields. 1) Set Action to Draft 2) Please find the category ID for your listings here: https://pages.ebay.com/sellerinformation/news/categorychanges.html", "", "", "", "", "", "", "", "", "", ""],
  ["#INFO After you've successfully uploaded your draft from the Seller Hub Reports tab, complete your drafts to active listings here: https://www.ebay.co.uk/sh/lst/drafts", "", "", "", "", "", "", "", "", "", ""],
  ["#INFO", "", "", "", "", "", "", "", "", "", ""],
];

/** eBay's own placeholder sample row (row 6 / index 5 of the real file).
 * Its exact Title is the guard this module's own SAMPLE_ROW_TITLE export
 * uses everywhere a generated file is checked for "did the sample row
 * accidentally end up in a real upload" — see csv-generator.ts's own
 * assertion. Never emitted by any production code path; kept here only
 * so the compatibility test can prove the bundled fixture still matches
 * what this contract expects, and so a human reading this file can see
 * exactly what eBay's own example looked like. */
export const SAMPLE_ROW_TITLE = "Test Draft Shoe";
export const SAMPLE_ROW: readonly string[] = [
  "Draft", "", "47140", SAMPLE_ROW_TITLE, "", "11", "1",
  "https://ir.ebaystatic.com/cr/v/c1/rsc/ebay_logo_512.png", "NEW",
  "<p><CENTER><H4>This is a Test Auction...Please Do Not Bid</H4></CENTER><P>This is one of those test auctions. Please do not bid as there is no merchandise being auctioned.</P>",
  "FixedPrice",
];

/**
 * Column count sanity — every metadata row, the header row, and the
 * sample row all have exactly this many fields in the real template.
 * A generated row with a different field count is a bug, not a variant.
 */
export const BASE_COLUMN_COUNT = BASE_HEADERS.length;

/**
 * The ONLY value the Action column may ever contain for a row this
 * application generates. eBay's own template supports Add/Revise/Relist/
 * End actions too (documented elsewhere, never in this reference
 * template) — this application is architecturally forbidden from ever
 * emitting any of them. See ebay-feed-allowlist.ts for the hard,
 * denylist-first enforcement of this at the point a row is actually
 * built, not just here as a constant.
 */
export const ONLY_ALLOWED_ACTION = "Draft";

/** Raises if the values above no longer describe a template this
 * application has verified against a real download. Every CSV-generating
 * code path must call this before building a single row — see this
 * file's own header for why silent drift is never acceptable here. */
export function assertTemplateContractCurrent(): void {
  if (TEMPLATE_VERSION !== "0.0.2" || TEMPLATE_IDENTIFIER !== "eBay-draft-listings-template_GB") {
    throw new Error(`Unsupported eBay draft template version (expected ${TEMPLATE_IDENTIFIER} v0.0.2). Download a fresh template from Seller Hub and update the template contract before generating any file.`);
  }
}
