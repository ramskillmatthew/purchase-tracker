import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

// supabase-returns-losses.sql is a checked-in, NOT-YET-RUN migration —
// asserted structurally (it's SQL, not something vitest can execute against
// a real database), following the same source-text pattern
// tests/sales-migration.test.ts uses for supabase-sales.sql.
const migration = readFileSync("supabase-returns-losses.sql", "utf8").replace(/\r\n/g, "\n");
const executable = migration.slice(0, migration.indexOf("-- ROLLBACK"));
const executableCodeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");
const codeOnly = executable.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");

/** SQL with every `$$ ... $$` function/DO body removed — i.e. only the
 * statements that run at APPLY time. Runtime DML inside a `create or replace
 * function` body (e.g. rl_purge_deletable_sale's `delete from ...`) is
 * app-invoked logic, not a migration-time table rewrite, so the
 * "additive migration" guarantees are asserted against this. */
function ddlOnly(sql: string): string {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ ... $$");
}
const executableDdlOnly = ddlOnly(executableCodeOnly);

describe("supabase-returns-losses.sql — idempotent and additive", () => {
  it("every DDL statement is safe to run more than once", () => {
    expect(executableCodeOnly).not.toMatch(/\bcreate table(?! if not exists)/i);
    expect(executableCodeOnly).not.toMatch(/\bcreate index(?! if not exists)/i);
    expect(executableCodeOnly).not.toMatch(/\bcreate unique index(?! if not exists)/i);
    expect(executableCodeOnly).toContain("create or replace function");
  });

  it("never uses a bare DROP that would fail on a second run", () => {
    expect(executableCodeOnly).not.toMatch(/\bdrop table(?! if exists)/i);
    expect(executableCodeOnly).not.toMatch(/\bdrop function(?! if exists)/i);
  });

  it("never touches an existing table's data at APPLY time (purchases/expenses/sales_orders/sale_items/investments)", () => {
    // ddlOnly() drops function bodies — runtime DML inside a CREATE FUNCTION
    // (e.g. rl_purge_deletable_sale) is app-invoked logic, not a migration-time
    // rewrite.
    for (const forbidden of [/\balter table public\.purchases\b/i, /\balter table public\.expenses\b/i, /\balter table public\.sales_orders\b/i, /\balter table public\.sale_items\b/i, /\bdelete from\b/i, /\btruncate\b/i]) {
      expect(executableDdlOnly).not.toMatch(forbidden);
    }
  });

  it("wraps the whole migration in one explicit transaction", () => {
    expect(codeOnly.split("\n")[0]).toBe("begin;");
    const lines = codeOnly.split("\n");
    expect(lines[lines.length - 1]).toBe("commit;");
  });
});

describe("supabase-returns-losses.sql — ownership + RLS", () => {
  it("every new table is owner-scoped and RLS-enabled, matching sales_orders' own convention", () => {
    for (const table of ["return_records", "loss_records", "inventory_movements", "return_loss_audit_events", "return_loss_counters"]) {
      expect(executableCodeOnly).toMatch(new RegExp(`create table if not exists public\\.${table}[\\s\\S]*?owner_id uuid not null references auth\\.users`));
      expect(executableCodeOnly).toContain(`alter table public.${table} enable row level security`);
      expect(executableCodeOnly).toContain(`revoke all on public.${table} from anon, authenticated`);
    }
  });
});

describe("supabase-returns-losses.sql — required domain fields", () => {
  it("return_records supports the five visible workflow stages and both completion outcomes", () => {
    expect(executableCodeOnly).toContain("'return_started', 'item_sent', 'return_delivered', 'return_completed', 'return_cancelled'");
    expect(executableCodeOnly).toContain("'returned_safely', 'buyer_refunded_no_return'");
  });

  it("date-precision columns exist for both exact and month-only recognition dates", () => {
    expect(executableCodeOnly).toMatch(/started_precision text not null default 'exact' check \(started_precision in \('exact', 'month'\)\)/);
    expect(executableCodeOnly).toMatch(/event_precision text not null default 'exact' check \(event_precision in \('exact', 'month'\)\)/);
  });

  it("loss_records requires a matched purchase for lost_inventory / unsellable_purchase", () => {
    expect(executableCodeOnly).toContain("loss_type not in ('lost_inventory', 'unsellable_purchase') or purchase_id is not null");
  });

  it("inventory_movements has a UNIQUE idempotency key and the four distinct out-of-stock reasons plus two reversal reasons", () => {
    expect(executableCodeOnly).toContain("inventory_movements_idempotency_key_uidx");
    expect(executableCodeOnly).toContain("'lost', 'unsellable', 'refunded_no_return', 'returned_to_stock',\n    'loss_reversed', 'return_reversed'");
  });

  it("money columns use numeric(10,2), matching every table this feature links to", () => {
    expect(executableCodeOnly).toMatch(/revenue_reversed numeric\(10,2\)/);
    expect(executableCodeOnly).toMatch(/unit_cost numeric\(10,2\) not null check \(unit_cost >= 0\)/);
  });
});

describe("supabase-returns-losses.sql — v2 hardening (Stage 1)", () => {
  it("adds soft-delete + the full separate financial-component columns idempotently", () => {
    for (const col of ["deleted_at", "deleted_by", "original_sale_revenue", "original_sale_profit", "inventory_write_off", "stock_value_restored", "other_costs", "net_profit_impact", "reversed_movement_gen"]) {
      expect(executableCodeOnly).toMatch(new RegExp(`alter table public\\.return_records add column if not exists ${col}\\b`));
    }
    expect(executableCodeOnly).toMatch(/alter table public\.loss_records add column if not exists deleted_at/);
    expect(executableCodeOnly).toMatch(/alter table public\.loss_records add column if not exists net_profit_impact/);
    expect(executableCodeOnly).toMatch(/alter table public\.loss_records add column if not exists sale_item_ids/);
  });

  it("enforces array_length(sale_item_ids) = quantity on return_records", () => {
    expect(executableCodeOnly).toContain("coalesce(array_length(sale_item_ids, 1), 0) = quantity");
  });

  it("requires recognition_month + completed_on for a completed return, via a one-directional implication (see the v3 block for the full semantic + cancellation regression)", () => {
    expect(executableCodeOnly).toMatch(
      /workflow_status\s*<>\s*'return_completed'\s*or\s*\(\s*outcome is not null\s*and\s*recognition_month is not null\s*and\s*completed_on is not null\s*\)/,
    );
    // the pre-fix biconditional form is gone
    expect(executableCodeOnly).not.toContain("(workflow_status = 'return_completed') = (recognition_month is not null)");
  });

  it("expands the audit-event enum with outcome_selected / recognition_month_changed / sales_status_changed", () => {
    for (const t of ["outcome_selected", "recognition_month_changed", "sales_status_changed"]) {
      expect(executableCodeOnly).toContain(`'${t}'`);
    }
  });

  it("adds updated_at auto-touch triggers", () => {
    expect(executableCodeOnly).toContain("create or replace function public.rl_touch_updated_at()");
    expect(executableCodeOnly).toContain("create trigger return_records_touch_updated_at before update on public.return_records");
  });
});

describe("supabase-returns-losses.sql — transactional appliers (Stage 1)", () => {
  it("defines the six atomic RPCs with distinct, non-colliding names", () => {
    const names = ["rl_apply_movements", "rl_assert_stock", "rl_add_audit", "rl_apply_return_transition", "rl_create_return", "rl_apply_loss_transition"];
    for (const n of names) expect(executableCodeOnly).toMatch(new RegExp(`create or replace function public\\.${n}\\(`));
    expect(new Set(names).size).toBe(names.length);
  });

  it("every applier pins search_path and is plpgsql (no casual SECURITY DEFINER, no dynamic SQL in the appliers)", () => {
    const fnBodies = executableCodeOnly.split("create or replace function").slice(1).filter(b => /rl_(apply|assert|add|create)/.test(b.slice(0, 60)));
    for (const b of fnBodies) {
      expect(b).toMatch(/set search_path = public, pg_temp/);
      expect(b).not.toMatch(/security definer/i);
      expect(b).not.toMatch(/\bexecute\s+format\(/i); // rl_ appliers use no dynamic SQL
    }
  });

  it("rl_apply_movements is idempotent on the movement idempotency key", () => {
    expect(executableCodeOnly).toContain("on conflict (idempotency_key) do nothing");
  });

  it("rl_apply_return_transition locks the target row FOR UPDATE and validates ownership + not-deleted", () => {
    const fn = executableCodeOnly.slice(executableCodeOnly.indexOf("function public.rl_apply_return_transition"));
    expect(fn).toContain("where id = p_return_id and owner_id = p_owner_id and deleted_at is null");
    expect(fn).toContain("for update");
  });

  it("rl_assert_stock rolls back the whole call on a stock_conflict", () => {
    expect(executableCodeOnly).toContain("raise exception 'stock_conflict'");
  });
});

// ===========================================================================
// v3 corrections — audit remediation (completed-shape implication, function
// EXECUTE lockdown, search_path on all eight, ledger FK RESTRICT, loss-create
// idempotency). Each maps to a numbered required regression.
// ===========================================================================
describe("supabase-returns-losses.sql — v3: completed-shape is a one-directional implication", () => {
  // The final rule must appear BOTH inline (fresh install) and in the v2
  // hardening drop+re-add (re-run) path, and neither may be a biconditional.
  const implication = /workflow_status\s*<>\s*'return_completed'\s*or\s*\(\s*outcome is not null\s*and\s*recognition_month is not null\s*and\s*completed_on is not null\s*\)/;

  it("2. the constraint is stated as `<> 'return_completed' OR (all three not null)`, never `(a) = (b)` biconditional", () => {
    const matches = executableCodeOnly.match(new RegExp(implication, "g")) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // inline + v2 re-add
    // No biconditional equality form anywhere near the constraint.
    expect(executableCodeOnly).not.toMatch(/\(workflow_status = 'return_completed'\)\s*=\s*\(outcome is not null\)/);
    expect(executableCodeOnly).not.toMatch(/\(workflow_status = 'return_completed'\)\s*=\s*\(recognition_month is not null\)/);
    expect(executableCodeOnly).not.toMatch(/\(workflow_status = 'return_completed'\)\s*=\s*\(completed_on is not null\)/);
  });

  it("1+3. the implication logically PASSES a cancelled row that kept its completion history (so cancelling a completed return, and re-running the migration afterwards, cannot violate it)", () => {
    // Faithful JS model of: workflow_status <> 'return_completed'
    //                       OR (outcome!=null AND recognition_month!=null AND completed_on!=null)
    const holds = (r: { workflow_status: string; outcome: unknown; recognition_month: unknown; completed_on: unknown }) =>
      r.workflow_status !== "return_completed" ||
      (r.outcome != null && r.recognition_month != null && r.completed_on != null);

    // completed return -> must carry all three
    expect(holds({ workflow_status: "return_completed", outcome: "returned_safely", recognition_month: "2026-09", completed_on: "2026-09-03" })).toBe(true);
    expect(holds({ workflow_status: "return_completed", outcome: null, recognition_month: "2026-09", completed_on: "2026-09-03" })).toBe(false);
    // completed-then-cancelled, history retained -> PASSES (the Defect 1 fix)
    expect(holds({ workflow_status: "return_cancelled", outcome: "returned_safely", recognition_month: "2026-09", completed_on: "2026-09-03" })).toBe(true);
    // soft-deleted / reactivated with stale completion fields -> also PASSES
    expect(holds({ workflow_status: "return_started", outcome: "returned_safely", recognition_month: "2026-09", completed_on: "2026-09-03" })).toBe(true);
    // plain in-progress return -> PASSES
    expect(holds({ workflow_status: "return_started", outcome: null, recognition_month: null, completed_on: null })).toBe(true);
  });

  it("3. the v2 hardening block drop+re-adds the constraint idempotently (guarded drop, unconditional re-add of the implication)", () => {
    const block = executableCodeOnly.slice(
      executableCodeOnly.indexOf("select conname into c from pg_constraint where conname = 'return_records_completed_shape'"),
    );
    expect(block).toContain("if c is not null then alter table public.return_records drop constraint return_records_completed_shape; end if;");
    expect(block).toMatch(implication);
  });
});

describe("supabase-returns-losses.sql — every function pins a safe search_path (all nine)", () => {
  const FUNCTIONS = [
    "next_return_loss_reference", "rl_touch_updated_at", "rl_apply_movements", "rl_assert_stock",
    "rl_add_audit", "rl_apply_return_transition", "rl_create_return", "rl_apply_loss_transition",
    "rl_purge_deletable_sale",
  ];
  it("4. each `create or replace function public.<name>(` is followed (before its $$ body) by `set search_path = public, pg_temp`", () => {
    for (const fn of FUNCTIONS) {
      const start = executableCodeOnly.indexOf(`create or replace function public.${fn}(`);
      expect(start, `${fn} defined`).toBeGreaterThan(-1);
      const header = executableCodeOnly.slice(start, executableCodeOnly.indexOf("$$", start));
      expect(header, `${fn} pins search_path`).toMatch(/set search_path = public, pg_temp/);
    }
  });
});

describe("supabase-returns-losses.sql — function EXECUTE lockdown (all nine)", () => {
  // exact signatures the lockdown must name
  const SIGNATURES = [
    "public.next_return_loss_reference(uuid, text)",
    "public.rl_touch_updated_at()",
    "public.rl_apply_movements(uuid, jsonb, text)",
    "public.rl_assert_stock(jsonb)",
    "public.rl_add_audit(uuid, uuid, uuid, jsonb)",
    "public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text)",
    "public.rl_create_return(uuid, jsonb, text, jsonb)",
    "public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text)",
    "public.rl_purge_deletable_sale(uuid, uuid[])",
  ];
  const baseName = (sig: string) => sig.replace(/^public\./, "").replace(/\(.*$/, "");

  // v2->v3 covers the first eight (rl_purge_deletable_sale arrives in v4);
  // v3->v4 covers all nine, so its permission outcomes must equal canonical.
  const v2v3 = readFileSync("supabase-returns-losses-v2-to-v3-upgrade.sql", "utf8").replace(/\r\n/g, "\n")
    .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const v3v4 = readFileSync("supabase-returns-losses-v3-to-v4-upgrade.sql", "utf8").replace(/\r\n/g, "\n")
    .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

  /** The statements inside `do $$ ... if exists (pg_roles rolname='X') then ... end if; ...` for role X. */
  function roleGuardBody(src: string, rolname: string): string {
    const start = src.indexOf(`if exists (select 1 from pg_roles where rolname = '${rolname}') then`);
    if (start < 0) return "";
    const end = src.indexOf("end if;", start);
    return end < 0 ? "" : src.slice(start, end + "end if;".length);
  }
  /** Every `revoke all|grant execute on function <sig> from|to <role>` statement, normalised + sorted. */
  function permOutcomes(src: string): string[] {
    return [...src.matchAll(/(revoke all|grant execute) on function (public\.[a-z_]+\([^)]*\)) (from|to) (public|anon|authenticated|service_role);/g)]
      .map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`)
      .sort();
  }

  for (const [label, code, sigs] of [
    ["canonical migration", executableCodeOnly, SIGNATURES] as const,
    ["v3->v4 upgrade script", v3v4, SIGNATURES] as const,
    ["v2->v3 upgrade script", v2v3, SIGNATURES.filter((s) => baseName(s) !== "rl_purge_deletable_sale")] as const,
  ]) {
    describe(label, () => {
      it("1. PUBLIC has EXECUTE removed on every function (revoke ... from public, exact signature)", () => {
        for (const sig of sigs) expect(code).toContain(`revoke all on function ${sig} from public;`);
      });

      it("2. anon has EXECUTE removed on every function, inside a pg_roles('anon') existence guard", () => {
        const g = roleGuardBody(code, "anon");
        expect(g).not.toBe("");
        for (const sig of sigs) expect(g).toContain(`revoke all on function ${sig} from anon;`);
      });

      it("3. authenticated has EXECUTE removed on every function, inside a pg_roles('authenticated') existence guard", () => {
        const g = roleGuardBody(code, "authenticated");
        expect(g).not.toBe("");
        for (const sig of sigs) expect(g).toContain(`revoke all on function ${sig} from authenticated;`);
      });

      it("4. service_role is EXPLICITLY re-granted EXECUTE on every function, inside a pg_roles('service_role') guard — a PUBLIC revoke also strips service_role's inherited access, so the grant is REQUIRED, not optional", () => {
        const g = roleGuardBody(code, "service_role");
        expect(g).not.toBe("");
        for (const sig of sigs) expect(g).toContain(`grant execute on function ${sig} to service_role;`);
        // never revoked from service_role anywhere
        expect(code).not.toMatch(/revoke[^\n]*\bfrom\s+service_role\b/i);
      });

      it("5. the server-side RPC workflow stays usable: every function the app RPC-calls is in the service_role grant set, and nothing extra is", () => {
        const g = roleGuardBody(code, "service_role");
        // directly via callTransition(...) / nextReference / rpc/rl_purge_deletable_sale
        const directRpc = ["rl_create_return", "rl_apply_return_transition", "rl_apply_loss_transition",
          "next_return_loss_reference", "rl_purge_deletable_sale"];
        // reached transitively: the transition RPCs `perform` these, and the
        // updated_at trigger fires as service_role (callers are SECURITY INVOKER)
        const transitiveRpc = ["rl_apply_movements", "rl_assert_stock", "rl_add_audit", "rl_touch_updated_at"];
        const expected = [...directRpc, ...transitiveRpc].filter((fn) => sigs.some((s) => baseName(s) === fn)).sort();
        for (const fn of expected) {
          const sig = sigs.find((s) => baseName(s) === fn)!;
          expect(g, `service_role keeps EXECUTE on ${fn}`).toContain(`grant execute on function ${sig} to service_role;`);
        }
        const granted = [...g.matchAll(/grant execute on function public\.([a-z_]+)\(/g)].map((m) => m[1]).sort();
        expect(granted).toEqual(expected);
      });

      it("uses literal SQL only — no dynamic execute() anywhere in the lockdown", () => {
        const lockdown = code.slice(code.indexOf("revoke all on function public.next_return_loss_reference(uuid, text) from public;"));
        expect(lockdown).not.toMatch(/execute\s+(format\s*)?\(/i);
      });

      it("never names postgres (the object owner keeps EXECUTE inherently)", () => {
        const lockdown = code.slice(code.indexOf("revoke all on function public.next_return_loss_reference(uuid, text) from public;"));
        expect(lockdown).not.toMatch(/\bpostgres\b/);
      });
    });
  }

  it("6. the v3->v4 upgrade script and the canonical migration produce IDENTICAL permission outcomes (all nine)", () => {
    const canon = permOutcomes(executableCodeOnly);
    // 4 statements per function: revoke public + revoke anon + revoke authenticated + grant service_role
    expect(canon.length).toBe(SIGNATURES.length * 4);
    expect(permOutcomes(v3v4)).toEqual(canon);
  });

  it("6. the v2->v3 upgrade script's permission outcomes are a strict subset of canonical (its eight functions only)", () => {
    const canon = new Set(permOutcomes(executableCodeOnly));
    const v2v3Outcomes = permOutcomes(v2v3);
    expect(v2v3Outcomes.length).toBe((SIGNATURES.length - 1) * 4);
    for (const stmt of v2v3Outcomes) expect(canon.has(stmt)).toBe(true);
  });

  it("6. the pre-migration backup folder's upgrade-v2-to-v3.sql (while present) matches the v2->v3 outcomes", () => {
    const p = "C:/Users/arams/Documents/Supabase Backups/purchase-logger-before-returns-migration-2026-09-02-0948/upgrade-v2-to-v3.sql";
    if (!existsSync(p)) return; // the backup folder is transient; skip once gone
    const backupCodeOnly = readFileSync(p, "utf8").replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    expect(permOutcomes(backupCodeOnly)).toEqual(permOutcomes(v2v3));
  });
});

describe("supabase-returns-losses.sql — v3: ledger FK behaviour matches inventory_movements_one_source", () => {
  it("7. inventory_movements parent FKs are ON DELETE RESTRICT (fresh install), never SET NULL", () => {
    expect(executableCodeOnly).toMatch(/return_record_id uuid references public\.return_records \(id\) on delete restrict/);
    expect(executableCodeOnly).toMatch(/loss_record_id uuid references public\.loss_records \(id\) on delete restrict/);
    expect(executableCodeOnly).not.toMatch(/return_record_id uuid references public\.return_records \(id\) on delete set null/);
    expect(executableCodeOnly).not.toMatch(/loss_record_id uuid references public\.loss_records \(id\) on delete set null/);
  });

  it("7. an existing SET NULL definition is converted to RESTRICT idempotently (confdeltype 'n' guard)", () => {
    expect(executableCodeOnly).toContain("and confdeltype = 'n'");
    expect(executableCodeOnly).toContain("add constraint inventory_movements_return_record_id_fkey");
    expect(executableCodeOnly).toContain("references public.return_records (id) on delete restrict;");
    expect(executableCodeOnly).toContain("add constraint inventory_movements_loss_record_id_fkey");
    expect(executableCodeOnly).toContain("references public.loss_records (id) on delete restrict;");
  });

  it("7. the exactly-one-source CHECK is still present and unchanged", () => {
    expect(executableCodeOnly).toContain("(return_record_id is not null)::int + (loss_record_id is not null)::int = 1");
  });
});

describe("supabase-returns-losses.sql — v3: loss-creation idempotency", () => {
  it("8. loss_records carries a nullable idempotency_key (fresh install + add-column-if-not-exists for re-run)", () => {
    expect(executableCodeOnly).toMatch(/idempotency_key text,/); // inline, nullable
    expect(executableCodeOnly).toContain("alter table public.loss_records add column if not exists idempotency_key text;");
  });

  it("8/9. a PARTIAL unique index enforces one loss per (owner, key) but never constrains NULL keys, so distinct losses (distinct keys) are always allowed", () => {
    expect(executableCodeOnly).toMatch(
      /create unique index if not exists loss_records_owner_idempotency_key_uidx\s+on public\.loss_records \(owner_id, idempotency_key\)\s+where idempotency_key is not null;/,
    );
  });

  it("8. rl_apply_loss_transition create-path does `on conflict (owner_id, idempotency_key) where idempotency_key is not null do nothing` and returns the existing row (already_applied) instead of a second insert", () => {
    const fn = executableCodeOnly.slice(executableCodeOnly.indexOf("function public.rl_apply_loss_transition"));
    expect(fn).toContain("on conflict (owner_id, idempotency_key) where idempotency_key is not null do nothing");
    expect(fn).toContain("if v_id is null then");
    expect(fn).toContain("'already_applied', true");
    // the early return happens BEFORE movements/audit are applied on a retry
    const conflictIdx = fn.indexOf("on conflict (owner_id, idempotency_key)");
    const earlyReturnIdx = fn.indexOf("'already_applied', true");
    const applyMovementsIdx = fn.indexOf("perform public.rl_apply_movements");
    expect(conflictIdx).toBeLessThan(earlyReturnIdx);
    expect(earlyReturnIdx).toBeLessThan(applyMovementsIdx);
  });

  it("10. the cross-table economic-event rule stays application-enforced (findRefundNoReturnConflict*) — no fragile cross-table uniqueness was invented", () => {
    // Nothing tries to unique-index across return_records + loss_records, and
    // no partial unique on (owner_id, sales_order_id) that would block two
    // legitimately separate refund_without_return losses on one sale.
    expect(executableCodeOnly).not.toMatch(/unique index[^\n]*loss_records[^\n]*\(owner_id, sales_order_id\)/i);
    expect(executableCodeOnly).not.toMatch(/unique index[^\n]*on public\.return_records[^\n]*sales_order_id/i);
  });
});

describe("audit event types agree across SQL, TypeScript and display labels (regression 11)", () => {
  const EXPECTED_16 = [
    "record_created", "status_changed", "sale_linked", "purchase_linked",
    "quantity_changed", "amount_changed", "inventory_restored", "inventory_written_off",
    "return_completed", "outcome_selected", "return_cancelled", "record_edited",
    "record_reversed", "record_deleted", "recognition_month_changed", "sales_status_changed",
  ].sort();

  function stringSet(text: string): string[] {
    return [...new Set(text.match(/'([a-z_]+)'/g)?.map(s => s.slice(1, -1)) ?? [])].sort();
  }

  it("SQL: the v2 return_loss_audit_events_event_type_check lists exactly the 16", () => {
    const chk = executableCodeOnly.slice(
      executableCodeOnly.indexOf("return_loss_audit_events add constraint return_loss_audit_events_event_type_check check (event_type in ("),
    );
    const list = chk.slice(0, chk.indexOf("));"));
    expect(stringSet(list)).toEqual(EXPECTED_16);
  });

  it("TypeScript: ReturnLossAuditEventRow['event_type'] union is exactly the 16", () => {
    const types = readFileSync("lib/returns/types.ts", "utf8");
    const union = types.slice(types.indexOf("event_type:"), types.indexOf(";", types.indexOf("event_type:")));
    expect([...new Set(union.match(/"([a-z_]+)"/g)?.map(s => s.slice(1, -1)) ?? [])].sort()).toEqual(EXPECTED_16);
  });

  it("Display: EVENT_LABELS in RecordDetailDialog has a non-empty label for all 16", () => {
    const dlg = readFileSync("components/returns-losses/RecordDetailDialog.tsx", "utf8");
    const block = dlg.slice(dlg.indexOf("const EVENT_LABELS"), dlg.indexOf("};", dlg.indexOf("const EVENT_LABELS")));
    for (const ev of EXPECTED_16) {
      expect(block).toMatch(new RegExp(`\\b${ev}:\\s*"[^"]+"`));
    }
  });

  it("Routes: every auditEvent(\"...\") the API emits is one of the 16", () => {
    const dirs = ["app/api/returns", "app/api/losses", "lib/returns"];
    const emitted = new Set<string>();
    const walk = (p: string) => {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        const full = `${p}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          for (const m of readFileSync(full, "utf8").matchAll(/auditEvent\("([a-z_]+)"/g)) emitted.add(m[1]);
        }
      }
    };
    for (const d of dirs) walk(d);
    for (const ev of emitted) expect(EXPECTED_16).toContain(ev);
    // and every SQL-permitted event is actually reachable from code
    expect([...emitted].sort()).toEqual(EXPECTED_16);
  });
});

describe("supabase-returns-losses.sql — v3: preserved guarantees (regression 12)", () => {
  it("still additive at APPLY time — no data-touching DDL was introduced by the corrections", () => {
    for (const forbidden of [/\balter table public\.purchases\b/i, /\balter table public\.expenses\b/i, /\balter table public\.sales_orders\b/i, /\balter table public\.sale_items\b/i, /\bdelete from\b/i, /\btruncate\b/i]) {
      expect(executableDdlOnly).not.toMatch(forbidden);
    }
  });
  it("still one transaction, still every DDL guarded for re-run", () => {
    expect(codeOnly.split("\n")[0]).toBe("begin;");
    expect(codeOnly.split("\n").at(-1)).toBe("commit;");
    expect(executableCodeOnly).not.toMatch(/\bcreate table(?! if not exists)/i);
    expect(executableCodeOnly).not.toMatch(/\bcreate (unique )?index(?! if not exists)/i);
  });
  it("money stays numeric(10,2) — the corrections added no float/real/double column", () => {
    expect(executableCodeOnly).not.toMatch(/\b(real|double precision|float4|float8)\b/i);
    expect(executableCodeOnly).toMatch(/idempotency_key text/); // the one added column is text, not numeric — fine
  });
});

// ===========================================================================
// v4 — active-return accounting stored at create, + safe cancelled-sale purge
// ===========================================================================
describe("supabase-returns-losses.sql — v4: rl_create_return stores the active return's accounting", () => {
  const fn = executableCodeOnly.slice(
    executableCodeOnly.indexOf("create or replace function public.rl_create_return("),
    executableCodeOnly.indexOf("end $$;", executableCodeOnly.indexOf("create or replace function public.rl_create_return(")),
  );

  it("inserts the six money columns from p_return, each coalesced to 0 (older callers / re-runs unaffected)", () => {
    for (const col of ["original_sale_revenue", "original_sale_profit", "original_stock_cost",
      "revenue_reversed", "profit_reversed", "net_profit_impact"]) {
      expect(fn).toContain(col);
      expect(fn).toMatch(new RegExp(`coalesce\\(\\(p_return->>'${col}'\\)::numeric, 0\\)`));
    }
  });

  it("still creates as 'return_started' and still links the sale + audits", () => {
    expect(fn).toContain("'return_started'");
    expect(fn).toContain("update public.sales_orders set process_status = p_sale_process_status");
    expect(fn).toContain("perform public.rl_add_audit(p_owner_id, v_id, null, p_audit)");
  });
});

describe("supabase-returns-losses.sql — v4: rl_purge_deletable_sale", () => {
  const fn = executableCodeOnly.slice(
    executableCodeOnly.indexOf("create or replace function public.rl_purge_deletable_sale("),
    executableCodeOnly.indexOf("end $$;", executableCodeOnly.indexOf("create or replace function public.rl_purge_deletable_sale(")),
  );

  it("refuses a still-completed sale, and locks each sale FOR UPDATE first", () => {
    expect(fn).toContain("select status into v_status from public.sales_orders");
    expect(fn).toContain("for update");
    expect(fn).toContain("if v_status = 'completed' then raise exception 'sale_still_active'");
  });

  it("refuses while a genuinely ACTIVE return (not cancelled, not soft-deleted) owns the sale", () => {
    expect(fn).toMatch(/from public\.return_records\s+where sales_order_id = v_id[\s\S]*?deleted_at is null and workflow_status <> 'return_cancelled'/);
    expect(fn).toContain("raise exception 'active_return_blocks_delete'");
  });

  it("refuses while a non-deleted loss owns the sale", () => {
    expect(fn).toContain("raise exception 'active_loss_blocks_delete'");
  });

  it("removes the ledger rows explicitly IN dependency order (movements -> returns -> sale), keeping RESTRICT FKs intact", () => {
    const mv = fn.indexOf("delete from public.inventory_movements where return_record_id = any(v_ret_ids)");
    const rr = fn.indexOf("delete from public.return_records where id = any(v_ret_ids)");
    const so = fn.indexOf("delete from public.sales_orders where id = v_id");
    expect(mv).toBeGreaterThan(-1);
    expect(mv).toBeLessThan(rr);
    expect(rr).toBeLessThan(so);
  });

  it("DETACHES (never deletes) a soft-deleted loss still pointing at the sale", () => {
    expect(fn).toMatch(/update public\.loss_records set sales_order_id = null[\s\S]*?deleted_at is not null/);
    expect(fn).not.toMatch(/delete from public\.loss_records/);
  });

  it("is plpgsql, pins search_path, uses no dynamic SQL", () => {
    const header = executableCodeOnly.slice(
      executableCodeOnly.indexOf("create or replace function public.rl_purge_deletable_sale("),
      executableCodeOnly.indexOf("$$", executableCodeOnly.indexOf("create or replace function public.rl_purge_deletable_sale(")),
    );
    expect(header).toMatch(/language plpgsql set search_path = public, pg_temp/);
    expect(fn).not.toMatch(/execute\s+(format\s*)?\(/i);
  });
});

describe("supabase-returns-losses-v3-to-v4-upgrade.sql — narrow, additive, one transaction", () => {
  const v3v4Full = readFileSync("supabase-returns-losses-v3-to-v4-upgrade.sql", "utf8").replace(/\r\n/g, "\n");
  const code = v3v4Full.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const codeTrimmed = code.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  const ddl = ddlOnly(code);

  it("wraps everything in one begin; ... commit;", () => {
    expect(codeTrimmed.split("\n")[0]).toBe("begin;");
    expect(codeTrimmed.split("\n").at(-1)).toBe("commit;");
  });

  it("contains NO schema/column/constraint change — only create-or-replace function + guarded grants", () => {
    expect(ddl).not.toMatch(/\balter table\b/i);
    expect(ddl).not.toMatch(/\bcreate table\b/i);
    expect(ddl).not.toMatch(/\bdrop (table|constraint|index)\b/i);
    expect(ddl).not.toMatch(/\bcreate (unique )?index\b/i);
    // no APPLY-time data touch
    for (const forbidden of [/\balter table public\.(purchases|expenses|sales_orders|sale_items)\b/i, /\bdelete from\b/i, /\btruncate\b/i]) {
      expect(ddl).not.toMatch(forbidden);
    }
  });

  it("replaces rl_create_return with the money-storing body (byte-identical to canonical)", () => {
    const grab = (src: string) => src.slice(
      src.indexOf("create or replace function public.rl_create_return("),
      src.indexOf("end $$;", src.indexOf("create or replace function public.rl_create_return(")) + "end $$;".length,
    );
    expect(grab(v3v4Full)).toBe(grab(migration));
  });

  it("adds rl_purge_deletable_sale with a body byte-identical to canonical", () => {
    const grab = (src: string) => src.slice(
      src.indexOf("create or replace function public.rl_purge_deletable_sale("),
      src.indexOf("end $$;", src.indexOf("create or replace function public.rl_purge_deletable_sale(")) + "end $$;".length,
    );
    expect(grab(v3v4Full)).toBe(grab(migration));
  });
});
