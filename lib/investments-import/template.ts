import ExcelJS from "exceljs";
import { importColumns } from "./schema";

/** Generates the downloadable investments-import-template.xlsx — mirrors purchase-import-sheet/template.ts's own generation approach exactly (server-side exceljs, no macros, no example data rows). */

const COLUMN_WIDTHS: Record<string, number> = {
  account_name: 20, asset_category: 14, asset_name: 28, ticker: 10, exchange: 12, pokepulse_url: 42,
  lego_set_number: 14, transaction_type: 14, transaction_date: 14, quantity: 12, native_unit_price: 14,
  currency: 10, actual_total_gbp: 14, fx_rate_at_trade: 14, fees_gbp: 10, image_url: 30, notes: 30, import_reference: 18,
};

const VALIDATION_ROWS = 200;

export async function buildInvestmentsImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Purchase Tracker";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Transactions", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = importColumns.map(column => ({ header: column.heading, key: column.field, width: COLUMN_WIDTHS[column.field] }));

  const headerRow = sheet.getRow(1);
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF32405A" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF1F2937" } } };
  });
  sheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + importColumns.length)}1` };

  sheet.getColumn("transaction_date").numFmt = "dd/mm/yyyy";
  sheet.getColumn("actual_total_gbp").numFmt = "£#,##0.00";
  sheet.getColumn("fees_gbp").numFmt = "£#,##0.00";

  const categoryColumn = String.fromCharCode(65 + importColumns.findIndex(c => c.field === "asset_category"));
  const typeColumn = String.fromCharCode(65 + importColumns.findIndex(c => c.field === "transaction_type"));
  for (let row = 2; row <= VALIDATION_ROWS; row++) {
    sheet.getCell(`${categoryColumn}${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"stock,pokemon,lego,cash"'] };
    sheet.getCell(`${typeColumn}${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"buy,sell,fee,deposit,withdrawal,adjustment"'] };
  }

  const instructions = workbook.addWorksheet("Instructions");
  instructions.getColumn(1).width = 100;
  const lines = [
    "How to use this template",
    "",
    "Do not rename the column headings on the Transactions sheet.",
    "Use one row per transaction (buy, sell, fee, deposit, withdrawal, or adjustment).",
    "Account Name is required — a matching account is reused, or created automatically if it doesn't exist yet.",
    "Asset Category must be one of: stock, pokemon, lego, cash.",
    "Ticker is required for stock rows. PokePulse URL is required for pokemon rows (must be a real https://pokepulse.io/sealed/... or /cards/... link). LEGO Set Number is required for lego rows.",
    "Transaction Type must be one of: buy, sell, fee, deposit, withdrawal, adjustment.",
    "Transaction Date is required — use a real date, e.g. 24/07/2026.",
    "Quantity is required for buy/sell/adjustment/deposit/withdrawal rows (a deposit/withdrawal's Quantity is its GBP amount).",
    "Actual Total GBP is the authoritative GBP amount actually charged/received — if left blank, it is estimated from Native Unit Price × Quantity × Purchase FX Rate.",
    "Purchase FX Rate is the GBP-per-native-currency rate at the time of the trade — required for a non-GBP buy/sell if Actual Total GBP is left blank.",
    "Import Reference is optional but strongly recommended — re-importing the same file will never create duplicate transactions for rows that share the same Import Reference.",
    "Do not add totals, merged cells, notes, or formulas within the import table.",
  ];
  lines.forEach((text, index) => {
    const cell = instructions.getCell(`A${index + 1}`);
    cell.value = text;
    if (index === 0) cell.font = { bold: true, size: 13 };
    else if (text) cell.font = { size: 11 };
    cell.alignment = { wrapText: false, vertical: "top" };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export const INVESTMENTS_IMPORT_TEMPLATE_FILENAME = "investments-import-template.xlsx";
