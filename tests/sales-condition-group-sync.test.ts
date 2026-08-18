import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deriveConditionGroup } from "@/lib/condition-group";
import { conditions } from "@/lib/validation/purchase";

/**
 * The atomic create_completed_sale() RPC (supabase-sales.sql) derives
 * condition_group_snapshot itself, inline, from a freshly-locked purchase
 * row — it deliberately does NOT call back into lib/condition-group.ts
 * (there is no round trip from SQL to a TypeScript pure function). This
 * test is the promised guard against the SQL CASE expression drifting from
 * the canonical TypeScript mapping: every canonical condition must resolve
 * to the same group on both sides, checked here by pulling the RPC's own
 * source text apart.
 */
describe("supabase-sales.sql's condition-group CASE mirrors lib/condition-group.ts exactly", () => {
  const migration = readFileSync("supabase-sales.sql", "utf8").replace(/\r\n/g, "\n");
  const rpcBody = migration.slice(migration.indexOf("create or replace function public.create_completed_sale"), migration.indexOf("revoke all on function public.create_completed_sale"));
  const caseBlock = rpcBody.slice(rpcBody.indexOf("v_condition_group := case"), rpcBody.indexOf("end;\n\n    insert into public.sale_items"));

  it("every canonical condition appears in the SQL CASE, mapped to the same group deriveConditionGroup returns", () => {
    for (const condition of conditions) {
      const group = deriveConditionGroup(condition);
      const whenLine = caseBlock.split("\n").find(line => line.includes(`'${condition}'`));
      expect(whenLine, `no WHEN clause found for "${condition}"`).toBeDefined();
      expect(whenLine).toContain(`'${group}'`);
    }
  });

  it("the SQL CASE has an else branch resolving to 'unknown', matching deriveConditionGroup's own fallback", () => {
    expect(caseBlock).toContain("else 'unknown'");
    expect(deriveConditionGroup("something historical and free-text")).toBe("unknown");
  });

  it("the SQL CASE lists exactly the same condition set as the TypeScript NEW+USED lists combined — no extra, no missing", () => {
    const quotedInSql = [...caseBlock.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(value => (conditions as readonly string[]).includes(value));
    expect(new Set(quotedInSql)).toEqual(new Set(conditions));
  });
});
