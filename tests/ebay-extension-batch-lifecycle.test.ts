// eBay Seller Hub extension drafter — LIFECYCLE tests (stale-batch review).
//
// Same disclosed limitation as tests/ebay-extension-batch-migration.test.ts:
// this environment cannot execute PL/pgSQL against a real Postgres
// instance. The RPC-behaviour assertions below are STRUCTURAL — they parse
// the migration SQL's own text and assert the required control flow is
// present. The route-behaviour assertions are genuine (mocked RPC).
// Genuine end-to-end confirmation of the expiry/cancel semantics requires
// the user to apply the migration and exercise it against a real (or
// staging) database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const sql = readFileSync("supabase-ebay-extension-batches.sql", "utf8");
function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  return sql.slice(start, sql.indexOf("\n$$;", start));
}
const createBody = fnBody("listing_studio_create_ebay_extension_batch");
const expireBody = fnBody("listing_studio_expire_ebay_extension_batch");
const cancelBody = fnBody("listing_studio_cancel_ebay_extension_batch");
const reportBody = fnBody("listing_studio_report_ebay_extension_item_result");

describe("stale-batch lifecycle — SQL: expiring an unclaimed batch releases its child (Defect scenario 1 + 8)", () => {
  it("listing_studio_expire_ebay_extension_batch exists and sets both the parent AND its still-live children", () => {
    expect(expireBody).toContain("update public.ebay_extension_batch_items bi");
    expect(expireBody).toContain("set status = 'cancelled', completed_at = now()");
    expect(expireBody).toContain("update public.ebay_extension_batches b");
    expect(expireBody).toContain("set status = 'expired', completed_at = coalesce(b.completed_at, now())");
  });

  it("the child update targets queued/preparing/filling (the statuses that occupy the duplicate-lock index) and excludes waiting_for_review", () => {
    const childUpdate = expireBody.slice(expireBody.indexOf("update public.ebay_extension_batch_items"), expireBody.indexOf("update public.ebay_extension_batches"));
    expect(childUpdate).toContain("bi.status in ('queued', 'preparing', 'filling')");
    expect(childUpdate).not.toContain("waiting_for_review");
  });

  it("REQUIREMENT 4: the expiry RPC is a hard no-op for any batch not currently 'pending_claim' — a claimed/in_progress/waiting_for_review batch is never touched by pairing-window expiry", () => {
    // CORRECTIVE PASS 4 (cancellation race review): eligibility is now read
    // ONCE from the parent-locked row into v_status/v_expires_at and
    // checked before either UPDATE runs, rather than repeated inline on
    // each UPDATE's own WHERE clause.
    expect(expireBody).toContain("v_status <> 'pending_claim'");
    expect(expireBody).toContain("v_expires_at > now()");
    expect(expireBody).not.toMatch(/status (in|not in)[^'\n]*'claimed'/);
  });
});

describe("stale-batch lifecycle — SQL: atomicity + safe create-time cleanup (scenarios 2, 3, 7)", () => {
  it("REQUIREMENT 2: expiry is ONE plpgsql function (one implicit transaction) — parent and child updates cannot land independently", () => {
    // The whole expire body is a single function: no COMMIT, no nested BEGIN/subtransaction
    expect(expireBody).not.toMatch(/\bcommit\b/i);
    expect(expireBody.match(/\bbegin\b/gi)?.length).toBe(1); // just the plpgsql block opener
  });

  it("REQUIREMENT 3: the create RPC cleans up this owner's genuinely-expired, never-claimed batches for THIS listing BEFORE the conflict check", () => {
    const cleanupIdx = createBody.indexOf("LIFECYCLE FIX (stale-batch review): safe cleanup");
    const conflictIdx = createBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft");
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(conflictIdx);
    // Scoped to this owner, this listing, still-pending-claim, genuinely expired
    const cleanup = createBody.slice(cleanupIdx, conflictIdx);
    expect(cleanup).toContain("b.owner_id = p_owner_id");
    expect(cleanup).toContain("b.status = 'pending_claim'");
    expect(cleanup).toContain("b.expires_at <= now()");
    expect(cleanup).toContain("x.marketplace_draft_id = v_marketplace_draft_id");
  });

  it("REQUIREMENT 7: the create-time cleanup runs under the SAME owner-scoped advisory lock as the rest of create — a concurrent create cannot interleave with another's expiry cleanup", () => {
    const lockIdx = createBody.indexOf("pg_advisory_xact_lock");
    const cleanupIdx = createBody.indexOf("LIFECYCLE FIX (stale-batch review): safe cleanup");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(lockIdx);
  });

  it("the create-time cleanup NEVER touches a claimed batch (scoped to status = 'pending_claim' only)", () => {
    // Only the actual UPDATE statements, never the surrounding comment
    // (which describes what must NOT happen and so mentions 'claimed'/
    // 'waiting_for_review' descriptively).
    const cleanup = createBody.slice(createBody.indexOf("LIFECYCLE FIX (stale-batch review): safe cleanup"), createBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft"));
    const statements = cleanup.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/status (=|in|not in)[^\n]*'claimed'/);
    expect(statements).not.toContain("waiting_for_review");
    expect(statements).toMatch(/b\.status = 'pending_claim'/);
  });
});

describe("stale-batch lifecycle — SQL: explicit cancel releases the listing (scenarios 5, 6)", () => {
  it("REQUIREMENT 6/7: listing_studio_cancel_ebay_extension_batch cancels the parent AND every live child INCLUDING waiting_for_review", () => {
    const childUpdate = cancelBody.slice(cancelBody.indexOf("update public.ebay_extension_batch_items"), cancelBody.indexOf("update public.ebay_extension_batches"));
    expect(childUpdate).toContain("bi.status in ('queued', 'preparing', 'filling', 'waiting_for_review')");
    expect(cancelBody).toContain("set status = 'cancelled', completed_at = coalesce(b.completed_at, now())");
  });

  it("the cancel RPC is owner-checked — a batch belonging to a different owner is a hard no-op (no error, no info leak)", () => {
    // CORRECTIVE PASS 4: owner is read ONCE from the parent-locked row into
    // v_owner_id and checked before either UPDATE runs.
    expect(cancelBody).toContain("select b.owner_id, b.status into v_owner_id, v_status");
    expect(cancelBody).toContain("v_owner_id <> p_owner_id");
    const raiseLines = cancelBody.match(/raise exception[^;]*;/g) ?? [];
    for (const line of raiseLines) expect(line).not.toContain("p_batch_id");
  });

  it("REQUIREMENT 8: the cancel RPC touches ONLY the two extension tables — never listing_drafts, listing_marketplace_drafts, ebay_feed_batches, or any offer", () => {
    expect(cancelBody).not.toMatch(/listing_drafts|listing_marketplace_drafts|ebay_feed_batch|ebay_offer|inventory/i);
  });

  it("REQUIREMENT 5: 'waiting_for_review' still blocks a duplicate send — the create conflict query and the partial unique index both still treat it as live", () => {
    const conflictQuery = createBody.slice(createBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft"), createBody.indexOf("limit 1"));
    expect(conflictQuery).toContain("bi.status not in ('failed', 'cancelled')");
    expect(conflictQuery).not.toContain("waiting_for_review");
    // Anchored on the actual CREATE statement (not just the bare index
    // name), which this file's own top comment now also mentions in prose —
    // a bare-name search would find that earlier mention instead.
    const idxDeclIdx = sql.indexOf("create unique index if not exists ebay_extension_batch_items_live_draft_idx");
    const idxStatement = sql.slice(idxDeclIdx, sql.indexOf(";", idxDeclIdx));
    expect(idxDeclIdx).toBeGreaterThan(-1);
    expect(idxStatement).toContain("where status not in ('failed', 'cancelled')");
  });

  it("all three lifecycle RPCs (expire, cancel, report-result) are service_role-only", () => {
    for (const sig of [
      "listing_studio_expire_ebay_extension_batch(uuid)",
      "listing_studio_cancel_ebay_extension_batch(uuid, uuid)",
      "listing_studio_report_ebay_extension_item_result(uuid, uuid, text, text, text, text, text)",
    ]) {
      const grantBlock = sql.slice(sql.indexOf(`revoke all on function public.${sig}`), sql.indexOf(`revoke all on function public.${sig}`) + 700);
      expect(grantBlock).toContain(`revoke all on function public.${sig} from anon, authenticated`);
      expect(grantBlock).toContain(`grant execute on function public.${sig} to service_role`);
    }
  });
});

// ---- CORRECTIVE PASS 4 (cancellation race review) --------------------------
//
// A third concurrency defect: listing_studio_cancel_ebay_extension_batch
// updated its child row(s) BEFORE its parent, with no explicit lock, while
// the (now-retired) item-result HTTP route read the parent with a plain,
// lock-free SELECT and later PATCHed the child independently. A result
// report racing a concurrent Cancel could read the batch while still
// active, then overwrite an already-cancelled child back to a LIVE status —
// leaving a cancelled parent with a child still occupying
// ebay_extension_batch_items_live_draft_idx. Fixed by giving all three
// lifecycle-mutating RPCs (expire, cancel, and the new
// listing_studio_report_ebay_extension_item_result) the SAME lock order:
// the parent row locked FIRST (`for update`), re-checked, THEN the child
// touched. See supabase-ebay-extension-batches.sql's own top comment.
describe("cancellation race review — consistent parent-first lock ordering across all three RPCs (scenario 6)", () => {
  const rpcs: Array<[string, string]> = [
    ["expire", expireBody],
    ["cancel", cancelBody],
    ["report-result", reportBody],
  ];

  it.each(rpcs)("%s: locks the PARENT row with `for update` before touching any child row", (_name, body) => {
    const lockIdx = body.indexOf("for update");
    expect(lockIdx).toBeGreaterThan(-1);
    // The parent lock's own SELECT must be against ebay_extension_batches,
    // not ebay_extension_batch_items.
    const lockStatement = body.slice(Math.max(0, body.lastIndexOf("select", lockIdx)), lockIdx);
    expect(lockStatement).toContain("public.ebay_extension_batches");
    expect(lockStatement).not.toContain("ebay_extension_batch_items");

    const childTouchIdx = Math.min(
      ...[body.indexOf("update public.ebay_extension_batch_items"), body.indexOf("select bi.status")].filter(i => i !== -1),
    );
    if (Number.isFinite(childTouchIdx)) expect(childTouchIdx).toBeGreaterThan(lockIdx);
  });

  it("REQUIREMENT: no deadlock-prone child-first path exists anywhere in the three functions (scenario 7) — none of them ever locks/touches ebay_extension_batch_items before locking ebay_extension_batches", () => {
    for (const [, body] of rpcs) {
      const firstChildRef = body.indexOf("ebay_extension_batch_items");
      const firstParentLock = body.indexOf("for update");
      expect(firstParentLock).toBeGreaterThan(-1);
      if (firstChildRef !== -1) expect(firstChildRef).toBeGreaterThan(firstParentLock);
    }
  });
});

describe("cancellation race review — the new item-result RPC's own transaction (scenarios 1-4)", () => {
  it("locks the child row too (`for update`) before deciding anything about it", () => {
    const childLockIdx = reportBody.indexOf("for update", reportBody.indexOf("select bi.status"));
    expect(childLockIdx).toBeGreaterThan(-1);
  });

  it("REQUIREMENT: 'a result must never change a child already cancelled' — this check is UNCONDITIONAL (checked before any p_status-specific branching, including the transition table), catching both a plain cancel-race report AND a replayed 'cancelled' report after cancellation (scenarios 1, 2, 3, 5)", () => {
    const guardIdx = reportBody.indexOf("if v_item_status in ('waiting_for_review', 'failed', 'cancelled') then");
    const transitionTableIdx = reportBody.indexOf("v_transition_allowed :=");
    const applyIdx = reportBody.indexOf("update public.ebay_extension_batch_items\n  set\n    status = p_status");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(transitionTableIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(transitionTableIdx);
    expect(transitionTableIdx).toBeLessThan(applyIdx);
  });

  it("REQUIREMENT: 'a result may update an item only while its parent remains claimed or in_progress' — checked against the freshly parent-locked status, before the update (scenario 4)", () => {
    const guardIdx = reportBody.indexOf("v_batch_status not in ('claimed', 'in_progress')");
    const applyIdx = reportBody.indexOf("update public.ebay_extension_batch_items\n  set\n    status = p_status");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(applyIdx);
  });

  it("REQUIREMENT (state-transition guard review): 'cancelled' is no longer an accepted requested status at all — explicit cancellation continues through the dedicated Cancel RPC only", () => {
    expect(reportBody).toContain("p_status not in ('queued', 'preparing', 'filling', 'waiting_for_review', 'failed')");
  });

  it("REQUIREMENT: batch auto-close still checks only failed/cancelled, never waiting_for_review (same discipline as before, now inside the RPC)", () => {
    const closeCheckIdx = reportBody.indexOf("select bool_and(bi.status in ('failed', 'cancelled'))");
    expect(closeCheckIdx).toBeGreaterThan(-1);
  });

  it("is a single plpgsql function (one implicit transaction) — no COMMIT, no nested BEGIN", () => {
    // Strip comment lines first — this function's own comments describe
    // Cancel's "commit" prose-wise, which must not false-positive here.
    const statements = reportBody.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/\bcommit\b/i);
    expect(statements.match(/\bbegin\b/gi)?.length).toBe(1);
  });
});

// ---- CORRECTIVE PASS 5 (state-transition guard review) --------------------
//
// A fourth defect, independent of locking: the item-result RPC accepted ANY
// status while the parent was claimed/in_progress, with no check that the
// transition made sense against the item's CURRENT status — permitting
// waiting_for_review -> filling, waiting_for_review -> preparing,
// filling -> preparing, and unbounded attempt_count growth from repeated
// 'preparing' reports. Fixed with an explicit, exhaustive forward-only
// transition table. See supabase-ebay-extension-batches.sql's own top
// comment.
describe("state-transition guard review — the explicit forward-only transition table (SQL structure)", () => {
  it("the whitelist is EXACTLY the three permitted current-statuses' forward transitions — no more, no fewer (CORRECTIVE PASS 6: 'queued' also permits 'failed' — see the retry-truthfulness review's own evidence, checked separately below)", () => {
    const tableIdx = reportBody.indexOf("v_transition_allowed :=");
    const tableEnd = reportBody.indexOf(";", tableIdx);
    const table = reportBody.slice(tableIdx, tableEnd);
    expect(table).toContain("v_item_status = 'queued' and p_status in ('preparing', 'failed')");
    expect(table).toContain("v_item_status = 'preparing' and p_status in ('filling', 'failed')");
    expect(table).toContain("v_item_status = 'filling' and p_status in ('waiting_for_review', 'failed')");
    // Exactly two 'or' joins between exactly three disjuncts (one per
    // current-status) — nothing extra.
    expect((table.match(/\bor\b/gi) ?? []).length).toBe(2);
    expect((table.match(/v_item_status = '\w+' and p_status/g) ?? []).length).toBe(3);
  });

  it("a DIFFERENT requested status is checked against the whitelist ONLY when it differs from the current status — a same-status report skips the whitelist and falls through as an idempotent progress update", () => {
    const skipIdx = reportBody.indexOf("if p_status <> v_item_status then");
    const tableIdx = reportBody.indexOf("v_transition_allowed :=");
    expect(skipIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(skipIdx);
  });

  it("a transition not in the whitelist is refused as a no-op — never raises, never silently applies", () => {
    const tableIdx = reportBody.indexOf("v_transition_allowed :=");
    const rejectBlock = reportBody.slice(tableIdx, reportBody.indexOf("end if;", reportBody.indexOf("if not v_transition_allowed then", tableIdx)));
    expect(rejectBlock).toContain("if not v_transition_allowed then");
    expect(rejectBlock).toContain("applied := false; duplicate := true;");
    expect(rejectBlock).not.toContain("raise exception");
  });

  it("REQUIREMENT: attempt_count increments ONLY on the genuine 'queued' -> 'preparing' transition — a repeated 'preparing' -> 'preparing' report (v_item_status already 'preparing') does NOT match this condition and leaves attempt_count untouched", () => {
    const incrementLine = reportBody.split("\n").find(l => l.includes("attempt_count = case"));
    expect(incrementLine).toBeTruthy();
    expect(incrementLine).toContain("v_item_status = 'queued' and p_status = 'preparing'");
    // The OLD, buggy condition (p_status = 'preparing' alone, regardless of
    // the item's current status) must be gone.
    expect(incrementLine).not.toMatch(/case when p_status = 'preparing' then/);
  });

  it("REQUIREMENT: 'cancelled' is not an accepted requested status for this RPC — explicit cancellation continues through the dedicated Cancel RPC only", () => {
    expect(reportBody).toContain("p_status not in ('queued', 'preparing', 'filling', 'waiting_for_review', 'failed')");
    // Defence in depth at the HTTP request-schema layer too.
    const schemaSource = readFileSync("lib/listing-studio/ebay-extension-batch-schema.ts", "utf8");
    const reportableIdx = schemaSource.indexOf("EBAY_EXTENSION_REPORTABLE_ITEM_STATUSES = [");
    const reportableLine = schemaSource.slice(reportableIdx, schemaSource.indexOf("]", reportableIdx));
    expect(reportableIdx).toBeGreaterThan(-1);
    expect(reportableLine).not.toContain("cancelled");
    expect(schemaSource).toContain("status: z.enum(EBAY_EXTENSION_REPORTABLE_ITEM_STATUSES)");
  });
});

describe("state-transition guard review — behavioural: every permitted transition, every prohibited transition, repeats, stale messages, and races", () => {
  const ITEM_UUID = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    process.env.EXTENSION_BATCH_SECRET = "d".repeat(32);
    process.env.EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";
    supabaseRequest.mockReset();
    supabaseRequestAll.mockReset();
  });

  async function postResult(status: string) {
    const { POST } = await import("@/app/api/extension/ebay-batch/items/[itemId]/result/route");
    const { signBatchToken } = await import("@/lib/listing-studio/extension-batch-tokens");
    const token = await signBatchToken(BATCH_UUID, 3600);
    const request = new Request("http://test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return POST(request, { params: Promise.resolve({ itemId: ITEM_UUID }) });
  }

  // ---- Permitted forward transitions ----
  it.each([
    ["queued", "preparing"],
    ["preparing", "filling"],
    ["preparing", "failed"],
    ["filling", "waiting_for_review"],
    ["filling", "failed"],
  ])("PERMITTED: %s -> %s is forwarded to the RPC and its applied:true result is surfaced honestly", async (_from, to) => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: to, batch_status: "claimed", applied: true, duplicate: false },
    ]), { status: 200 }));

    const response = await postResult(to);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: to, duplicate: false });
    const rpcCall = supabaseRequest.mock.calls.find(([path]) => String(path).startsWith("rpc/listing_studio_report_ebay_extension_item_result"));
    expect(JSON.parse(String((rpcCall![1] as RequestInit).body))).toMatchObject({ p_status: to });
  });

  // ---- Prohibited backward / out-of-order transitions — the RPC refuses
  // and reports the item's ACTUAL (unchanged) status; the route must
  // surface that honestly, never claim the requested status applied.
  it.each([
    ["waiting_for_review", "filling"],
    ["waiting_for_review", "preparing"],
    ["filling", "preparing"],
    ["preparing", "queued"],
    ["queued", "filling"],
    ["queued", "waiting_for_review"],
    ["failed", "preparing"],
  ])("PROHIBITED: a %s -> %s report is refused — the route surfaces the item's actual current status ('%s'), not the requested one", async (current, requested) => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: current, batch_status: "claimed", applied: false, duplicate: true },
    ]), { status: 200 }));

    const response = await postResult(requested);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: current, duplicate: true });
  });

  it("REPEATED preparing: a second 'preparing' report while already 'preparing' is forwarded exactly as reported — the RPC (proven structurally above) applies it without a second attempt_count increment", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: "preparing", batch_status: "claimed", applied: true, duplicate: false },
    ]), { status: 200 }));

    const response = await postResult("preparing");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: "preparing", duplicate: false });
  });

  it("REPEATED filling: a second 'filling' progress report while already 'filling' is forwarded exactly as reported", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: "filling", batch_status: "claimed", applied: true, duplicate: false },
    ]), { status: 200 }));

    const response = await postResult("filling");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: "filling", duplicate: false });
  });

  it("DELAYED MESSAGE after waiting_for_review: a late 'filling' progress report arriving after the item already reached waiting_for_review is refused — the route reports 'waiting_for_review', never reopening it", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: "waiting_for_review", batch_status: "claimed", applied: false, duplicate: true },
    ]), { status: 200 }));

    const response = await postResult("filling");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: "waiting_for_review", duplicate: true });
  });

  it("CANCELLATION/RESULT RACE: a 'filling' report arriving after a concurrent Cancel already committed 'cancelled' is refused — the route reports 'cancelled', never resurrecting the item", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: "cancelled", batch_status: "cancelled", applied: false, duplicate: true },
    ]), { status: 200 }));

    const response = await postResult("filling");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: "cancelled", duplicate: true });
  });

  it("REQUIREMENT: a request claiming status: 'cancelled' is rejected at the HTTP boundary (zod) before the RPC is ever called — explicit cancellation must go through the dedicated Cancel RPC only", async () => {
    const response = await postResult("cancelled");
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});

describe("cancellation race review — a cancelled/expired parent never retains a live-indexed child (scenario 8)", () => {
  it("the cancel RPC's child update is UNCONDITIONAL once it runs — every live status transitions straight to 'cancelled', which the partial unique index (and the create RPC's own conflict query) both already exclude from 'live'", () => {
    const childUpdate = cancelBody.slice(cancelBody.indexOf("update public.ebay_extension_batch_items"), cancelBody.indexOf("update public.ebay_extension_batches"));
    expect(childUpdate).toContain("set status = 'cancelled', completed_at = now()");
    // No alternate branch that could leave a child in any other status.
    expect(childUpdate).not.toMatch(/case\s+when/i);
  });

  it("the expire RPC's child update is likewise unconditional — every live status transitions straight to 'cancelled'", () => {
    const childUpdate = expireBody.slice(expireBody.indexOf("update public.ebay_extension_batch_items"), expireBody.indexOf("update public.ebay_extension_batches"));
    expect(childUpdate).toContain("set status = 'cancelled', completed_at = now()");
    expect(childUpdate).not.toMatch(/case\s+when/i);
  });

  it("a listing whose only batch is now cancelled is eligible for a brand-new batch — the create RPC's conflict query only excludes 'failed'/'cancelled' children, both of which this cancel/expire path always produces", () => {
    const conflictQuery = createBody.slice(createBody.indexOf("select bi.marketplace_draft_id into v_conflicting_draft"), createBody.indexOf("limit 1"));
    expect(conflictQuery).toContain("bi.status not in ('failed', 'cancelled')");
  });
});

describe("stale-batch lifecycle — the three separated lifetimes (requirement 5)", () => {
  it("the claim route expires via the atomic RPC, NEVER two independent PATCHes", () => {
    const source = readFileSync("app/api/extension/ebay-batch/claim/route.ts", "utf8");
    expect(source).toContain("rpc/listing_studio_expire_ebay_extension_batch");
    // The old two-step PATCH-to-expired is gone
    expect(source).not.toMatch(/PATCH[\s\S]{0,120}status: "expired"/);
  });

  it("the batch token's lifetime is the fixed EXTENSION-SESSION constant, decoupled from the pairing-code window (expires_at)", () => {
    const source = readFileSync("app/api/extension/ebay-batch/claim/route.ts", "utf8");
    expect(source).toContain("EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS");
    expect(source).toContain("signBatchToken(batch.id, EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS)");
    // the old expires_at-derived token life is gone
    expect(source).not.toMatch(/signBatchToken\([^)]*expires_at/);
  });

  it("REQUIREMENT 4: the payload / photo / result routes NO LONGER 410 a claimed batch merely because the pairing window elapsed — they gate on token + status only", () => {
    for (const path of [
      "app/api/extension/ebay-batch/route.ts",
      "app/api/extension/ebay-batch/photos/[itemId]/[position]/route.ts",
      "app/api/extension/ebay-batch/items/[itemId]/result/route.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/new Date\(batch\.expires_at\)\.getTime\(\) <= Date\.now\(\)/);
    }
  });

  it("EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS is materially longer than the pairing window, so a claimed mid-fill batch's session doesn't die with the pairing code", async () => {
    const schema = await import("@/lib/listing-studio/ebay-extension-batch-schema");
    expect(schema.EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS).toBeGreaterThan(schema.EBAY_EXTENSION_BATCH_EXPIRY_SECONDS * 4);
  });
});

// ---- Route behaviour: explicit cancel (both entry points) ------------------

const { requireOwner, supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "o@e.com" })),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [{ id: "batch-1", owner_id: "owner-1" }] as unknown[]),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

const BATCH_UUID = "11111111-1111-4111-8111-111111111111";

describe("stale-batch lifecycle — explicit Cancel routes call the atomic RPC (requirement 7)", () => {
  beforeEach(() => {
    process.env.EXTENSION_BATCH_SECRET = "d".repeat(32);
    process.env.EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";
    requireOwner.mockClear();
    supabaseRequest.mockClear();
    supabaseRequestAll.mockClear();
    supabaseRequest.mockResolvedValue(new Response("{}", { status: 200 }));
    supabaseRequestAll.mockResolvedValue([{ id: BATCH_UUID, owner_id: "owner-1" }]);
  });

  it("the owner-authenticated DELETE route calls listing_studio_cancel_ebay_extension_batch with the SESSION owner id", async () => {
    const { DELETE } = await import("@/app/api/listing-studio/ebay-extension-batches/[batchId]/route");
    const response = await DELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ batchId: BATCH_UUID }) });
    expect(response.status).toBe(200);
    const rpcCall = supabaseRequest.mock.calls.find(([path]) => String(path).startsWith("rpc/listing_studio_cancel_ebay_extension_batch"));
    expect(rpcCall).toBeTruthy();
    expect(JSON.parse(String((rpcCall![1] as RequestInit).body))).toMatchObject({ p_owner_id: "owner-1", p_batch_id: BATCH_UUID });
  });

  it("the owner-authenticated DELETE route derives the owner from the session — a spoofed body owner id has zero effect (it never reads the body at all)", async () => {
    const source = readFileSync("app/api/listing-studio/ebay-extension-batches/[batchId]/route.ts", "utf8");
    expect(source).not.toMatch(/request\.json\(\)/);
    expect(source).toContain("await requireOwner()");
  });

  it("the extension (batch-token) POST /cancel route resolves the owner from the batch row and calls the SAME RPC", async () => {
    const { POST } = await import("@/app/api/extension/ebay-batch/cancel/route");
    const { signBatchToken } = await import("@/lib/listing-studio/extension-batch-tokens");
    const token = await signBatchToken(BATCH_UUID, 3600);
    const response = await POST(new Request("http://test", { method: "POST", headers: { Authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    const rpcCall = supabaseRequest.mock.calls.find(([path]) => String(path).startsWith("rpc/listing_studio_cancel_ebay_extension_batch"));
    expect(rpcCall).toBeTruthy();
    expect(JSON.parse(String((rpcCall![1] as RequestInit).body))).toMatchObject({ p_owner_id: "owner-1", p_batch_id: BATCH_UUID });
  });

  it("STRUCTURAL: the extension /cancel route uses verifyBatchToken and never requireOwner (it has no owner session)", () => {
    const source = readFileSync("app/api/extension/ebay-batch/cancel/route.ts", "utf8");
    expect(source).toContain("verifyBatchToken");
    expect(source).not.toContain("requireOwner");
  });
});

// ---- Route behaviour: the rewritten item-result route (CORRECTIVE PASS 4) --

describe("cancellation race review — the rewritten item-result route is a thin wrapper around the new RPC", () => {
  const ITEM_UUID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    process.env.EXTENSION_BATCH_SECRET = "d".repeat(32);
    process.env.EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";
    supabaseRequest.mockReset();
    supabaseRequestAll.mockReset();
  });

  async function postResult(body: unknown) {
    const { POST } = await import("@/app/api/extension/ebay-batch/items/[itemId]/result/route");
    const { signBatchToken } = await import("@/lib/listing-studio/extension-batch-tokens");
    const token = await signBatchToken(BATCH_UUID, 3600);
    const request = new Request("http://test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(request, { params: Promise.resolve({ itemId: ITEM_UUID }) });
  }

  it("calls listing_studio_report_ebay_extension_item_result exactly once, and never reads or PATCHes either table directly any more", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: "waiting_for_review", batch_status: "claimed", applied: true, duplicate: false },
    ]), { status: 200 }));

    const response = await postResult({ status: "waiting_for_review" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: "waiting_for_review", duplicate: false });
    const rpcCall = supabaseRequest.mock.calls.find(([path]) => String(path).startsWith("rpc/listing_studio_report_ebay_extension_item_result"));
    expect(rpcCall).toBeTruthy();
    expect(JSON.parse(String((rpcCall![1] as RequestInit).body))).toMatchObject({ p_batch_id: BATCH_UUID, p_item_id: ITEM_UUID, p_status: "waiting_for_review" });
    expect(supabaseRequestAll).not.toHaveBeenCalled();
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
  });

  it("REQUIREMENT (scenarios 1, 2): a result the RPC refused (a concurrent Cancel, or a closed parent) is surfaced HONESTLY — the item's OWN current status, never the status that was merely requested — with duplicate:true", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: "cancelled", batch_status: "cancelled", applied: false, duplicate: true },
    ]), { status: 200 }));

    const response = await postResult({ status: "waiting_for_review" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: "cancelled", duplicate: true });
  });

  it("REQUIREMENT (scenario 3): a replayed report after cancellation is idempotent — a repeated report of whatever status the extension last sent (e.g. 'filling', its last known state) is refused, honestly reporting 'cancelled', no error. (A replay claiming status: 'cancelled' itself is no longer possible at all — see the state-transition guard review's own coverage of that rejection at the HTTP boundary.)", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: ITEM_UUID, item_status: "cancelled", batch_status: "cancelled", applied: false, duplicate: true },
    ]), { status: 200 }));

    const response = await postResult({ status: "filling" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_UUID, status: "cancelled", duplicate: true });
  });

  it("maps a BATCH_NOT_FOUND RPC rejection to a safe 404, never the raw error text", async () => {
    supabaseRequest.mockRejectedValue(Object.assign(new Error("BATCH_NOT_FOUND"), { status: 400 }));

    const response = await postResult({ status: "waiting_for_review" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Batch not found." });
  });

  it("maps an ITEM_NOT_FOUND RPC rejection to a safe 404, never the raw error text", async () => {
    supabaseRequest.mockRejectedValue(Object.assign(new Error("ITEM_NOT_FOUND"), { status: 400 }));

    const response = await postResult({ status: "waiting_for_review" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "This item does not belong to the active batch." });
  });

  it("STRUCTURAL: the route no longer imports/uses isTerminalEbayExtensionItemStatus, isEbayExtensionBatchClosingItemStatus, or supabaseRequestAll — that entire decision now lives inside the RPC", () => {
    const source = readFileSync("app/api/extension/ebay-batch/items/[itemId]/result/route.ts", "utf8");
    expect(source).not.toContain("isTerminalEbayExtensionItemStatus");
    expect(source).not.toContain("isEbayExtensionBatchClosingItemStatus");
    expect(source).not.toContain("supabaseRequestAll");
    expect(source).toContain("rpc/listing_studio_report_ebay_extension_item_result");
  });

  // CORRECTIVE PASS 6 (retry truthfulness review) — a stale message
  // targeting the OLD, now-permanently-failed item id, arriving AFTER a
  // retry has already created a brand-new item id for the same listing.
  // The old id's own terminal guard (unchanged — see the state-transition
  // guard review's own coverage) refuses it regardless of what the new
  // retry item is doing; the two item ids are otherwise completely
  // independent rows.
  it("REQUIREMENT (stale old-item message after retry): a late report against the OLD failed item id is refused — it can never resurrect the old row, and it has no effect on the NEW retry item (a different row entirely)", async () => {
    const OLD_ITEM_ID = "55555555-5555-4555-8555-555555555555";
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([
      { item_id: OLD_ITEM_ID, item_status: "failed", batch_status: "completed", applied: false, duplicate: true },
    ]), { status: 200 }));

    const { POST } = await import("@/app/api/extension/ebay-batch/items/[itemId]/result/route");
    const { signBatchToken } = await import("@/lib/listing-studio/extension-batch-tokens");
    const token = await signBatchToken(BATCH_UUID, 3600);
    const response = await POST(new Request("http://test", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ status: "waiting_for_review" }),
    }), { params: Promise.resolve({ itemId: OLD_ITEM_ID }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: OLD_ITEM_ID, status: "failed", duplicate: true });
  });
});
