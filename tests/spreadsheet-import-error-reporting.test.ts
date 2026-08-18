import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 201 })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import { POST as purchasePreviewRoute } from "@/app/api/purchases/import/preview/route";
import { importColumns as purchaseColumns } from "@/lib/purchase-import-sheet/schema";
import { POST as expensePreviewRoute } from "@/app/api/expenses/import/preview/route";
import { importColumns as expenseColumns } from "@/lib/expense-import-sheet/schema";

beforeEach(() => { requireOwner.mockClear(); supabaseRequest.mockClear(); });

function csvRequest(csv: string, url: string, name = "import.csv") {
  const formData = new FormData();
  formData.append("file", new File([csv], name, { type: "text/csv" }));
  return new Request(url, { method: "POST", body: formData });
}

const purchaseHeader = purchaseColumns.map(c => c.heading);
function purchaseRow(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "Order Date": "2026-07-24", "Purchased From": "Vinted", "SKU": "1801", "Arrived": "Yes",
    "Item Description": "Nike Air Max 95", "Size": "9", "Item Condition": "Brand new", "Category": "Other", "Price Purchased": "13.49",
    ...overrides,
  };
  return purchaseHeader.map(heading => values[heading]);
}
function purchaseCsv(rows: string[][]) {
  return [purchaseHeader, ...rows].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
}

/**
 * Reproduces the reported case exactly: 498 data rows, 493 valid, 5
 * invalid — with three of the five invalid rows (214, 377, 491) beyond
 * the 200-row preview cap, which is precisely the scenario that used to
 * render an empty error panel despite a correct "5 need attention" count.
 */
function build498RowReproCsv() {
  // `i` is the 1-based data-row position (row 1 of data = spreadsheet row 2,
  // since row 1 is the header) — so to land an invalid row at spreadsheet
  // row N, the data row here must be N-1.
  const rows: string[][] = [];
  for (let i = 1; i <= 498; i++) {
    if (i === 6) rows.push(purchaseRow({ "Item Description": "", "Price Purchased": "" })); // spreadsheet row 7
    else if (i === 44) rows.push(purchaseRow({ "Order Date": "31/02/2026" })); // row 45
    else if (i === 213) rows.push(purchaseRow({ "Price Purchased": "12.999" })); // row 214
    else if (i === 376) rows.push(purchaseRow({ "Price Purchased": "-5" })); // row 377
    else if (i === 490) rows.push(purchaseRow({ "Size": "" })); // row 491
    else rows.push(purchaseRow({ SKU: `SKU-${i}` }));
  }
  return purchaseCsv(rows);
}

describe("REPRODUCTION: 498 rows / 5 invalid / some beyond row 200", () => {
  it("REQUIREMENT: reports 493 valid and 5 need attention, matching the screenshot", async () => {
    const response = await purchasePreviewRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/preview"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalDataRows).toBe(498);
    expect(body.validCount).toBe(493);
    expect(body.invalidCount).toBe(5);
  });

  it("6/7. every invalid row's failures are present, including rows 214, 377, and 491 which fall beyond the first 200 previewed rows", async () => {
    const response = await purchasePreviewRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    const rowsWithFailures = new Set(body.failures.map((f: { row: number }) => f.row));
    expect(rowsWithFailures).toEqual(new Set([7, 45, 214, 377, 491]));
    // and specifically confirmed present past the 200-row preview cutoff
    expect(rowsWithFailures.has(214)).toBe(true);
    expect(rowsWithFailures.has(377)).toBe(true);
    expect(rowsWithFailures.has(491)).toBe(true);
  });

  it("7. invalidRows (used by the Needs Attention tab) includes row 491 in full, uncapped by the 200-row preview limit", async () => {
    const response = await purchasePreviewRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.invalidRows).toHaveLength(5);
    const row491 = body.invalidRows.find((row: { row: number }) => row.row === 491);
    expect(row491).toBeTruthy();
    expect(row491.errors[0]).toEqual({ field: "item_size", reason: "Size is required." });
  });

  it("8. rows (the All-rows tab) stays capped at the first 200 rows even for this large file", async () => {
    const response = await purchasePreviewRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.rows).toHaveLength(200);
    expect(body.truncated).toBe(true);
    expect(body.previewRowLimit).toBe(200);
  });

  it("1/2/3. each failure carries the real spreadsheet row number, field, reason, and (where useful) the original value", async () => {
    const response = await purchasePreviewRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    const row45 = body.failures.find((f: { row: number }) => f.row === 45);
    expect(row45).toEqual({ row: 45, field: "order_date", reason: expect.stringContaining("real date"), value: "31/02/2026" });
  });

  it("4. row 7's two field errors are both present and share the same row number (grouped client-side)", async () => {
    const response = await purchasePreviewRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    const row7Failures = body.failures.filter((f: { row: number }) => f.row === 7);
    expect(row7Failures).toHaveLength(2);
    expect(row7Failures.map((f: { field: string }) => f.field).sort()).toEqual(["item_description", "price_purchased"]);
  });

  it("9/10. the invalid-row count reflects distinct rows, not the number of field errors — row 7 alone contributes 2 errors, giving 6 total field errors across 5 invalid rows", async () => {
    const response = await purchasePreviewRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.invalidCount).toBe(5);
    expect(body.failures.length).toBe(6);
  });

  it("20. the commit route independently rejects this file too — the reported case was never importable, only invisible", async () => {
    const { POST: commitRoute } = await import("@/app/api/purchases/import/commit/route");
    const response = await commitRoute(csvRequest(build498RowReproCsv(), "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("21. correcting the five rows and re-uploading produces a fully valid file with zero failures", async () => {
    const rows: string[][] = [];
    for (let i = 1; i <= 498; i++) rows.push(purchaseRow({ SKU: `SKU-${i}` }));
    const response = await purchasePreviewRoute(csvRequest(purchaseCsv(rows), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.invalidCount).toBe(0);
    expect(body.failures).toEqual([]);
    expect(body.invalidRows).toEqual([]);
  });
});

describe("SpreadsheetImportFailure shared contract", () => {
  it("13. purchase-import preview failures conform to {row, field, reason, value?}", async () => {
    const response = await purchasePreviewRoute(csvRequest(purchaseCsv([purchaseRow({ "Item Description": "" })]), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.failures[0]).toEqual({ row: 2, field: "item_description", reason: "Item Description is required.", value: undefined });
  });

  it("14. expense-import preview failures use the identical {row, field, reason, value?} shape", async () => {
    const expenseHeader = expenseColumns.map(c => c.heading);
    const csv = [expenseHeader, ["2026-07-24", "Amazon", "Yes", "", "4.99"]].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
    const response = await expensePreviewRoute(csvRequest(csv, "http://test/api/expenses/import/preview"));
    const body = await response.json();
    expect(body.failures[0]).toEqual({ row: 2, field: "item_description", reason: "Item Description is required.", value: undefined });
    expect(body.invalidRows).toHaveLength(1);
  });

  it("18. a missing required value displays with a clear reason", async () => {
    const response = await purchasePreviewRoute(csvRequest(purchaseCsv([purchaseRow({ "Purchased From": "" })]), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.failures[0]).toEqual({ row: 2, field: "purchased_from", reason: "Purchased From is required.", value: undefined });
  });

  it("16. an invalid date displays with row, field, and the original text", async () => {
    const response = await purchasePreviewRoute(csvRequest(purchaseCsv([purchaseRow({ "Order Date": "31/02/2026" })]), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.failures[0]).toMatchObject({ row: 2, field: "order_date", value: "31/02/2026" });
  });

  it("17. an invalid price displays with row, field, and the original text", async () => {
    const response = await purchasePreviewRoute(csvRequest(purchaseCsv([purchaseRow({ "Price Purchased": "£12.999" })]), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.failures[0]).toMatchObject({ row: 2, field: "price_purchased", value: "£12.999" });
  });

  it("19. a historical free-text Item Condition remains valid and produces zero failures", async () => {
    const response = await purchasePreviewRoute(csvRequest(purchaseCsv([purchaseRow({ "Item Condition": "Holes in heel" })]), "http://test/api/purchases/import/preview"));
    const body = await response.json();
    expect(body.invalidCount).toBe(0);
    expect(body.rows[0].values.item_condition).toBe("Holes in heel");
  });
});

describe("SpreadsheetImportDialog.tsx renders the fixed contract (structural — no React test harness in this project)", () => {
  const source = readFileSync("components/SpreadsheetImportDialog.tsx", "utf8");

  it("REQUIREMENT: renders preview.failures (not the old, empty-when-truncated approach), grouped by row", () => {
    expect(source).toContain("preview.failures");
    expect(source).toContain("failuresByRow");
    expect(source).toContain("map.set(failure.row");
  });

  it("REQUIREMENT: the Needs Attention tab reads from invalidRows, never sliced to the 200-row preview cap", () => {
    expect(source).toContain("preview.invalidRows");
    expect(source).not.toMatch(/invalidRows\.slice/);
  });

  it("REQUIREMENT: a defensive fallback exists and is logged as a safe development error, never a raw stack trace", () => {
    expect(source).toContain("could not be displayed");
    expect(source).toContain("console.error(");
    expect(source).not.toMatch(/console\.error\([^)]*\.stack/);
  });

  it("11. the error panel can never render structurally empty when invalidCount > 0 — it always renders either the grouped list or the fallback message", () => {
    expect(source).toMatch(/failuresByRow\.length > 0\s*\?/);
  });

  it("REQUIREMENT: the updated heading and hint text are present", () => {
    expect(source).toContain("row{preview.invalidCount === 1 ? \"\" : \"s\"} need attention");
    expect(source).toContain("Correct these rows in the spreadsheet, then upload the file again.");
  });

  it("REQUIREMENT: the All rows / Needs attention toggle exists and defaults to Needs attention when errors are found", () => {
    expect(source).toContain("Needs attention");
    expect(source).toContain('setViewTab(body.invalidCount > 0 ? "needs-attention" : "all")');
  });

  it("REQUIREMENT: the All-rows truncation note states every row was validated, never implying rows beyond 200 were skipped", () => {
    expect(source).toContain("All {preview.totalDataRows} rows were validated.");
  });

  it("20. the Import button's disabled state is explained to the user", () => {
    expect(source).toContain("Resolve all {preview.invalidCount} invalid row");
  });

  it("does not use dangerouslySetInnerHTML anywhere in the rendered error content", () => {
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});
