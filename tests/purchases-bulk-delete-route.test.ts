import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Next.js server routes touching Supabase directly — no live database in
// this test suite, so checked structurally, consistent with
// tests/security-boundaries.test.ts and tests/sales-api-routes.test.ts's
// own convention for this project's route.ts files.
//
// Rewritten for safe purchase deletion (supabase-safe-purchase-deletion.sql):
// single delete, bulk delete, and Clear All now all share ONE atomic RPC
// (safe_delete_purchases) via lib/purchases-delete.ts, rather than each
// route running its own raw DELETE statement — see tests/purchase-safe-
// deletion-lib.test.ts for that shared helper's own tests.
const bulkDeleteRoute = readFileSync("app/api/purchases/bulk-delete/route.ts", "utf8");
const purchasesRoute = readFileSync("app/api/purchases/route.ts", "utf8");

describe("app/api/purchases/bulk-delete/route.ts — dedicated multi-select bulk delete", () => {
  it("requires owner authentication, same as the other purchase routes", () => {
    expect(bulkDeleteRoute).toContain("await requireOwner();");
  });

  it("validates the request body with the shared deletePurchasesInputSchema (min 1, max cap, no duplicates)", () => {
    expect(bulkDeleteRoute).toContain("deletePurchasesInputSchema.parse(await request.json())");
  });

  it("REQUIREMENT: calls the shared safe_delete_purchases RPC via safeDeletePurchases exactly once — never a raw multi-row DELETE, never a per-id loop", () => {
    expect(bulkDeleteRoute).toContain("safeDeletePurchases(ids)");
    expect(bulkDeleteRoute).not.toContain("id=in.(");
    expect(bulkDeleteRoute).not.toMatch(/for\s*\(/);
  });

  it("REQUIREMENT: never reuses or triggers the existing Clear All path — no ?clear=all and no unconditional 'id=not.is.null' delete", () => {
    expect(bulkDeleteRoute).not.toContain("clear=all");
    expect(bulkDeleteRoute).not.toContain("id=not.is.null");
  });

  it("REQUIREMENT: converts a fully-protected result into HTTP 409 with a structured, safe reason — never a bare 500", () => {
    expect(bulkDeleteRoute).toContain("isFullyProtectedResult(result)");
    expect(bulkDeleteRoute).toContain('reason: "purchase_linked_to_completed_sale"');
    expect(bulkDeleteRoute).toContain("status: 409");
  });

  it("returns the structured protectedCount/protectedIds on a 409, not raw database text", () => {
    const conflictBlock = bulkDeleteRoute.slice(bulkDeleteRoute.indexOf("isFullyProtectedResult(result)"), bulkDeleteRoute.indexOf("}", bulkDeleteRoute.indexOf("isFullyProtectedResult(result)")) + 1);
    expect(conflictBlock).toContain("protectedCount: result.protectedCount");
    expect(conflictBlock).toContain("protectedIds: result.protectedIds");
  });

  it("a mixed or fully-successful result (deletedCount > 0) returns the full structured result, not just a bare ok flag", () => {
    expect(bulkDeleteRoute).toContain("return NextResponse.json(result);");
  });

  it("routes unexpected failures through the shared safeApiError helper, never leaking raw errors", () => {
    expect(bulkDeleteRoute).toContain('return safeApiError(error, "Could not delete the selected purchases.");');
  });
});

describe("app/api/purchases/route.ts — single delete and Clear All share the same safe-deletion RPC", () => {
  it("REQUIREMENT: single delete (?id=) calls the shared safeDeletePurchases with exactly that one id, never a raw DELETE statement", () => {
    const deleteHandler = purchasesRoute.slice(purchasesRoute.indexOf("export async function DELETE"));
    expect(deleteHandler).toContain("const result = await safeDeletePurchases([id]);");
    expect(deleteHandler).not.toContain("method: \"DELETE\"");
  });

  it("REQUIREMENT: a fully-protected single delete returns HTTP 409 with the exact required explanation and a reason code", () => {
    const deleteHandler = purchasesRoute.slice(purchasesRoute.indexOf("export async function DELETE"));
    expect(deleteHandler).toContain("isFullyProtectedResult(result)");
    expect(deleteHandler).toContain("PURCHASE_PROTECTED_MESSAGE");
    expect(deleteHandler).toContain('reason: "purchase_linked_to_completed_sale"');
    expect(deleteHandler).toContain("status: 409");
  });

  it('lib/purchases-delete.ts defines the exact required explanation verbatim', () => {
    const lib = readFileSync("lib/purchases-delete.ts", "utf8");
    expect(lib).toContain('export const PURCHASE_PROTECTED_MESSAGE = "This purchase belongs to a completed sale. Cancel the sale before deleting the purchase.";');
  });

  it("REQUIREMENT: Clear All fetches every purchase id, then deletes in bounded batches — never one unbounded/unsafe delete statement", () => {
    const clearAllBlock = purchasesRoute.slice(purchasesRoute.indexOf('params.get("clear") === "all"'), purchasesRoute.indexOf("const id = params.get"));
    expect(clearAllBlock).toContain('supabaseRequestAll<{ id: string }>("purchases?select=id")');
    expect(clearAllBlock).toContain("safeDeletePurchasesInBatches(allIds.map(row => row.id))");
    expect(clearAllBlock).not.toContain('"purchases?id=not.is.null"');
  });

  it("REQUIREMENT: Clear All never errors out just because some purchases are protected — it always reports counts (200), leaving protected purchases intact", () => {
    const clearAllBlock = purchasesRoute.slice(purchasesRoute.indexOf('params.get("clear") === "all"'), purchasesRoute.indexOf("const id = params.get"));
    expect(clearAllBlock).not.toContain("isFullyProtectedResult");
    expect(clearAllBlock).toContain("NextResponse.json({ ok: true, ...result });");
  });

  it("GET annotates every purchase with its live protection status in one bounded follow-up query, never one request per row", () => {
    const getHandler = purchasesRoute.slice(purchasesRoute.indexOf("export async function GET"), purchasesRoute.indexOf("export async function POST"));
    expect(getHandler).toContain("loadPurchaseProtectionMap()");
    expect(getHandler).toContain("protectedSaleId: protection.get(row.id) ?? null");
  });
});
