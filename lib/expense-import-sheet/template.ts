import ExcelJS from "exceljs";
import { importColumns } from "./schema";

/**
 * Generates the downloadable expense-import-template.xlsx entirely
 * server-side via exceljs — mirrors lib/purchase-import-sheet/template.ts's
 * styling exactly (same header fill/font, same freeze/autofilter/format
 * conventions) for a consistent look, but with the expense-specific 5
 * columns and a single Arrived dropdown instead of two. No Excel
 * installation involved, no macros (exceljs cannot write them), no example
 * expense rows (an empty data-entry table is safer than a "delete this
 * row" convention).
 */

const COLUMN_WIDTHS: Record<string, number> = {
  order_date: 14, purchased_from: 22, arrived: 10, item_description: 40, cost: 16,
};

// Working range for dropdown validation — generous enough for a real batch
// without bloating the file with per-row validation for thousands of rows
// nobody will use (the commit endpoint caps at 500 rows anyway).
const VALIDATION_ROWS = 200;

export async function buildImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Purchase Tracker";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Expenses", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = importColumns.map(column => ({ header: column.heading, key: column.field, width: COLUMN_WIDTHS[column.field] }));

  const headerRow = sheet.getRow(1);
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF32405A" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF1F2937" } } };
  });
  sheet.autoFilter = { from: "A1", to: "E1" };

  sheet.getColumn("order_date").numFmt = "dd/mm/yyyy";
  sheet.getColumn("cost").numFmt = "£#,##0.00";

  const arrivedColumn = String.fromCharCode(65 + importColumns.findIndex(c => c.field === "arrived"));
  for (let row = 2; row <= VALIDATION_ROWS; row++) {
    sheet.getCell(`${arrivedColumn}${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'] };
  }

  const instructions = workbook.addWorksheet("Instructions");
  instructions.getColumn(1).width = 92;
  const lines = [
    "How to use this template",
    "",
    "Do not rename the column headings on the Expenses sheet.",
    "Use one row per expense.",
    "Order Date is required — use a real date, e.g. 24/07/2026.",
    "Purchased From is required.",
    "Arrived accepts Yes, No, or blank.",
    "Item Description is required.",
    "Cost must be a non-negative amount in pounds, e.g. 12.50.",
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

export const IMPORT_TEMPLATE_FILENAME = "expense-import-template.xlsx";
