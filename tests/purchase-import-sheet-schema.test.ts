import { describe, expect, it } from "vitest";
import { conditions } from "@/lib/validation/purchase";
import {
  buildImportRows, FORMULA_CELL, importColumns, mapHeadings, parseImportArrived, parseImportCondition,
  parseImportDate, parseImportPrice, type CellValue, type ImportField,
} from "@/lib/purchase-import-sheet/schema";

const canonicalHeader = importColumns.map(c => c.heading);

describe("mapHeadings", () => {
  it("REQUIREMENT 1: maps the exact template headings in order", () => {
    const result = mapHeadings(canonicalHeader);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mapping).toEqual(importColumns.map(c => c.field));
  });

  it("REQUIREMENT 2: recognises aliases, case-insensitively, ignoring underscores/hyphens/repeated spaces", () => {
    const result = mapHeadings(["  Date ", "Retailer", "sku", "HAS_ARRIVED", "Product", "Item   Size", "CONDITION", "purchase-price"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mapping).toEqual(["order_date", "purchased_from", "sku", "arrived", "item_description", "item_size", "item_condition", "price_purchased"]);
  });

  it("REQUIREMENT 3: reports every missing required heading rather than guessing", () => {
    const result = mapHeadings(["Order Date", "Purchased From", "SKU"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("item_description");
      expect(result.missing).toContain("price_purchased");
    }
  });

  it("REQUIREMENT 4: stops on duplicate headings mapping to the same field rather than picking one", () => {
    const result = mapHeadings([...canonicalHeader, "Condition"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.duplicates[0].field).toBe("item_condition");
  });

  it("ignores unrecognised extra columns and reports them back", () => {
    const result = mapHeadings([...canonicalHeader, "Notes"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ignoredColumns).toEqual(["Notes"]);
  });
});

describe("parseImportDate", () => {
  it("REQUIREMENT 6: accepts a real Excel date cell using UTC getters (never shifted by local timezone)", () => {
    const result = parseImportDate(new Date(Date.UTC(2026, 6, 24)));
    expect(result).toEqual({ ok: true, value: "2026-07-24" });
  });

  it("REQUIREMENT 7: accepts UK dd/mm/yyyy strings", () => {
    expect(parseImportDate("24/07/2026")).toEqual({ ok: true, value: "2026-07-24" });
  });

  it("REQUIREMENT 8: accepts ISO yyyy-mm-dd strings", () => {
    expect(parseImportDate("2026-07-24")).toEqual({ ok: true, value: "2026-07-24" });
  });

  it("REQUIREMENT 9: rejects calendar-invalid dates (both UK and ISO forms)", () => {
    expect(parseImportDate("31/02/2026").ok).toBe(false);
    expect(parseImportDate("2026-02-30").ok).toBe(false);
  });

  it("rejects a blank cell as required, not as a silently-skipped optional field", () => {
    expect(parseImportDate(null)).toEqual({ ok: false, error: "Order Date is required." });
  });
});

describe("parseImportArrived", () => {
  it("REQUIREMENT 10: accepts Yes/No/True/False/1/0 case-insensitively, and blank as null", () => {
    expect(parseImportArrived("Yes")).toEqual({ ok: true, value: true });
    expect(parseImportArrived("no")).toEqual({ ok: true, value: false });
    expect(parseImportArrived("TRUE")).toEqual({ ok: true, value: true });
    expect(parseImportArrived("false")).toEqual({ ok: true, value: false });
    expect(parseImportArrived(1)).toEqual({ ok: true, value: true });
    expect(parseImportArrived(0)).toEqual({ ok: true, value: false });
    expect(parseImportArrived(null)).toEqual({ ok: true, value: null });
    expect(parseImportArrived("")).toEqual({ ok: true, value: null });
  });

  it("REQUIREMENT 11: rejects any other value with a row-specific error", () => {
    const result = parseImportArrived("maybe");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Arrived");
  });
});

describe("parseImportCondition (purchase-import ONLY: free text, never canonicalized)", () => {
  it("1. accepts every one of the five canonical conditions unchanged", () => {
    for (const condition of conditions) expect(parseImportCondition(condition)).toEqual({ ok: true, value: condition });
  });

  it("2/3. accepts historical free-text descriptions verbatim — never mapped to a canonical condition", () => {
    expect(parseImportCondition("Holes in heel")).toEqual({ ok: true, value: "Holes in heel" });
    expect(parseImportCondition("Scuffs on toe box")).toEqual({ ok: true, value: "Scuffs on toe box" });
  });

  it("4. preserves capitalization exactly — never normalized to a canonical value's casing", () => {
    expect(parseImportCondition("brand new")).toEqual({ ok: true, value: "brand new" });
    expect(parseImportCondition("HEAVILY WORN")).toEqual({ ok: true, value: "HEAVILY WORN" });
  });

  it("5. trims only surrounding whitespace, preserving the wording exactly", () => {
    expect(parseImportCondition("  Scuffs on toe box  ")).toEqual({ ok: true, value: "Scuffs on toe box" });
  });

  it("6. rejects a blank condition", () => {
    expect(parseImportCondition("")).toEqual({ ok: false, error: "Item Condition is required." });
    expect(parseImportCondition("   ")).toEqual({ ok: false, error: "Item Condition is required." });
  });

  it("7. rejects a null condition", () => {
    expect(parseImportCondition(null)).toEqual({ ok: false, error: "Item Condition is required." });
  });

  it("no longer rejects a condition merely for being outside the canonical list", () => {
    expect(parseImportCondition("Like new")).toEqual({ ok: true, value: "Like new" });
  });
});

describe("parseImportPrice", () => {
  it("REQUIREMENT 15: accepts numeric Excel cells", () => {
    expect(parseImportPrice(12.5)).toEqual({ ok: true, value: 12.5 });
  });

  it("REQUIREMENT 16: accepts pound-prefixed strings", () => {
    expect(parseImportPrice("£12.50")).toEqual({ ok: true, value: 12.5 });
  });

  it("REQUIREMENT 17: accepts comma-formatted strings", () => {
    expect(parseImportPrice("1,250.00")).toEqual({ ok: true, value: 1250 });
  });

  it("REQUIREMENT 18: rejects negative, non-numeric, NaN, and infinite values", () => {
    expect(parseImportPrice("-5").ok).toBe(false);
    expect(parseImportPrice("abc").ok).toBe(false);
    expect(parseImportPrice(NaN).ok).toBe(false);
    expect(parseImportPrice(Infinity).ok).toBe(false);
    expect(parseImportPrice(-5).ok).toBe(false);
  });

  it("does not silently round beyond 2 decimal places — a genuine 3rd decimal is rejected", () => {
    expect(parseImportPrice("12.345").ok).toBe(false);
    expect(parseImportPrice(12.345).ok).toBe(false);
  });

  it("tolerates harmless floating-point noise at the 2dp boundary", () => {
    expect(parseImportPrice(12.5000000001)).toEqual({ ok: true, value: 12.5 });
  });

  it("requires a value rather than silently coercing a blank cell to zero", () => {
    expect(parseImportPrice(null)).toEqual({ ok: false, error: "Price Purchased is required." });
    expect(parseImportPrice("")).toEqual({ ok: false, error: "Price Purchased is required." });
  });
});

function cellsFor(overrides: Partial<Record<typeof importColumns[number]["field"], CellValue>> = {}) {
  const base: Record<string, CellValue> = {
    order_date: "2026-07-24", purchased_from: "Vinted", sku: "1801", arrived: "Yes",
    item_description: "Nike Air Max 95", item_size: "9", item_condition: "Brand new", price_purchased: 13.49,
  };
  return { ...base, ...overrides };
}
function aoaFrom(rows: Record<string, CellValue>[]): CellValue[][] {
  return [canonicalHeader, ...rows.map(row => importColumns.map(c => row[c.field]))];
}

describe("buildImportRows", () => {
  it("REQUIREMENT 5: skips completely blank rows without renumbering the rows that follow", () => {
    const aoa = aoaFrom([cellsFor(), {}, cellsFor({ sku: "1802" })]);
    const result = buildImportRows(aoa);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].row).toBe(2);
      // row 3 is the blank row (skipped); the next real row is spreadsheet row 4
      expect(result.rows[1].row).toBe(4);
    }
  });

  it("REQUIREMENT 19: preserves SKU text with leading zeroes", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ sku: "007" })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].purchase?.sku).toBe("007");
  });

  it("allows a blank SKU, matching the existing purchase schema's own rule", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ sku: null })]));
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.rows[0].errors).toEqual([]); expect(result.rows[0].purchase?.sku).toBe(""); }
  });

  it("REQUIREMENT 23: forces quantity 1 and seller_name null on every imported row, never client/sheet-suppliable", () => {
    const result = buildImportRows(aoaFrom([cellsFor()]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].purchase?.quantity).toBe(1);
      expect(result.rows[0].purchase?.seller_name).toBeNull();
    }
  });

  it("REQUIREMENT: uses spreadsheet row numbers (header offset included) in error output, e.g. 'Row 7: Item Description is required.'", () => {
    const rows = [cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor({ item_description: "" })];
    const result = buildImportRows(aoaFrom(rows));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const failing = result.rows.find(row => row.errors.length);
      expect(failing?.row).toBe(7);
      expect(failing?.errors[0]).toEqual({ field: "item_description", reason: "Item Description is required." });
    }
  });

  it("rejects a partially populated row and reports every missing field, not just the first", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ purchased_from: "", item_size: "" })]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fields = result.rows[0].errors.map(e => e.field);
      expect(fields).toContain("purchased_from");
      expect(fields).toContain("item_size");
    }
  });

  it("REQUIREMENT 25: a formula-like string is preserved as literal untrusted text, never evaluated", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ purchased_from: "=1+1" })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].purchase?.purchased_from).toBe("=1+1");
  });

  it("still runs every row through the real purchaseImportInputSchema as the final gate (e.g. an over-length field is rejected)", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ item_description: "x".repeat(501) })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "item_description")).toBe(true);
  });

  it("2/3/4/5. imports a historical free-text Item Condition unchanged, trimmed, case preserved, alongside normal validation of every other field", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ item_condition: "  Holes in heel  " })]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].errors).toEqual([]);
      expect(result.rows[0].purchase?.item_condition).toBe("Holes in heel");
      // 10. every other field still goes through its own normal validation, unaffected
      expect(result.rows[0].purchase?.order_date).toBe("2026-07-24");
      expect(result.rows[0].purchase?.price_purchased).toBe(13.49);
    }
  });

  it("8. rejects an excessively long Item Condition (the dedicated import schema caps at 200 characters)", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ item_condition: "x".repeat(201) })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors).toContainEqual({ field: "item_condition", reason: "Item Condition is too long." });
  });

  it("accepts an Item Condition right at the 200-character limit", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ item_condition: "x".repeat(200) })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors).toEqual([]);
  });

  it("rejects unsafe control characters in Item Condition", () => {
    const result = buildImportRows(aoaFrom([cellsFor({ item_condition: "Holes in heel\x00" })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "item_condition")).toBe(true);
  });
});

describe("SAFETY: formula cells are rejected explicitly, never accepted as their cached result", () => {
  const fieldLabels: Record<ImportField, string> = {
    order_date: "Order Date", purchased_from: "Purchased From", sku: "SKU", arrived: "Arrived",
    item_description: "Item Description", item_size: "Size", item_condition: "Item Condition", price_purchased: "Price Purchased",
  };

  it("applies to all eight mapped fields, each with its own clear, field-specific message", () => {
    for (const field of importColumns.map(c => c.field)) {
      const result = buildImportRows(aoaFrom([cellsFor({ [field]: FORMULA_CELL })]));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const error = result.rows[0].errors.find(e => e.field === field);
      expect(error).toEqual({ field, reason: `${fieldLabels[field]} must contain a value, not a formula.` });
      expect(result.rows[0].purchase).toBeNull();
    }
  });

  it("REQUIREMENT: uses the exact 'Row N: <Field> must contain a value, not a formula.' wording with the correct spreadsheet row number", () => {
    const rows = [cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor(), cellsFor({ price_purchased: FORMULA_CELL })];
    const result = buildImportRows(aoaFrom(rows));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failing = result.rows.find(row => row.errors.length);
    expect(failing?.row).toBe(7);
    expect(failing?.errors[0]).toEqual({ field: "price_purchased", reason: "Price Purchased must contain a value, not a formula." });
  });

  it("rejects a formula cell even when its cached result would otherwise have looked like a perfectly valid value", () => {
    // FORMULA_CELL never carries the cached value at all by this point (read-file.ts
    // discards it before it reaches here) — this just documents that the row is
    // rejected outright rather than falling through to any default/blank handling.
    const result = buildImportRows(aoaFrom([cellsFor({ item_condition: FORMULA_CELL })]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].errors).toEqual([{ field: "item_condition", reason: "Item Condition must contain a value, not a formula." }]);
      expect(result.rows[0].values.item_condition).toBe("");
    }
  });

  it("a formula cell is never treated as blank — the row is still validated and rejected, not silently skipped", () => {
    const allFormula = importColumns.reduce((acc, c) => ({ ...acc, [c.field]: FORMULA_CELL }), {} as Record<ImportField, CellValue>);
    const result = buildImportRows(aoaFrom([allFormula]));
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.rows).toHaveLength(1); expect(result.rows[0].errors).toHaveLength(8); }
  });

  it("REGRESSION: ordinary, non-formula values for every field are completely unaffected", () => {
    const result = buildImportRows(aoaFrom([cellsFor()]));
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.rows[0].errors).toEqual([]); expect(result.rows[0].purchase).not.toBeNull(); }
  });
});
