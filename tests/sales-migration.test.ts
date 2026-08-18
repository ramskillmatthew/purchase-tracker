import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// supabase-sales.sql is a checked-in, NOT-YET-RUN migration — asserted
// structurally (it's SQL, not something vitest can execute against a real
// database), following the same source-text pattern used in
// tests/purchase-import-migration.test.ts for the sibling
// supabase-purchase-import-v2.sql migration.
const migration = readFileSync("supabase-sales.sql", "utf8").replace(/\r\n/g, "\n");
const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
// Comments (including the header's own prose, which mentions "create
// table/index if not exists" in passing) must never be mistaken for actual
// DDL — every idempotency/scope check below runs against code with `--`
// comments stripped.
const executableCodeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");

describe("supabase-sales.sql — idempotent and additive", () => {
  it("every DDL statement is safe to run more than once", () => {
    expect(executableCodeOnly).not.toMatch(/\bcreate table(?! if not exists)/i);
    expect(executableCodeOnly).not.toMatch(/\bcreate index(?! if not exists)/i);
    expect(executableCodeOnly).not.toMatch(/\bcreate unique index(?! if not exists)/i);
    expect(executableCodeOnly).toContain("create or replace function");
  });

  it("never uses a bare DROP/ALTER that would fail on a second run", () => {
    expect(executableCodeOnly).not.toMatch(/\bdrop table(?! if exists)/i);
  });
});

describe("supabase-sales.sql — REGRESSION: wrapped in one explicit transaction", () => {
  const codeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");

  it("begins with begin; before the first executable statement", () => {
    expect(codeOnly.split("\n")[0]).toBe("begin;");
  });

  it("ends with commit; after the final executable statement", () => {
    const lines = codeOnly.split("\n");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("commit; appears strictly after the RPC and its revokes are fully defined", () => {
    const commitIndex = executable.lastIndexOf("commit;");
    const revokeBlockEnd = executable.indexOf("end $$;", executable.indexOf("do $$ begin"));
    expect(commitIndex).toBeGreaterThan(revokeBlockEnd);
  });
});

describe("supabase-sales.sql — scope boundaries", () => {
  it("REQUIREMENT: never touches any investment table — only mentions supabase-investments.sql in a documentation comment, never as a DDL target", () => {
    const codeOnly = migration.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");
    expect(codeOnly).not.toMatch(/investment_/i);
  });

  it("REQUIREMENT: never recreates or drops public.purchases", () => {
    expect(migration).not.toMatch(/drop table.*purchases/i);
    expect(migration).not.toMatch(/create table.*\bpublic\.purchases\b/i);
  });

  it("REQUIREMENT: never marks an existing purchase as sold or inserts example/seed sales data OUTSIDE the RPC's own runtime logic — the migration script itself performs no such write, and the RPC's writes are gated behind its own validation (checked separately below)", () => {
    // The RPC legitimately inserts into sales_orders/sale_items and updates
    // purchases.stock_status at CALL TIME — that's its entire purpose. What
    // this guards against is the migration SCRIPT ITSELF (outside the
    // function body) seeding/mutating data when merely applied.
    const outsideRpc = executable.slice(0, executable.indexOf("create or replace function public.create_completed_sale"))
      + executable.slice(executable.indexOf("revoke all on function public.create_completed_sale"));
    expect(outsideRpc).not.toMatch(/insert into public\.sales_orders/i);
    expect(outsideRpc).not.toMatch(/insert into public\.sale_items/i);
    expect(outsideRpc).not.toMatch(/update public\.purchases/i);
  });

  it("requires supabase-purchase-category.sql conceptually (documented, not enforced by SQL) — category_snapshot copies public.purchases.category", () => {
    expect(migration).toContain("category_snapshot");
    expect(migration).toContain("supabase-purchase-category.sql");
  });
});

describe("supabase-sales.sql — schema", () => {
  it("sales_orders has no order-reference column", () => {
    const ordersBlock = migration.slice(migration.indexOf("create table if not exists public.sales_orders"), migration.indexOf("create table if not exists public.sale_items"));
    expect(ordersBlock).not.toMatch(/order_reference/i);
  });

  it("platform is a closed enum including Other, and custom_platform_name is contradiction-checked", () => {
    expect(migration).toContain("platform text not null check (platform in ('vinted', 'ebay', 'depop', 'other'))");
    expect(migration).toContain("sales_orders_custom_platform_name_check");
    expect(migration).toContain("platform = 'other' and custom_platform_name is not null");
    expect(migration).toContain("platform <> 'other' and custom_platform_name is null");
  });

  it("status supports completed, refunded, and cancelled, defaulting to completed", () => {
    expect(migration).toContain("status text not null default 'completed' check (status in ('completed', 'refunded', 'cancelled'))");
  });

  it("every money column uses numeric(10,2), matching public.purchases.price_purchased's own convention", () => {
    for (const column of ["revenue_input_value", "total_revenue", "platform_fees numeric(10,2)", "postage numeric(10,2)"]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain("allocated_revenue numeric(10,2)");
    expect(migration).toContain("purchase_cost_snapshot numeric(10,2)");
    expect(migration).toContain("profit numeric(10,2)");
  });

  it("REQUIREMENT: profit is not constrained non-negative — a loss is a valid stored value", () => {
    const profitLine = migration.split("\n").find(line => line.trim().startsWith("profit numeric(10,2)"));
    expect(profitLine).toBeDefined();
    expect(profitLine).not.toMatch(/check/i);
  });

  it("sale_items snapshots every field the spec requires", () => {
    for (const column of [
      "sku_snapshot", "item_description_snapshot", "category_snapshot", "item_condition_snapshot",
      "condition_group_snapshot", "purchase_cost_snapshot", "purchased_from_snapshot",
    ]) expect(migration).toContain(`${column} `);
  });
});

describe("supabase-sales.sql — double-sell prevention", () => {
  it("REQUIREMENT: an is_active flag plus a partial unique index on purchase_id enforces at most one active sale per purchase", () => {
    expect(migration).toContain("is_active boolean not null default true");
    expect(migration).toContain("create unique index if not exists sale_items_active_purchase_unique on public.sale_items (purchase_id) where is_active;");
  });

  it("REQUIREMENT: the RPC re-checks availability under a row lock before writing anything (belt-and-braces alongside the index)", () => {
    expect(migration).toContain("for update");
    expect(migration).toContain("v_purchase.stock_status <> 'in_stock'");
    expect(migration).toContain("PURCHASE_NOT_AVAILABLE");
    expect(migration).toContain("select 1 from public.sale_items where purchase_id = v_purchase.id and is_active");
    expect(migration).toContain("PURCHASE_ALREADY_SOLD");
  });

  it("validates every purchase (pass 1) strictly before any insert (pass 2) — mirrors import_purchase_order's own two-pass discipline", () => {
    const rpcBody = migration.slice(migration.indexOf("create or replace function public.create_completed_sale"), migration.indexOf("revoke all on function public.create_completed_sale"));
    const pass1Idx = rpcBody.indexOf("PURCHASE_NOT_FOUND");
    const insertOrderIdx = rpcBody.indexOf("insert into public.sales_orders");
    const insertItemsIdx = rpcBody.indexOf("insert into public.sale_items");
    expect(pass1Idx).toBeGreaterThan(-1);
    expect(pass1Idx).toBeLessThan(insertOrderIdx);
    expect(insertOrderIdx).toBeLessThan(insertItemsIdx);
  });
});

describe("supabase-sales.sql — validation order and error codes", () => {
  const rpcBody = migration.slice(migration.indexOf("create or replace function public.create_completed_sale"), migration.indexOf("revoke all on function public.create_completed_sale"));

  it("rejects duplicate purchase ids explicitly", () => {
    expect(rpcBody).toContain("DUPLICATE_PURCHASE_IDS");
    expect(rpcBody).toContain("v_distinct_count <> v_item_count");
  });

  it("enforces a maximum item count", () => {
    expect(rpcBody).toContain("TOO_MANY_ITEMS");
    expect(rpcBody).toContain("v_item_count > 100");
  });

  it("normalises total vs average revenue mode", () => {
    expect(rpcBody).toContain("case when p_revenue_input_mode = 'average' then p_revenue_input_value * v_item_count else p_revenue_input_value end");
  });

  it("sorts purchase ids deterministically (by uuid) before allocating the remainder, never using submission order", () => {
    expect(rpcBody).toContain("array_agg(x order by x)");
  });

  it("every raised exception carries a distinct errcode", () => {
    const codes = [...rpcBody.matchAll(/errcode = '(P2\d{3})'/g)].map(m => m[1]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThanOrEqual(11);
  });
});

describe("supabase-sales.sql — RPC access control matches import_purchase_order's own pattern", () => {
  it("revokes execute from public, anon, and authenticated — only the service-role key may call it", () => {
    expect(migration).toContain("revoke all on function public.create_completed_sale");
    expect(migration).toContain("revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]) from anon;");
    expect(migration).toContain("revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]) from authenticated;");
  });
});

describe("supabase-sales.sql — ownership isolation, matching the modern (non-purchases/expenses) convention", () => {
  it("both tables carry owner_id / are scoped via a table that does, RLS is enabled, and anon/authenticated grants are revoked", () => {
    expect(migration).toContain("owner_id uuid not null references auth.users (id)");
    expect(migration).toContain("alter table public.sales_orders enable row level security;");
    expect(migration).toContain("revoke all on public.sales_orders from anon, authenticated;");
    expect(migration).toContain("alter table public.sale_items enable row level security;");
    expect(migration).toContain("revoke all on public.sale_items from anon, authenticated;");
  });
});
