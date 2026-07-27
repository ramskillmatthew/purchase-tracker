import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { detectFileKind, MAX_IMPORT_FILE_BYTES, readSheetFile, SheetReadError, SUPPORTED_EXTENSIONS } from "@/lib/purchase-import-sheet/read-file";
import { FORMULA_CELL } from "@/lib/purchase-import-sheet/schema";

describe("detectFileKind", () => {
  it("accepts .xlsx and .csv case-insensitively, rejects everything else including .xls", () => {
    expect(detectFileKind("template.xlsx")).toBe("xlsx");
    expect(detectFileKind("Template.XLSX")).toBe("xlsx");
    expect(detectFileKind("purchases.csv")).toBe("csv");
    expect(detectFileKind("purchases.CSV")).toBe("csv");
    expect(detectFileKind("legacy.xls")).toBeNull();
    expect(detectFileKind("purchases.txt")).toBeNull();
    expect(detectFileKind("no-extension")).toBeNull();
  });

  it("only advertises the two genuinely supported extensions", () => {
    expect(SUPPORTED_EXTENSIONS).toEqual([".xlsx", ".csv"]);
  });
});

it("enforces a 5MB file size ceiling", () => {
  expect(MAX_IMPORT_FILE_BYTES).toBe(5 * 1024 * 1024);
});

describe("readSheetFile — csv", () => {
  it("REQUIREMENT 20: handles quoted commas, escaped quotes, multiline cells, and a UTF-8 BOM", async () => {
    const bom = "﻿";
    const csv = `${bom}Order Date,Purchased From,Item Description,Price Purchased\n2026-07-24,"Vinted, UK","He said ""hi""\nsecond line",12.50\n`;
    const rows = await readSheetFile(Buffer.from(csv, "utf8"), "csv");
    expect(rows[0]).toEqual(["Order Date", "Purchased From", "Item Description", "Price Purchased"]);
    expect(rows[1]).toEqual(["2026-07-24", "Vinted, UK", 'He said "hi"\nsecond line', "12.50"]);
    // no stray BOM character leaking into the first header cell
    expect((rows[0][0] as string).charCodeAt(0)).not.toBe(0xfeff);
  });

  it("REQUIREMENT 25: never executes a formula-looking CSV cell — CSV has no formula concept, so it stays a literal string", async () => {
    const csv = "Item Description,Price Purchased\n=1+1,12.50\n";
    const rows = await readSheetFile(Buffer.from(csv, "utf8"), "csv");
    expect(rows[1][0]).toBe("=1+1");
  });
});

describe("readSheetFile — xlsx", () => {
  async function buildWorkbookBuffer(configure: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Purchases");
    configure(sheet);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it("reads a real Excel date cell as a Date object", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "Order Date";
      sheet.getCell("A2").value = new Date(Date.UTC(2026, 6, 24));
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows[1][0]).toBeInstanceOf(Date);
    expect((rows[1][0] as Date).getUTCFullYear()).toBe(2026);
  });

  it("preserves a text-formatted SKU with leading zeroes", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "SKU";
      sheet.getCell("A2").value = "007";
      sheet.getCell("A2").numFmt = "@";
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows[1][0]).toBe("007");
  });

  it("SAFETY: a formula with a cached numeric result is flagged, never imported as that number", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "Price Purchased";
      sheet.getCell("A2").value = { formula: "1+1", result: 2 } as ExcelJS.CellFormulaValue;
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows[1][0]).toBe(FORMULA_CELL);
  });

  it("SAFETY: a formula with a cached text result is flagged, never imported as that text", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "Item Description";
      sheet.getCell("A2").value = { formula: 'CONCATENATE("Nike"," Air Max")', result: "Nike Air Max" } as ExcelJS.CellFormulaValue;
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows[1][0]).toBe(FORMULA_CELL);
  });

  it("SAFETY: a formula whose cached result is an error is also flagged, not silently nulled", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "Price Purchased";
      sheet.getCell("A2").value = { formula: "1/0", result: { error: "#DIV/0!" } } as unknown as ExcelJS.CellFormulaValue;
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows[1][0]).toBe(FORMULA_CELL);
  });

  it("SAFETY: a literal string cell that merely starts with '=' (never an actual formula-type cell) is left as ordinary text", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "Purchased From";
      sheet.getCell("A2").value = "=1+1";
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows[1][0]).toBe("=1+1");
    expect(rows[1][0]).not.toBe(FORMULA_CELL);
  });

  it("reads rich-text cells as their plain concatenated text, never a hyperlink target", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "Item Description";
      sheet.getCell("A2").value = { richText: [{ text: "Nike " }, { text: "Air Max" }] };
      sheet.getCell("B1").value = "Purchased From";
      sheet.getCell("B2").value = { text: "Vinted profile", hyperlink: "https://example.invalid/track" };
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows[1][0]).toBe("Nike Air Max");
    expect(rows[1][1]).toBe("Vinted profile");
  });

  it("represents a fully blank row as all-null cells, matching the header's column width", async () => {
    const buffer = await buildWorkbookBuffer(sheet => {
      sheet.getCell("A1").value = "Order Date";
      sheet.getCell("B1").value = "Purchased From";
      sheet.getCell("A2").value = "2026-07-24";
      sheet.getCell("B2").value = "Vinted";
      sheet.addRow([]);
      sheet.getCell("A4").value = "2026-07-25";
      sheet.getCell("B4").value = "eBay";
    });
    const rows = await readSheetFile(buffer, "xlsx");
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual([null, null]);
  });

  it("rejects a buffer that is not actually a zip/xlsx file", async () => {
    await expect(readSheetFile(Buffer.from("not a real workbook"), "xlsx")).rejects.toBeInstanceOf(SheetReadError);
  });
});
