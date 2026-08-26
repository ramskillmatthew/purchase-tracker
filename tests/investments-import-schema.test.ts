import { describe, expect, it } from "vitest";
import { buildImportRows, importColumns, FORMULA_CELL, type CellValue } from "@/lib/investments-import/schema";

const HEADER = importColumns.map(c => c.heading);

function row(values: Partial<Record<string, CellValue>>): CellValue[] {
  return importColumns.map(c => values[c.field] ?? null);
}

describe("investments-import schema — header mapping", () => {
  it("accepts the real template header row", () => {
    const result = buildImportRows([HEADER]);
    expect(result.ok).toBe(true);
  });

  it("rejects a file missing a required column", () => {
    const result = buildImportRows([HEADER.filter(h => h !== "Ticker")]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Ticker/);
  });

  it("recognises heading aliases (case/spacing-insensitive)", () => {
    const aliasHeader = HEADER.map(h => h === "Account Name" ? "account name" : h === "Ticker" ? "SYMBOL" : h);
    const result = buildImportRows([aliasHeader]);
    expect(result.ok).toBe(true);
  });
});

describe("investments-import schema — row validation", () => {
  it("a valid stock buy row produces a candidate with no errors", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "Stocks & Shares ISA", asset_category: "stock", asset_name: "NVIDIA Corp", ticker: "NVDA",
      transaction_type: "buy", transaction_date: "01/01/2026", quantity: 10, native_unit_price: 100, currency: "USD", fx_rate_at_trade: 0.8,
    })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].errors).toEqual([]);
      expect(result.rows[0].candidate?.ticker).toBe("NVDA");
      expect(result.rows[0].candidate?.transactionType).toBe("buy");
    }
  });

  it("requires Ticker for a stock row", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", transaction_type: "buy", transaction_date: "01/01/2026", quantity: 1,
    })]);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "ticker")).toBe(true);
  });

  it("requires PokePulse URL for a pokemon row", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "Pokémon Collection", asset_category: "pokemon", transaction_type: "buy", transaction_date: "01/01/2026", quantity: 1,
    })]);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "pokepulse_url")).toBe(true);
  });

  it("requires LEGO Set Number for a lego row", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "LEGO Collection", asset_category: "lego", asset_name: "Millennium Falcon", transaction_type: "buy", transaction_date: "01/01/2026", quantity: 1,
    })]);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "lego_set_number")).toBe(true);
  });

  it("rejects an unrecognised asset_category or transaction_type", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "A", asset_category: "crypto", transaction_type: "buy", transaction_date: "01/01/2026",
    })]);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "asset_category")).toBe(true);
  });

  it("a deposit needs no asset fields at all — only account, type, date, and quantity (amount)", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "Cash", asset_category: "cash", transaction_type: "deposit", transaction_date: "01/01/2026", quantity: 500,
    })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].errors).toEqual([]);
  });

  it("requires quantity for buy/sell/adjustment/deposit/withdrawal but not fee", () => {
    const fee = buildImportRows([HEADER, row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", ticker: "NVDA", transaction_type: "fee", transaction_date: "01/01/2026", fees_gbp: 5,
    })]);
    if (fee.ok) expect(fee.rows[0].errors).toEqual([]);

    const buyMissingQty = buildImportRows([HEADER, row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", ticker: "NVDA", transaction_type: "buy", transaction_date: "01/01/2026",
    })]);
    if (buyMissingQty.ok) expect(buyMissingQty.rows[0].errors.some(e => e.field === "quantity")).toBe(true);
  });

  it("rejects a non-real transaction date", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", ticker: "NVDA", transaction_type: "buy", transaction_date: "31/02/2026", quantity: 1,
    })]);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "transaction_date")).toBe(true);
  });

  it("rejects a negative price/fee value", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", ticker: "NVDA", transaction_type: "buy", transaction_date: "01/01/2026",
      quantity: 1, native_unit_price: -5,
    })]);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "native_unit_price")).toBe(true);
  });

  it("blank rows are skipped entirely, never counted or reported", () => {
    const result = buildImportRows([HEADER, row({}), row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", ticker: "NVDA", transaction_type: "buy", transaction_date: "01/01/2026", quantity: 1, native_unit_price: 100,
    })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(1);
  });

  it("defaults currency to GBP when the cell is blank", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "LEGO Collection", asset_category: "lego", asset_name: "Millennium Falcon", lego_set_number: "75192",
      transaction_type: "buy", transaction_date: "01/01/2026", quantity: 1, native_unit_price: 700,
    })]);
    if (result.ok) expect(result.rows[0].candidate?.currency).toBe("GBP");
  });

  it("import_reference is optional and carried through unchanged when present", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", ticker: "NVDA", transaction_type: "buy", transaction_date: "01/01/2026",
      quantity: 1, native_unit_price: 100, import_reference: "BROKER-STMT-2026-001",
    })]);
    if (result.ok) expect(result.rows[0].candidate?.importReference).toBe("BROKER-STMT-2026-001");
  });

  it("a formula cell is rejected explicitly, never silently accepted as a value", () => {
    const result = buildImportRows([HEADER, row({
      account_name: "ISA", asset_category: "stock", asset_name: "NVIDIA", ticker: FORMULA_CELL as unknown as string,
      transaction_type: "buy", transaction_date: "01/01/2026", quantity: 1, native_unit_price: 100,
    })]);
    if (result.ok) expect(result.rows[0].errors.some(e => e.field === "ticker")).toBe(true);
  });
});
