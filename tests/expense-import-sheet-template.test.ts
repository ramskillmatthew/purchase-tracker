import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildImportTemplate, IMPORT_TEMPLATE_FILENAME } from "@/lib/expense-import-sheet/template";
import { importColumns, buildImportRows } from "@/lib/expense-import-sheet/schema";
import { readSheetFile } from "@/lib/spreadsheet-import/read-file";

describe("buildImportTemplate (expenses)", () => {
  it("REQUIREMENT: suggests the exact requested filename", () => {
    expect(IMPORT_TEMPLATE_FILENAME).toBe("expense-import-template.xlsx");
  });

  it("opens successfully and contains the Expenses and Instructions worksheets", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    expect(workbook.getWorksheet("Expenses")).toBeTruthy();
    expect(workbook.getWorksheet("Instructions")).toBeTruthy();
  });

  it("REQUIREMENT 35: has all five columns, in the exact required order and wording", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("Expenses")!;
    const headings = sheet.getRow(1).values as unknown[];
    expect(headings.slice(1)).toEqual(["Order Date", "Purchased From", "Arrived", "Item Description", "Cost"]);
    expect(importColumns.map(c => c.heading)).toEqual(["Order Date", "Purchased From", "Arrived", "Item Description", "Cost"]);
  });

  it("does not pre-fill any example expense row — the data-entry table itself is empty", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("Expenses")!;
    const row2Values = (sheet.getRow(2).values as unknown[]).slice(1).filter(value => value !== null && value !== undefined);
    expect(row2Values).toEqual([]);
  });

  function columnLetter(field: string): string {
    return String.fromCharCode(65 + importColumns.findIndex(c => c.field === field));
  }

  it("REQUIREMENT 37: formats Order Date as dd/mm/yyyy and Cost as GBP currency", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("Expenses")!;
    expect(sheet.getColumn(columnLetter("order_date")).numFmt).toBe("dd/mm/yyyy");
    expect(sheet.getColumn(columnLetter("cost")).numFmt).toContain("£");
  });

  it("REQUIREMENT 37: freezes the header row and adds an autofilter across all five columns", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("Expenses")!;
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(JSON.stringify(sheet.autoFilter)).toContain("A1");
    expect(JSON.stringify(sheet.autoFilter)).toContain("E1");
  });

  it("has sensible column widths so no heading is clipped", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("Expenses")!;
    importColumns.forEach(column => {
      const width = sheet.getColumn(columnLetter(column.field)).width ?? 0;
      expect(width).toBeGreaterThanOrEqual(column.heading.length);
    });
  });

  it("REQUIREMENT 37: adds a Yes/No dropdown validation on the Arrived column", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("Expenses")!;
    const arrivedValidation = sheet.getCell("C5").dataValidation;
    expect(arrivedValidation?.type).toBe("list");
    expect(arrivedValidation?.formulae?.[0]).toBe('"Yes,No"');
  });

  it("REQUIREMENT 36: contains no formulas anywhere in the generated workbook", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    for (const sheet of workbook.worksheets) {
      sheet.eachRow(row => row.eachCell(cell => {
        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
      }));
    }
  });

  it("includes a short Instructions sheet covering the required-field and no-formulas rules", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const instructions = workbook.getWorksheet("Instructions")!;
    const text = instructions.getSheetValues().flat().filter(Boolean).join(" ");
    expect(text).toContain("Order Date is required");
    expect(text).toContain("Purchased From is required");
    expect(text).toContain("Item Description is required");
    expect(text).toContain("Cost must be a non-negative");
    expect(text).toContain("formulas");
  });

  it("REQUIREMENT: the same template can be read back by the importer's own parser after adding valid data", async () => {
    const buffer = await buildImportTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("Expenses")!;
    sheet.addRow(["2026-07-24", "Amazon", "Yes", "Packing tape", 4.99]);
    const roundTrip = Buffer.from(await workbook.xlsx.writeBuffer());
    const aoa = await readSheetFile(roundTrip, "xlsx");
    const result = buildImportRows(aoa);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].errors).toEqual([]);
      expect(result.rows[0].expense?.purchase_date).toBe("2026-07-24");
    }
  });
});
