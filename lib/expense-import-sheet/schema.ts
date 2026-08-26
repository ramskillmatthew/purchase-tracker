import { z } from "zod";
import { expenseInputSchema } from "@/lib/validation/purchase";
import {
  cellToText, isRowBlank, mapHeadings as mapHeadingsGeneric, parseField, parseImportArrived,
  parseImportDate, parseMoneyValue, requiredText, sheetRowNumber, type CellValue, type ImportColumn,
} from "@/lib/spreadsheet-import/cell-parsers";

/**
 * Expense-specific spreadsheet-import logic — mirrors
 * lib/purchase-import-sheet/schema.ts's structure exactly, but composes
 * the same shared lib/spreadsheet-import/cell-parsers.ts building blocks
 * for its own, smaller 5-field column list. The only source of truth for
 * what makes a valid expense remains expenseInputSchema itself (imported,
 * never re-implemented).
 */

export type ImportField = "order_date" | "purchased_from" | "arrived" | "item_description" | "cost";

export const importColumns: ImportColumn<ImportField>[] = [
  { field: "order_date", heading: "Order Date", aliases: ["order date", "purchase date", "date", "expense date"] },
  { field: "purchased_from", heading: "Purchased From", aliases: ["purchased from", "retailer", "shop", "store", "supplier", "source"] },
  { field: "arrived", heading: "Arrived", aliases: ["arrived", "has arrived", "received"] },
  { field: "item_description", heading: "Item Description", aliases: ["item description", "description", "item", "product", "expense description"] },
  { field: "cost", heading: "Cost", aliases: ["cost", "amount", "price", "expense cost", "price paid"] },
];

export const requiredImportFields: ImportField[] = importColumns.map(c => c.field);

/** Matches the purchase importer's ceiling — same operational limit, applied consistently. */
export const MAX_IMPORT_ROWS = 500;
/** How many rows the preview response returns in full — validation itself still runs over every row. */
export const IMPORT_PREVIEW_ROW_LIMIT = 200;

function fieldLabel(field: ImportField): string {
  return importColumns.find(c => c.field === field)?.heading ?? field;
}

export type HeadingMapResult =
  | { ok: true; mapping: (ImportField | null)[]; ignoredColumns: string[] }
  | { ok: false; missing: ImportField[]; duplicates: { field: ImportField; headings: string[] }[] };

export function mapHeadings(headerRow: unknown[]): HeadingMapResult {
  return mapHeadingsGeneric(headerRow, importColumns);
}

export type ImportRowValues = Record<ImportField, string>;
export type ImportRowError = { field: ImportField; reason: string };
export type ExpenseImportCandidate = z.infer<typeof expenseInputSchema>;

export type ImportRowResult = {
  row: number;
  values: ImportRowValues;
  errors: ImportRowError[];
  expense: ExpenseImportCandidate | null;
};

function mapZodIssues(error: z.ZodError): ImportRowError[] {
  return error.issues.map(issue => {
    const field = (importColumns.some(c => c.field === issue.path[0]) ? issue.path[0] : "item_description") as ImportField;
    const label = fieldLabel(field);
    if (issue.code === "too_big") return { field, reason: `${label} is too long.` };
    if (issue.code === "too_small") return { field, reason: `${label} is required.` };
    return { field, reason: `${label} is invalid.` };
  });
}

/**
 * Builds one validated row. `sheetRow` must already be the true spreadsheet
 * row number (header offset applied, blank rows never renumbered) so error
 * messages always point at the real row in the user's file. The visible
 * heading is "Order Date" but the underlying expense field is
 * `purchase_date` — only this mapping step knows about that rename.
 */
export function buildImportRow(sheetRow: number, cellsByField: Record<ImportField, CellValue>): ImportRowResult {
  const errors: ImportRowError[] = [];
  const display: Partial<ImportRowValues> = {};

  const date = parseField(cellsByField.order_date, fieldLabel("order_date"), parseImportDate);
  display.order_date = date.ok ? date.value : cellToText(cellsByField.order_date);
  if (!date.ok) errors.push({ field: "order_date", reason: date.error });

  const purchasedFrom = parseField(cellsByField.purchased_from, fieldLabel("purchased_from"), value => requiredText(value, fieldLabel("purchased_from")));
  display.purchased_from = purchasedFrom.ok ? purchasedFrom.value : cellToText(cellsByField.purchased_from);
  if (!purchasedFrom.ok) errors.push({ field: "purchased_from", reason: purchasedFrom.error });

  const arrived = parseField(cellsByField.arrived, fieldLabel("arrived"), parseImportArrived);
  display.arrived = arrived.ok ? (arrived.value === null ? "" : arrived.value ? "Yes" : "No") : cellToText(cellsByField.arrived);
  if (!arrived.ok) errors.push({ field: "arrived", reason: arrived.error });

  const description = parseField(cellsByField.item_description, fieldLabel("item_description"), value => requiredText(value, fieldLabel("item_description")));
  display.item_description = description.ok ? description.value : cellToText(cellsByField.item_description);
  if (!description.ok) errors.push({ field: "item_description", reason: description.error });

  const cost = parseField(cellsByField.cost, fieldLabel("cost"), value => parseMoneyValue(value, fieldLabel("cost")));
  display.cost = cost.ok ? cost.value.toFixed(2) : cellToText(cellsByField.cost);
  if (!cost.ok) errors.push({ field: "cost", reason: cost.error });

  let expense: ExpenseImportCandidate | null = null;
  if (!errors.length && date.ok && purchasedFrom.ok && arrived.ok && description.ok && cost.ok) {
    const candidate = {
      purchase_date: date.value, purchased_from: purchasedFrom.value,
      arrived: arrived.value, item_description: description.value, cost: cost.value,
    };
    const parsed = expenseInputSchema.safeParse(candidate);
    if (parsed.success) expense = parsed.data;
    else errors.push(...mapZodIssues(parsed.error));
  }

  return { row: sheetRow, values: display as ImportRowValues, errors, expense };
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
