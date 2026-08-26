import { z } from "zod";
import { conditions, purchaseCategories, purchaseImportInputSchema, resolveCategoryText } from "@/lib/validation/purchase";
import {
  FORMULA_CELL, anyText, cellToText, isRowBlank, mapHeadings as mapHeadingsGeneric, parseField, parseImportArrived,
  parseImportDate as parseImportDateGeneric, parseMoneyValue, requiredText, sheetRowNumber as sheetRowNumberGeneric,
  type CellValue as CellValueGeneric, type FieldResult,
} from "@/lib/spreadsheet-import/cell-parsers";

/**
 * Purchase-specific spreadsheet-import logic: the 8-field column list and
 * the final purchaseImportInputSchema gate. The domain-agnostic building
 * blocks (heading recognition, per-cell parsing) live in
 * lib/spreadsheet-import/cell-parsers.ts and are only composed here.
 *
 * Item Condition is a deliberate, narrow exception to the rest of this
 * app: spreadsheet imports may carry factual historical free text (e.g.
 * "Holes in heel") that the five canonical conditions can't represent, so
 * this module validates against purchaseImportInputSchema — which reuses
 * every other field from the real purchaseInputSchema untouched and only
 * overrides item_condition to a bounded free-text rule (see
 * lib/validation/purchase.ts). Every other purchase-creation path (manual
 * Add/Edit, email import, AI extraction, Vinted import) still validates
 * against the real purchaseInputSchema and stays canonical-only.
 *
 * Every export below keeps its original name/signature so nothing
 * importing from this module needs to change.
 */

export type ImportField =
  | "order_date" | "purchased_from" | "sku" | "arrived"
  | "item_description" | "item_size" | "item_condition" | "category" | "price_purchased";

export const importColumns: { field: ImportField; heading: string; aliases: string[]; required?: boolean }[] = [
  { field: "order_date", heading: "Order Date", aliases: ["order date", "date", "purchase date"] },
  { field: "purchased_from", heading: "Purchased From", aliases: ["purchased from", "platform", "retailer", "source"] },
  { field: "sku", heading: "SKU", aliases: ["sku"] },
  { field: "arrived", heading: "Arrived", aliases: ["arrived", "has arrived"] },
  { field: "item_description", heading: "Item Description", aliases: ["item description", "description", "item", "product"] },
  { field: "item_size", heading: "Size", aliases: ["size", "item size"] },
  { field: "item_condition", heading: "Item Condition", aliases: ["item condition", "condition"] },
  // Not required: an older template/CSV predating Category must still
  // import cleanly (see the ImportColumn.required comment in
  // lib/spreadsheet-import/cell-parsers.ts) — every row without this column
  // present at all, or with a blank cell, defaults to "Other" via
  // parseImportCategory below, never rejected for a missing/blank category.
  { field: "category", heading: "Category", aliases: ["category", "product category"], required: false },
  { field: "price_purchased", heading: "Price Purchased", aliases: ["price purchased", "purchase price", "price", "cost"] },
];

export const requiredImportFields: ImportField[] = importColumns.map(c => c.field);

/** Matches the existing app/api/purchases/bulk/route.ts ceiling — preserved rather than changed. */
export const MAX_IMPORT_ROWS = 500;
/** How many rows the preview response returns in full — validation itself still runs over every row. */
export const IMPORT_PREVIEW_ROW_LIMIT = 200;

function fieldLabel(field: ImportField): string {
  return importColumns.find(c => c.field === field)?.heading ?? field;
}

export { normalizeHeading } from "@/lib/spreadsheet-import/cell-parsers";

export type HeadingMapResult =
  | { ok: true; mapping: (ImportField | null)[]; ignoredColumns: string[] }
  | { ok: false; missing: ImportField[]; duplicates: { field: ImportField; headings: string[] }[] };

export function mapHeadings(headerRow: unknown[]): HeadingMapResult {
  return mapHeadingsGeneric(headerRow, importColumns);
}

export { FORMULA_CELL };
export type CellValue = CellValueGeneric;

export function parseImportDate(value: CellValue): FieldResult<string> {
  return parseImportDateGeneric(value);
}

export { parseImportArrived };

export function parseImportPrice(value: CellValue): FieldResult<number> {
  return parseMoneyValue(value, "Price Purchased");
}

/**
 * Purchase-import-only: Item Condition is free text here, never matched
 * against the canonical five — historical spreadsheet descriptions (e.g.
 * "Holes in heel") must be preserved exactly as written, never guessed
 * into a canonical bucket. Required-ness/trim/length/control-character
 * rules are enforced by purchaseImportItemConditionSchema as the final
 * gate (see buildImportRow) — this only handles the friendly "required"
 * message and formula-cell rejection via the caller's parseField wrapper.
 */
export function parseImportCondition(value: CellValue): FieldResult<string> {
  return requiredText(value, fieldLabel("item_condition"));
}

/**
 * A blank cell (or a column entirely absent from the file — buildImportRows
 * defaults cellsByField.category to null in that case) safely resolves to
 * "Other", never rejected or guessed from other row content. A non-blank
 * cell must match one of the canonical categories case-insensitively —
 * typos are rejected explicitly rather than silently coerced.
 */
export function parseImportCategory(value: CellValue): FieldResult<string> {
  const resolved = resolveCategoryText(cellToText(value));
  return resolved.ok ? resolved : { ok: false, error: `${fieldLabel("category")} must be one of: ${purchaseCategories.join(", ")}, or left blank.` };
}

export type ImportRowValues = Record<ImportField, string>;
export type ImportRowError = { field: ImportField; reason: string };
export type PurchaseImportCandidate = z.infer<typeof purchaseImportInputSchema>;

export type ImportRowResult = {
  row: number;
  values: ImportRowValues;
  errors: ImportRowError[];
  purchase: PurchaseImportCandidate | null;
};

function mapZodIssues(error: z.ZodError): ImportRowError[] {
  return error.issues.map(issue => {
    const field = (importColumns.some(c => c.field === issue.path[0]) ? issue.path[0] : "item_description") as ImportField;
    const label = fieldLabel(field);
    if (issue.code === "too_big") return { field, reason: `${label} is too long.` };
    if (issue.code === "too_small") return { field, reason: `${label} is required.` };
    if (issue.code === "invalid_value") return { field, reason: `${label} must be one of: ${conditions.join(", ")}.` };
    // "custom" here is always our own authored refine() message (e.g. the
    // Item Condition control-character check) — safe to surface directly,
    // never a raw/internal Zod string.
    if (issue.code === "custom") return { field, reason: issue.message };
    return { field, reason: `${label} is invalid.` };
  });
}

export function sheetRowNumber(dataRowIndex1Based: number): number {
  return sheetRowNumberGeneric(dataRowIndex1Based);
}

/**
 * Builds one validated row. `sheetRow` must already be the true spreadsheet
 * row number (header offset applied, blank rows never renumbered) so error
 * messages always point at the real row in the user's file.
 */
export function buildImportRow(sheetRow: number, cellsByField: Record<ImportField, CellValue>): ImportRowResult {
  const errors: ImportRowError[] = [];
  const display: Partial<ImportRowValues> = {};

  const date = parseField(cellsByField.order_date, fieldLabel("order_date"), parseImportDateGeneric);
  display.order_date = date.ok ? date.value : cellToText(cellsByField.order_date);
  if (!date.ok) errors.push({ field: "order_date", reason: date.error });

  const purchasedFrom = parseField(cellsByField.purchased_from, fieldLabel("purchased_from"), value => requiredText(value, fieldLabel("purchased_from")));
  display.purchased_from = purchasedFrom.ok ? purchasedFrom.value : cellToText(cellsByField.purchased_from);
  if (!purchasedFrom.ok) errors.push({ field: "purchased_from", reason: purchasedFrom.error });

  const sku = parseField(cellsByField.sku, fieldLabel("sku"), anyText);
  display.sku = sku.ok ? sku.value : cellToText(cellsByField.sku);
  if (!sku.ok) errors.push({ field: "sku", reason: sku.error });

  const arrived = parseField(cellsByField.arrived, fieldLabel("arrived"), parseImportArrived);
  display.arrived = arrived.ok ? (arrived.value === null ? "" : arrived.value ? "Yes" : "No") : cellToText(cellsByField.arrived);
  if (!arrived.ok) errors.push({ field: "arrived", reason: arrived.error });

  const description = parseField(cellsByField.item_description, fieldLabel("item_description"), value => requiredText(value, fieldLabel("item_description")));
  display.item_description = description.ok ? description.value : cellToText(cellsByField.item_description);
  if (!description.ok) errors.push({ field: "item_description", reason: description.error });

  const size = parseField(cellsByField.item_size, fieldLabel("item_size"), value => requiredText(value, fieldLabel("item_size")));
  display.item_size = size.ok ? size.value : cellToText(cellsByField.item_size);
  if (!size.ok) errors.push({ field: "item_size", reason: size.error });

  const condition = parseField(cellsByField.item_condition, fieldLabel("item_condition"), parseImportCondition);
  display.item_condition = condition.ok ? condition.value : cellToText(cellsByField.item_condition);
  if (!condition.ok) errors.push({ field: "item_condition", reason: condition.error });

  const category = parseField(cellsByField.category, fieldLabel("category"), parseImportCategory);
  display.category = category.ok ? category.value : cellToText(cellsByField.category);
  if (!category.ok) errors.push({ field: "category", reason: category.error });

  const price = parseField(cellsByField.price_purchased, fieldLabel("price_purchased"), value => parseMoneyValue(value, "Price Purchased"));
  display.price_purchased = price.ok ? price.value.toFixed(2) : cellToText(cellsByField.price_purchased);
  if (!price.ok) errors.push({ field: "price_purchased", reason: price.error });

  let purchase: PurchaseImportCandidate | null = null;
  if (!errors.length && date.ok && purchasedFrom.ok && sku.ok && arrived.ok && description.ok && size.ok && condition.ok && category.ok && price.ok) {
    const candidate = {
      order_date: date.value, purchased_from: purchasedFrom.value, seller_name: null,
      sku: sku.value, item_description: description.value, item_size: size.value, quantity: 1,
      item_condition: condition.value, category: category.value, price_purchased: price.value, arrived: arrived.value,
    };
    const parsed = purchaseImportInputSchema.safeParse(candidate);
    if (parsed.success) purchase = parsed.data;
    else errors.push(...mapZodIssues(parsed.error));
  }

  return { row: sheetRow, values: display as ImportRowValues, errors, purchase };
}

export type BuildImportRowsResult =
  | { ok: true; rows: ImportRowResult[]; ignoredColumns: string[] }
  | { ok: false; error: string };

/**
 * Top-level entry: given the raw AOA (row 1 = headings) from either xlsx or
 * csv, maps headings then builds every non-blank data row. Blank rows are
 * skipped entirely (not counted, not reported) but never cause later rows
 * to be renumbered — `sheetRow` always reflects the row's true position.
 */
export function buildImportRows(aoa: CellValue[][]): BuildImportRowsResult {
  const headerRow = aoa[0] ?? [];
  const mapped = mapHeadings(headerRow);
  if (!mapped.ok) {
    if (mapped.duplicates.length) {
      const detail = mapped.duplicates.map(d => `"${d.headings.join('", "')}" both map to ${fieldLabel(d.field)}`).join("; ");
      return { ok: false, error: `Duplicate column headings found: ${detail}. Please fix the file and try again.` };
    }
    return { ok: false, error: `Missing required column${mapped.missing.length > 1 ? "s" : ""}: ${mapped.missing.map(fieldLabel).join(", ")}.` };
  }

  const rows: ImportRowResult[] = [];
  for (let index = 1; index < aoa.length; index++) {
    const cells = aoa[index] ?? [];
    if (isRowBlank(cells)) continue;
    const cellsByField = {} as Record<ImportField, CellValue>;
    mapped.mapping.forEach((field, columnIndex) => { if (field) cellsByField[field] = cells[columnIndex] ?? null; });
    requiredImportFields.forEach(field => { if (!(field in cellsByField)) cellsByField[field] = null; });
    rows.push(buildImportRow(sheetRowNumber(index), cellsByField));
  }

  return { ok: true, rows, ignoredColumns: mapped.ignoredColumns };
}
