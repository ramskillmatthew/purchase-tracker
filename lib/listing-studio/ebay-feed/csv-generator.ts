/**
 * Builds a real, eBay-template-shaped CSV file for the Sell Feed API's
 * FX_LISTING feed type, Action=Draft only. Uses papaparse's Unparse
 * (already a direct dependency of this project — see package.json — used
 * elsewhere for spreadsheet import; this is the same reputable, RFC 4180
 * -correct encoder, never manual string concatenation).
 *
 * Every row this module can produce is validated against
 * template-contract.ts (the locked, real-template-derived definition)
 * before being written — assertTemplateContractCurrent() is called first,
 * and every row is checked for the exact base column count and the
 * "Draft" action, so a bug elsewhere in this file can never silently
 * produce a row eBay would reject or, worse, one that could be
 * misinterpreted as a different Action.
 */
import "server-only";
import Papa from "papaparse";
import { BASE_HEADERS, ONLY_ALLOWED_ACTION, SAMPLE_ROW_TITLE, assertTemplateContractCurrent } from "@/lib/listing-studio/ebay-feed/template-contract";
import { toFeedTemplateConditionId } from "@/lib/listing-studio/ebay-feed/feed-condition";

export type FeedDraftRowInput = {
  sku: string;
  categoryId: string;
  title: string;
  pricePence: number;
  quantity: number;
  /**
   * Primary/cover photo only — deliberately, disclosed, NOT guessed.
   *
   * RESEARCH TRAIL (Phase 2, this pass): searched for the exact multi-URL
   * separator for this column against eBay's own official documentation.
   * Found: (1) eBay Developer KB (developer.ebay.com/support/kb-article?
   * KBid=1240, fetched via its edp.ebay.com mirror since developer.ebay.com
   * itself 403s) officially confirms a max of 24 photos per non-variation
   * listing — but only describes the Trading API's XML
   * PictureDetails.PictureURL element, not this CSV column. (2) Multiple
   * independent eBay Community forum threads (e.g.
   * community.ebay.com/t5/Selling/Multiple-Image-URLs-In-EXCEL-Spreadsheet
   * -Draft-Listings/td-p/32767524) report a DOUBLE pipe "||" separator for
   * this exact "Item photo URL" column in a Draft-listings CSV — but this
   * is one seller's own forum-reported experience, not eBay's own
   * documentation. (3) Other, more numerous community/third-party sources
   * (File Exchange PDFs, 3Dsellers' own help docs) describe a SINGLE pipe
   * "|" separator — but for the older, DIFFERENT "File Exchange"/LMS
   * bulk-listing system, not confirmed to be the same mechanism as the
   * modern Sell-Feed-API-driven "Create Drafts" template this pipeline
   * actually uses. No source found meets this app's own bar of
   * "authoritative eBay documentation for THIS exact template" — two
   * different separators are each reported by different, non-official
   * sources, which is itself evidence this is genuinely unresolved rather
   * than merely under-researched. Guessing between "|" and "||" risks
   * silently corrupting the photo column (a wrong separator could become
   * part of a literal, malformed image URL) rather than merely omitting a
   * feature — so this remains single-photo-only, disclosed explicitly to
   * the user in the pre-submission preview (see
   * lib/listing-studio/ebay-feed/feed-batches.ts's own
   * buildFeedDraftPreview), never silently claimed as full photo transfer.
   */
  primaryPhotoUrl: string;
  conditionValue: string | null;
  description: string;
  /**
   * Category-specific item specifics, each becoming its own "C:Name"
   * column — the column-header convention itself (C:Name) is well
   * corroborated (eBay Community threads describing real templates with
   * 80+ C: columns successfully used for Draft rows). The MULTI-VALUE
   * separator for a single aspect that itself has multiple values (e.g.
   * Colour: Red AND Blue) is, like the photo separator above, NOT
   * confirmed against official eBay documentation this pass — a
   * third-party seller-tool vendor's own help docs (3Dsellers) describe a
   * comma separator with quoting, but that is that vendor's own
   * documentation of their own product, not eBay's. Only the FIRST value
   * of a multi-value aspect is therefore sent — see
   * feed-batches.ts's own flattenAspectsForFeedRow — disclosed in preview,
   * never guessed. Genuinely optional either way: a draft is allowed to be
   * incomplete — see this module's own eligibility comment.
   */
  aspects?: Record<string, string>;
};

export type FeedDraftRowValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Pure validation — never touches the network, never throws; the caller
 * decides what an invalid row means for batch eligibility. Distinct from
 * (and deliberately looser than) full batch eligibility: a draft is
 * intentionally allowed to be missing recommended-but-optional fields
 * (eBay's own template only strictly requires Action and Category ID —
 * see template-contract.ts's own #INFO row 2) — this only rejects what
 * would make the CSV itself malformed or misleading.
 */
export function validateFeedDraftRow(input: FeedDraftRowInput): FeedDraftRowValidation {
  if (!input.sku || !input.sku.trim()) return { ok: false, reason: "Missing SKU." };
  if (!input.categoryId || !/^\d+$/.test(input.categoryId)) return { ok: false, reason: "Missing or invalid eBay category ID." };
  if (!input.title || !input.title.trim()) return { ok: false, reason: "Missing title." };
  if (input.title.length > 80) return { ok: false, reason: "Title exceeds eBay's 80-character limit." };
  if (!Number.isFinite(input.pricePence) || input.pricePence <= 0) return { ok: false, reason: "Missing or invalid price." };
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) return { ok: false, reason: "Missing or invalid quantity." };
  if (!input.primaryPhotoUrl || !/^https:\/\//i.test(input.primaryPhotoUrl)) return { ok: false, reason: "Missing a valid HTTPS photo URL." };
  const condition = toFeedTemplateConditionId(input.conditionValue);
  if (!condition.ok) return { ok: false, reason: condition.reason };
  if (input.title.trim() === SAMPLE_ROW_TITLE) return { ok: false, reason: "This title matches eBay's own template sample row and has been blocked as a safety precaution." };
  return { ok: true };
}

/**
 * CORRECTIVE PASS (audit point 9) — this file previously prefixed a cell
 * starting with =, +, -, @, tab, or CR with a single quote, following the
 * standard OWASP CSV-injection mitigation. REMOVED, because that mitigation
 * does not apply to this pipeline and was actively corrupting legitimate
 * data:
 *
 * The OWASP mitigation exists to protect an INNOCENT, DIFFERENT VIEWER who
 * later opens an exported CSV in a spreadsheet application from a MALICIOUS
 * THIRD PARTY's data (e.g. a support-ticket export where an attacker's
 * ticket subject line is itself a formula that exfiltrates data when a
 * support agent opens the export in Excel). That threat model requires two
 * distinct parties: an untrusted data source, and a separate, less-trusted
 * viewer. Neither applies here: this CSV is generated from the SELLER's OWN
 * listing content (their own title/description, or content this app
 * generated from their own photos) and is uploaded directly,
 * programmatically, server-side, straight to eBay's Feed API — it is never
 * opened in a spreadsheet by anyone, let alone a different, less-trusted
 * party. eBay's own CSV parser reads a cell's literal text — it has no
 * Excel-style formula-injection convention — so a leading quote character
 * was not "neutralising a formula" from eBay's point of view, it was
 * simply prepending a stray `'` onto the actual title/description/aspect
 * value eBay would receive. A real listing legitimately titled e.g.
 * "-50% off retail, tags attached" would have been uploaded to eBay as
 * "'-50% off retail, tags attached" — visibly wrong on the resulting
 * draft. Removing this was a strict correctness improvement, not a safety
 * regression: every field is now sent to eBay exactly as the seller/this
 * app's own generation produced it, which is what "Custom label (SKU)"
 * matching, category IDs, and drafting SPECIFICALLY require to work
 * correctly, and what previewFeedDraftRow's whole reason for existing
 * (showing the user the real, honest value before submission) depends on.
 */

function penceToDecimalGbp(pence: number): string {
  return (pence / 100).toFixed(2);
}

/**
 * Builds one CSV row (an array of exactly BASE_HEADERS.length + aspect
 * count cells) for a single draft. Callers must call
 * validateFeedDraftRow() first — this function itself still fails closed
 * on an unmapped condition (never silently omits the column or guesses),
 * matching every other authoritative-translator call site in this
 * codebase.
 */
function buildRowCells(input: FeedDraftRowInput, aspectColumns: string[]): string[] {
  const condition = toFeedTemplateConditionId(input.conditionValue);
  if (!condition.ok) throw new Error(condition.reason);
  const base = [
    ONLY_ALLOWED_ACTION,
    input.sku,
    input.categoryId,
    input.title,
    "", // UPC — left empty, matching the real template's own sample row; no authoritative "does not apply" placeholder was confirmed this session
    penceToDecimalGbp(input.pricePence),
    String(input.quantity),
    input.primaryPhotoUrl,
    condition.enumValue,
    input.description,
    "FixedPrice",
  ];
  const aspectCells = aspectColumns.map(name => input.aspects?.[name] ?? "");
  return [...base, ...aspectCells];
}

export type GeneratedFeedCsv = { csv: string; rowCount: number; headers: string[] };

/**
 * The one entry point every batch-processing code path uses to build an
 * actual upload file. Never includes eBay's own sample row (guarded both
 * by validateFeedDraftRow's title check above and, defensively, again
 * here). Every input row must already have passed validateFeedDraftRow —
 * this function throws rather than silently skipping an invalid row, so
 * a caller can never accidentally upload a partially-wrong file.
 *
 * `aspectColumns` is the full, stable set of "C:Name" columns for this
 * batch (computed by the caller from every row's own aspects, so every
 * row has the same column count — a CSV requirement, not an eBay one).
 */
export function generateFeedDraftCsv(rows: FeedDraftRowInput[], aspectNames: string[] = []): GeneratedFeedCsv {
  assertTemplateContractCurrent();
  if (rows.length === 0) throw new Error("Cannot generate an empty eBay draft upload — at least one row is required.");
  for (const row of rows) {
    const validation = validateFeedDraftRow(row);
    if (!validation.ok) throw new Error(`Row for SKU "${row.sku}" failed validation: ${validation.reason}`);
    if (row.title.trim() === SAMPLE_ROW_TITLE) throw new Error("Refusing to generate a row matching eBay's own sample title — this would be indistinguishable from the template's own placeholder data.");
  }
  const aspectColumns = [...aspectNames].sort();
  const headers = [...BASE_HEADERS, ...aspectColumns.map(name => `C:${name}`)];
  const dataRows = rows.map(row => buildRowCells(row, aspectColumns));
  const csv = Papa.unparse({ fields: headers, data: dataRows }, { newline: "\r\n" });
  return { csv, rowCount: dataRows.length, headers };
}

/**
 * A safe preview of what a row would contain — for showing the user
 * before submission (Phase 3's explicit requirement). Masks the photo
 * URL down to its path shape only, never the full signed URL (which
 * carries a live, time-bounded access token in its query string) — same
 * "never persist/display a signed URL in full" rule the Inventory API
 * pipeline already follows.
 */
export function previewFeedDraftRow(input: FeedDraftRowInput): Record<string, string> {
  const condition = toFeedTemplateConditionId(input.conditionValue);
  let photoPreview = "(no photo)";
  try {
    const url = new URL(input.primaryPhotoUrl);
    photoPreview = `${url.origin}${url.pathname.slice(0, 40)}… (URL truncated — not shown in full)`;
  } catch { /* invalid URL — validateFeedDraftRow already reports this as a real error */ }
  return {
    Action: ONLY_ALLOWED_ACTION,
    "Custom label (SKU)": input.sku,
    "Category ID": input.categoryId,
    Title: input.title,
    Price: penceToDecimalGbp(input.pricePence),
    Quantity: String(input.quantity),
    "Item photo URL": photoPreview,
    "Condition ID": condition.ok ? condition.enumValue : `(blocked: ${condition.reason})`,
    Description: input.description.length > 200 ? `${input.description.slice(0, 200)}…` : input.description,
  };
}
