import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("email_index_coverage migration is safe to run against an existing database", () => {
  const migration = read("supabase-email-index-partial-status.sql");

  it("widens the status check constraint idempotently, tolerating an earlier partial run", () => {
    expect(migration).toContain("drop constraint if exists email_index_coverage_status_check");
    expect(migration).toContain("check (status in ('running', 'completed', 'failed', 'partial'))");
  });

  it("resets any 'running' row before consolidation, so a stale lock can never outrank a real completed/partial row", () => {
    const resetIndex = migration.indexOf("set status = 'failed'");
    const dedupIndex = migration.indexOf("with ranked as");
    expect(resetIndex).toBeGreaterThan(-1);
    expect(dedupIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeLessThan(dedupIndex); // reset happens before consolidation, not after
  });

  it("consolidates duplicate (owner_id, range_start, range_end) rows before adding the uniqueness guarantee", () => {
    const dedupIndex = migration.indexOf("with ranked as");
    const constraintIndex = migration.indexOf("email_index_coverage_owner_range_unique");
    expect(dedupIndex).toBeGreaterThan(-1);
    expect(constraintIndex).toBeGreaterThan(-1);
    expect(dedupIndex).toBeLessThan(constraintIndex); // dedup happens before the constraint that would otherwise fail on duplicates
  });

  it("ranks completed above partial above failed/running when choosing which duplicate row survives", () => {
    expect(migration).toContain("case status when 'completed' then 3 when 'partial' then 2 else 1 end desc");
  });

  it("breaks ties within the same status tier by recency, favoring completed_at with a created_at fallback", () => {
    expect(migration).toContain("coalesce(completed_at, created_at) desc");
  });

  it("only deletes rows that lost the ranking, never the winner", () => {
    expect(migration).toContain("where id in (select id from ranked where rank > 1)");
  });

  it("adds the new unique constraint idempotently, tolerating a rerun after it already succeeded", () => {
    expect(migration).toContain("if not exists (select 1 from pg_constraint where conname = 'email_index_coverage_owner_range_unique')");
  });
});
