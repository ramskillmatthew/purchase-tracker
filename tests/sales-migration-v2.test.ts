import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// supabase-sales-v2.sql is a checked-in, NOT-YET-RUN migration — asserted
// structurally, following the same source-text pattern used throughout this
// project's other SQL migration tests (see tests/sales-migration.test.ts,
// tests/purchase-import-migration.test.ts).
const migration = readFileSync("supabase-sales-v2.sql", "utf8").replace(/\r\n/g, "\n");
const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
const executableCodeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");

describe("supabase-sales-v2.sql — idempotent, transactional, and correctly scoped", () => {
  it("begins with begin; and ends with commit;", () => {
    const codeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");
    expect(codeOnly.split("\n")[0]).toBe("begin;");
    const lines = codeOnly.split("\n");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("every table/index DDL is safe to run more than once", () => {
    expect(executableCodeOnly).not.toMatch(/\bcreate table(?! if not exists)/i);
    expect(executableCodeOnly).not.toMatch(/\bcreate index(?! if not exists)/i);
  });

  it("documents the required migration order and the v1 re-run caveat", () => {
    expect(migration).toContain("REQUIRES supabase-sales.sql");
    expect(migration).toContain("DO NOT RE-RUN supabase-sales.sql");
  });

  it("never touches an investment table", () => {
    expect(executableCodeOnly).not.toMatch(/investment_/i);
  });

  it("never drops or recreates sales_orders/sale_items, and never deletes rows", () => {
    expect(migration).not.toMatch(/drop table/i);
    expect(migration).not.toMatch(/delete from/i);
  });

  it("does not touch the double-sell-prevention partial unique index", () => {
    expect(migration).not.toContain("sale_items_active_purchase_unique");
  });
});

describe("supabase-sales-v2.sql — widens revenue_input_mode to include itemised, found by content", () => {
  it("finds the existing constraint by content rather than a guessed name", () => {
    expect(migration).toContain("pg_get_constraintdef(con.oid) ilike '%revenue_input_mode%'");
    expect(migration).toContain("execute format('alter table public.sales_orders drop constraint %I', existing_constraint);");
  });

  it("the new constraint keeps total/average and adds itemised — the full cumulative list, not a narrower replacement", () => {
    expect(migration).toContain("check (revenue_input_mode in ('total', 'average', 'itemised'));");
  });
});

describe("supabase-sales-v2.sql — allocate_proportional_pence helper", () => {
  it("is a plpgsql function returning bigint[], revoked from anon/authenticated", () => {
    expect(migration).toContain("create or replace function public.allocate_proportional_pence(p_total bigint, p_weights bigint[])");
    expect(migration).toContain("returns bigint[]");
    expect(migration).toContain("revoke all on function public.allocate_proportional_pence(bigint, bigint[]) from public;");
  });

  it("falls back to an equal split when the weights sum to zero or fewer than one position exists", () => {
    expect(migration).toContain("v_sum_weights <= 0");
    expect(migration).toContain("v_count = 0");
  });

  it("uses a largest-remainder (fractional part desc, index asc) ranking — deterministic, mirrors lib/sales/allocation.ts", () => {
    expect(migration).toContain("order by frac desc, idx asc");
  });
});

describe("supabase-sales-v2.sql — create_completed_sale extended for itemised mode", () => {
  it("REQUIREMENT: explicitly drops the old 9-parameter overload before creating the new 10-parameter one, avoiding overload ambiguity", () => {
    const dropIdx = migration.indexOf("drop function if exists public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]);");
    const createIdx = migration.indexOf("create or replace function public.create_completed_sale(");
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(createIdx);
  });

  it("the new signature adds p_line_revenues jsonb with a default of null — existing 9-argument-shaped calls still resolve", () => {
    expect(migration).toContain("p_line_revenues jsonb default null");
  });

  const rpcBody = migration.slice(migration.indexOf("create or replace function public.create_completed_sale("), migration.indexOf("revoke all on function public.create_completed_sale"));

  it("accepts 'itemised' as a valid revenue mode", () => {
    expect(rpcBody).toContain("if p_revenue_input_mode not in ('total', 'average', 'itemised') then");
  });

  it("REQUIREMENT: itemised lines must be present, cover exactly the selected purchases, be non-negative, and reconcile to the declared total — each check has its own distinct error code", () => {
    expect(rpcBody).toContain("ITEMISED_LINES_REQUIRED");
    expect(rpcBody).toContain("ITEMISED_LINE_COUNT_MISMATCH");
    expect(rpcBody).toContain("ITEMISED_LINE_PURCHASE_MISMATCH");
    expect(rpcBody).toContain("ITEMISED_REVENUE_MISMATCH");
    expect(rpcBody).toContain("v_line_revenue_sum_pence is distinct from round(p_revenue_input_value * 100)");
  });

  it("REQUIREMENT: rejects itemised data supplied for a non-itemised mode (contradictory payload)", () => {
    expect(rpcBody).toContain("ITEMISED_DATA_NOT_ALLOWED");
    expect(rpcBody).toContain("elsif p_line_revenues is not null then");
  });

  it("itemised-mode line revenues are matched to the SAME sorted purchase order used everywhere else, so array indices line up", () => {
    expect(rpcBody).toContain("where (elem->>'purchase_id')::uuid = v_sorted_ids[i]");
  });

  it("REQUIREMENT: itemised revenue is used directly per line (no equal split); total/average keep the original equal-split code path unchanged", () => {
    expect(rpcBody).toContain("v_revenue_shares := v_line_revenues;");
    expect(rpcBody).toContain("v_base := v_total_revenue_pence / v_item_count;");
  });

  it("REQUIREMENT: fees/postage in itemised mode are allocated proportionally to revenue, falling back to cost when all revenue is zero", () => {
    expect(rpcBody).toContain("public.allocate_proportional_pence(v_fees_pence, v_revenue_shares)");
    expect(rpcBody).toContain("public.allocate_proportional_pence(v_fees_pence, v_costs)");
    expect(rpcBody).toContain("public.allocate_proportional_pence(v_postage_pence, v_revenue_shares)");
    expect(rpcBody).toContain("public.allocate_proportional_pence(v_postage_pence, v_costs)");
  });

  it("REGRESSION: total/average fee/postage allocation is byte-for-byte the same equal-split code as before", () => {
    expect(rpcBody).toContain("v_base := v_fees_pence / v_item_count;");
    expect(rpcBody).toContain("v_base := v_postage_pence / v_item_count;");
  });

  it("collects each purchase's cost during the existing pass-1 lock/validate loop — no extra query pass added", () => {
    const pass1 = rpcBody.slice(rpcBody.indexOf("-- Pass 1:"), rpcBody.indexOf("-- Revenue allocation:"));
    expect(pass1).toContain("v_costs[i] := round(v_purchase.price_purchased * 100);");
    expect(pass1).toContain("PURCHASE_NOT_FOUND");
    expect(pass1).toContain("PURCHASE_NOT_AVAILABLE");
    expect(pass1).toContain("PURCHASE_ALREADY_SOLD");
  });

  it("validation and allocation for itemised mode happen before the sales_orders insert — nothing is written on invalid input", () => {
    const validationIdx = rpcBody.indexOf("ITEMISED_LINES_REQUIRED");
    const insertOrderIdx = rpcBody.indexOf("insert into public.sales_orders");
    expect(validationIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeLessThan(insertOrderIdx);
  });

  it("snapshot/condition-group derivation and the double-sell stock flip are unchanged from v1", () => {
    expect(rpcBody).toContain("v_purchase.item_condition in ('Brand new', 'Brand new without tags') then 'new'");
    expect(rpcBody).toContain("update public.purchases set stock_status = 'no_longer_in_stock' where id = v_purchase.id;");
  });

  it("revokes execute on the new 10-parameter signature from anon/authenticated", () => {
    expect(migration).toContain("revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[], jsonb) from public;");
    expect(migration).toContain("revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[], jsonb) from anon;");
    expect(migration).toContain("revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[], jsonb) from authenticated;");
  });
});
