import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// supabase-sales-v3.sql is a checked-in, NOT-YET-RUN migration — asserted
// structurally, following the same source-text pattern used throughout this
// project's other SQL migration tests (see tests/sales-migration-v2.test.ts).
const migration = readFileSync("supabase-sales-v3.sql", "utf8").replace(/\r\n/g, "\n");
const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
const executableCodeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");

describe("supabase-sales-v3.sql — idempotent, transactional, and correctly scoped", () => {
  it("begins with begin; and ends with commit;", () => {
    const codeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");
    expect(codeOnly.split("\n")[0]).toBe("begin;");
    const lines = codeOnly.split("\n");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("adds columns idempotently (if not exists)", () => {
    expect(migration).toContain("add column if not exists cancelled_at");
    expect(migration).toContain("add column if not exists cancellation_stock_action");
  });

  it("never touches an investment table", () => {
    expect(executableCodeOnly).not.toMatch(/investment_/i);
  });

  it("never drops sales_orders/sale_items, and never deletes rows", () => {
    expect(executableCodeOnly).not.toMatch(/drop table/i);
    expect(executableCodeOnly).not.toMatch(/delete from/i);
  });

  it("REQUIREMENT: never weakens the double-sell-prevention partial unique index", () => {
    expect(migration).not.toContain("drop index");
    expect(migration).not.toContain("sale_items_active_purchase_unique");
  });

  it("REQUIREMENT: never touches create_completed_sale or allocate_proportional_pence — cancellation is additive only", () => {
    expect(executableCodeOnly).not.toContain("create_completed_sale");
    expect(executableCodeOnly).not.toContain("allocate_proportional_pence");
  });

  it("does not add an order-reference field", () => {
    expect(migration.toLowerCase()).not.toContain("order_reference");
    expect(migration.toLowerCase()).not.toContain("order reference");
  });
});

describe("supabase-sales-v3.sql — cancellation_stock_action constraint, found by content", () => {
  it("finds any existing constraint by content rather than a guessed name (idempotent re-run safe)", () => {
    expect(migration).toContain("pg_get_constraintdef(con.oid) ilike '%cancellation_stock_action%'");
    expect(migration).toContain("execute format('alter table public.sales_orders drop constraint %I', existing_constraint);");
  });

  it("REQUIREMENT: the audit value is exactly 'returned_to_stock' or 'kept_out_of_stock', distinguishing the two outcomes, or null for a never-cancelled order", () => {
    expect(migration).toContain("check (cancellation_stock_action in ('returned_to_stock', 'kept_out_of_stock') or cancellation_stock_action is null);");
  });
});

describe("supabase-sales-v3.sql — cancel_completed_sales RPC", () => {
  const rpcBody = migration.slice(migration.indexOf("create or replace function public.cancel_completed_sales("), migration.indexOf("revoke all on function public.cancel_completed_sales"));

  it("is a plpgsql function accepting owner id, an order-id array, and an explicit stock-return boolean", () => {
    expect(migration).toContain("create or replace function public.cancel_completed_sales(\n  p_owner_id uuid,\n  p_sales_order_ids uuid[],\n  p_return_to_stock boolean\n)");
  });

  it("REQUIREMENT: rejects an empty/null selection", () => {
    expect(rpcBody).toContain("EMPTY_SELECTION");
    expect(rpcBody).toContain("p_sales_order_ids is null or array_length(p_sales_order_ids, 1) is null");
  });

  it("REQUIREMENT: enforces a maximum batch size", () => {
    expect(rpcBody).toContain("TOO_MANY_SALES");
    expect(rpcBody).toContain("v_order_count > 200");
  });

  it("REQUIREMENT: rejects duplicate sale ids", () => {
    expect(rpcBody).toContain("DUPLICATE_SALE_IDS");
    expect(rpcBody).toContain("v_distinct_count <> v_order_count");
  });

  it("REQUIREMENT: confirms every selected sale exists and belongs to the calling owner — both report the identical SALE_NOT_FOUND code, never distinguishing them", () => {
    const notFoundOccurrences = rpcBody.match(/SALE_NOT_FOUND/g) ?? [];
    expect(notFoundOccurrences.length).toBeGreaterThanOrEqual(2);
    expect(rpcBody).toContain("if not found then");
    expect(rpcBody).toContain("v_order.owner_id <> p_owner_id");
  });

  it("REQUIREMENT: confirms every selected sale is currently completed", () => {
    expect(rpcBody).toContain("SALE_NOT_COMPLETED");
    expect(rpcBody).toContain("v_order.status <> 'completed'");
  });

  it("REQUIREMENT: locks every selected order row (for update) before any write", () => {
    expect(rpcBody).toContain("select * into v_order from public.sales_orders where id = v_sorted_order_ids[i] for update;");
  });

  it("REQUIREMENT: identifies purchases ONLY through the selected orders' own active sale_items.purchase_id — never SKU/description", () => {
    expect(rpcBody).toContain("from public.sale_items si");
    expect(rpcBody).toContain("si.sales_order_id = any(v_sorted_order_ids) and si.is_active");
    expect(rpcBody.toLowerCase()).not.toContain("sku_snapshot");
    expect(rpcBody.toLowerCase()).not.toContain("item_description_snapshot");
  });

  it("REQUIREMENT: locks every affected purchase row (for update) before any write", () => {
    expect(rpcBody).toContain("perform 1 from public.purchases where id = v_purchase_ids[i] for update;");
  });

  it("REQUIREMENT: validation happens entirely before any write — nothing is written if any selected sale fails", () => {
    const firstUpdateIdx = rpcBody.indexOf("update public.sales_orders");
    const lastValidationIdx = rpcBody.indexOf("SALE_NOT_COMPLETED");
    expect(lastValidationIdx).toBeGreaterThan(-1);
    expect(firstUpdateIdx).toBeGreaterThan(lastValidationIdx);
  });

  it("REQUIREMENT: sets every selected order to cancelled and records the audit fields together", () => {
    expect(rpcBody).toContain("set status = 'cancelled',");
    expect(rpcBody).toContain("cancelled_at = now(),");
    expect(rpcBody).toContain("cancellation_stock_action = case when p_return_to_stock then 'returned_to_stock' else 'kept_out_of_stock' end");
  });

  it("REQUIREMENT: deactivates every one of the selected orders' active sale_items", () => {
    expect(rpcBody).toContain("update public.sale_items\n    set is_active = false\n    where sales_order_id = any(v_sorted_order_ids) and is_active;");
  });

  it("REQUIREMENT: restores stock ONLY when explicitly requested, and only for the exact linked purchase UUIDs", () => {
    expect(rpcBody).toContain("if p_return_to_stock and v_purchase_ids is not null then\n    update public.purchases set stock_status = 'in_stock' where id = any(v_purchase_ids);\n  end if;");
  });

  it("REQUIREMENT: returns useful counts — orders cancelled and units affected", () => {
    expect(migration).toContain("returns table (orders_cancelled int, units_affected int)");
    expect(rpcBody).toContain("orders_cancelled := v_order_count;");
    expect(rpcBody).toContain("units_affected := v_units_affected;");
  });

  it("deterministic lock order — sorted ascending by UUID, never caller submission order (avoids lock-order deadlocks)", () => {
    expect(rpcBody).toContain("select array_agg(x order by x) into v_sorted_order_ids from unnest(p_sales_order_ids) x;");
  });

  it("revokes execute from anon/authenticated — only the service-role key (application layer) may call this", () => {
    expect(migration).toContain("revoke all on function public.cancel_completed_sales(uuid, uuid[], boolean) from public;");
    expect(migration).toContain("revoke all on function public.cancel_completed_sales(uuid, uuid[], boolean) from anon;");
    expect(migration).toContain("revoke all on function public.cancel_completed_sales(uuid, uuid[], boolean) from authenticated;");
  });
});
