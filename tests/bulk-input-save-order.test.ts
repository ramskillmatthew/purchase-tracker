import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * REWRITTEN — the previous implementation this file tested (a "deterministic
 * created_at offset per preview row" hack — see git history) has been
 * replaced with a genuine SKU-aware authoritative sort (lib/purchase-order.ts),
 * per the explicit requirement that Bulk Input's paste/save order must never
 * itself determine the saved display order. This file now proves the OLD
 * mechanism is gone, not merely that a different one replaced it — see
 * tests/purchase-order.test.ts for the actual new ordering rule's own
 * thorough tests, and tests/purchases-search.test.ts /
 * tests/purchases-stock-status.test.ts for GET /api/purchases's continued
 * "most-recent-first, complete table" fetch-order contract.
 */
const routeSource = readFileSync("app/api/purchases/bulk/route.ts", "utf8");
const purchasesRouteSource = readFileSync("app/api/purchases/route.ts", "utf8");
const bulkInputPageSource = readFileSync("app/bulk-input/page.tsx", "utf8");

describe("bulk purchase save order", () => {
  it("REGRESSION: no longer assigns a fabricated descending created_at sequence to imitate preview order", () => {
    expect(routeSource).not.toContain("batchCreatedAt");
    expect(routeSource).not.toContain("new Date(batchCreatedAt");
    expect(routeSource).not.toMatch(/created_at:\s*new Date/);
  });

  it("REQUIREMENT: every bulk-inserted row gets the database's own default created_at — never a client- or route-computed timestamp", () => {
    const insertedRowBlock = routeSource.slice(routeSource.indexOf("return [{"), routeSource.indexOf("}];", routeSource.indexOf("return [{")));
    expect(insertedRowBlock).not.toContain("created_at");
  });

  it("REQUIREMENT: display order comes from the authoritative sort (see lib/purchase-order.ts via GET /api/purchases), not from insert order or timestamp manipulation", () => {
    expect(purchasesRouteSource).toContain('import { sortPurchasesForDisplay } from "@/lib/purchase-order";');
    expect(purchasesRouteSource).toContain("sortPurchasesForDisplay(rows)");
  });

  it("the raw database fetch still uses a deterministic order (order_date, created_at, then id) purely so supabaseRequestAll's own pagination is internally consistent — this is not the display order", () => {
    expect(purchasesRouteSource).toContain("order=order_date.desc,created_at.desc,id.desc");
  });
});

describe("Bulk Input Live Preview stays in pasted order", () => {
  it("REQUIREMENT: preview rows are keyed and rendered by their raw index — never sorted by date or SKU before saving", () => {
    // The only .sort() in this whole page fixes the COLUMN header display
    // order (which field appears in which table column) — a constant,
    // unrelated to row order. The rows themselves are never sorted: they're
    // rendered directly off the `rows` array in its natural (pasted) order.
    expect(bulkInputPageSource).toContain("rows.map((row, index) => <tr key={index}>");
    expect(bulkInputPageSource).not.toMatch(/\brows\s*\.sort\(/);
    expect(bulkInputPageSource).not.toMatch(/\[\.\.\.rows\]\.sort\(/);
  });

  it("REQUIREMENT: each preview row is assembled by column-index position, so field alignment survives blank/invalid intermediate rows — a row is never reconstructed from mismatched positions across columns", () => {
    expect(bulkInputPageSource).toContain("const columnValue = lines(columns[field.key])[index] ?? \"\";");
  });

  it("row count is driven purely by the longest column's line count, independent of any row's validity", () => {
    expect(bulkInputPageSource).toContain("const count = Math.max(0, ...fields.map(field => lineCount(columns[field.key])));");
  });
});
