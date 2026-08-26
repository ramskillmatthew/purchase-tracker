import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// supabase-purchase-category-v2.sql is a checked-in, NOT-YET-RUN migration —
// asserted structurally (it's SQL, not something vitest can execute against
// a real database), following the same source-text pattern used in
// tests/purchase-import-migration.test.ts and tests/sales-migration.test.ts.
const migration = readFileSync("supabase-purchase-category-v2.sql", "utf8").replace(/\r\n/g, "\n");

describe("supabase-purchase-category-v2.sql — idempotent and safe to re-run", () => {
  it("is wrapped in one explicit transaction", () => {
    const codeOnly = migration.split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join("\n");
    expect(codeOnly.split("\n")[0]).toBe("begin;");
    const lines = codeOnly.split("\n");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("documents that it requires supabase-purchase-category.sql to have already run", () => {
    expect(migration).toContain("REQUIRES supabase-purchase-category.sql");
  });

  it("finds the existing category constraint BY CONTENT rather than a guessed name, mirroring supabase-investments.sql's own corrected pattern", () => {
    expect(migration).toContain("pg_constraint");
    expect(migration).toContain("pg_get_constraintdef(con.oid) ilike '%category%'");
    expect(migration).toContain("execute format('alter table public.purchases drop constraint %I', existing_constraint);");
  });

  it("migrates any casing/whitespace variant of Lorcana to Non-Pokémon TCG", () => {
    expect(migration).toContain("set category = 'Non-Pokémon TCG'");
    expect(migration).toContain("where lower(trim(category)) = 'lorcana';");
  });

  it("REQUIREMENT: anything else unrecognized safely defaults to Other, never guessed into a specific category", () => {
    expect(migration).toContain("set category = 'Other'");
    expect(migration).toContain("category is distinct from 'Pokémon'");
    expect(migration).toContain("category is distinct from 'Non-Pokémon TCG'");
  });

  it("REQUIREMENT: the final constraint holds exactly the new five-value cumulative list", () => {
    expect(migration).toContain("check (category in ('Pokémon', 'Non-Pokémon TCG', 'Clothing', 'Footwear', 'Other'));");
  });

  it("data migration (Steps 2-3) happens before the new constraint is added (Step 4) — otherwise the ADD CONSTRAINT would fail on any still-nonconforming row", () => {
    const lorcanaIdx = migration.indexOf("set category = 'Non-Pokémon TCG'");
    const otherIdx = migration.indexOf("set category = 'Other'");
    const constraintIdx = migration.indexOf("add constraint purchases_category_check");
    expect(lorcanaIdx).toBeGreaterThan(-1);
    expect(otherIdx).toBeGreaterThan(-1);
    expect(constraintIdx).toBeGreaterThan(-1);
    expect(lorcanaIdx).toBeLessThan(constraintIdx);
    expect(otherIdx).toBeLessThan(constraintIdx);
  });

  it("never touches an investment table", () => {
    const codeOnly = migration.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");
    expect(codeOnly).not.toMatch(/investment_/i);
  });

  it("never drops or recreates public.purchases, and never deletes rows", () => {
    expect(migration).not.toMatch(/drop table/i);
    expect(migration).not.toMatch(/delete from/i);
  });
});
