import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Next.js server routes touching Supabase directly — no live database in
// this test suite, so checked structurally, consistent with
// tests/security-boundaries.test.ts and tests/bulk-arrivals.test.ts's own
// convention for this project's route.ts files.
const createRoute = readFileSync("app/api/sales/route.ts", "utf8");
const singleRoute = readFileSync("app/api/sales/[id]/route.ts", "utf8");

describe("app/api/sales/route.ts — POST create sale", () => {
  it("requires owner authentication (also covered generically by tests/security-boundaries.test.ts's app/api/** glob)", () => {
    expect(createRoute).toContain("await requireOwner();");
  });

  it("validates the request body with the strict createSaleInputSchema", () => {
    expect(createRoute).toContain("createSaleInputSchema.parse(await request.json())");
  });

  it("REQUIREMENT: calls rpc/create_completed_sale exactly once — never a sequence of separate client-side requests", () => {
    expect(createRoute).toContain('supabaseRequest("rpc/create_completed_sale"');
    expect(createRoute.match(/supabaseRequest\("rpc\/create_completed_sale"/g)?.length).toBe(1);
  });

  it("REQUIREMENT: does not accept or forward purchase cost, description, category, SKU, or supplier as RPC parameters — the RPC body only ever carries order-level facts and the purchase-id array", () => {
    const rpcCallBlock = createRoute.slice(createRoute.indexOf('supabaseRequest("rpc/create_completed_sale"'), createRoute.indexOf("});", createRoute.indexOf('supabaseRequest("rpc/create_completed_sale"')));
    for (const forbidden of ["cost", "description", "category", "sku", "supplier", "purchased_from"]) {
      expect(rpcCallBlock.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("passes every RPC parameter under the exact p_-prefixed name the SQL function declares", () => {
    for (const param of ["p_owner_id", "p_sale_date", "p_platform", "p_custom_platform_name", "p_revenue_input_mode", "p_revenue_input_value", "p_platform_fees", "p_postage", "p_purchase_ids", "p_line_revenues"]) {
      expect(createRoute).toContain(`${param}:`);
    }
  });

  it("REQUIREMENT (Stage 4): forwards itemised line revenues under the RPC's snake_case shape, converting from the camelCase API input, and sends null when absent (never omits the parameter)", () => {
    expect(createRoute).toContain("input.lineRevenues");
    expect(createRoute).toContain("purchase_id: line.purchaseId, revenue: line.revenue");
    expect(createRoute).toContain(": null");
  });

  it("REQUIREMENT: only a recognized RPC conflict is classified — anything else rethrows to the outer safeApiError handler", () => {
    expect(createRoute).toContain("classifySaleRpcError(error)");
    expect(createRoute).toContain("if (!reason) throw error;");
  });

  it("returns owner-scoped order + items after a successful create, not a raw RPC passthrough", () => {
    expect(createRoute).toContain("sales_orders?id=eq.${row.sales_order_id}&owner_id=eq.${user.id}");
    expect(createRoute).toContain("sale_items?sales_order_id=eq.${row.sales_order_id}");
  });

  it("routes unrecognized failures through the shared safeApiError helper, never leaking raw errors", () => {
    expect(createRoute).toContain('return safeApiError(error, "Could not create the sale.");');
  });
});

describe("app/api/sales/route.ts — GET list", () => {
  it("REQUIREMENT: lists in a stable, most-recent-first order", () => {
    expect(createRoute).toContain("order=sale_date.desc,created_at.desc");
  });

  it("is owner-scoped", () => {
    expect(createRoute).toContain("sales_orders?owner_id=eq.${user.id}");
  });

  it("REQUIREMENT: exposes server-backed page/page-size controls instead of a recent-200 browser list", () => {
    const getFn = createRoute.slice(createRoute.indexOf("export async function GET"));
    expect(getFn).toContain("HISTORY_PAGE_SIZES.includes");
    expect(getFn).toContain("filtered.slice((page - 1) * pageSize, page * pageSize)");
    expect(getFn).toContain("totalPages");
  });

  it("REQUIREMENT: annotates orders in fixed-size batches, never with one sale-items request per order", () => {
    expect(createRoute).toContain("index += SALE_ITEM_BATCH_SIZE");
    expect(createRoute).toContain('`sale_items?sales_order_id=in.(${ids.join(",")})&select=sales_order_id,item_description_snapshot,category_snapshot,profit&order=sales_order_id.asc,created_at.asc`');
    expect(createRoute).not.toMatch(/for \(const order of orders\)[\s\S]{0,250}supabaseRequest/);
  });

  it("REQUIREMENT: profit is summed from each sale_item's own saved `profit` (poundsToPence), never recalculated — agrees exactly with the sale detail page", () => {
    expect(createRoute).toContain("poundsToPence(Number(item.profit))");
  });

  it("REQUIREMENT: description groups come from the immutable item_description_snapshot via the shared groupItemDescriptions helper, not the current purchase description", () => {
    expect(createRoute).toContain("groupItemDescriptions(orderItems.map(item => item.item_description_snapshot))");
  });
});

describe("app/api/sales/[id]/route.ts — GET single sale with line items", () => {
  it("requires owner authentication", () => {
    expect(singleRoute).toContain("await requireOwner();");
  });

  it("is owner-scoped when looking up the order", () => {
    expect(singleRoute).toContain("sales_orders?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}");
  });

  it("returns 404 rather than leaking existence of another owner's sale (there is only ever one owner here, but the scoping is what makes this safe)", () => {
    expect(singleRoute).toContain('if (!order) return NextResponse.json({ error: "Sale not found." }, { status: 404 });');
  });

  it("fetches every line item for the sale via supabaseRequestAll, in a stable order", () => {
    expect(singleRoute).toContain("supabaseRequestAll<SaleItem>(`sale_items?sales_order_id=eq.${encodeURIComponent(id)}&order=created_at.asc`)");
  });
});
