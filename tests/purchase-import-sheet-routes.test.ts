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

import { GET as templateRoute } from "@/app/api/purchases/import/template/route";
import { POST as previewRoute } from "@/app/api/purchases/import/preview/route";
import { POST as commitRoute } from "@/app/api/purchases/import/commit/route";
import { AuthError } from "@/lib/auth/server";
import { importColumns } from "@/lib/purchase-import-sheet/schema";

const canonicalHeader = importColumns.map(c => c.heading);

function csvRequest(csv: string, url: string) {
  const formData = new FormData();
  formData.append("file", new File([csv], "purchases.csv", { type: "text/csv" }));
  return new Request(url, { method: "POST", body: formData });
}

function validCsv(rows: string[][] = []) {
  const body = [canonicalHeader, ...rows].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
  return body;
}

function oneValidRow(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "Order Date": "2026-07-24", "Purchased From": "Vinted", "SKU": "1801", "Arrived": "Yes",
    "Item Description": "Nike Air Max 95", "Size": "9", "Item Condition": "Brand new", "Category": "Other", "Price Purchased": "13.49",
    ...overrides,
  };
  return canonicalHeader.map(heading => values[heading]);
}

beforeEach(() => { requireOwner.mockClear(); supabaseRequest.mockClear(); });

describe("GET /api/purchases/import/template", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await templateRoute();
    expect(response.status).toBe(401);
  });

  it("returns a real, downloadable xlsx workbook with the suggested filename", async () => {
    const response = await templateRoute();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("purchase-import-template.xlsx");
    expect(response.headers.get("Content-Type")).toContain("spreadsheetml");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    expect(workbook.getWorksheet("Purchases")).toBeTruthy();
  });
});

describe("POST /api/purchases/import/preview", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await previewRoute(csvRequest(validCsv([oneValidRow()]), "http://test/api/purchases/import/preview"));
    expect(response.status).toBe(401);
  });

  it("rejects a file with a missing required column", async () => {
    const csv = ["Order Date,Purchased From,SKU"].join("\n");
    const response = await previewRoute(csvRequest(csv, "http://test/api/purchases/import/preview"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Missing required column");
  });

  it("returns counts, ignored columns, and per-row errors without saving anything", async () => {
    const csv = validCsv([oneValidRow(), oneValidRow({ "Item Description": "" })]);
    const response = await previewRoute(csvRequest(csv, "http://test/api/purchases/import/preview"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalDataRows).toBe(2);
    expect(body.validCount).toBe(1);
    expect(body.invalidCount).toBe(1);
    expect(body.rows[1].errors[0]).toEqual({ field: "item_description", reason: "Item Description is required." });
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before attempting to parse it", async () => {
    const formData = new FormData();
    const oversized = "a".repeat(6 * 1024 * 1024);
    formData.append("file", new File([oversized], "big.csv", { type: "text/csv" }));
    const response = await previewRoute(new Request("http://test/api/purchases/import/preview", { method: "POST", body: formData }));
    expect(response.status).toBe(413);
  });

  it("rejects an unsupported file extension", async () => {
    const formData = new FormData();
    formData.append("file", new File(["not a spreadsheet"], "legacy.xls", { type: "application/vnd.ms-excel" }));
    const response = await previewRoute(new Request("http://test/api/purchases/import/preview", { method: "POST", body: formData }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Unsupported file type");
  });
});

describe("POST /api/purchases/import/commit", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await commitRoute(csvRequest(validCsv([oneValidRow()]), "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(401);
  });

  it("REQUIREMENT 22: rejects the whole batch when any row is invalid, saving nothing", async () => {
    const csv = validCsv([oneValidRow(), oneValidRow({ "Price Purchased": "not-a-number" })]);
    const response = await commitRoute(csvRequest(csv, "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Some purchases need attention.");
    expect(body.failures[0]).toEqual({ row: 3, field: "price_purchased", reason: expect.stringContaining("Price Purchased") });
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REQUIREMENT 21: rejects more than 500 rows without saving anything", async () => {
    const rows = Array.from({ length: 501 }, () => oneValidRow());
    const csv = validCsv(rows);
    const response = await commitRoute(csvRequest(csv, "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("500");
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("REQUIREMENT 23: saves valid rows with quantity 1 and seller_name null via a single batched insert, never trusting the client's earlier preview", async () => {
    const csv = validCsv([oneValidRow(), oneValidRow({ SKU: "1802" })]);
    const response = await commitRoute(csvRequest(csv, "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ ok: true, created: 2 });
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
    const [path, init] = supabaseRequest.mock.calls[0];
    expect(path).toBe("purchases");
    const inserted = JSON.parse((init as RequestInit).body as string);
    expect(inserted).toHaveLength(2);
    for (const row of inserted) { expect(row.quantity).toBe(1); expect(row.seller_name).toBeNull(); }
  });

  it("REQUIREMENT 14: independently re-validates and imports a historical free-text Item Condition, never trusting the client's preview", async () => {
    const csv = validCsv([oneValidRow({ "Item Condition": "Holes in heel" })]);
    const response = await commitRoute(csvRequest(csv, "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(201);
    const [, init] = supabaseRequest.mock.calls[0];
    const inserted = JSON.parse((init as RequestInit).body as string);
    expect(inserted[0].item_condition).toBe("Holes in heel");
  });

  it("REQUIREMENT 9: rejects a genuine Excel formula in Item Condition, never its cached result", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Purchases");
    sheet.addRow(canonicalHeader);
    sheet.addRow([...oneValidRow().slice(0, 6), { formula: "A1", result: "Brand new" } as ExcelJS.CellFormulaValue, ...oneValidRow().slice(7)]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const response = await commitRoute(new Request("http://test/api/purchases/import/commit", { method: "POST", body: (() => { const fd = new FormData(); fd.append("file", new File([buffer], "purchases.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })); return fd; })() }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.failures[0]).toEqual({ row: 2, field: "item_condition", reason: "Item Condition must contain a value, not a formula." });
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("rejects a file with no data rows", async () => {
    const csv = canonicalHeader.join(",");
    const response = await commitRoute(csvRequest(csv, "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("no data rows");
  });

  it("never claims success when the database insert fails, and never leaks the raw database error", async () => {
    supabaseRequest.mockRejectedValueOnce(Object.assign(new Error("relation \"purchases\" secret detail"), { status: 500 }));
    const response = await commitRoute(csvRequest(validCsv([oneValidRow()]), "http://test/api/purchases/import/commit"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toContain("secret detail");
    expect(body.ok).toBeUndefined();
  });
});

describe("REQUIREMENT 24: untrusted content never reaches logs or responses unsafely", () => {
  it("never logs the file name or row content on the happy path", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    await previewRoute(csvRequest(validCsv([oneValidRow({ "Item Description": "<script>alert(1)</script>" })]), "http://test/api/purchases/import/preview"));
    expect(logSpy).not.toHaveBeenCalled();
    expect(logSpy2).not.toHaveBeenCalled();
    logSpy.mockRestore(); logSpy2.mockRestore();
  });

  it("the import dialog component never uses dangerouslySetInnerHTML on cell content or the filename", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("components/PurchaseImportDialog.tsx", "utf8");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});
