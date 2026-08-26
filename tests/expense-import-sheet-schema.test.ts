import { describe, expect, it } from "vitest";
import {
  buildImportRows, importColumns, mapHeadings, type ImportField,
} from "@/lib/expense-import-sheet/schema";
import { FORMULA_CELL, parseImportArrived, parseImportDate, parseMoneyValue, type CellValue } from "@/lib/spreadsheet-import/cell-parsers";

const canonicalHeader = importColumns.map(c => c.heading);

describe("mapHeadings", () => {
  it("REQUIREMENT 35: maps the exact official template headings in order", () => {
    const result = mapHeadings(canonicalHeader);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mapping).toEqual(importColumns.map(c => c.field));
  });

  it("REQUIREMENT 2: recognises every specified alias, case-insensitively, ignoring underscores/hyphens/repeated spaces", () => {
    const result = mapHeadings(["  Expense Date ", "SUPPLIER", "received", "Product", "price-paid"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mapping).toEqual(["order_date", "purchased_from", "arrived", "item_description", "cost"]);
  });

  it("recognises every alias listed in the spec for each field", () => {
    const aliasesByField: Record<ImportField, string[]> = {
      order_date: ["Order Date", "Purchase Date", "Date", "Expense Date"],
      purchased_from: ["Purchased From", "Retailer", "Shop", "Store", "Supplier", "Source"],
      arrived: ["Arrived", "Has Arrived", "Received"],
      item_description: ["Item Description", "Description", "Item", "Product", "Expense Description"],
      cost: ["Cost", "Amount", "Price", "Expense Cost", "Price Paid"],
    };
    for (const [field, aliases] of Object.entries(aliasesByField) as [ImportField, string[]][]) {
      for (const alias of aliases) {
        const header = importColumns.map(c => (c.field === field ? alias : c.heading));
        const result = mapHeadings(header);
        expect(result.ok, `${alias} should map to ${field}`).toBe(true);
        if (result.ok) expect(result.mapping[importColumns.findIndex(c => c.field === field)]).toBe(field);
      }
    }
  });

  it("REQUIREMENT 4: reports every missing required heading rather than guessing", () => {
    const result = mapHeadings(["Order Date", "Purchased From"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("item_description");
      expect(result.missing).toContain("cost");
    }
  });

  it("REQUIREMENT 5: stops on duplicate headings mapping to the same field rather than picking one", () => {
    const result = mapHeadings([...canonicalHeader, "Amount"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.duplicates[0].field).toBe("cost");
  });

  it("REQUIREMENT 6: ignores unrecognised extra columns and reports them back", () => {
    const result = mapHeadings([...canonicalHeader, "Notes"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ignoredColumns).toEqual(["Notes"]);
  });
});

function cellsFor(overrides: Partial<Record<ImportField, CellValue>> = {}) {
  const base: Record<ImportField, CellValue> = {
    order_date: "2026-07-24", purchased_from: "Amazon", arrived: "Yes", item_description: "Packing tape", cost: 4.99,
  };
  return { ...base, ...overrides };
}
function aoaFrom(rows: Record<ImportField, CellValue>[]): CellValue[][] {
  return [canonicalHeader, ...rows.map(row => importColumns.map(c => row[c.field]))];
}

describe("buildImportRows", () => {
  it("REQUIREMENT 7: skips completely blank rows without renumbering the rows that follow", () => {
    const aoa = aoaFrom([cellsFor(), cellsFor({ order_date: null, purchased_from: null, arrived: null, item_description: null, cost: null }), cellsFor({ item_description: "Second item" })]);
    const result = buildImportRows(aoa);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].row).toBe(2);
      expect(result.rows[1].row).toBe(4);
    }
  });

  it("REQUIREMENT 8: rejects a partially populated row rather than skipping it", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ purchased_from: null })]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].errors.some(e => e.field === "purchased_from")).toBe(true);
    }
  });

  it("REQUIREMENT 9: uses the correct spreadsheet row number (header offset included), e.g. 'Row 7: Item Description is required.'", () => {
    const rows = [cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor({ item_description: null })];
    const result = buildImportRows(aoaFrom(rows));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const failing = result.rows.find(row => row.errors.length);
      expect(failing?.row).toBe(7);
      expect(failing?.errors[0]).toEqual({ field: "item_description", reason: "Item Description is required." });
    }
  });

  it("REQUIREMENT 10/11/12: real Excel date, ISO, UK, and invalid dates all behave per parseImportDate", () => {
    expect(parseImportDate(new Date(Date.UTC(2026, 6, 24)))).toEqual({ ok: true, value: "2026-07-24" });
    expect(parseImportDate("2026-07-24")).toEqual({ ok: true, value: "2026-07-24" });
    expect(parseImportDate("24/07/2026")).toEqual({ ok: true, value: "2026-07-24" });
    expect(parseImportDate("31/02/2026").ok).toBe(false);
  });

  it("REQUIREMENT 14/15: Arrived accepts Yes/No/True/False/1/0/blank and rejects other values", () => {
    expect(parseImportArrived("Yes")).toEqual({ ok: true, value: true });
    expect(parseImportArrived("0")).toEqual({ ok: true, value: false });
    expect(parseImportArrived("")).toEqual({ ok: true, value: null });
    expect(parseImportArrived("maybe").ok).toBe(false);
  });

  it("REQUIREMENT 16/17/18: Cost accepts numeric, pound-prefixed, and comma-formatted amounts", () => {
    expect(parseMoneyValue(4.99, "Cost")).toEqual({ ok: true, value: 4.99 });
    expect(parseMoneyValue("£4.99", "Cost")).toEqual({ ok: true, value: 4.99 });
    expect(parseMoneyValue("1,250.00", "Cost")).toEqual({ ok: true, value: 1250 });
  });

  it("REQUIREMENT 19: rejects negative cost", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ cost: -5 })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "cost")).toBe(true);
  });

  it("REQUIREMENT 20: rejects cost with more than two decimal places rather than rounding", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ cost: "12.345" })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "cost")).toBe(true);
  });

  it("REQUIREMENT 31: every valid row produces a candidate that maps Order Date to purchase_date and is otherwise field-for-field expenseInputSchema-shaped", () => {
    const result = buildImportRows(aoaFrom([cellsFor()]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].errors).toEqual([]);
      expect(result.rows[0].expense).toEqual({
        purchase_date: "2026-07-24", purchased_from: "Amazon", arrived: true, item_description: "Packing tape", cost: 4.99,
      });
    }
  });

  it("still runs every row through the real expenseInputSchema as the final gate (e.g. an over-length field is rejected)", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ item_description: "x".repeat(501) })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "item_description")).toBe(true);
  });

  it("literal text beginning with '=' remains inert ordinary text, never evaluated", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ purchased_from: "=1+1" })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].expense?.purchased_from).toBe("=1+1");
  });
});

describe("SAFETY: formula cells are rejected explicitly in every one of the five mapped fields", () => {
  const fieldLabels: Record<ImportField, string> = {
    order_date: "Order Date", purchased_from: "Purchased From", arrived: "Arrived", item_description: "Item Description", cost: "Cost",
  };

  it("REQUIREMENT 21: applies to all five mapped fields with clear, field-specific messages", () => {
    for (const field of importColumns.map(c => c.field)) {
      const result = buildImportRows(aoaFrom([cellsFor({ [field]: FORMULA_CELL })]));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const error = result.rows[0].errors.find(e => e.field === field);
      expect(error).toEqual({ field, reason: `${fieldLabels[field]} must contain a value, not a formula.` });
      expect(result.rows[0].expense).toBeNull();
    }
  });

  it("REQUIREMENT: uses the exact 'Row N: Cost must contain a value, not a formula.' wording with the correct row number", () => {
    const rows = [cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor({ cost: FORMULA_CELL })];
    const result = buildImportRows(aoaFrom(rows));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failing = result.rows.find(row => row.errors.length);
    expect(failing?.row).toBe(7);
    expect(failing?.errors[0]).toEqual({ field: "cost", reason: "Cost must contain a value, not a formula." });
  });

  it("a formula cell is never treated as blank — the row is still validated and rejected, not silently skipped", () => {
    const allFormula = importColumns.reduce((acc, c) => ({ ...acc, [c.field]: FORMULA_CELL }), {} as Record<ImportField, CellValue>);
    const result = buildImportRows(aoaFrom([allFormula]));
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.rows).toHaveLength(1); expect(result.rows[0].errors).toHaveLength(5); }
  });

  it("REGRESSION: ordinary, non-formula values for every field are completely unaffected", () => {
    const result = buildImportRows(aoaFrom([cellsFor()]));
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.rows[0].errors).toEqual([]); expect(result.rows[0].expense).not.toBeNull(); }
  });
});
