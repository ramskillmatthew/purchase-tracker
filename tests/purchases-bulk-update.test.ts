import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bulkPurchaseUpdateSchema } from "@/lib/validation/purchases-bulk-update";

const page = readFileSync("app/purchases/page.tsx", "utf8");
const route = readFileSync("app/api/purchases/bulk-update/route.ts", "utf8");
const css = readFileSync("app/globals.css", "utf8");
const id1 = "11111111-1111-4111-8111-111111111111";
const id2 = "22222222-2222-4222-8222-222222222222";

describe("bulkPurchaseUpdateSchema", () => {
  it("accepts stock-only, arrival-only, and combined changes", () => {
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [id1], stockStatus: "in_stock" }).success).toBe(true);
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [id1], arrived: false }).success).toBe(true);
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [id1], stockStatus: "no_longer_in_stock", arrived: true }).success).toBe(true);
  });
  it("requires ids and at least one actual change", () => {
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [], arrived: true }).success).toBe(false);
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [id1] }).success).toBe(false);
  });
  it("rejects malformed ids, fields, and status values", () => {
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: ["bad"], arrived: true }).success).toBe(false);
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [id1], stockStatus: "sold" }).success).toBe(false);
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [id1], arrived: "yes" }).success).toBe(false);
    expect(bulkPurchaseUpdateSchema.safeParse({ ids: [id1], arrived: true, surprise: true }).success).toBe(false);
  });
  it("deduplicates repeated ids before the database update", () => {
    expect(bulkPurchaseUpdateSchema.parse({ ids: [id1, id1, id2], arrived: true }).ids).toEqual([id1, id2]);
  });
});

describe("authenticated atomic bulk update route", () => {
  it("requires owner authentication and validates before database access", () => {
    expect(route.indexOf("await requireOwner();")).toBeLessThan(route.indexOf("bulkPurchaseUpdateSchema.parse"));
  });
  it("preflights every selected id and fails safely when any is missing", () => {
    expect(route).toContain("const missingIds = input.ids.filter");
    expect(route).toContain("status: 404");
  });
  it("uses one multi-row PATCH for the complete selection, never one request per id", () => {
    expect(route).toContain('method: "PATCH"');
    expect(route).toContain("purchases?id=in.(${idFilter})");
    expect(route).not.toMatch(/for\s*\(/);
  });
  it("only sends fields explicitly selected by the user", () => {
    expect(route).toContain("if (input.stockStatus !== undefined) changes.stock_status = input.stockStatus;");
    expect(route).toContain("if (input.arrived !== undefined) changes.arrived = input.arrived;");
  });
  it("uses the shared safe API error boundary", () => {
    expect(route).toContain('safeApiError(error, "Could not update the selected purchases.")');
  });
});

describe("Purchases contextual bulk toolbar", () => {
  it("only renders while a selection exists and announces the count", () => {
    expect(page).toContain('{selectedIds.size > 0 && <div className="purchase-bulk-update-bar"');
    expect(page).toContain('role="status" aria-live="polite"');
  });
  it("offers both exact stock and arrival choices", () => {
    for (const label of ["Stock status", "In stock", "No longer in stock", "Arrival status", "Arrived", "Not arrived"]) expect(page).toContain(label);
  });
  it("keeps Apply disabled until a real change is chosen", () => {
    expect(page).toContain('disabled={bulkUpdating || (!bulkStockStatus && !bulkArrivalStatus)}');
  });
  it("sends one request, omits unchanged fields, and clears only after success", () => {
    const fn = page.slice(page.indexOf("async function applyBulkUpdate"), page.indexOf("// Priority order"));
    expect(fn).toContain('fetch("/api/purchases/bulk-update"');
    expect(fn).toContain("if (bulkStockStatus) payload.stockStatus = bulkStockStatus;");
    expect(fn).toContain('if (bulkArrivalStatus) payload.arrived = bulkArrivalStatus === "arrived";');
    expect(fn.indexOf("clearSelection();")).toBeGreaterThan(fn.indexOf("if (!response.ok)"));
  });
  it("has tablet and mobile layouts without a fixed overlay", () => {
    expect(css).toContain("@media (max-width: 1100px)");
    expect(css).toContain("@media (max-width: 700px)");
    expect(css).not.toMatch(/\.purchase-bulk-update-bar\s*\{[^}]*position:\s*fixed/);
  });
});
