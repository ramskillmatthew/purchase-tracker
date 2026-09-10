// eBay Seller Hub extension drafter — structural tests over the migration
// SQL's own TEXT. This environment has no way to execute DDL or run
// PL/pgSQL against a real Postgres instance (established earlier in this
// project: only PostgREST REST access is available). These tests cannot
// prove the SQL behaves correctly when actually run — only that the exact
// safety-relevant patterns the review required are genuinely present, in
// the right relative order, in the file that would be applied. Genuine
// behavioural confirmation requires the user to apply this migration and
// exercise it themselves (see the final report's own permission-verifier
// query and manual-check suggestions).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase-ebay-extension-batches.sql", "utf8");
const fnStart = sql.indexOf("create or replace function public.listing_studio_create_ebay_extension_batch");
const fnBody = sql.slice(fnStart, sql.indexOf("\n$$;", fnStart));

describe("eBay extension batch migration — Defect 1 (inconsistent empty batches) fix", () => {
  it("rejects a null or empty marketplace-draft-id array before touching any table", () => {
    expect(fnBody).toMatch(/p_marketplace_draft_ids is null or array_length\(p_marketplace_draft_ids, 1\) is null/);
    expect(fnBody).toContain("NO_DRAFTS");
  });

  it("rejects anything other than exactly one id", () => {
    expect(fnBody).toMatch(/array_length\(p_marketplace_draft_ids, 1\) <> 1/);
    expect(fnBody).toContain("EXACTLY_ONE_DRAFT_REQUIRED");
  });

  it("rejects duplicate ids (defensive, for a future multi-item relaxation)", () => {
    expect(fnBody).toContain("DUPLICATE_DRAFT_IDS");
    expect(fnBody).toMatch(/count\(distinct x\)/);
  });

  it("REQUIREMENT: validates and LOCKS the exact eligible row (exists, owner, EBAY_UK) BEFORE the parent batch is ever inserted", () => {
    const lockIdx = fnBody.indexOf("for update");
    const parentInsertIdx = fnBody.indexOf("insert into public.ebay_extension_batches");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(parentInsertIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(parentInsertIdx);
    // The eligibility check covers existence, owner, and marketplace in one query
    const checkStart = fnBody.indexOf("select md.product_draft_id into v_product_draft_id");
    const checkBody = fnBody.slice(checkStart, fnBody.indexOf("for update", checkStart) + 10);
    expect(checkBody).toContain("md.owner_id = p_owner_id");
    expect(checkBody).toContain("md.marketplace = 'EBAY_UK'");
    expect(fnBody).toContain("DRAFT_NOT_ELIGIBLE");
  });

  it("REQUIREMENT: the child item is inserted with a single-row INSERT ... VALUES, never INSERT ... SELECT (the exact shape that let the original defect insert fewer rows than the parent claimed)", () => {
    const itemsInsertIdx = fnBody.indexOf("insert into public.ebay_extension_batch_items");
    const itemsInsertStatement = fnBody.slice(itemsInsertIdx, fnBody.indexOf(";", itemsInsertIdx));
    expect(itemsInsertStatement).toContain("values (v_batch_id, v_marketplace_draft_id, v_product_draft_id, 0)");
    expect(itemsInsertStatement).not.toMatch(/insert into public\.ebay_extension_batch_items[^;]*select/i);
  });

  it("REQUIREMENT: verifies the inserted count and RAISES (rolling back the whole transaction, parent included) if it doesn't equal the requested count", () => {
    expect(fnBody).toContain("get diagnostics v_inserted_count = row_count");
    expect(fnBody).toMatch(/if v_inserted_count <> 1 then\s*raise exception 'ITEM_INSERT_MISMATCH'/);
  });
});

describe("eBay extension batch migration — Defect 2 (duplicate form risk) fix", () => {
  it("REQUIREMENT: the conflict query no longer excludes 'waiting_for_review' — only 'failed' and 'cancelled' end an item's protection", () => {
    const conflictIdx = fnBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft");
    const conflictQuery = fnBody.slice(conflictIdx, fnBody.indexOf("limit 1", conflictIdx) + 7);
    expect(conflictQuery).toContain("bi.status not in ('failed', 'cancelled')");
    expect(conflictQuery).not.toContain("waiting_for_review");
  });

  it("REQUIREMENT: a database-level partial unique index independently prevents one marketplace_draft_id from appearing in more than one LIVE batch item, regardless of the RPC's own logic", () => {
    const idxStart = sql.indexOf("create unique index if not exists ebay_extension_batch_items_live_draft_idx");
    expect(idxStart).toBeGreaterThan(-1);
    const idxStatement = sql.slice(idxStart, sql.indexOf(";", idxStart));
    expect(idxStatement).toContain("on public.ebay_extension_batch_items (marketplace_draft_id)");
    expect(idxStatement).toContain("where status not in ('failed', 'cancelled')");
  });

  it("STRUCTURAL: the partial unique index is declared, and 'waiting_for_review' is absent from its exclusion list (i.e. treated as live)", () => {
    const idxStart = sql.indexOf("ebay_extension_batch_items_live_draft_idx (");
    const nextParen = sql.indexOf(")", sql.indexOf("where status not in", idxStart));
    const predicate = sql.slice(sql.indexOf("where status not in", idxStart), nextParen + 1);
    expect(predicate).not.toContain("waiting_for_review");
  });
});

describe("eBay extension batch migration — additional validation (review requirement)", () => {
  it("rejects a null owner id, a null/empty pairing-code hash, and a non-future or too-distant expiry", () => {
    expect(fnBody).toContain("OWNER_ID_REQUIRED");
    expect(fnBody).toContain("PAIRING_CODE_HASH_REQUIRED");
    expect(fnBody).toMatch(/length\(btrim\(p_pairing_code_hash\)\) = 0/);
    expect(fnBody).toContain("EXPIRY_MUST_BE_FUTURE");
    expect(fnBody).toContain("EXPIRY_TOO_FAR_IN_FUTURE");
    expect(fnBody).toMatch(/p_expires_at > now\(\) \+ interval '1 hour'/);
  });

  it("never includes the conflicting draft id (or any other potentially owner-identifying detail) in a raised exception's message", () => {
    const raiseLines = fnBody.match(/raise exception[^;]*;/g) ?? [];
    for (const line of raiseLines) expect(line).not.toContain("v_conflicting_draft");
  });

  it("display-number allocation happens under the SAME owner-scoped advisory lock as the rest of the function (safe under concurrency)", () => {
    const lockIdx = fnBody.indexOf("pg_advisory_xact_lock");
    const displayNumberIdx = fnBody.indexOf("v_display_number integer;");
    expect(lockIdx).toBeGreaterThan(-1);
    const allocationIdx = fnBody.indexOf("into v_display_number");
    expect(allocationIdx).toBeGreaterThan(lockIdx);
  });

  it("REQUIREMENT: service_role alone can execute the function — anon/authenticated are explicitly revoked", () => {
    const grantBlock = sql.slice(sql.indexOf("revoke all on function public.listing_studio_create_ebay_extension_batch"));
    expect(grantBlock).toContain("revoke all on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) from anon, authenticated");
    expect(grantBlock).toContain("grant execute on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) to service_role");
  });

  it("REQUIREMENT: anon/authenticated cannot read either table directly", () => {
    expect(sql).toContain("revoke all on public.ebay_extension_batches from anon, authenticated");
    expect(sql).toContain("revoke all on public.ebay_extension_batch_items from anon, authenticated");
  });

  it("the standalone permission verifier checks both table-select privileges, not just the function's own execute privilege", () => {
    const verifier = sql.slice(sql.indexOf("READ-ONLY PERMISSION VERIFIER"));
    expect(verifier).toContain("has_table_privilege('anon', 'public.ebay_extension_batches'");
    expect(verifier).toContain("has_table_privilege('authenticated', 'public.ebay_extension_batches'");
    expect(verifier).toContain("has_table_privilege('anon', 'public.ebay_extension_batch_items'");
    expect(verifier).toContain("has_table_privilege('authenticated', 'public.ebay_extension_batch_items'");
  });

  it("the whole function body sits under ONE owner-scoped advisory lock — genuinely atomic under concurrent calls for the same owner (Postgres's own single-transaction-per-function-call semantics, combined with the lock, serialize every create-batch call for one owner; the partial unique index above is the independent backstop that holds even across owners or a bypass of this function entirely)", () => {
    expect(fnBody).toContain("perform pg_advisory_xact_lock(hashtext(p_owner_id::text))");
  });

  it("documents the ON DELETE CASCADE decision explicitly rather than leaving it unexplained", () => {
    expect(sql).toContain("ON DELETE CASCADE decision (review requirement");
  });
});

describe("eBay extension batch migration — application-layer half of Defect 2's fix", () => {
  it("REQUIREMENT: a batch is only auto-marked 'completed' once every item is failed/cancelled — never merely because one reached waiting_for_review", async () => {
    const schema = await import("@/lib/listing-studio/ebay-extension-batch-schema");
    expect(schema.isEbayExtensionBatchClosingItemStatus("waiting_for_review")).toBe(false);
    expect(schema.isEbayExtensionBatchClosingItemStatus("failed")).toBe(true);
    expect(schema.isEbayExtensionBatchClosingItemStatus("cancelled")).toBe(true);
    expect(schema.isEbayExtensionBatchClosingItemStatus("queued")).toBe(false);
  });

  it("STRUCTURAL: the item-result route uses isEbayExtensionBatchClosingItemStatus for its batch-completion check, never the broader isTerminalEbayExtensionItemStatus", () => {
    const source = readFileSync("app/api/extension/ebay-batch/items/[itemId]/result/route.ts", "utf8");
    const checkIdx = source.indexOf("allItems.every(");
    const checkLine = source.slice(checkIdx, source.indexOf(")", checkIdx) + 1);
    expect(checkLine).toContain("isEbayExtensionBatchClosingItemStatus");
    expect(checkLine).not.toContain("isTerminalEbayExtensionItemStatus");
  });
});
