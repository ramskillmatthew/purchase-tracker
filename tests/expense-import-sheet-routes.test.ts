import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

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

import { GET as templateRoute } from "@/app/api/expenses/import/template/route";
import { POST as previewRoute } from "@/app/api/expenses/import/preview/route";
import { POST as commitRoute } from "@/app/api/expenses/import/commit/route";
import { AuthError } from "@/lib/auth/server";
import { importColumns } from "@/lib/expense-import-sheet/schema";

const canonicalHeader = importColumns.map(c => c.heading);

function csvFile(csv: string, name = "expenses.csv") {
  return new File([csv], name, { type: "text/csv" });
}
function fileRequest(file: File, url: string) {
  const formData = new FormData();
  formData.append("file", file);
  return new Request(url, { method: "POST", body: formData });
}

function validCsv(rows: string[][] = []) {
  return [canonicalHeader, ...rows].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
}

function oneValidRow(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "Order Date": "2026-07-24", "Purchased From": "Amazon", "Arrived": "Yes",
    "Item Description": "Packing tape", "Cost": "4.99",
    ...overrides,
  };
  return canonicalHeader.map(heading => values[heading]);
}

beforeEach(() => { requireOwner.mockClear(); supabaseRequest.mockClear(); });

describe("GET /api/expenses/import/template", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await templateRoute();
    expect(response.status).toBe(401);
  });

  it("returns a real, downloadable xlsx workbook with the suggested filename", async () => {
    const response = await templateRoute();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("expense-import-template.xlsx");
    expect(response.headers.get("Content-Type")).toContain("spreadsheetml");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    expect(workbook.getWorksheet("Expenses")).toBeTruthy();
  });
});

describe("POST /api/expenses/import/preview", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await previewRoute(fileRequest(csvFile(validCsv([oneValidRow()])), "http://test/api/expenses/import/preview"));
    expect(response.status).toBe(401);
  });

  it("rejects a file with a missing required column", async () => {
    const csv = "Order Date,Purchased From";
    const response = await previewRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/preview"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Missing required column");
  });

  it("returns counts, ignored columns, and per-row errors without saving anything", async () => {
    const csv = validCsv([oneValidRow(), oneValidRow({ "Item Description": "" })]);
    const response = await previewRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/preview"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalDataRows).toBe(2);
    expect(body.validCount).toBe(1);
    expect(body.invalidCount).toBe(1);
    expect(body.rows[1].errors[0]).toEqual({ field: "item_description", reason: "Item Description is required." });
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REQUIREMENT 26-29: correctly parses quoted commas, escaped quotes, multiline cells, and a UTF-8 BOM", async () => {
    const bom = "﻿";
    const csv = `${bom}${canonicalHeader.join(",")}\n2026-07-24,"Amazon, UK","Yes","He said ""hi""\nsecond line",4.99\n`;
    const response = await previewRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/preview"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalDataRows).toBe(1);
    expect(body.validCount).toBe(1);
    expect(body.rows[0].values.purchased_from).toBe("Amazon, UK");
    expect(body.rows[0].values.item_description).toContain('He said "hi"');
  });

  it("REQUIREMENT 22/23/24: rejects formula cells (cached numeric, cached text, cached error) across the mapped fields", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Expenses");
    sheet.addRow(canonicalHeader);
    sheet.addRow(["2026-07-24", "Amazon", "Yes", "Packing tape", { formula: "1+1", result: 2 } as ExcelJS.CellFormulaValue]);
    sheet.addRow(["2026-07-24", { formula: 'CONCATENATE("A","B")', result: "AB" } as unknown, "Yes", "Packing tape", 4.99]);
    sheet.addRow(["2026-07-24", "Amazon", "Yes", "Packing tape", { formula: "1/0", result: { error: "#DIV/0!" } } as unknown as ExcelJS.CellFormulaValue]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const response = await previewRoute(fileRequest(new File([buffer], "expenses.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "http://test/api/expenses/import/preview"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.validCount).toBe(0);
    expect(body.invalidCount).toBe(3);
    expect(body.rows[0].errors).toContainEqual({ field: "cost", reason: "Cost must contain a value, not a formula." });
    expect(body.rows[1].errors).toContainEqual({ field: "purchased_from", reason: "Purchased From must contain a value, not a formula." });
    expect(body.rows[2].errors).toContainEqual({ field: "cost", reason: "Cost must contain a value, not a formula." });
  });

  it("REQUIREMENT 25: a literal '=' string cell (not an actual formula cell) is treated as ordinary untrusted text", async () => {
    const csv = validCsv([oneValidRow({ "Purchased From": "=1+1" })]);
    const response = await previewRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/preview"));
    const body = await response.json();
    expect(body.validCount).toBe(1);
    expect(body.rows[0].values.purchased_from).toBe("=1+1");
  });

  it("rejects an oversized file before attempting to parse it", async () => {
    const oversized = "a".repeat(6 * 1024 * 1024);
    const response = await previewRoute(fileRequest(csvFile(oversized, "big.csv"), "http://test/api/expenses/import/preview"));
    expect(response.status).toBe(413);
  });

  it("rejects an unsupported file extension", async () => {
    const response = await previewRoute(fileRequest(new File(["not a spreadsheet"], "legacy.xls", { type: "application/vnd.ms-excel" }), "http://test/api/expenses/import/preview"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Unsupported file type");
  });
});

describe("POST /api/expenses/import/commit", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await commitRoute(fileRequest(csvFile(validCsv([oneValidRow()])), "http://test/api/expenses/import/commit"));
    expect(response.status).toBe(401);
  });

  it("REQUIREMENT 32: rejects the whole batch when any row is invalid, saving nothing", async () => {
    const csv = validCsv([oneValidRow(), oneValidRow({ Cost: "not-a-number" })]);
    const response = await commitRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/commit"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Some expenses need attention.");
    expect(body.failures[0]).toEqual({ row: 3, field: "cost", reason: expect.stringContaining("Cost") });
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REQUIREMENT 30: rejects more than 500 rows without saving anything", async () => {
    const rows = Array.from({ length: 501 }, () => oneValidRow());
    const response = await commitRoute(fileRequest(csvFile(validCsv(rows)), "http://test/api/expenses/import/commit"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("500");
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REQUIREMENT 33: saves every valid row via a single batched insert, never trusting the client's earlier preview", async () => {
    const csv = validCsv([oneValidRow(), oneValidRow({ "Item Description": "Second item" })]);
    const response = await commitRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/commit"));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ ok: true, created: 2 });
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
    const [path, init] = supabaseRequest.mock.calls[0];
    expect(path).toBe("expenses");
    const inserted = JSON.parse((init as RequestInit).body as string);
    expect(inserted).toHaveLength(2);
    for (const row of inserted) {
      expect(row).toEqual({ purchase_date: "2026-07-24", purchased_from: "Amazon", arrived: true, item_description: expect.any(String), cost: 4.99 });
    }
  });

  it("rejects a file with no data rows", async () => {
    const response = await commitRoute(fileRequest(csvFile(canonicalHeader.join(",")), "http://test/api/expenses/import/commit"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("no data rows");
  });

  it("never claims success when the database insert fails, and never leaks the raw database error", async () => {
    supabaseRequest.mockRejectedValueOnce(Object.assign(new Error("relation \"expenses\" secret detail"), { status: 500 }));
    const response = await commitRoute(fileRequest(csvFile(validCsv([oneValidRow()])), "http://test/api/expenses/import/commit"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toContain("secret detail");
    expect(body.ok).toBeUndefined();
  });
});

describe("preview and commit produce consistent validation results", () => {
  it("REQUIREMENT 34: the same file yields the same valid/invalid outcome from both routes", async () => {
    const csv = validCsv([oneValidRow(), oneValidRow({ Cost: "-5" })]);
    const previewResponse = await previewRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/preview"));
    const previewBody = await previewResponse.json();
    const commitResponse = await commitRoute(fileRequest(csvFile(csv), "http://test/api/expenses/import/commit"));
    const commitBody = await commitResponse.json();
    expect(previewBody.invalidCount).toBe(1);
    expect(commitResponse.status).toBe(400);
    expect(commitBody.failures[0].field).toBe(previewBody.rows[1].errors[0].field);
    expect(commitBody.failures[0].reason).toBe(previewBody.rows[1].errors[0].reason);
  });
});

describe("untrusted content never reaches logs or responses unsafely", () => {
  it("never logs the file name or row content on the happy path", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    await previewRoute(fileRequest(csvFile(validCsv([oneValidRow({ "Item Description": "<script>alert(1)</script>" })])), "http://test/api/expenses/import/preview"));
    expect(logSpy).not.toHaveBeenCalled();
    expect(logSpy2).not.toHaveBeenCalled();
    logSpy.mockRestore(); logSpy2.mockRestore();
  });

  it("neither import dialog component uses dangerouslySetInnerHTML on cell content or the filename", async () => {
    const fs = await import("node:fs");
    for (const file of ["components/SpreadsheetImportDialog.tsx", "components/ExpenseImportDialog.tsx", "components/PurchaseImportDialog.tsx"]) {
      expect(fs.readFileSync(file, "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
  });
});
