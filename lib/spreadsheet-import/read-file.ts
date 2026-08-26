import ExcelJS from "exceljs";
import Papa from "papaparse";
import { FORMULA_CELL, type CellValue } from "./cell-parsers";

/**
 * The only module in this feature that touches exceljs/papaparse — kept
 * separate from cell-parsers.ts so the parsing/validation rules stay
 * directly unit-testable without needing real file buffers. Turns an
 * uploaded spreadsheet into a plain array-of-arrays of primitive cell
 * values. Shared verbatim by every import domain (purchases, expenses, ...)
 * — nothing here is domain-specific.
 *
 * Never evaluates formulas, follows hyperlinks, or trusts workbook macros —
 * exceljs itself has no formula engine or macro-execution capability, so a
 * formula cell can only ever surface the value Excel itself last cached
 * when the file was saved. That cached value — whatever type it is, a
 * number, text, or an error — is never accepted here at all: any formula
 * cell is flagged with the FORMULA_CELL sentinel instead, so each domain's
 * schema module can reject the row explicitly rather than silently
 * importing a stale calculated value.
 */

export const SUPPORTED_EXTENSIONS = [".xlsx", ".csv"] as const;
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

export type FileKind = "xlsx" | "csv";

export function detectFileKind(fileName: string): FileKind | null {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}

/** xlsx files are zip archives — the "PK\x03\x04" local-file-header signature is a cheap, safe sanity check before handing the buffer to exceljs. */
function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

export class SheetReadError extends Error {}

export async function readSheetFile(buffer: Buffer, kind: FileKind): Promise<CellValue[][]> {
  return kind === "csv" ? readCsv(buffer) : readXlsx(buffer);
}

function readCsv(buffer: Buffer): CellValue[][] {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const result = Papa.parse<string[]>(text, { skipEmptyLines: false });
  return result.data.map(row => row.map(cell => (cell === "" ? null : cell)));
}

async function readXlsx(buffer: Buffer): Promise<CellValue[][]> {
  if (!looksLikeZip(buffer)) throw new SheetReadError("This does not look like a valid .xlsx file.");
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's own .d.ts locally shadows the ambient `Buffer` type with an
    // incompatible `extends ArrayBuffer` shim, so a real Node Buffer never
    // structurally matches it — this is a type-only mismatch (the runtime
    // value is a genuine Buffer), hence the narrow `any` cast.
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new SheetReadError("This .xlsx file could not be read.");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const width = sheet.columnCount || sheet.getRow(1).cellCount;
  const rows: CellValue[][] = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    const cells: CellValue[] = [];
    for (let column = 1; column <= width; column++) cells.push(cellToValue(row.getCell(column)));
    rows.push(cells);
  });
  return rows;
}

function cellToValue(cell: ExcelJS.Cell): CellValue {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  // Formula cell — reject explicitly regardless of what it last cached
  // (a number, text, or an error); never imported as if it were a value.
  if ("result" in value) return FORMULA_CELL;
  if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map(part => part.text).join("");
  if ("text" in value) {
    const text = (value as ExcelJS.CellHyperlinkValue).text;
    return typeof text === "string" ? text : null;
  }
  return null;
}
