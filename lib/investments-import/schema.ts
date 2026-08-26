import {
  FORMULA_CELL, anyText, cellToText, isRowBlank, mapHeadings as mapHeadingsGeneric, parseField, parseImportDate,
  requiredText, sheetRowNumber as sheetRowNumberGeneric, type CellValue as CellValueGeneric, type FieldResult,
} from "@/lib/spreadsheet-import/cell-parsers";

/**
 * Investments spreadsheet-import column list + row validation — composes
 * the SAME domain-agnostic building blocks purchases/expenses already use
 * (lib/spreadsheet-import/cell-parsers.ts), never a parallel reimplementation.
 * One TRANSACTION per row (matching every other transaction-type import in
 * this app's own conventions) — an "asset" is identified per-row by
 * category + the fields relevant to that category, and is resolved or
 * created during commit (see app/api/investments/import/commit/route.ts),
 * never here (this module is pure parsing/validation, no DB access).
 */

export type ImportField =
  | "account_name" | "asset_category" | "asset_name" | "ticker" | "exchange" | "pokepulse_url" | "lego_set_number"
  | "transaction_type" | "transaction_date" | "quantity" | "native_unit_price" | "currency" | "actual_total_gbp"
  | "fx_rate_at_trade" | "fees_gbp" | "image_url" | "notes" | "import_reference";

export const importColumns: { field: ImportField; heading: string; aliases: string[] }[] = [
  { field: "account_name", heading: "Account Name", aliases: ["account name", "account"] },
  { field: "asset_category", heading: "Asset Category", aliases: ["asset category", "category"] },
  { field: "asset_name", heading: "Asset Name", aliases: ["asset name", "name", "product name", "company name"] },
  { field: "ticker", heading: "Ticker", aliases: ["ticker", "symbol"] },
  { field: "exchange", heading: "Exchange", aliases: ["exchange"] },
  { field: "pokepulse_url", heading: "PokePulse URL", aliases: ["pokepulse url", "pokepulse link"] },
  { field: "lego_set_number", heading: "LEGO Set Number", aliases: ["lego set number", "set number"] },
  { field: "transaction_type", heading: "Transaction Type", aliases: ["transaction type", "type"] },
  { field: "transaction_date", heading: "Transaction Date", aliases: ["transaction date", "date"] },
  { field: "quantity", heading: "Quantity", aliases: ["quantity", "qty"] },
  { field: "native_unit_price", heading: "Native Unit Price", aliases: ["native unit price", "unit price", "price"] },
  { field: "currency", heading: "Currency", aliases: ["currency"] },
  { field: "actual_total_gbp", heading: "Actual Total GBP", aliases: ["actual total gbp", "total gbp", "gbp total"] },
  { field: "fx_rate_at_trade", heading: "Purchase FX Rate", aliases: ["purchase fx rate", "fx rate", "fx rate at trade"] },
  { field: "fees_gbp", heading: "Fees GBP", aliases: ["fees gbp", "fees"] },
  { field: "image_url", heading: "Image URL", aliases: ["image url", "image"] },
  { field: "notes", heading: "Notes", aliases: ["notes"] },
  { field: "import_reference", heading: "Import Reference", aliases: ["import reference", "reference", "import ref"] },
];

export const requiredImportFields: ImportField[] = importColumns.map(c => c.field);
export const MAX_IMPORT_ROWS = 500;
export const IMPORT_PREVIEW_ROW_LIMIT = 200;

const ASSET_CATEGORIES = ["stock", "pokemon", "lego", "cash"] as const;
const TRANSACTION_TYPES = ["buy", "sell", "fee", "deposit", "withdrawal", "adjustment"] as const;

function fieldLabel(field: ImportField): string {
  return importColumns.find(c => c.field === field)?.heading ?? field;
}

export { normalizeHeading } from "@/lib/spreadsheet-import/cell-parsers";
export { FORMULA_CELL };
export type CellValue = CellValueGeneric;

export type HeadingMapResult =
  | { ok: true; mapping: (ImportField | null)[]; ignoredColumns: string[] }
  | { ok: false; missing: ImportField[]; duplicates: { field: ImportField; headings: string[] }[] };

export function mapHeadings(headerRow: unknown[]): HeadingMapResult {
  return mapHeadingsGeneric(headerRow, importColumns);
}

function parseEnum<T extends string>(value: CellValue, label: string, allowed: readonly T[]): FieldResult<T> {
  const text = cellToText(value).toLowerCase();
  if (!text) return { ok: false, error: `${label} is required.` };
  if ((allowed as readonly string[]).includes(text)) return { ok: true, value: text as T };
  return { ok: false, error: `${label} must be one of: ${allowed.join(", ")}.` };
}

function parseOptionalNumber(value: CellValue, label: string): FieldResult<number | null> {
  const text = cellToText(value);
  if (!text) return { ok: true, value: null };
  const cleaned = text.replace(/£|\$/g, "").replace(/,/g, "").trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return { ok: false, error: `${label} must be a non-negative number.` };
  return { ok: true, value: num };
}

export type InvestmentImportCandidate = {
  accountName: string; assetCategory: typeof ASSET_CATEGORIES[number]; assetName: string; ticker: string | null;
  exchange: string | null; pokePulseUrl: string | null; legoSetNumber: string | null;
  transactionType: typeof TRANSACTION_TYPES[number]; tradeAt: string; quantity: number | null;
  nativeUnitPrice: number | null; currency: string; actualTotalGbp: number | null; fxRateAtTrade: number | null;
  feesGbp: number; imageUrl: string | null; notes: string | null; importReference: string | null;
};

export type ImportRowValues = Record<ImportField, string>;
export type ImportRowError = { field: ImportField; reason: string };
export type ImportRowResult = { row: number; values: ImportRowValues; errors: ImportRowError[]; candidate: InvestmentImportCandidate | null };

export function sheetRowNumber(dataRowIndex1Based: number): number {
  return sheetRowNumberGeneric(dataRowIndex1Based);
}

export function buildImportRow(sheetRow: number, cells: Record<ImportField, CellValue>): ImportRowResult {
  const errors: ImportRowError[] = [];
  const display: Partial<ImportRowValues> = {};

  function field<T>(key: ImportField, parser: (value: CellValue) => FieldResult<T>): T | null {
    const result = parseField(cells[key], fieldLabel(key), parser);
    display[key] = result.ok ? String(result.value ?? "") : cellToText(cells[key]);
    if (!result.ok) { errors.push({ field: key, reason: result.error }); return null; }
    return result.value;
  }

  const accountName = field("account_name", value => requiredText(value, fieldLabel("account_name")));
  const assetCategory = field("asset_category", value => parseEnum(value, fieldLabel("asset_category"), ASSET_CATEGORIES));
  const assetName = field("asset_name", anyText) ?? "";
  const ticker = field("ticker", anyText) || null;
  const exchange = field("exchange", anyText) || null;
  const pokePulseUrl = field("pokepulse_url", anyText) || null;
  const legoSetNumber = field("lego_set_number", anyText) || null;
  const transactionType = field("transaction_type", value => parseEnum(value, fieldLabel("transaction_type"), TRANSACTION_TYPES));
  const tradeAt = field("transaction_date", parseImportDate);
  const quantity = field("quantity", value => parseOptionalNumber(value, fieldLabel("quantity")));
  const nativeUnitPrice = field("native_unit_price", value => parseOptionalNumber(value, fieldLabel("native_unit_price")));
  const currencyRaw = field("currency", anyText) || "GBP";
  const actualTotalGbp = field("actual_total_gbp", value => parseOptionalNumber(value, fieldLabel("actual_total_gbp")));
  const fxRateAtTrade = field("fx_rate_at_trade", value => parseOptionalNumber(value, fieldLabel("fx_rate_at_trade")));
  const feesGbpRaw = field("fees_gbp", value => parseOptionalNumber(value, fieldLabel("fees_gbp")));
  const imageUrl = field("image_url", anyText) || null;
  const notes = field("notes", anyText) || null;
  const importReference = field("import_reference", anyText) || null;

  // Category-conditional required-ness — the column itself is always
  // present in the template, but which cells must be filled in depends on
  // asset_category, mirroring the same rules the Add Investment modal and
  // POST /api/investments/assets already enforce.
  if (assetCategory === "stock" && !ticker) errors.push({ field: "ticker", reason: "Ticker is required for a stock." });
  if (assetCategory === "pokemon" && !pokePulseUrl) errors.push({ field: "pokepulse_url", reason: "PokePulse URL is required for a Pokémon investment." });
  if (assetCategory === "lego" && !legoSetNumber) errors.push({ field: "lego_set_number", reason: "LEGO Set Number is required for a LEGO investment." });
  if ((assetCategory === "stock" || assetCategory === "lego") && !assetName) errors.push({ field: "asset_name", reason: "Asset Name is required." });
  if (transactionType && transactionType !== "fee" && transactionType !== "deposit" && transactionType !== "withdrawal" && quantity === null) {
    errors.push({ field: "quantity", reason: "Quantity is required for this transaction type." });
  }
  if ((transactionType === "deposit" || transactionType === "withdrawal") && quantity === null) {
    errors.push({ field: "quantity", reason: "Quantity (amount) is required for a deposit/withdrawal." });
  }

  let candidate: InvestmentImportCandidate | null = null;
  if (!errors.length && accountName && assetCategory && transactionType && tradeAt) {
    candidate = {
      accountName, assetCategory, assetName, ticker, exchange, pokePulseUrl, legoSetNumber, transactionType, tradeAt,
      quantity, nativeUnitPrice, currency: currencyRaw.toUpperCase() || "GBP", actualTotalGbp, fxRateAtTrade,
      feesGbp: feesGbpRaw ?? 0, imageUrl, notes, importReference,
    };
  }

  return { row: sheetRow, values: display as ImportRowValues, errors, candidate };
}

export type BuildImportRowsResult = { ok: true; rows: ImportRowResult[]; ignoredColumns: string[] } | { ok: false; error: string };

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
    mapped.mapping.forEach((f, columnIndex) => { if (f) cellsByField[f] = cells[columnIndex] ?? null; });
    requiredImportFields.forEach(f => { if (!(f in cellsByField)) cellsByField[f] = null; });
    rows.push(buildImportRow(sheetRowNumber(index), cellsByField));
  }
  return { ok: true, rows, ignoredColumns: mapped.ignoredColumns };
}
