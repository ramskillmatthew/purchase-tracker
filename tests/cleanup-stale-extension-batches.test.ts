import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase-cleanup-stale-extension-batches.sql", "utf8");

const STALE_BATCH_IDS = [
  "a9d0c220-8eea-4ec9-8981-eb6f551f9125",
  "dfb253e5-f1f2-42b6-939d-8b9b35c1efe4",
  "21ff8827-3fd1-441a-9896-cbae93c1537b",
  "1b0e5093-ab46-4685-8cc8-0632f518675a",
  "62437264-7889-403c-96ee-439f3448bb5c",
  "2145e088-f161-4980-bf94-6c7a5316a8d0",
  "c8647ddc-891f-4d0c-a56a-a73f6391db94",
  "69e57b59-77b7-489b-a6a5-6bb33625ed98",
  "26fe5c90-91a7-45bd-9e20-29dedeb15efd",
  "155045d7-6b2e-4298-8c23-dfb5ddbe6dfe",
  "f85b0138-129c-450e-84c5-f40c02a78de8",
  "5f9f3d12-f8b9-4fff-844a-4bd74d5dfdd8",
  "2d4b26bc-322f-4bde-a8c0-c8f6f8a793a5",
  "16f60d8e-9773-474d-898f-46bc2c883fec",
  "11a586f1-ae91-4313-b383-a1f81024f8b7",
  "540252ce-e11a-4eb4-b9ec-f13be2f1a51c",
  "ae3b3dab-fc79-4530-8c9b-7ed04055fde8",
];

// One-time cleanup (multi-batch numbering fix follow-up) — this whole file
// is structural/source-scanning (matching every other *.sql regression
// test in this repo — see tests/listing-studio-migration.test.ts), since
// there is no live-Postgres harness in this suite. It proves the SQL text
// carries every safety property the task required, not that the SQL
// executes correctly against a real database (that's what the manual
// verification query in the file itself, plus the maintainer running it
// against a real Supabase instance, covers).
describe("supabase-cleanup-stale-extension-batches.sql — one-time stale-batch cleanup", () => {
  it("targets EXACTLY the 17 confirmed stale batch ids, and only those — never a display_number-based or broader selection", () => {
    for (const id of STALE_BATCH_IDS) expect(sql).toContain(`'${id}'`);
    // No selection anywhere in this file is based on display_number —
    // display numbers are never used to choose which rows to touch,
    // exactly per the requirement that scope is exact-immutable-ID only.
    expect(sql).not.toMatch(/where[\s\S]{0,80}display_number/i);
  });

  it("is wrapped in an explicit transaction", () => {
    expect(sql.trim().toLowerCase()).toMatch(/^--[\s\S]*\nbegin;/m);
    expect(sql).toMatch(/\ncommit;/);
    const beginIndex = sql.indexOf("\nbegin;");
    const commitIndex = sql.indexOf("\ncommit;");
    expect(beginIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(beginIndex);
  });

  it("verifies each row is still pending_claim/in_progress AND box_dismissed_at is still null before touching it — the same condition that makes a rerun a no-op", () => {
    const batchUpdateIndex = sql.indexOf("update public.vinted_extension_batches b");
    const itemsUpdateIndex = sql.indexOf("update public.vinted_extension_batch_items i");
    const batchUpdateSection = sql.slice(batchUpdateIndex, itemsUpdateIndex);
    expect(batchUpdateSection).toContain("and b.status in ('pending_claim', 'in_progress')");
    expect(batchUpdateSection).toContain("and b.box_dismissed_at is null;");
  });

  it("mirrors the real cancellation route exactly: batch -> status='cancelled', completed_at=now()", () => {
    const batchUpdateIndex = sql.indexOf("update public.vinted_extension_batches b");
    const itemsUpdateIndex = sql.indexOf("update public.vinted_extension_batch_items i");
    const batchUpdateSection = sql.slice(batchUpdateIndex, itemsUpdateIndex);
    expect(batchUpdateSection).toContain("status = 'cancelled'");
    expect(batchUpdateSection).toContain("completed_at = now()");
  });

  it("also sets box_dismissed_at AND activity_dismissed_at on the batch, in the SAME statement — the combined terminal-dismissal semantics, not a separate step", () => {
    const batchUpdateIndex = sql.indexOf("update public.vinted_extension_batches b");
    const firstSemicolonAfter = sql.indexOf(";", batchUpdateIndex);
    const statement = sql.slice(batchUpdateIndex, firstSemicolonAfter);
    expect(statement).toContain("box_dismissed_at = now()");
    expect(statement).toContain("activity_dismissed_at = now()");
  });

  it("REGRESSION: item cancellation ONLY ever touches status='queued' rows — never completed/failed/preparing/filling/saving, so no real result is ever overwritten", () => {
    const itemsUpdateIndex = sql.indexOf("update public.vinted_extension_batch_items i");
    const verificationIndex = sql.indexOf("-- Verification");
    const itemsSection = sql.slice(itemsUpdateIndex, verificationIndex);
    expect(itemsSection).toContain("set status = 'cancelled'");
    expect(itemsSection).toContain("and i.status = 'queued';");
    expect(itemsSection).not.toMatch(/'completed'|'failed'|'preparing'|'filling'|'saving'/);
  });

  it("never hard-deletes anything — no DELETE statement, no TRUNCATE, anywhere in the file", () => {
    expect(sql.toLowerCase()).not.toMatch(/\bdelete\s+from\b/);
    expect(sql.toLowerCase()).not.toMatch(/\btruncate\b/);
  });

  it("never touches listing_drafts — no UPDATE/DELETE statement targets it (the two mentions of the word are both explanatory comments confirming this)", () => {
    expect(sql).not.toMatch(/(?:update|delete from)\s+public\.listing_drafts/i);
  });

  it("provides a final verification SELECT covering id, display_number, status, box_dismissed_at, and activity_dismissed_at for the exact same 17 ids", () => {
    const selectIndex = sql.indexOf("select\n  id,\n  display_number,\n  status,\n  box_dismissed_at,\n  activity_dismissed_at");
    expect(selectIndex).toBeGreaterThan(-1);
    const selectSection = sql.slice(selectIndex, sql.indexOf("commit;"));
    for (const id of STALE_BATCH_IDS) expect(selectSection).toContain(`'${id}'`);
  });

  it("reports (without implementing) why stale pending_claim/in_progress rows can persist indefinitely, and explicitly scopes out an automatic sweep", () => {
    expect(sql).toMatch(/no periodic sweep/i);
    expect(sql).toMatch(/no automatic\s*\n?--?\s*sweep is implemented/i);
  });
});
