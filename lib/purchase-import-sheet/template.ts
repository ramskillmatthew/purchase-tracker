import ExcelJS from "exceljs";
import { conditions } from "@/lib/validation/purchase";
import { importColumns } from "./schema";

/**
 * Generates the downloadable purchase-import-template.xlsx entirely
 * server-side via exceljs — no Excel installation involved, no macros
 * (exceljs cannot write them), no example purchase rows (an empty
 * data-entry table is safer than a "delete this row" convention).
 */

const COLUMN_WIDTHS: Record<string, number> = {
  order_date: 14, purchased_from: 22, sku: 14, arrived: 10,
  item_description: 40, item_size: 12, item_condition: 32, price_purchased: 16,
};

// Working range for dropdown validation and formats — generous enough for
// a real batch without bloating the file with per-row validation for
// thousands of rows nobody will use (the commit endpoint caps at 500 rows
// anyway).
const VALIDATION_ROWS = 200;

export async function buildImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Purchase Tracker";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Purchases", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = importColumns.map(column => ({ header: column.heading, key: column.field, width: COLUMN_WIDTHS[column.field] }));

  const headerRow = sheet.getRow(1);
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF32405A" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF1F2937" } } };
  });
  sheet.autoFilter = { from: "A1", to: "H1" };

  sheet.getColumn("order_date").numFmt = "dd/mm/yyyy";
  sheet.getColumn("sku").numFmt = "@";
  sheet.getColumn("price_purchased").numFmt = "£#,##0.00";

  const arrivedColumn = String.fromCharCode(65 + importColumns.findIndex(c => c.field === "arrived"));
  const conditionColumn = String.fromCharCode(65 + importColumns.findIndex(c => c.field === "item_condition"));
  for (let row = 2; row <= VALIDATION_ROWS; row++) {
    sheet.getCell(`${arrivedColumn}${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'] };
    sheet.getCell(`${conditionColumn}${row}`).dataValidation = { type: "list", allowBlank: true, formulae: [`"${conditions.join(",")}"`] };
  }

  const instructions = workbook.addWorksheet("Instructions");
  instructions.getColumn(1).width = 92;
  const lines = [
    "How to use this template",
    "",
    "Do not rename the column headings on the Purchases sheet.",
    "Use one row per item.",
    "Order Date is required — use a real date, e.g. 24/07/2026.",
    "Purchased From is required.",
    "SKU may be left blank.",
    "Arrived accepts Yes, No, or blank.",
    "Item Description is required.",
    "Size is required.",
    `Item Condition: choose one of ${conditions.join(", ")} for a new purchase.`,
    "Historical spreadsheet imports may use a factual free-text condition description, such as ‘Holes in heel’ or ‘Scuffs on toe box’. New purchases should use one of the standard conditions.",
    "Price Purchased must be a non-negative amount in pounds, e.g. 12.50.",
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

export const IMPORT_TEMPLATE_FILENAME = "purchase-import-template.xlsx";
