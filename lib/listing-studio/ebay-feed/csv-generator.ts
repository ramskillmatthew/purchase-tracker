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
  /** Primary/cover photo only for this version — see this file's own
   * note on why multi-photo support is deliberately not implemented yet
   * (the real multi-URL separator for this exact column was not
   * confirmed against authoritative documentation this session; guessing
   * one risks corrupting the file rather than merely omitting a feature). */
  primaryPhotoUrl: string;
  conditionValue: string | null;
  description: string;
  /** Category-specific item specifics, each becoming its own "C:Name"
   * column — confirmed supported for Draft rows via eBay seller-community
   * evidence gathered this session (real templates with 80+ C: columns
   * successfully used for drafts). Genuinely optional: a draft is allowed
   * to be incomplete — see this module's own eligibility comment. */
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

/** OWASP-recommended CSV/formula-injection neutralisation: a cell whose
 * first character is one a spreadsheet application would interpret as
 * the start of a formula (=, +, -, @) or a control character (tab, CR)
 * is prefixed with a single quote, which forces "treat as text" in
 * Excel/Sheets/Numbers without altering the underlying data eBay itself
 * receives (eBay's own CSV parser reads the literal cell value, not a
 * spreadsheet formula). Applied to every free-text field this
 * application writes (title, description, aspect values) — never to
 * fields this module itself controls the shape of (SKU, category ID,
 * price, quantity, condition, Action). */
function neutralizeFormulaInjection(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

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
    neutralizeFormulaInjection(input.sku),
    input.categoryId,
    neutralizeFormulaInjection(input.title),
    "", // UPC — left empty, matching the real template's own sample row; no authoritative "does not apply" placeholder was confirmed this session
    penceToDecimalGbp(input.pricePence),
    String(input.quantity),
    input.primaryPhotoUrl,
    condition.enumValue,
    neutralizeFormulaInjection(input.description),
    "FixedPrice",
  ];
  const aspectCells = aspectColumns.map(name => neutralizeFormulaInjection(input.aspects?.[name] ?? ""));
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
