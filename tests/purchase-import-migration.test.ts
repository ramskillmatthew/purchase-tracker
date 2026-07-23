import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// supabase-purchase-import-v2.sql is a checked-in, NOT-YET-RUN migration —
// see app/api/vinted/{sync,candidates,import}/route.ts and
// lib/purchase-import/identity.ts, which are all already written against
// the schema this file defines. Asserted structurally (it's SQL, not
// something vitest can execute against a real database) following the same
// source-text pattern used for the route handlers in
// tests/purchase-import-routes.test.ts.
// Normalized to LF: git may check this file out with CRLF line endings
// (confirmed on this repo), and JS regex `.` doesn't match `\r`, which would
// otherwise silently break any `$`-anchored per-line pattern below.
const migration = readFileSync("supabase-purchase-import-v2.sql", "utf8").replace(/\r\n/g, "\n");

describe("migration v2: idempotent and additive", () => {
  // The ROLLBACK section documents manual, one-time SQL to run only if the
  // whole migration is ever reverted — it is explicitly not part of the
  // migration itself and isn't required to be idempotent.
  const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));

  it("every DDL statement is safe to run more than once", () => {
    expect(executable).not.toMatch(/\badd column(?! if not exists)/i);
    expect(executable).not.toMatch(/\bdrop index(?! if exists)/i);
    expect(executable.match(/create unique index/gi)?.length).toBeGreaterThan(0);
    expect(executable).not.toMatch(/create unique index(?! if not exists)/i);
  });
});

describe("migration v2: REGRESSION — the entire executable migration is wrapped in one explicit transaction", () => {
  // The ROLLBACK section documents manual, one-time SQL to run only if the
  // whole migration is ever reverted — deliberately outside/after the
  // committed transaction, and not itself required to run inside one.
  const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
  const codeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");

  it("begins with begin; before the first executable statement", () => {
    expect(codeOnly.split("\n")[0]).toBe("begin;");
  });

  it("ends with commit; after the final executable statement, so any failure rolls back every schema/index/function change together", () => {
    const lines = codeOnly.split("\n");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("commit; appears strictly after the transactional RPC and its revokes are fully defined", () => {
    const commitIndex = executable.lastIndexOf("commit;");
    const revokeBlockEnd = executable.indexOf("end $$;", executable.indexOf("do $$ begin"));
    expect(commitIndex).toBeGreaterThan(revokeBlockEnd);
  });
});

describe("migration v2: REGRESSION — replaces order-level uniqueness with item-level uniqueness (fixes the multi-item-order rejection defect)", () => {
  it("drops the two order-level unique indexes that rejected the 2nd+ item of any multi-item order", () => {
    expect(migration).toContain("drop index if exists purchases_vinted_reference_unique");
    expect(migration).toContain("drop index if exists purchases_vinted_fingerprint_unique");
  });

  it("adds source_item_key to purchases and enforces uniqueness on it instead — so two or more items sharing one order reference can all import", () => {
    expect(migration).toContain("alter table public.purchases add column if not exists source_item_key text");
    expect(migration).toContain("create unique index if not exists purchases_source_item_key_unique on public.purchases(source_item_key)");
  });

  it("leaves purchases_vinted_candidate_unique untouched (one candidate can still only ever produce one purchase)", () => {
    expect(migration).not.toContain("drop index if exists purchases_vinted_candidate_unique");
  });

  it("widens candidate uniqueness from one-row-per-email to one-row-per-item, so the same physical item can never be imported twice", () => {
    expect(migration).toContain("drop index if exists vinted_candidates_message_unique");
    expect(migration).toContain("create unique index if not exists vinted_candidates_source_item_key_unique on public.vinted_import_candidates(source_item_key)");
  });

  it("backfills source_item_key for existing rows before enforcing NOT NULL, so no pre-existing row is left invalid", () => {
    const candidateSection = migration.slice(migration.indexOf("source_item_key text;", migration.indexOf("vinted_import_candidates add column")), migration.indexOf("2. Candidate uniqueness"));
    expect(candidateSection).toContain("update public.vinted_import_candidates");
    expect(candidateSection).toContain("set source_item_key = yahoo_message_id || '::' || item_index || '::' || unit_index");
    expect(candidateSection).toContain("alter column source_item_key set not null");
  });
});

describe("migration v2: transactional, owner-scoped order-group import RPC", () => {
  it("defines import_purchase_order(uuid, jsonb) as a plpgsql function (its body is one implicit transaction)", () => {
    expect(migration).toContain("create or replace function public.import_purchase_order(p_owner_id uuid, p_records jsonb)");
    expect(migration).toContain("language plpgsql");
  });

  it("REGRESSION: locks every candidate row (for update) before writing anything, preventing a concurrent double-import race", () => {
    const matches = migration.match(/for update/gi) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("validates ownership and pending status before inserting, and rejects a likely duplicate order rather than silently importing it", () => {
    expect(migration).toContain("CANDIDATE_NOT_FOUND");
    expect(migration).toContain("CANDIDATE_NOT_PENDING");
    expect(migration).toContain("POSSIBLE_DUPLICATE_ORDER");
  });

  it("marks every candidate in the group imported and returns the inserted purchase ids", () => {
    expect(migration).toContain("import_status = 'imported'");
    expect(migration).toContain("returns table(purchase_id uuid, source_item_key text)");
  });

  it("REGRESSION: denies direct execution to anon/authenticated — only the service-role key (used exclusively by the app server) may call it", () => {
    expect(migration).toContain("revoke all on function public.import_purchase_order(uuid, jsonb) from public");
    expect(migration).toMatch(/revoke all on function public\.import_purchase_order\(uuid, jsonb\) from anon/);
    expect(migration).toMatch(/revoke all on function public\.import_purchase_order\(uuid, jsonb\) from authenticated/);
  });

  it("documents a rollback path and calls out which operations are unsafe once a multi-item order has been imported", () => {
    expect(migration).toMatch(/ROLLBACK/);
    expect(migration).toMatch(/Only safe BEFORE any multi-item order has been imported/);
  });
});

describe("migration v2: REGRESSION — duplicate-order detection uses the relational join, never fragile string-parsing of source_item_key", () => {
  it("joins purchases to vinted_import_candidates through vinted_candidate_id and compares yahoo_message_id directly", () => {
    expect(migration).toContain("join public.vinted_import_candidates c2 on c2.id = p.vinted_candidate_id");
    expect(migration).toContain("c2.yahoo_message_id is distinct from v_candidate.yahoo_message_id");
  });

  it("no longer parses source_item_key's own text to recover the originating message id", () => {
    expect(migration).not.toMatch(/position\('::'\s*in\s*source_item_key\)/);
    expect(migration).not.toMatch(/left\(source_item_key,/);
  });
});

describe("migration v2: REGRESSION — an order must be imported all-or-nothing (Pass 1.5 completeness check)", () => {
  it("for every distinct source order among the submitted candidates, locks and compares against the FULL set of still-pending, importable siblings", () => {
    expect(migration).toContain("import_status = 'pending' and cancellation_refund_status is null");
    expect(migration).toContain("into v_total_ids");
  });

  it("locks the full sibling set (for update), not just the submitted rows, so a concurrent request can't change the answer mid-check", () => {
    const pass15 = migration.slice(migration.indexOf("Pass 1.5"), migration.indexOf("Pass 2:"));
    expect(pass15).toMatch(/for update/);
  });

  it("compares the submitted and required id sets as an exact array equality, raising INCOMPLETE_ORDER_SELECTION on any mismatch", () => {
    expect(migration).toContain("v_submitted_ids is distinct from v_total_ids");
    expect(migration).toContain("raise exception 'INCOMPLETE_ORDER_SELECTION' using errcode = 'P0006'");
  });
});

describe("migration v2: REGRESSION — FOR UPDATE is never combined with aggregation in the same query (PostgreSQL forbids row-locking clauses on aggregate results)", () => {
  it("REGRESSION: the old broken pattern — array_agg directly over the base table with a trailing FOR UPDATE in the same query — no longer appears", () => {
    expect(migration).not.toMatch(/array_agg\(id order by id\) into v_total_ids\s*\n\s*from public\.vinted_import_candidates[\s\S]{0,300}for update;/);
  });

  it("locks the plain (non-aggregated) sibling rows first inside a CTE — the CTE itself has no aggregate function alongside its FOR UPDATE", () => {
    expect(migration).toContain("with locked_siblings as (");
    const outerQueryStart = migration.indexOf("select array_agg(id order by id), max(order_total_paid), count(distinct order_total_paid)");
    const cte = migration.slice(migration.indexOf("with locked_siblings as ("), outerQueryStart);
    expect(cte).toMatch(/for update\s*\)/);
    expect(cte).not.toMatch(/array_agg|count\(/i);
  });

  it("aggregates the already-locked ids in a separate outer query whose own SELECT carries no FOR UPDATE of its own", () => {
    const outerQueryStart = migration.indexOf("select array_agg(id order by id), max(order_total_paid), count(distinct order_total_paid)");
    expect(outerQueryStart).toBeGreaterThan(0);
    const outerStatement = migration.slice(outerQueryStart, migration.indexOf(";", outerQueryStart) + 1);
    expect(outerStatement).toContain("array_agg(id order by id)");
    expect(outerStatement).toContain("into v_total_ids, v_order_total, v_distinct_totals");
    expect(outerStatement).not.toMatch(/for update/i);
  });
});

describe("migration v2: REGRESSION — inconsistent sibling order totals reject the whole group rather than max() silently picking one value", () => {
  it("counts distinct non-null order_total_paid values across the FULL locked sibling set, not a single row's own value", () => {
    expect(migration).toContain("count(distinct order_total_paid)");
    expect(migration).toContain("into v_total_ids, v_order_total, v_distinct_totals");
  });

  it("raises INCONSISTENT_ORDER_TOTAL when more than one distinct non-null total exists, before the completeness or total-match checks, and imports nothing from that group", () => {
    const inconsistentIndex = migration.indexOf("raise exception 'INCONSISTENT_ORDER_TOTAL' using errcode = 'P0008'");
    const incompleteIndex = migration.indexOf("raise exception 'INCOMPLETE_ORDER_SELECTION'");
    const firstInsertIndex = migration.indexOf("insert into public.purchases (");
    expect(migration).toContain("if v_distinct_totals > 1 then");
    expect(inconsistentIndex).toBeGreaterThan(0);
    expect(inconsistentIndex).toBeLessThan(incompleteIndex);
    expect(inconsistentIndex).toBeLessThan(firstInsertIndex);
  });

  it("retains the existing null-total behaviour when every sibling total is null (count(distinct ...) already ignores nulls)", () => {
    const checkBlock = migration.slice(migration.indexOf("if v_distinct_totals > 1 then"), migration.indexOf("if v_submitted_ids is distinct from v_total_ids"));
    expect(checkBlock).not.toContain("v_order_total is null");
  });
});

describe("migration v2: REGRESSION — every submitted price must be an exact whole-penny amount before any total comparison or insert", () => {
  it("validates non-negativity and whole-penny precision inside Pass 1, before Pass 1.5's total comparisons run", () => {
    const priceCheckIndex = migration.indexOf("raise exception 'INVALID_PRICE_PRECISION'");
    const pass15Index = migration.indexOf("Pass 1.5");
    expect(priceCheckIndex).toBeGreaterThan(0);
    expect(priceCheckIndex).toBeLessThan(pass15Index);
  });

  it("uses exact numeric arithmetic (never floating point) to detect a fractional-penny value", () => {
    expect(migration).toContain("v_price := (v_item->>'price_purchased')::numeric");
    expect(migration).toContain("v_price is null or v_price < 0 or v_price * 100 <> round(v_price * 100)");
    expect(migration).toContain("raise exception 'INVALID_PRICE_PRECISION' using errcode = 'P0009'");
  });
});

describe("migration v2: REGRESSION — the order-total invariant is enforced inside the transaction, before any row is inserted", () => {
  it("sums the submitted prices in exact integer pence and compares to the candidate's own stored order_total_paid", () => {
    expect(migration).toContain("round(sum((elem->>'price_purchased')::numeric) * 100) into v_submitted_total_pence");
    expect(migration).toContain("v_submitted_total_pence is distinct from round(v_order_total * 100)");
  });

  it("raises a distinct ORDER_TOTAL_MISMATCH conflict, never silently altering or rebalancing the submitted prices", () => {
    expect(migration).toContain("raise exception 'ORDER_TOTAL_MISMATCH' using errcode = 'P0007'");
    expect(migration).not.toMatch(/price_purchased[^;]*:=/);
  });

  it("skips enforcement entirely when the order total was never confidently extracted (null)", () => {
    expect(migration).toContain("if v_order_total is not null then");
  });

  it("the check runs in Pass 1.5, strictly before Pass 2's inserts", () => {
    const orderTotalCheckIndex = migration.indexOf("raise exception 'ORDER_TOTAL_MISMATCH'");
    const pass2Index = migration.indexOf("Pass 2:");
    const firstInsertIndex = migration.indexOf("insert into public.purchases (");
    expect(orderTotalCheckIndex).toBeGreaterThan(0);
    expect(orderTotalCheckIndex).toBeLessThan(pass2Index);
    expect(orderTotalCheckIndex).toBeLessThan(firstInsertIndex);
  });
});
