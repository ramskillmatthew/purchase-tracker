import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Next.js server route touching Supabase directly — no live database in
// this test suite, so checked structurally, consistent with
// tests/sales-api-routes.test.ts's own convention for this project's
// route.ts files.
const route = readFileSync("app/api/sales/cancel/route.ts", "utf8");

describe("app/api/sales/cancel/route.ts — POST bulk-cancel", () => {
  it("REQUIREMENT: only exports POST — never DELETE (a DELETE method would falsely suggest the financial record itself is removed)", () => {
    expect(route).toContain("export async function POST(");
    expect(route).not.toContain("export async function DELETE(");
  });

  it("requires owner authentication (also covered generically by tests/security-boundaries.test.ts's app/api/** glob)", () => {
    expect(route).toContain("await requireOwner();");
  });

  it("validates the request body with the strict cancelSalesInputSchema", () => {
    expect(route).toContain("cancelSalesInputSchema.parse(await request.json())");
  });

  it("REQUIREMENT: never trusts a client-supplied owner id — always passes the server-resolved authenticated user's id", () => {
    expect(route).toContain("p_owner_id: user.id,");
    expect(route).not.toContain("input.ownerId");
    expect(route).not.toContain("body.ownerId");
  });

  it("REQUIREMENT: calls rpc/cancel_completed_sales exactly once — never a sequence of separate requests for orders/items/purchases", () => {
    expect(route).toContain('supabaseRequest("rpc/cancel_completed_sales"');
    expect(route.match(/supabaseRequest\("rpc\/cancel_completed_sales"/g)?.length).toBe(1);
  });

  it("forwards the exact selected sale ids and the explicit stock decision under the RPC's p_-prefixed parameter names", () => {
    expect(route).toContain("p_sales_order_ids: input.salesOrderIds,");
    expect(route).toContain("p_return_to_stock: input.returnToStock,");
  });

  it("REQUIREMENT: only a recognized RPC conflict is classified — anything else rethrows to the outer safeApiError handler", () => {
    expect(route).toContain("classifySaleRpcError(error)");
    expect(route).toContain("if (!reason) throw error;");
  });

  it("REQUIREMENT: rejects (via the RPC's own SALE_NOT_COMPLETED conflict) an already-cancelled or refunded sale with a clear message, not a raw database error", () => {
    expect(route).toContain("sale_not_completed:");
    expect(route.toLowerCase()).toContain("already cancelled or refunded");
  });

  it("returns the RPC's own counts, not a raw passthrough of the whole response body", () => {
    expect(route).toContain("ordersCancelled: row.orders_cancelled, unitsAffected: row.units_affected");
  });

  it("routes unrecognized failures through the shared safeApiError helper, never leaking raw errors", () => {
    expect(route).toContain('return safeApiError(error, "Could not cancel the selected sales.");');
  });
});
