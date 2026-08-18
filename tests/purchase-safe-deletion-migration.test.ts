import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// supabase-safe-purchase-deletion.sql is a checked-in, NOT-YET-RUN migration
// — asserted structurally, following the same source-text pattern used
// throughout this project's other SQL migration tests (see
// tests/sales-cancel-migration.test.ts).
const migration = readFileSync("supabase-safe-purchase-deletion.sql", "utf8").replace(/\r\n/g, "\n");
const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
const executableCodeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");

describe("supabase-safe-purchase-deletion.sql — idempotent, transactional, and correctly scoped", () => {
  it("begins with begin; and ends with commit;", () => {
    const codeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");
    expect(codeOnly.split("\n")[0]).toBe("begin;");
    const lines = codeOnly.split("\n");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("REQUIREMENT: makes sale_items.purchase_id nullable without touching the FK constraint itself — no ON DELETE CASCADE anywhere", () => {
    expect(migration).toContain("alter table public.sale_items alter column purchase_id drop not null;");
    expect(migration.toLowerCase()).not.toContain("on delete cascade");
    expect(migration).not.toContain("drop constraint");
  });

  it("never touches an investment table", () => {
    expect(executableCodeOnly).not.toMatch(/investment_/i);
  });

  it("never drops a table, and never deletes/truncates sale_items or sales_orders rows directly", () => {
    expect(executableCodeOnly).not.toMatch(/drop table/i);
    expect(executableCodeOnly).not.toMatch(/delete from public\.sale_items/i);
    expect(executableCodeOnly).not.toMatch(/delete from public\.sales_orders/i);
    expect(executableCodeOnly).not.toMatch(/truncate/i);
  });

  it("REQUIREMENT: never weakens the double-sell-prevention partial unique index", () => {
    expect(migration).not.toContain("sale_items_active_purchase_unique");
  });

  it("REQUIREMENT: never touches create_completed_sale, cancel_completed_sales, or allocate_proportional_pence — additive only", () => {
    expect(executableCodeOnly).not.toContain("create_completed_sale");
    expect(executableCodeOnly).not.toContain("cancel_completed_sales");
    expect(executableCodeOnly).not.toContain("allocate_proportional_pence");
  });
});

describe("supabase-safe-purchase-deletion.sql — safe_delete_purchases RPC", () => {
  const rpcBody = migration.slice(migration.indexOf("create or replace function public.safe_delete_purchases("), migration.indexOf("revoke all on function public.safe_delete_purchases"));

  it("REQUIREMENT: takes no owner parameter — purchases has no owner_id column (a single-owner table; requireOwner() at the API layer is the real boundary)", () => {
    expect(migration).toContain("create or replace function public.safe_delete_purchases(p_purchase_ids uuid[])");
  });

  it("returns structured counts and protected ids, never a bare success flag", () => {
    expect(migration).toContain("requested_count int,");
    expect(migration).toContain("deleted_count int,");
    expect(migration).toContain("protected_count int,");
    expect(migration).toContain("protected_ids uuid[],");
    expect(migration).toContain("missing_count int");
  });

  it("REQUIREMENT: rejects an empty/null selection and enforces a maximum batch size", () => {
    expect(rpcBody).toContain("EMPTY_SELECTION");
    expect(rpcBody).toContain("p_purchase_ids is null or array_length(p_purchase_ids, 1) is null");
    expect(rpcBody).toContain("TOO_MANY_PURCHASES");
    expect(rpcBody).toContain("v_requested_count > 500");
  });

  it("REQUIREMENT: rejects duplicate purchase ids", () => {
    expect(rpcBody).toContain("DUPLICATE_PURCHASE_IDS");
    expect(rpcBody).toContain("v_distinct_count <> v_requested_count");
  });

  it("REQUIREMENT: locks every requested purchase row before any write, and a missing purchase is reported (not raised) via missing_count", () => {
    expect(rpcBody).toContain("perform 1 from public.purchases where id = v_purchase_id for update;");
    expect(rpcBody).toContain("v_missing_count := v_missing_count + 1;");
  });

  it("REQUIREMENT (Rule 1): a purchase with no sale_items reference at all is deletable", () => {
    expect(rpcBody).toContain("from public.sale_items si");
    expect(rpcBody).toContain("join public.sales_orders so on so.id = si.sales_order_id");
    expect(rpcBody).toContain("where si.purchase_id = v_purchase_id");
  });

  it("REQUIREMENT (Rule 2): a purchase is protected the moment any linked sale_items row is still active", () => {
    expect(rpcBody).toContain("if rec.is_active or rec.order_status = 'completed' then");
  });

  it("REQUIREMENT (Rule 4): an inactive sale_items row on a STILL-completed order is treated as protected, not guessed safe — same condition as Rule 2's active check, deliberately not a separate/weaker branch", () => {
    // The single condition above covers both Rule 2 (is_active) and Rule 4
    // (inactive but order still completed) — confirmed by the presence of
    // both disjuncts in one check, never two separately-reasoned branches
    // that could drift apart.
    expect(rpcBody).toContain("rec.is_active or rec.order_status = 'completed'");
  });

  it("REQUIREMENT: locks every relevant sale_items row (for update of si) while classifying — never just reads them unlocked", () => {
    expect(rpcBody).toContain("for update of si");
  });

  it("REQUIREMENT (Rule 3): only the SAFE (inactive, non-completed-order) sale_items references are nulled — never touches a protected purchase's rows", () => {
    expect(rpcBody).toContain("update public.sale_items\n      set purchase_id = null\n      where purchase_id = any(v_deletable_ids);");
  });

  it("nulls references and deletes the purchase in the same pass, only for the classified-deletable set", () => {
    const pass2 = rpcBody.slice(rpcBody.indexOf("-- Pass 2:"));
    expect(pass2).toContain("delete from public.purchases where id = any(v_deletable_ids);");
    const nullIdx = pass2.indexOf("set purchase_id = null");
    const deleteIdx = pass2.indexOf("delete from public.purchases");
    expect(nullIdx).toBeGreaterThan(-1);
    expect(nullIdx).toBeLessThan(deleteIdx);
  });

  it("REQUIREMENT: classification (pass 1) happens entirely before any write (pass 2) — nothing is written if anything about the batch is invalid", () => {
    const pass1Idx = rpcBody.indexOf("-- Pass 1:");
    const pass2Idx = rpcBody.indexOf("-- Pass 2:");
    const firstWriteIdx = rpcBody.indexOf("update public.sale_items");
    expect(pass1Idx).toBeGreaterThan(-1);
    expect(pass2Idx).toBeGreaterThan(pass1Idx);
    expect(firstWriteIdx).toBeGreaterThan(pass2Idx);
  });

  it("deterministic lock order — sorted ascending by UUID, never caller submission order (avoids lock-order deadlocks)", () => {
    expect(rpcBody).toContain("select array_agg(x order by x) into v_sorted_ids from unnest(p_purchase_ids) x;");
  });

  it("revokes execute from anon/authenticated — only the service-role key (application layer) may call this", () => {
    expect(migration).toContain("revoke all on function public.safe_delete_purchases(uuid[]) from public;");
    expect(migration).toContain("revoke all on function public.safe_delete_purchases(uuid[]) from anon;");
    expect(migration).toContain("revoke all on function public.safe_delete_purchases(uuid[]) from authenticated;");
  });
});
