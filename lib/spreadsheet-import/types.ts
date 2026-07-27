/**
 * Shared failure contract used identically by both import domains
 * (purchases, expenses) across the preview API response and the generic
 * SpreadsheetImportDialog UI — one flat entry per field-level error, never
 * per row, so a row with multiple bad fields produces multiple entries
 * sharing the same `row` number. `value` is the original (display) text
 * for that field where showing it is useful and safe.
 */
export type SpreadsheetImportFailure = {
  row: number;
  field: string;
  reason: string;
  value?: string;
};
