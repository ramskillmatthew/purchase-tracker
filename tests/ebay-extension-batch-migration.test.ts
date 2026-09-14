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
    expect(itemsInsertStatement).toContain("values (v_batch_id, v_marketplace_draft_id, v_product_draft_id, 0, v_retry_of_item_id)");
    expect(itemsInsertStatement).not.toMatch(/insert into public\.ebay_extension_batch_items[^;]*select/i);
  });

  it("REQUIREMENT: verifies the inserted count and RAISES (rolling back the whole transaction, parent included) if it doesn't equal the requested count", () => {
    expect(fnBody).toContain("get diagnostics v_inserted_count = row_count");
    expect(fnBody).toMatch(/if v_inserted_count <> 1 then\s*raise exception 'ITEM_INSERT_MISMATCH'/);
  });
});

describe("eBay extension batch migration — Defect 2 (duplicate form risk) fix", () => {
  it("REQUIREMENT: the conflict query no longer excludes 'waiting_for_review' — only 'failed' and 'cancelled' end an item's protection", () => {
    // CORRECTIVE PASS (blocking-batch visibility review) — this exact
    // boolean now lives in ONE place, listing_studio_is_ebay_extension_item_active
    // (see that describe block's own "defines 'active'" test), which the
    // conflict query below calls rather than re-deriving inline. This test
    // still proves the SAME substantive requirement: the conflict query
    // itself never excludes 'waiting_for_review' from blocking a new send.
    const conflictIdx = fnBody.indexOf("select bi.marketplace_draft_id, b.id into v_conflicting_draft, v_conflicting_batch_id");
    const conflictQuery = fnBody.slice(conflictIdx, fnBody.indexOf("limit 1", conflictIdx) + 7);
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(conflictQuery).toContain("public.listing_studio_is_ebay_extension_item_active(b.status, bi.status)");
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

  it("STRUCTURAL (CORRECTIVE PASS 4): the item-result route no longer performs its own batch-completion check at all — that logic, and its own only-failed/cancelled-close discipline, now live inside listing_studio_report_ebay_extension_item_result (see the lifecycle test file's own coverage of that RPC's SQL text)", () => {
    const source = readFileSync("app/api/extension/ebay-batch/items/[itemId]/result/route.ts", "utf8");
    expect(source).not.toContain("allItems.every(");
    expect(source).not.toContain("isEbayExtensionBatchClosingItemStatus");
    expect(source).not.toContain("isTerminalEbayExtensionItemStatus");
    // It calls the RPC, not any direct table read/write of its own.
    expect(source).toContain("rpc/listing_studio_report_ebay_extension_item_result");
    expect(source).not.toMatch(/supabaseRequestAll/);
  });
});

// ---- CORRECTIVE PASS 6 (retry truthfulness review) -------------------------
//
// A real retry is a FRESH batch and a FRESH ebay_extension_batch_items row,
// created through the authenticated app's existing create-batch flow — the
// old failed row is retained, immutable history, never reset or
// overwritten. Attempt lineage (retry_of_item_id) is derived entirely
// server-side by the create RPC itself: the most recent genuinely 'failed'
// item for this owner+listing, if any. See this file's own top comment.
describe("retry truthfulness review — the retry_of_item_id lineage column", () => {
  it("exists on ebay_extension_batch_items, nullable, referencing the same table, ON DELETE SET NULL (never CASCADE — the new row must never be deleted just because its ancestor was)", () => {
    const colIdx = sql.indexOf("retry_of_item_id uuid");
    expect(colIdx).toBeGreaterThan(-1);
    const colBlock = sql.slice(colIdx, sql.indexOf(",", sql.indexOf("on delete set null", colIdx)));
    expect(colBlock).toContain("references public.ebay_extension_batch_items (id)");
    expect(colBlock).toContain("on delete set null");
    expect(colBlock).not.toContain("on delete cascade");
  });
});

describe("retry truthfulness review — the create RPC derives lineage itself, server-side only", () => {
  it("returns retry_of_item_id in its RETURNS TABLE — never accepted as an input parameter (a caller can never claim false lineage)", () => {
    const signatureIdx = sql.indexOf("create or replace function public.listing_studio_create_ebay_extension_batch(");
    const returnsIdx = sql.indexOf("returns table(", signatureIdx);
    const paramList = sql.slice(signatureIdx, sql.indexOf(")", sql.indexOf("uuid[]", signatureIdx)) + 1);
    const returnsList = sql.slice(returnsIdx, sql.indexOf(")", returnsIdx));
    expect(paramList).not.toContain("retry_of_item_id");
    expect(paramList).not.toContain("p_retry_of_item_id");
    expect(returnsList).toContain("retry_of_item_id uuid");
  });

  it("REQUIREMENT: matches only a genuinely 'failed' prior item for THIS owner and THIS exact listing — never 'cancelled' (an explicit cancel is not a failure), never another owner's item", () => {
    const lookupIdx = fnBody.indexOf("select bi.id into v_retry_of_item_id");
    const lookupEnd = fnBody.indexOf("limit 1;", lookupIdx) + "limit 1;".length;
    expect(lookupIdx).toBeGreaterThan(-1);
    const lookup = fnBody.slice(lookupIdx, lookupEnd);
    expect(lookup).toContain("bi.marketplace_draft_id = v_marketplace_draft_id");
    expect(lookup).toContain("b.owner_id = p_owner_id");
    expect(lookup).toContain("bi.status = 'failed'");
    expect(lookup).not.toContain("cancelled");
    expect(lookup).toContain("order by b.created_at desc");
  });

  it("REQUIREMENT: the lineage lookup runs AFTER the conflict check (so it only ever executes once this send is genuinely eligible) and under the SAME owner-scoped advisory lock as everything else — a double-click retry is serialized exactly like any other create-batch call, never able to compute lineage from a half-finished concurrent create", () => {
    const advisoryLockIdx = fnBody.indexOf("pg_advisory_xact_lock");
    const conflictIdx = fnBody.indexOf("DRAFT_ALREADY_IN_ACTIVE_BATCH");
    const lookupIdx = fnBody.indexOf("select bi.id into v_retry_of_item_id");
    const insertIdx = fnBody.indexOf("insert into public.ebay_extension_batch_items");
    expect(advisoryLockIdx).toBeGreaterThan(-1);
    expect(advisoryLockIdx).toBeLessThan(conflictIdx);
    expect(conflictIdx).toBeLessThan(lookupIdx);
    expect(lookupIdx).toBeLessThan(insertIdx);
  });

  it("REQUIREMENT: the old row is only ever READ for lineage — never written to. The create RPC's only UPDATE statements on ebay_extension_batch_items are the pre-existing stale-batch cleanup ones, scoped to queued/preparing/filling only, never 'failed'", () => {
    const updateStatements = [...fnBody.matchAll(/update public\.ebay_extension_batch_items[\s\S]*?;/g)].map(m => m[0]);
    expect(updateStatements.length).toBeGreaterThan(0); // the stale-cleanup update still exists
    for (const statement of updateStatements) {
      expect(statement).not.toContain("status = 'failed'");
      expect(statement).toContain("bi.status in ('queued', 'preparing', 'filling')");
    }
  });

  it("the new item row always gets a genuinely FRESH identity — the INSERT never specifies an explicit id, relying on the table's own gen_random_uuid() default, and retry_of_item_id is populated on the INSERT itself from the server-derived variable", () => {
    const insertIdx = fnBody.indexOf("insert into public.ebay_extension_batch_items");
    const insertEnd = fnBody.indexOf(";", insertIdx);
    const insertStatement = fnBody.slice(insertIdx, insertEnd);
    expect(insertStatement).not.toMatch(/\bid\b\s*,/); // column list never includes id
    expect(insertStatement).toContain("retry_of_item_id");
    expect(insertStatement).toContain("v_retry_of_item_id");
    expect(sql).toContain("id uuid primary key default gen_random_uuid()");
  });
});

describe("retry truthfulness review — 'queued' -> 'failed' is a permitted transition (failure before the first 'preparing' report)", () => {
  it("REQUIREMENT: verified against the real extension code path, not assumed — the whitelist includes it", () => {
    const reportFnStart = sql.indexOf("create or replace function public.listing_studio_report_ebay_extension_item_result");
    const reportFnBody = sql.slice(reportFnStart, sql.indexOf("\n$$;", reportFnStart));
    expect(reportFnBody).toContain("v_item_status = 'queued' and p_status in ('preparing', 'failed')");
  });

  it("the evidence is documented right alongside the transition table itself, naming the exact extension code path that can fail before any 'preparing' report ever reaches the server", () => {
    const reportFnStart = sql.indexOf("create or replace function public.listing_studio_report_ebay_extension_item_result");
    const reportFnBody = sql.slice(reportFnStart, sql.indexOf("\n$$;", reportFnStart));
    expect(reportFnBody).toContain("startEbayItem");
    expect(reportFnBody).toContain("dispatchEbayItem");
    expect(reportFnBody).toContain("findStalledEbayItem");
  });
});

describe("retry truthfulness review — the extension-side Retry button and its client-only mechanism are gone", () => {
  it("no EBAY_RETRY_ITEM message type, no retryEbayItem handler, no ebay-drafter-retry button, no applyRetryEbayItem state function", () => {
    const messages = readFileSync("vinted-draft-queue-extension/shared/ebay-messages.js", "utf8");
    const serviceWorker = readFileSync("vinted-draft-queue-extension/service-worker.js", "utf8");
    const sidepanelHtml = readFileSync("vinted-draft-queue-extension/sidepanel.html", "utf8");
    const sidepanelJs = readFileSync("vinted-draft-queue-extension/sidepanel.js", "utf8");
    const queueState = readFileSync("vinted-draft-queue-extension/shared/ebay-queue-state.js", "utf8");

    expect(messages).not.toMatch(/EBAY_RETRY_ITEM:\s*"EBAY_RETRY_ITEM"/);
    expect(serviceWorker).not.toMatch(/async function retryEbayItem/);
    expect(serviceWorker).not.toMatch(/EBAY_PANEL_TO_WORKER\.EBAY_RETRY_ITEM/);
    expect(sidepanelHtml).not.toContain('id="ebay-drafter-retry"');
    expect(sidepanelJs).not.toMatch(/ebayDrafterRetry\.addEventListener/);
    expect(queueState).not.toMatch(/export function applyRetryEbayItem/);
  });

  it("REQUIREMENT: a failed item's card shows a plain instruction to retry from Listings Review instead of a non-functional button", () => {
    const sidepanelHtml = readFileSync("vinted-draft-queue-extension/sidepanel.html", "utf8");
    expect(sidepanelHtml).toContain('id="ebay-drafter-retry-instructions"');
    expect(sidepanelHtml.toLowerCase()).toContain("listings review");
    const sidepanelJs = readFileSync("vinted-draft-queue-extension/sidepanel.js", "utf8");
    expect(sidepanelJs).toContain("ebayDrafterRetryInstructions.hidden = !failed");
  });
});

describe("retry truthfulness review — the app-side 'Try again with eBay extension' action", () => {
  const workspaceSource = readFileSync("components/listings-review/ListingsReviewWorkspace.tsx", "utf8");
  const routeSource = readFileSync("app/api/listing-studio/ebay-extension-batches/route.ts", "utf8");

  it("REQUIREMENT: retry reuses the SAME authenticated create-batch route as a first send — never a second, separate endpoint (so it inherits the exact same advisory lock / conflict-check / cleanup protections)", () => {
    expect(routeSource).toContain("rpc/listing_studio_create_ebay_extension_batch");
    // Only ONE POST handler in this route file — retry is not a second path.
    expect((routeSource.match(/export async function POST/g) ?? []).length).toBe(1);
  });

  it("the route surfaces the RPC's own server-derived isRetry flag honestly — never guessed or set by the client", () => {
    expect(routeSource).toContain("isRetry: created.retry_of_item_id !== null");
  });

  it("the app UI shows honest, server-derived retry framing — never a client-side guess", () => {
    expect(workspaceSource).toContain("setEbayExtensionIsRetry(Boolean(body.isRetry))");
    expect(workspaceSource).toContain("Retrying with the eBay extension");
  });
});

describe("blocking-batch visibility review — one authoritative 'active' definition", () => {
  const isActiveStart = sql.indexOf("create or replace function public.listing_studio_is_ebay_extension_item_active");
  const isActiveBody = sql.slice(isActiveStart, sql.indexOf("$$;", sql.indexOf("as $$", isActiveStart)) + 3);
  const conflictStart = sql.indexOf("create or replace function public.listing_studio_create_ebay_extension_batch");
  const conflictFnBody = sql.slice(conflictStart, sql.indexOf("\n$$;", conflictStart));
  const listStart = sql.indexOf("create or replace function public.listing_studio_list_ebay_extension_batches");
  const listBody = sql.slice(listStart, sql.indexOf("\n$$;", listStart));

  it("REQUIREMENT: listing_studio_is_ebay_extension_item_active exists, is immutable, and defines 'active' as neither the batch nor the item being terminal", () => {
    expect(isActiveStart).toBeGreaterThan(-1);
    expect(isActiveBody).toContain("immutable");
    expect(isActiveBody).toContain("p_batch_status not in ('completed', 'cancelled', 'expired')");
    expect(isActiveBody).toContain("p_item_status not in ('failed', 'cancelled')");
  });

  it("REQUIREMENT: is service-role only (never anon/authenticated)", () => {
    const grantBlockIdx = sql.indexOf("listing_studio_is_ebay_extension_item_active(text, text) to service_role");
    expect(grantBlockIdx).toBeGreaterThan(-1);
    const revokeBlockIdx = sql.indexOf("listing_studio_is_ebay_extension_item_active(text, text) from anon, authenticated");
    expect(revokeBlockIdx).toBeGreaterThan(-1);
    expect(revokeBlockIdx).toBeLessThan(grantBlockIdx);
  });

  it("REQUIREMENT: the create RPC's own conflict check calls the SHARED is_active function — never a second, independently-drifting boolean expression", () => {
    const conflictQueryIdx = conflictFnBody.indexOf("select bi.marketplace_draft_id, b.id into v_conflicting_draft, v_conflicting_batch_id");
    expect(conflictQueryIdx).toBeGreaterThan(-1);
    const conflictQuery = conflictFnBody.slice(conflictQueryIdx, conflictFnBody.indexOf("limit 1;", conflictQueryIdx));
    expect(conflictQuery).toContain("public.listing_studio_is_ebay_extension_item_active(b.status, bi.status)");
    // Never re-derives the same boolean inline (the old, since-fixed bug shape).
    expect(conflictQuery).not.toMatch(/b\.status not in \('completed'/);
  });

  it("REQUIREMENT: the conflict raise carries the blocking batch's own id, so the app can name it and offer a 'View this batch' action — never a bare, unidentifiable conflict", () => {
    expect(conflictFnBody).toContain("v_conflicting_batch_id uuid;");
    expect(conflictFnBody).toContain("raise exception 'DRAFT_ALREADY_IN_ACTIVE_BATCH:%', v_conflicting_batch_id");
  });

  it("REQUIREMENT: listing_studio_list_ebay_extension_batches exists, is read-only (stable, not volatile), and is service-role only", () => {
    expect(listStart).toBeGreaterThan(-1);
    expect(listBody).toContain("stable");
    expect(listBody).not.toMatch(/\bvolatile\b/);
    const grantIdx = sql.indexOf("listing_studio_list_ebay_extension_batches(uuid) to service_role");
    const revokeIdx = sql.indexOf("listing_studio_list_ebay_extension_batches(uuid) from anon, authenticated");
    expect(grantIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeLessThan(grantIdx);
  });

  it("REQUIREMENT: the list RPC computes is_active via the SAME shared function the create RPC's own conflict check uses — never a second definition", () => {
    expect(listBody).toContain("public.listing_studio_is_ebay_extension_item_active(b.status, bi.status)");
  });

  it("REQUIREMENT: the list RPC flags a genuinely expired-but-unreconciled 'pending_claim' batch (expires_at already elapsed, status column not yet flipped) — this is the exact root cause the review identified, and it MUST be flagged, never silently dropped", () => {
    expect(listBody).toContain("(b.status = 'pending_claim' and b.expires_at <= now())");
  });

  it("REQUIREMENT: the list RPC never filters rows by expires_at — only box_dismissed_at — so it can never again silently drop a batch the create RPC's own conflict check would still treat as active", () => {
    const whereIdx = listBody.indexOf("where b.owner_id = p_owner_id");
    const whereClause = listBody.slice(whereIdx, listBody.indexOf("order by", whereIdx));
    expect(whereClause).not.toContain("expires_at");
    expect(whereClause).toContain("b.box_dismissed_at is null");
  });

  it("REQUIREMENT: the permission-verifier query's own trailing comment block covers both new functions across anon/authenticated/service_role", () => {
    const verifierIdx = sql.lastIndexOf("has_function_privilege");
    expect(verifierIdx).toBeGreaterThan(-1);
    for (const fnSig of [
      "public.listing_studio_is_ebay_extension_item_active(text, text)",
      "public.listing_studio_list_ebay_extension_batches(uuid)",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(sql).toContain(`has_function_privilege('${role}', '${fnSig}', 'EXECUTE')`);
      }
    }
  });
});
