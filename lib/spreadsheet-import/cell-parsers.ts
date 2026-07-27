/**
 * Domain-agnostic spreadsheet-import building blocks shared by every
 * import feature (purchases, expenses, ...). Nothing here knows about a
 * specific field set or a specific Zod schema — each domain's own
 * `lib/<domain>-import-sheet/schema.ts` supplies its own field list and
 * final validation, then composes these primitives. Deliberately has no
 * exceljs/papaparse import so it stays directly unit-testable without real
 * file buffers — actual file reading lives in read-file.ts.
 */

/**
 * Sentinel used by read-file.ts to flag a cell that held an Excel formula —
 * never the formula's cached result, whatever type that result was. A
 * formula cell must always be rejected explicitly by the caller, never
 * silently treated as blank or as its last-calculated value.
 */
export const FORMULA_CELL = Symbol("import-formula-cell");

export type CellValue = string | number | boolean | Date | null | typeof FORMULA_CELL;

export function cellToText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return "";
  if (value === FORMULA_CELL) return "";
  return String(value).trim();
}

export function isRowBlank(cells: CellValue[]): boolean {
  return cells.every(value => value !== FORMULA_CELL && cellToText(value) === "" && !(value instanceof Date));
}

export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Accepts a real Excel date cell, ISO (YYYY-MM-DD), or UK (DD/MM/YYYY)
 * strings. Real date cells are read with UTC getters only — exceljs
 * represents the naive calendar date Excel stored as a UTC-midnight Date,
 * and using local getters here could silently shift the day depending on
 * the server's timezone offset. Every current import domain labels this
 * column "Order Date", so the message text is shared verbatim.
 */
export function parseImportDate(value: CellValue): FieldResult<string> {
  if (value instanceof Date) {
    const year = value.getUTCFullYear(), month = value.getUTCMonth() + 1, day = value.getUTCDate();
    if (!isRealCalendarDate(year, month, day)) return { ok: false, error: "Order Date is not a real date." };
    return { ok: true, value: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
  }
  const text = cellToText(value);
  if (!text) return { ok: false, error: "Order Date is required." };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    if (!isRealCalendarDate(year, month, day)) return { ok: false, error: "Order Date is not a real date." };
    return { ok: true, value: text };
  }
  const uk = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (uk) {
    const day = Number(uk[1]), month = Number(uk[2]), year = Number(uk[3]);
    if (!isRealCalendarDate(year, month, day)) return { ok: false, error: "Order Date is not a real date." };
    return { ok: true, value: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
  }
  return { ok: false, error: "Order Date must be a real date, e.g. 24/07/2026 or 2026-07-24." };
}

export function parseImportArrived(value: CellValue): FieldResult<boolean | null> {
  const text = cellToText(value);
  if (!text) return { ok: true, value: null };
  const lower = text.toLowerCase();
  if (lower === "yes" || lower === "true" || lower === "1") return { ok: true, value: true };
  if (lower === "no" || lower === "false" || lower === "0") return { ok: true, value: false };
  return { ok: false, error: "Arrived must be Yes, No, True, False, 1, 0, or blank." };
}

/**
 * Rejects rather than silently rounds when an amount carries more than 2
 * decimal places — a numeric Excel cell can carry float noise (e.g.
 * 12.5000000001) which is tolerated via a tiny epsilon, but a genuine third
 * decimal (12.345) is treated as an ambiguous/invalid amount, never
 * rounded. `label` names the field in the error text (e.g. "Cost" or
 * "Price Purchased") since different domains call this the same way but
 * name the column differently.
 */
export function parseMoneyValue(value: CellValue, label: string): FieldResult<number> {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, error: `${label} must be a valid number.` };
    if (value < 0) return { ok: false, error: `${label} cannot be negative.` };
    const pence = Math.round(value * 100);
    if (Math.abs(pence / 100 - value) > 1e-9) return { ok: false, error: `${label} must have at most 2 decimal places.` };
    return { ok: true, value: pence / 100 };
  }
  const text = cellToText(value);
  if (!text) return { ok: false, error: `${label} is required.` };
  const cleaned = text.replace(/£/gi, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, error: `${label} must be a non-negative amount with up to 2 decimal places, e.g. 12.50.` };
  return { ok: true, value: Number(cleaned) };
}

export function requiredText(value: CellValue, label: string): FieldResult<string> {
  const text = cellToText(value);
  if (!text) return { ok: false, error: `${label} is required.` };
  return { ok: true, value: text };
}

/** Passes any cell through as plain text with no required-ness/format rule — still routed through parseField so it gets the same formula guard as every other field. */
export function anyText(value: CellValue): FieldResult<string> {
  return { ok: true, value: cellToText(value) };
}

/**
 * Runs a field's parser only if the cell isn't a formula — a formula cell
 * (whatever it cached: a number, text, or an error) is rejected outright
 * and explicitly, never passed through as a value.
 */
export function parseField<T>(value: CellValue, label: string, run: (value: CellValue) => FieldResult<T>): FieldResult<T> {
  if (value === FORMULA_CELL) return { ok: false, error: `${label} must contain a value, not a formula.` };
  return run(value);
}

/** Trim, lowercase, collapse underscores/hyphens/repeated whitespace into single spaces. */
export function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export type ImportColumn<F extends string> = { field: F; heading: string; aliases: string[] };

export type HeadingMapResult<F extends string> =
  | { ok: true; mapping: (F | null)[]; ignoredColumns: string[] }
  | { ok: false; missing: F[]; duplicates: { field: F; headings: string[] }[] };

/**
 * Maps a header row's raw cell text to a domain's canonical import fields
 * via normalization + aliases. Never guesses past the alias list — an
 * unmatched heading is simply ignored (reported back so the caller can
 * tell the user it wasn't imported), never assigned to the "closest"
 * field. Generic over the field-key type so every import domain can reuse
 * the exact same, already-tested algorithm with its own column list.
 */
export function mapHeadings<F extends string>(headerRow: unknown[], columns: ImportColumn<F>[]): HeadingMapResult<F> {
  const normalizedToField = new Map<string, F>();
  for (const column of columns) for (const alias of column.aliases) normalizedToField.set(alias, column.field);

  const mapping: (F | null)[] = [];
  const ignoredColumns: string[] = [];
  const headingsByField = new Map<F, string[]>();

  headerRow.forEach(raw => {
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    const normalized = normalizeHeading(text);
    const field = normalized ? normalizedToField.get(normalized) ?? null : null;
    mapping.push(field);
    if (field) headingsByField.set(field, [...(headingsByField.get(field) ?? []), text]);
    else if (text) ignoredColumns.push(text);
  });

  const duplicates = [...headingsByField.entries()]
    .filter(([, headings]) => headings.length > 1)
    .map(([field, headings]) => ({ field, headings }));
  if (duplicates.length) return { ok: false, missing: [], duplicates };

  const requiredFields = columns.map(c => c.field);
  const missing = requiredFields.filter(field => !headingsByField.has(field));
  if (missing.length) return { ok: false, missing, duplicates: [] };

  return { ok: true, mapping, ignoredColumns };
}

/** Spreadsheet row number for the Nth (1-based) data row, given a single header row at row 1. */
export function sheetRowNumber(dataRowIndex1Based: number): number {
  return dataRowIndex1Based + 1;
}
