-- ============================================================================
-- eBay Seller Hub extension drafter — additive migration (NOT YET APPLIED)
-- ============================================================================
-- CORRECTIVE PASS (safety review) — this file REPLACES the original draft of
-- the same name in place (the original was never applied to any real
-- database — confirmed via a harmless RPC-existence probe returning
-- PGRST205 "table not found" — so there is no already-applied version to
-- migrate away from; overwriting is safe and deliberate, not a second
-- migration layered on top of a first).
--
-- CORRECTIVE PASS 4 (cancellation race review) — a THIRD concurrency defect
-- was found and fixed, on top of the two lifecycle fixes below:
-- listing_studio_cancel_ebay_extension_batch updated its child row(s) BEFORE
-- its parent row, with no explicit lock acquired on either beforehand,
-- while the (now-retired) item-result HTTP route read the parent with a
-- plain, lock-free SELECT and later PATCHed the child independently. A
-- result report racing a concurrent Cancel could read the batch while still
-- active, then — after Cancel committed 'cancelled' on both rows — overwrite
-- the child back to a LIVE status (e.g. 'waiting_for_review'), leaving a
-- cancelled parent with a child still occupying
-- ebay_extension_batch_items_live_draft_idx forever (the exact stuck-batch
-- shape the earlier lifecycle fix existed to prevent, reached a different
-- way). Fixed by:
--   1. Giving listing_studio_expire_ebay_extension_batch and
--      listing_studio_cancel_ebay_extension_batch an explicit
--      `select ... for update` on the PARENT row as their very first
--      statement, BEFORE any child row is touched.
--   2. Replacing the item-result HTTP route's own direct
--      SELECT+PATCH+PATCH with a THIRD transactional, service-role-only
--      RPC, listing_studio_report_ebay_extension_item_result, which uses
--      the exact same lock order: parent row locked first (`for update`),
--      status re-checked, THEN the child row locked and updated.
-- All three functions therefore always acquire parent-then-child locks,
-- never child-then-parent — so no two of them can ever deadlock against
-- each other, and a concurrent pair always serializes (the second blocks on
-- the parent lock until the first commits, then re-reads the now-current
-- parent status before deciding anything) rather than interleaving. A
-- transaction that commits a terminal parent status (cancelled/expired)
-- always commits its own child transition to 'cancelled' in the SAME
-- transaction, so no committed state can ever show a terminal parent next
-- to a live-indexed child.
--
-- CORRECTIVE PASS 5 (state-transition guard review) — a FOURTH defect,
-- independent of locking: listing_studio_report_ebay_extension_item_result
-- accepted ANY valid status while the parent was claimed/in_progress, with
-- no check that the requested transition made sense against the item's
-- CURRENT status. That permitted unsafe backwards/out-of-order transitions
-- (waiting_for_review -> filling, waiting_for_review -> preparing,
-- filling -> preparing) and repeated 'preparing' reports each incrementing
-- attempt_count as if every one were a brand-new attempt. Fixed by:
--   1. An explicit, exhaustive forward-only transition table —
--      queued -> preparing; preparing -> filling | failed;
--      filling -> waiting_for_review | failed — checked against the
--      freshly parent-and-child-locked current status. Any combination not
--      in this table is refused as a no-op, never silently applied.
--   2. A single unconditional guard: once a child reaches
--      'waiting_for_review', 'failed' or 'cancelled', NO further result
--      report — same status or different — may move it again. A stale,
--      delayed message arriving after the item is already terminal-for-now
--      can never reopen it.
--   3. A same-status report (e.g. 'filling' while already 'filling') is
--      still accepted as an idempotent PROGRESS update
--      (current_step/step_detail refreshed) but is explicitly excluded
--      from bumping attempt_count — only the genuine 'queued' ->
--      'preparing' transition does that, exactly once per real attempt.
--   4. 'cancelled' is no longer an accepted status for this RPC (and no
--      longer accepted at the HTTP request-schema layer either — see
--      lib/listing-studio/ebay-extension-batch-schema.ts's own matching
--      comment) — explicit cancellation continues through the dedicated
--      listing_studio_cancel_ebay_extension_batch RPC only, never through
--      a result report.
-- The lock order (parent, then child) and service-role-only grants from
-- CORRECTIVE PASS 4 are unchanged.
--
-- CORRECTIVE PASS 6 (retry truthfulness review) — the previously-reported
-- extension-side "Retry" button (sidepanel.js's ebay-drafter-retry,
-- service-worker.js's retryEbayItem) was a FIFTH defect: it only flipped
-- the extension's own LOCAL queue state for a failed item back to 'queued'
-- and re-dispatched it, which then re-reported 'preparing' against the
-- SAME server-side item id — an id that is now (CORRECTIVE PASS 5)
-- PERMANENTLY terminal once 'failed'. The database row never moved; the
-- button lied about retrying. Fixed by:
--   1. Removing that button and its whole client-only retry path entirely
--      (vinted-draft-queue-extension/sidepanel.html,
--      vinted-draft-queue-extension/sidepanel.js,
--      vinted-draft-queue-extension/service-worker.js,
--      vinted-draft-queue-extension/shared/ebay-messages.js,
--      vinted-draft-queue-extension/shared/ebay-queue-state.js) — the
--      extension has no owner session, only a batch-scoped token, so it
--      cannot securely create a fresh, authenticated app batch itself. A
--      failed item's card now shows a plain instruction to return to
--      Listings Review instead.
--   2. A real retry now means a FRESH batch and a FRESH
--      ebay_extension_batch_items row, created through the authenticated
--      app (components/listings-review/ListingsReviewWorkspace.tsx's
--      existing "Send to eBay extension" action, unchanged in shape) —
--      which already calls listing_studio_create_ebay_extension_batch, the
--      SAME owner-scoped advisory lock + conflict-check + create-time
--      cleanup this whole file has hardened across passes 2-5. Two
--      consequences fall out of reusing that exact path rather than a new
--      one: (a) the old failed row is NEVER reset or overwritten — nothing
--      in the create RPC ever writes to an existing item row, only reads
--      it; (b) a double-click can never create two fresh batches for the
--      same listing — the SAME advisory lock + partial unique index that
--      already prevents a duplicate send in general applies identically
--      here, with no new code needed.
--   3. Attempt lineage: the create RPC now derives retry_of_item_id
--      itself (see its own comment below and
--      ebay_extension_batch_items.retry_of_item_id's own column comment)
--      — the most recent 'failed' item for this owner+listing, if any.
--      Entirely server-derived, never supplied by a caller, so a client
--      can never claim false lineage; it only ever READS the old row.
--   4. 'queued' -> 'failed' added to the transition whitelist — verified
--      against the real extension code path (see the transition table's
--      own comment below), not assumed: a tab-creation or message-dispatch
--      failure before the content script's first "preparing" report is a
--      real, reachable case, and the item's local watchdog reports
--      'failed' directly while the server-side row is still 'queued'.
--
-- CORRECTIVE PASS (blocking-batch visibility review) — a live, real batch
-- (created via the actually-correct app instance) genuinely blocked a new
-- send while being COMPLETELY INVISIBLE in the app: the create RPC's own
-- conflict check (correctly) never looks at expires_at — a batch is still
-- genuinely active, and must still block a duplicate send, right up until
-- its pairing window elapses — but the app's GET-batches route excluded
-- ANY 'pending_claim' batch whose expires_at had passed, REGARDLESS of
-- whether its status column had actually been flipped to 'expired' yet
-- (nothing does that until something calls
-- listing_studio_expire_ebay_extension_batch; a plain read never
-- reconciles it on its own). Two independently-written "is this active"
-- definitions, quietly disagreeing at exactly the boundary where it
-- mattered most. Fixed by:
--   1. listing_studio_is_ebay_extension_item_active — the ONE
--      authoritative definition, now used by BOTH the create RPC's
--      conflict check AND the new list RPC below. See that function's own
--      comment.
--   2. listing_studio_list_ebay_extension_batches — the ONE query the
--      app's GET route now uses to render every one of an owner's
--      non-dismissed batches, with is_active computed via the function
--      above and is_expired_unreconciled flagging a 'pending_claim' batch
--      whose window has genuinely elapsed but hasn't been reconciled yet
--      — the app route calls the EXISTING, already-hardened expire RPC
--      for any such row before returning, so the UI always sees an
--      honest, already-reconciled state, never a phantom "still waiting"
--      for something that's actually dead.
--   3. The create RPC's conflict raise now also carries the BLOCKING
--      BATCH's own id (DRAFT_ALREADY_IN_ACTIVE_BATCH:<batch_id>), so the
--      app can tell the user exactly which batch to look at instead of a
--      dead-end generic message.
--
-- Two real defects were found in the original draft, both fixed below:
--
-- DEFECT 1 (inconsistent empty batches) — the original RPC set
-- listing_count from the requested array length and inserted the parent
-- batch BEFORE ever proving the referenced marketplace draft existed,
-- belonged to this owner, or was EBAY_UK. Its `insert ... select` could
-- then insert ZERO child rows (e.g. a nonexistent or wrong-owner id) while
-- the parent row still sat there claiming one listing — a batch with a
-- phantom, un-inspectable "1 listing" that nothing would ever process or
-- clean up. Fixed by validating and LOCKING the exact eligible
-- listing_marketplace_drafts row FIRST (`for update`, inside the same
-- transaction as everything else), and only inserting the parent once that
-- row is proven to exist. The child insert is then a single-row `insert
-- ... values` (not `insert ... select`, which is what made silently
-- inserting fewer rows than expected possible in the first place) followed
-- by an explicit `get diagnostics ... row_count` check that RAISES (and
-- therefore rolls back the whole transaction, parent included) if the
-- inserted count isn't exactly 1 — for this milestone's own "exactly one
-- listing per batch" scope, but written as a real count check rather than
-- an assumption, so a later relaxation to multiple listings inherits the
-- same protection rather than silently losing it.
--
-- DEFECT 2 (duplicate form risk) — the original conflict-detection query
-- excluded child status 'waiting_for_review' from what counts as "active",
-- directly contradicting this feature's own stated duplicate-protection
-- goal: a listing waiting for the user's review has a REAL, populated
-- Seller Hub tab open right now, and sending it again would open a SECOND
-- tab/form for the same listing. Fixed by removing 'waiting_for_review'
-- from the exclusion list — only 'failed' and 'cancelled' end an item's
-- protection now. A listing stays protected until the operation is
-- explicitly cancelled, or (a later milestone) confirmed saved.
--
-- A THIRD, independent fix was needed to make Defect 2's fix actually hold:
-- the application route that reports item results
-- (app/api/extension/ebay-batch/items/[itemId]/result/route.ts) used to
-- mark the PARENT BATCH 'completed' the moment every item reached ANY
-- terminal-looking status, including 'waiting_for_review' — which would
-- have flipped the batch's own status out of this RPC's
-- `b.status not in ('completed', ...)` filter, silently reopening the
-- exact duplicate-send hole this migration's own conflict query exists to
-- close. See that route's own corrective-pass comment for the fix
-- (a batch now only auto-closes once every item is failed/cancelled —
-- never merely because one reached waiting_for_review).
--
-- DATABASE-LEVEL INVARIANT (never rely only on the advisory lock + query) —
-- a partial unique index (below) makes "at most one LIVE
-- ebay_extension_batch_items row per marketplace_draft_id" a constraint the
-- database itself enforces, independent of this RPC's own conflict check —
-- so even a future code path that bypasses this RPC entirely (a bug, a
-- manual fix-up query, a later developer forgetting this function exists)
-- cannot create a second live operation for the same listing; Postgres
-- itself refuses the second INSERT with a unique-violation, which the
-- calling route surfaces as a real, safe error rather than silent data
-- corruption.
--
-- WHAT THIS FILE CANNOT PROVE ON ITS OWN — disclosed plainly: this
-- environment has no way to execute DDL or run PL/pgSQL against a real
-- Postgres instance (established earlier in this project — only PostgREST
-- REST access is available, which cannot run CREATE FUNCTION). Every claim
-- above is verified by careful manual construction and tracing of this
-- SQL's own control flow, and by structural tests
-- (tests/ebay-extension-batch-migration.test.ts) that parse this file's
-- TEXT and assert the safety-relevant patterns are present — never by an
-- executed test that actually ran this function against Postgres. Genuine
-- confirmation requires the user to apply this migration (SQL Editor,
-- instructions in the final report) and, ideally, exercise the rejection
-- cases against a real (or staging) database themselves before relying on
-- it live.
--
-- CORRECTIVE PASS (controlled pairing test review, Phase 4) — the user
-- needs a way to clear a TERMINAL (expired/cancelled/completed) batch's
-- card from Listings Review without hard-deleting the audit row. This
-- table already had a box_dismissed_at column (added for a Vinted-style
-- dismiss pattern this eBay feature never finished wiring up) and
-- listing_studio_list_ebay_extension_batches already filtered by it — but
-- nothing ever WROTE it for an eBay batch. Two changes below:
--   1. listing_studio_list_ebay_extension_batches gained
--      p_include_dismissed (default false — every existing caller's
--      behaviour is unchanged) so the SAME query also serves an optional
--      "Show dismissed batches" toggle, rather than a second query.
--   2. listing_studio_dismiss_ebay_extension_batch — the ONE place that
--      writes box_dismissed_at. A hard no-op for anything not already
--      'completed'/'cancelled'/'expired' — dismissal can never become a
--      silent substitute for the guarded Cancel action on a genuinely
--      active batch. Owner-checked and idempotent exactly like
--      cancel/expire above.

create table if not exists public.ebay_extension_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,

  pairing_code_hash text not null,

  status text not null default 'pending_claim'
    check (status in ('pending_claim', 'claimed', 'in_progress', 'completed', 'expired', 'cancelled')),

  -- This milestone only ever sends ONE listing at a time (see this
  -- feature's own README/task scope) — capped low deliberately, distinct
  -- from Vinted's own 1-5 range, so a future relaxation is a one-line
  -- constraint change, not a silent behaviour change today.
  listing_count integer not null
    check (listing_count = 1),

  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  expires_at timestamptz not null,
  completed_at timestamptz,

  extension_id text,
  extension_version text,
  browser_label text,

  display_number integer not null,
  box_dismissed_at timestamptz,
  activity_dismissed_at timestamptz,

  last_extension_activity_at timestamptz
);

create unique index if not exists ebay_extension_batches_pairing_code_hash_idx
  on public.ebay_extension_batches (pairing_code_hash);
create index if not exists ebay_extension_batches_owner_idx
  on public.ebay_extension_batches (owner_id, created_at desc);
create unique index if not exists ebay_extension_batches_owner_display_number_idx
  on public.ebay_extension_batches (owner_id, display_number)
  where box_dismissed_at is null;

alter table public.ebay_extension_batches enable row level security;
revoke all on public.ebay_extension_batches from anon, authenticated;

-- ON DELETE CASCADE decision (review requirement — considered deliberately,
-- not changed casually): kept, on all three foreign keys, matching
-- vinted_extension_batch_items' own identical FK design exactly. Reasoning:
--   - batch_id -> ebay_extension_batches: standard parent/child cascade —
--     deleting a batch should never leave orphaned item rows.
--   - marketplace_draft_id / product_draft_id -> the listing itself: THIS
--     table currently carries no durable audit value once a listing is
--     gone — no real Seller Hub draft has ever been confirmed by this
--     pipeline yet (ebay_seller_hub_draft_confirmed_at is always null
--     until a later milestone), so a batch/item row surviving the deletion
--     of the listing it describes would be an orphaned, un-actionable
--     record pointing at nothing (it can never be resumed, retried, or
--     even displayed meaningfully — every existing route already resolves
--     these ids back to the live listing_drafts/listing_marketplace_drafts
--     rows before showing anything). If a genuine cross-listing audit
--     trail of eBay Seller Hub sends becomes a real product requirement
--     later (once automatic Save Draft is enabled and
--     ebay_seller_hub_draft_confirmed_at starts being set), the right fix
--     is a soft-delete/archival column on listing_drafts itself — never
--     changing these FKs to RESTRICT/SET NULL, which would just move the
--     same orphaned-row problem into a different failure mode (a listing
--     that refuses to delete, or a batch item pointing at nothing).
create table if not exists public.ebay_extension_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.ebay_extension_batches (id)
    on delete cascade,
  marketplace_draft_id uuid not null
    references public.listing_marketplace_drafts (id)
    on delete cascade,
  product_draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,

  queue_position integer not null,

  status text not null default 'queued'
    check (status in ('queued', 'preparing', 'filling', 'waiting_for_review', 'failed', 'cancelled')),

  attempt_count integer not null default 0,

  error_code text,
  error_message text,
  current_step text,
  step_detail text,

  ebay_seller_hub_draft_confirmed_at timestamptz,

  started_at timestamptz,
  completed_at timestamptz,

  -- CORRECTIVE PASS 6 (retry truthfulness review) — attempt lineage.
  -- NULL for a first attempt; for a retry, points at the PREVIOUS attempt's
  -- own row for the same listing. Populated ONLY by
  -- listing_studio_create_ebay_extension_batch itself (see that function's
  -- own comment), which looks up the most recent genuinely 'failed' item
  -- for this owner+listing — never supplied by a caller, never written by
  -- any other path. Deliberately `on delete set null`, NOT cascade: the
  -- OLD failed row is immutable history (this column is the only thing
  -- that ever references it going forward); if that old row is ever
  -- removed for an unrelated reason, the lineage link simply disappears —
  -- the NEW row itself must never be deleted just because its ancestor was.
  retry_of_item_id uuid
    references public.ebay_extension_batch_items (id)
    on delete set null,

  unique (batch_id, marketplace_draft_id),
  unique (batch_id, queue_position)
);

create index if not exists ebay_extension_batch_items_batch_idx
  on public.ebay_extension_batch_items (batch_id, queue_position);

-- DATABASE-LEVEL INVARIANT (see this file's own top comment) — at most one
-- LIVE (not failed, not cancelled) row per marketplace_draft_id may exist
-- across ALL of this listing's eBay extension batches, ever, enforced by
-- Postgres itself. 'waiting_for_review' is deliberately INCLUDED in what
-- counts as live here (matching Defect 2's own fix) — a listing waiting
-- for review still has a real, populated Seller Hub tab open and must stay
-- protected. This is independent of, and a hard backstop for,
-- listing_studio_create_ebay_extension_batch's own conflict check below —
-- even a direct INSERT that bypasses the RPC entirely cannot violate it.
create unique index if not exists ebay_extension_batch_items_live_draft_idx
  on public.ebay_extension_batch_items (marketplace_draft_id)
  where status not in ('failed', 'cancelled');

alter table public.ebay_extension_batch_items enable row level security;
revoke all on public.ebay_extension_batch_items from anon, authenticated;

-- CORRECTIVE PASS (blocking-batch visibility review) — the ONE
-- authoritative definition of "this eBay extension item currently blocks
-- a new send for its listing". Before this, the create RPC's own conflict
-- check and the app's GET-batches route each computed "active" with their
-- OWN independent boolean logic — the create RPC never checked expires_at
-- at all (correctly: a batch is still genuinely active, and must still
-- block a duplicate send, the instant before its pairing window elapses),
-- while the GET route excluded ANY 'pending_claim' batch whose expires_at
-- had passed, REGARDLESS of whether its status column had actually been
-- flipped to 'expired' yet (nothing does that until something calls
-- listing_studio_expire_ebay_extension_batch — a read, by itself, never
-- reconciles it). The result: a batch that had just crossed its own
-- expiry, but was never claimed and never went through the expire RPC,
-- could be genuinely STILL BLOCKING (conflict check: status column still
-- says 'pending_claim', so "active") while being COMPLETELY INVISIBLE in
-- the app (GET route: same status column, but expires_at already passed,
-- so filtered out) — exactly the reported "cannot inspect or remove the
-- blocking batch" bug. A single `plpgsql` function (not `sql`)
-- deliberately, so this file's own structural tests can find and parse
-- its body the same way as every other function here.
create or replace function public.listing_studio_is_ebay_extension_item_active(
  p_batch_status text,
  p_item_status text
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  return p_batch_status not in ('completed', 'cancelled', 'expired')
     and p_item_status not in ('failed', 'cancelled');
end;
$$;

revoke all on function public.listing_studio_is_ebay_extension_item_active(text, text) from public;
do $$
begin
  revoke all on function public.listing_studio_is_ebay_extension_item_active(text, text) from anon, authenticated;
  grant execute on function public.listing_studio_is_ebay_extension_item_active(text, text) to service_role;
end $$;

-- Mirrors listing_studio_create_extension_batch's own advisory-lock +
-- sequential-display-number pattern (supabase-listing-studio.sql) — see
-- this file's own top comment for the two defects fixed relative to the
-- original draft of this function.
create or replace function public.listing_studio_create_ebay_extension_batch(
  p_owner_id uuid,
  p_pairing_code_hash text,
  p_expires_at timestamptz,
  p_marketplace_draft_ids uuid[]
)
returns table(batch_id uuid, display_number integer, retry_of_item_id uuid)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_display_number integer;
  v_marketplace_draft_id uuid;
  v_product_draft_id uuid;
  v_conflicting_draft uuid;
  v_conflicting_batch_id uuid;
  v_inserted_count integer;
  v_distinct_count integer;
  v_retry_of_item_id uuid;
begin
  -- ---- Basic argument validation — BEFORE anything touches the tables. ----
  if p_owner_id is null then
    raise exception 'OWNER_ID_REQUIRED' using errcode = 'P0001';
  end if;
  if p_pairing_code_hash is null or length(btrim(p_pairing_code_hash)) = 0 then
    raise exception 'PAIRING_CODE_HASH_REQUIRED' using errcode = 'P0001';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'EXPIRY_MUST_BE_FUTURE' using errcode = 'P0001';
  end if;
  -- An appropriate maximum lifetime — mirrors
  -- EBAY_EXTENSION_BATCH_EXPIRY_SECONDS (10 minutes) in
  -- lib/listing-studio/ebay-extension-batch-schema.ts with generous
  -- headroom (1 hour), so a legitimate slow clock/network never rejects a
  -- real request, while a caller passing a wildly-distant expiry (a bug, or
  -- an attempt to mint a long-lived pairing code) is refused outright.
  if p_expires_at > now() + interval '1 hour' then
    raise exception 'EXPIRY_TOO_FAR_IN_FUTURE' using errcode = 'P0001';
  end if;

  -- ---- Exactly one, unique marketplace draft id (this milestone's scope). ----
  if p_marketplace_draft_ids is null or array_length(p_marketplace_draft_ids, 1) is null then
    raise exception 'NO_DRAFTS' using errcode = 'P0001';
  end if;
  if array_length(p_marketplace_draft_ids, 1) <> 1 then
    raise exception 'EXACTLY_ONE_DRAFT_REQUIRED' using errcode = 'P0001';
  end if;
  -- Defensive, not reachable today given the exactly-one check above (a
  -- single-element array can never contain a duplicate) — kept so a future
  -- relaxation of the exactly-one constraint inherits duplicate protection
  -- automatically rather than silently losing it.
  select count(distinct x) into v_distinct_count from unnest(p_marketplace_draft_ids) as x;
  if v_distinct_count <> array_length(p_marketplace_draft_ids, 1) then
    raise exception 'DUPLICATE_DRAFT_IDS' using errcode = 'P0001';
  end if;

  v_marketplace_draft_id := p_marketplace_draft_ids[1];

  -- Owner-scoped serialization — every create-batch call for the SAME
  -- owner (including their very first batch ever) is fully serialized
  -- against every other one, without blocking any other owner's calls.
  -- Released automatically when this function returns or raises.
  perform pg_advisory_xact_lock(hashtext(p_owner_id::text));

  -- ---- DEFECT 1 FIX: validate AND LOCK the exact eligible row first. ----
  -- Covers every rejection case the review asked for in one check: a
  -- nonexistent id, a wrong-owner id, and a non-EBAY_UK id are all
  -- indistinguishable from each other here on purpose (never revealing
  -- WHICH condition failed — see this file's own top comment on avoiding
  -- an info leak about another owner's data). `for update` takes a real
  -- row lock for the rest of this transaction, so a second concurrent call
  -- for the SAME id (even from a different owner, though that could only
  -- ever be a caller error) cannot interleave with what follows.
  select md.product_draft_id into v_product_draft_id
  from public.listing_marketplace_drafts md
  where md.id = v_marketplace_draft_id
    and md.owner_id = p_owner_id
    and md.marketplace = 'EBAY_UK'
  for update;

  if not found then
    raise exception 'DRAFT_NOT_ELIGIBLE' using errcode = 'P0003';
  end if;

  -- ---- LIFECYCLE FIX (stale-batch review): safe cleanup of an abandoned
  -- pairing code BEFORE the conflict check. Scoped to THIS owner + THIS
  -- exact listing: any batch still 'pending_claim' whose pairing-code
  -- window has genuinely elapsed (expires_at <= now()) is fully expired
  -- here — parent -> 'expired', every still-live child -> 'cancelled',
  -- both stamped completed_at — inside this same transaction and advisory
  -- lock, so an abandoned/never-entered pairing code can never leave a
  -- 'queued' child permanently occupying ebay_extension_batch_items_live_draft_idx
  -- and blocking a resend. Deliberately NEVER touches a batch that was
  -- actually claimed ('claimed'/'in_progress'/etc are all excluded by the
  -- `status = 'pending_claim'` filter) — the short pairing window ending
  -- must never kill a claimed, mid-fill or waiting-for-review operation
  -- (see this file's own new expire/cancel RPCs below for those distinct
  -- lifecycles). 'waiting_for_review' children are excluded from the child
  -- update too, as defence in depth, even though a 'pending_claim' parent
  -- can never legitimately have one.
  update public.ebay_extension_batch_items bi
  set status = 'cancelled', completed_at = now()
  from public.ebay_extension_batches b
  where bi.batch_id = b.id
    and b.owner_id = p_owner_id
    and b.status = 'pending_claim'
    and b.expires_at <= now()
    and bi.status in ('queued', 'preparing', 'filling')
    and exists (
      select 1 from public.ebay_extension_batch_items x
      where x.batch_id = b.id and x.marketplace_draft_id = v_marketplace_draft_id
    );

  update public.ebay_extension_batches b
  set status = 'expired', completed_at = coalesce(b.completed_at, now())
  where b.owner_id = p_owner_id
    and b.status = 'pending_claim'
    and b.expires_at <= now()
    and exists (
      select 1 from public.ebay_extension_batch_items x
      where x.batch_id = b.id and x.marketplace_draft_id = v_marketplace_draft_id
    );

  -- ---- DEFECT 2 FIX: 'waiting_for_review' now correctly counts as active. ----
  -- CORRECTIVE PASS (blocking-batch visibility review) — "active" is now
  -- computed via listing_studio_is_ebay_extension_item_active, the ONE
  -- authoritative definition this migration's own list RPC
  -- (listing_studio_list_ebay_extension_batches) also uses for display —
  -- see that function's own comment for exactly why two independent
  -- copies of this boolean is what let a genuinely-blocking batch go
  -- invisible in the UI while still correctly blocking a new send here.
  -- Also now captures the BLOCKING BATCH's own id, not just the draft id,
  -- so the caller can tell the user exactly which batch to look at.
  select bi.marketplace_draft_id, b.id into v_conflicting_draft, v_conflicting_batch_id
  from public.ebay_extension_batch_items bi
  join public.ebay_extension_batches b on b.id = bi.batch_id
  where bi.marketplace_draft_id = v_marketplace_draft_id
    and b.owner_id = p_owner_id
    and public.listing_studio_is_ebay_extension_item_active(b.status, bi.status)
  limit 1;

  if v_conflicting_draft is not null then
    raise exception 'DRAFT_ALREADY_IN_ACTIVE_BATCH:%', v_conflicting_batch_id using errcode = 'P0002';
  end if;

  -- CORRECTIVE PASS 6 (retry truthfulness review) — attempt lineage,
  -- entirely SERVER-DERIVED, never supplied by the caller: the most recent
  -- item for this owner+listing that is genuinely 'failed' right now
  -- (across any of this listing's past batches), if one exists. Because
  -- the conflict check above already requires every OTHER item for this
  -- listing to be 'failed' or 'cancelled' before reaching here, and a
  -- 'cancelled' item was a deliberate user action rather than an attempt
  -- that failed, this deliberately matches on 'failed' only — a genuine
  -- retry. The OLD row is only ever READ here, never written to: it stays
  -- immutable, retained history (review requirement "the previous failed
  -- record is never reset or overwritten"). NULL for a genuine first
  -- attempt, or a resend following an explicit cancellation.
  select bi.id into v_retry_of_item_id
  from public.ebay_extension_batch_items bi
  join public.ebay_extension_batches b on b.id = bi.batch_id
  where bi.marketplace_draft_id = v_marketplace_draft_id
    and b.owner_id = p_owner_id
    and bi.status = 'failed'
  order by b.created_at desc
  limit 1;

  -- Sequential-within-a-run numbering — safe under the advisory lock above
  -- (see supabase-listing-studio.sql's own identical pattern/comment for
  -- the full reasoning on why "lowest free gap" was deliberately rejected
  -- in favour of this).
  select coalesce(max(ob.display_number), 0) + 1 into v_display_number
  from public.ebay_extension_batches ob
  where ob.owner_id = p_owner_id and ob.box_dismissed_at is null;

  insert into public.ebay_extension_batches (owner_id, pairing_code_hash, expires_at, listing_count, display_number)
  values (p_owner_id, p_pairing_code_hash, p_expires_at, 1, v_display_number)
  returning id into v_batch_id;

  -- A single-row INSERT ... VALUES (never INSERT ... SELECT, which is what
  -- let the original defect insert fewer rows than the parent claimed) —
  -- plus an explicit count check immediately after, so a future edit that
  -- reintroduces a SELECT-based multi-row insert here inherits the same
  -- rollback-on-mismatch protection rather than silently losing it.
  insert into public.ebay_extension_batch_items (batch_id, marketplace_draft_id, product_draft_id, queue_position, retry_of_item_id)
  values (v_batch_id, v_marketplace_draft_id, v_product_draft_id, 0, v_retry_of_item_id);

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> 1 then
    raise exception 'ITEM_INSERT_MISMATCH' using errcode = 'P0004';
  end if;

  batch_id := v_batch_id;
  display_number := v_display_number;
  retry_of_item_id := v_retry_of_item_id;
  return next;
end;
$$;

revoke all on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) from public;
do $$
begin
  revoke all on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) from anon, authenticated;
  grant execute on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) to service_role;
end $$;

-- ============================================================================
-- LIFECYCLE FIX (stale-batch review) — three distinct lifecycles, three
-- distinct mechanisms:
--
--   1. PAIRING-CODE CLAIM EXPIRY (short, ~10 min) — the window to type the
--      code into the extension. Enforced ONLY at the claim boundary
--      (app/api/extension/ebay-batch/claim/route.ts) and by
--      listing_studio_expire_ebay_extension_batch below. Once a batch is
--      'claimed', this window is irrelevant to it and must never expire or
--      cancel it (review requirement 4).
--
--   2. AUTHENTICATED EXTENSION-SESSION LIFETIME (medium, hours) — how long
--      the batch-scoped JWT the claim route issues stays valid, so the
--      mechanical fill (search -> category -> a human-scale manual
--      condition wait -> fill -> photo uploads) can genuinely outlast the
--      pairing window. This is the JWT's own `exp`
--      (EBAY_EXTENSION_TOKEN_LIFETIME_SECONDS in
--      lib/listing-studio/ebay-extension-batch-schema.ts), independent of
--      ebay_extension_batches.expires_at. The batch-payload / photo /
--      result / heartbeat routes gate on THIS (a valid token + a
--      'claimed'/'in_progress' status), never on expires_at.
--
--   3. ACTIVE POPULATED-FORM LIFETIME (indefinite) — a 'waiting_for_review'
--      item has a real, populated Seller Hub tab open; it stays
--      duplicate-protected with NO time-based expiry at all, released only
--      by an explicit user Cancel
--      (listing_studio_cancel_ebay_extension_batch below) or, a later
--      milestone, a confirmed save (review requirements 5 and 6).
-- ============================================================================

-- Expires ONE never-claimed batch atomically. Called by the claim route
-- (unauthenticated — it has only the batch id from its own pairing-hash
-- lookup) via the service-role client, never as two independent PATCHes.
-- A hard no-op (no rows changed, no error) for any batch not currently
-- 'pending_claim' — so a batch claimed in the race between the claim
-- route's lookup and this call is left completely untouched (review
-- requirement 4). 'waiting_for_review' children are excluded from the
-- child cancel as defence in depth (a 'pending_claim' parent can never
-- legitimately have one).
--
-- CONCURRENCY FIX (cancellation race review) — the parent row is locked
-- FIRST (`for update`), before any child row is touched, and the
-- eligibility check is re-read from that locked row rather than folded
-- into the later UPDATEs' own WHERE clauses. This is the SAME lock order
-- used by listing_studio_cancel_ebay_extension_batch and
-- listing_studio_report_ebay_extension_item_result below (see this file's
-- own top comment) — a concurrent call from either of those against the
-- SAME batch blocks here until one of the two transactions commits, then
-- the other re-reads the now-current status before deciding anything, so
-- neither can interleave with a half-finished parent/child pair.
create or replace function public.listing_studio_expire_ebay_extension_batch(
  p_batch_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_expires_at timestamptz;
begin
  select b.status, b.expires_at into v_status, v_expires_at
  from public.ebay_extension_batches b
  where b.id = p_batch_id
  for update;

  if not found or v_status <> 'pending_claim' or v_expires_at > now() then
    return;
  end if;

  update public.ebay_extension_batch_items bi
  set status = 'cancelled', completed_at = now()
  where bi.batch_id = p_batch_id
    and bi.status in ('queued', 'preparing', 'filling');

  update public.ebay_extension_batches b
  set status = 'expired', completed_at = coalesce(b.completed_at, now())
  where b.id = p_batch_id;
end;
$$;

revoke all on function public.listing_studio_expire_ebay_extension_batch(uuid) from public;
do $$
begin
  revoke all on function public.listing_studio_expire_ebay_extension_batch(uuid) from anon, authenticated;
  grant execute on function public.listing_studio_expire_ebay_extension_batch(uuid) to service_role;
end $$;

-- Explicit user Cancel — atomically cancels the parent AND every still-live
-- child (INCLUDING 'waiting_for_review', unlike the expiry RPC — this is a
-- deliberate human action, not a passive timeout), releasing the
-- duplicate-lock immediately. Owner-checked inside: the batch must belong
-- to p_owner_id or nothing happens (a hard no-op, no error — never
-- reveals whether the id exists under a different owner). A hard no-op
-- too for a batch already terminal ('completed'/'cancelled'/'expired').
-- NEVER touches listing_drafts, listing_marketplace_drafts, the legacy
-- Inventory API offer, or ebay_feed_batches — only these two extension
-- tables' own status columns (review requirement 8).
--
-- CONCURRENCY FIX (cancellation race review) — the parent row is locked
-- FIRST (`for update`), before any child row is touched, and the
-- owner/terminal-status checks are re-read from that locked row rather than
-- folded into the later UPDATEs' own WHERE clauses. This is what makes
-- Cancel win PERMANENTLY once committed: a concurrent
-- listing_studio_report_ebay_extension_item_result call for the SAME batch
-- either wins the parent lock first (in which case THIS call then sees
-- whatever status it left behind) or loses it and blocks here until this
-- transaction commits — at which point its own re-read of the parent
-- (locked in the same order) sees 'cancelled' and refuses to touch the
-- child at all (see that function's own comment). Neither call can ever
-- observe a half-committed parent/child pair.
create or replace function public.listing_studio_cancel_ebay_extension_batch(
  p_owner_id uuid,
  p_batch_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_status text;
begin
  if p_owner_id is null or p_batch_id is null then
    raise exception 'ARGUMENTS_REQUIRED' using errcode = 'P0001';
  end if;

  select b.owner_id, b.status into v_owner_id, v_status
  from public.ebay_extension_batches b
  where b.id = p_batch_id
  for update;

  if not found or v_owner_id <> p_owner_id or v_status in ('completed', 'cancelled', 'expired') then
    return;
  end if;

  update public.ebay_extension_batch_items bi
  set status = 'cancelled', completed_at = now()
  where bi.batch_id = p_batch_id
    and bi.status in ('queued', 'preparing', 'filling', 'waiting_for_review');

  update public.ebay_extension_batches b
  set status = 'cancelled', completed_at = coalesce(b.completed_at, now())
  where b.id = p_batch_id;
end;
$$;

revoke all on function public.listing_studio_cancel_ebay_extension_batch(uuid, uuid) from public;
do $$
begin
  revoke all on function public.listing_studio_cancel_ebay_extension_batch(uuid, uuid) from anon, authenticated;
  grant execute on function public.listing_studio_cancel_ebay_extension_batch(uuid, uuid) to service_role;
end $$;

-- Transactional item-result reporting — REPLACES the old direct
-- SELECT+PATCH+PATCH the HTTP route used to perform (see this file's own
-- top "CORRECTIVE PASS 4" comment for the exact race this closes). Called
-- by app/api/extension/ebay-batch/items/[itemId]/result/route.ts once per
-- extension progress/result report, via the service-role client only.
--
-- Lock order matches listing_studio_expire_ebay_extension_batch and
-- listing_studio_cancel_ebay_extension_batch exactly: the PARENT batch row
-- is locked first (`for update`), its status re-checked, and ONLY THEN is
-- the child item row locked and updated. Concretely, this enforces every
-- review requirement in one place:
--   - "A result may update an item only while its parent remains 'claimed'
--     or 'in_progress'" — checked against the freshly-locked parent row,
--     never a stale earlier read.
--   - "A result must never change a child already 'cancelled'" — checked
--     against the freshly-locked child row, after the parent lock is held,
--     so a Cancel that committed while this call was blocked on the parent
--     lock is always visible here before the child is touched.
--   - "Cancel must win permanently once committed" — a direct consequence
--     of the shared parent-first lock order: this function can never
--     observe the parent as still 'claimed'/'in_progress' AND the child as
--     already cancelled by a Cancel that has genuinely committed, because
--     both facts are updated together, in the same transaction, under the
--     same parent lock, by listing_studio_cancel_ebay_extension_batch.
--   - "Duplicate/result replays must be idempotent" — a replay that would
--     leave the child's status unchanged (including a replay AFTER
--     cancellation, which the child-already-cancelled check above also
--     catches) is a no-op that reports duplicate := true rather than
--     raising or silently reapplying side effects (attempt_count,
--     started_at, etc).
--
-- CORRECTIVE PASS 5 (state-transition guard review) — an EXPLICIT,
-- exhaustive forward-only transition table (see this file's own top
-- comment for the full defect writeup):
--     queued    -> preparing
--     preparing -> filling | failed
--     filling   -> waiting_for_review | failed
-- Any (current, requested) pair not in this table is refused as a no-op.
-- A same-status report is always accepted as an idempotent PROGRESS update
-- (current_step/step_detail refreshed) WITHOUT incrementing attempt_count —
-- only the genuine queued -> preparing transition increments it, exactly
-- once per real attempt. 'waiting_for_review', 'failed' and 'cancelled'
-- remain unconditionally terminal-for-this-RPC (unchanged from Pass 4);
-- 'cancelled' is also no longer an ACCEPTED requested status at all —
-- explicit cancellation continues through
-- listing_studio_cancel_ebay_extension_batch only.
-- Returns a single row describing the outcome so the calling route never
-- has to re-derive it with a second, separately-timed read.
create or replace function public.listing_studio_report_ebay_extension_item_result(
  p_batch_id uuid,
  p_item_id uuid,
  p_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_current_step text default null,
  p_step_detail text default null
)
returns table(item_id uuid, item_status text, batch_status text, applied boolean, duplicate boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_batch_status text;
  v_item_status text;
  v_item_attempt_count integer;
  v_item_started_at timestamptz;
  v_now timestamptz := now();
  v_new_started_at timestamptz;
  v_all_closing boolean;
  v_transition_allowed boolean;
begin
  if p_batch_id is null or p_item_id is null then
    raise exception 'ARGUMENTS_REQUIRED' using errcode = 'P0001';
  end if;
  -- CORRECTIVE PASS 5 — 'cancelled' is deliberately NOT an accepted
  -- requested status here. Explicit cancellation must continue through the
  -- dedicated Cancel RPC only.
  if p_status is null or p_status not in ('queued', 'preparing', 'filling', 'waiting_for_review', 'failed') then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;

  -- Lock the PARENT first — same order as expire/cancel above.
  select b.status into v_batch_status
  from public.ebay_extension_batches b
  where b.id = p_batch_id
  for update;

  if not found then
    raise exception 'BATCH_NOT_FOUND' using errcode = 'P0003';
  end if;

  -- THEN lock the child, scoped to this exact batch (mirrors the route's
  -- own existing "does not belong to the active batch" check).
  select bi.status, bi.attempt_count, bi.started_at
  into v_item_status, v_item_attempt_count, v_item_started_at
  from public.ebay_extension_batch_items bi
  where bi.id = p_item_id and bi.batch_id = p_batch_id
  for update;

  if not found then
    raise exception 'ITEM_NOT_FOUND' using errcode = 'P0003';
  end if;

  -- CORRECTIVE PASS 5 — ONE unconditional guard implements both
  -- "waiting_for_review -> no further result transition" and
  -- "failed/cancelled -> no further result transition" (and, unchanged
  -- from Pass 4, "a result must never change a child already 'cancelled'"
  -- / "Cancel must win permanently once committed"). Once a child reaches
  -- ANY of these three, no report — same status or different — moves it
  -- again. A stale, delayed message arriving after the item is already
  -- terminal-for-now can never reopen it.
  if v_item_status in ('waiting_for_review', 'failed', 'cancelled') then
    item_id := p_item_id; item_status := v_item_status; batch_status := v_batch_status;
    applied := false; duplicate := true;
    return next;
    return;
  end if;

  -- v_item_status is now guaranteed to be 'queued', 'preparing' or 'filling'.

  -- CORRECTIVE PASS 5 — the explicit forward-only transition table. A
  -- same-status report always falls through as an idempotent progress
  -- update (handled by the attempt_count/started_at logic below); any
  -- OTHER requested status must appear in this exact whitelist or the
  -- report is refused — covers every backward step (filling -> preparing,
  -- preparing -> queued, waiting_for_review -> filling/preparing — the
  -- last already caught by the guard above) and every out-of-order skip
  -- (queued -> filling, queued -> waiting_for_review).
  --
  -- CORRECTIVE PASS 6 (retry truthfulness review) — 'queued' -> 'failed' IS
  -- included, verified against the real extension code path rather than
  -- assumed: vinted-draft-queue-extension/service-worker.js's startEbayItem
  -- sets the item's LOCAL status to 'preparing' before any server report is
  -- sent, then dispatchEbayItem() opens/reuses the eBay tab and dispatches
  -- EBAY_FILL_LISTING to the content script — the SERVER only ever learns
  -- 'preparing' once the content script's own first step
  -- (shared/ebay-form-steps.js's report("preparing", ...)) actually runs.
  -- If tab creation or message dispatch fails silently before that (a real,
  -- possible path — see dispatchEbayItem's own comment on a missing-
  -- receiver chrome.runtime.lastError), the item's local watchdog
  -- (findStalledEbayItem) is the ONLY thing that ever reports anything for
  -- it, and it reports 'failed' directly — while the server-side row is
  -- still 'queued'. Rejecting that report would strand the item
  -- server-side forever. See this file's own top comment for the full
  -- writeup.
  if p_status <> v_item_status then
    v_transition_allowed :=
      (v_item_status = 'queued' and p_status in ('preparing', 'failed'))
      or (v_item_status = 'preparing' and p_status in ('filling', 'failed'))
      or (v_item_status = 'filling' and p_status in ('waiting_for_review', 'failed'));

    if not v_transition_allowed then
      item_id := p_item_id; item_status := v_item_status; batch_status := v_batch_status;
      applied := false; duplicate := true;
      return next;
      return;
    end if;
  end if;

  -- "A result may update an item only while its parent remains 'claimed'
  -- or 'in_progress'" — any other parent status (including a Cancel that
  -- committed while this call waited on the parent lock, or an already-
  -- completed/expired batch) refuses the update outright rather than
  -- silently resurrecting a live child under a closed batch.
  if v_batch_status not in ('claimed', 'in_progress') then
    item_id := p_item_id; item_status := v_item_status; batch_status := v_batch_status;
    applied := false; duplicate := true;
    return next;
    return;
  end if;

  v_new_started_at := case when v_item_started_at is null and p_status <> 'queued' then v_now else v_item_started_at end;

  update public.ebay_extension_batch_items
  set
    status = p_status,
    -- CORRECTIVE PASS 5 — increments ONLY on the genuine 'queued' ->
    -- 'preparing' transition (a real new attempt), never on a repeated
    -- 'preparing' -> 'preparing' progress report (the bug this pass fixes:
    -- "repeated preparing -> repeated attempt_count increments").
    attempt_count = case when v_item_status = 'queued' and p_status = 'preparing' then v_item_attempt_count + 1 else v_item_attempt_count end,
    started_at = v_new_started_at,
    completed_at = case when p_status in ('waiting_for_review', 'failed') then v_now else completed_at end,
    error_code = case when p_status = 'failed' then p_error_code else null end,
    error_message = case when p_status = 'failed' then p_error_message else null end,
    current_step = case when p_status in ('waiting_for_review', 'failed') then null else p_current_step end,
    step_detail = case when p_status in ('waiting_for_review', 'failed') then null else p_step_detail end
  where id = p_item_id and batch_id = p_batch_id;

  update public.ebay_extension_batches
  set last_extension_activity_at = v_now
  where id = p_batch_id;

  -- CORRECTIVE PASS (safety review, Defect 2's application-layer half,
  -- preserved verbatim here from the old route) — deliberately checking
  -- against 'failed'/'cancelled' only, NEVER 'waiting_for_review'. A batch
  -- only auto-closes once every item is genuinely failed/cancelled; an
  -- item merely reaching waiting_for_review keeps its batch open (and
  -- therefore keeps blocking a resend via the create RPC's own conflict
  -- check) until an explicit Cancel or a later confirmed-save milestone.
  select bool_and(bi.status in ('failed', 'cancelled')) into v_all_closing
  from public.ebay_extension_batch_items bi
  where bi.batch_id = p_batch_id;

  if v_all_closing then
    update public.ebay_extension_batches
    set status = 'completed', completed_at = coalesce(completed_at, v_now)
    where id = p_batch_id and status in ('pending_claim', 'claimed', 'in_progress');
  end if;

  item_id := p_item_id; item_status := p_status;
  select b.status into batch_status from public.ebay_extension_batches b where b.id = p_batch_id;
  applied := true; duplicate := false;
  return next;
end;
$$;

revoke all on function public.listing_studio_report_ebay_extension_item_result(uuid, uuid, text, text, text, text, text) from public;
do $$
begin
  revoke all on function public.listing_studio_report_ebay_extension_item_result(uuid, uuid, text, text, text, text, text) from anon, authenticated;
  grant execute on function public.listing_studio_report_ebay_extension_item_result(uuid, uuid, text, text, text, text, text) to service_role;
end $$;

-- CORRECTIVE PASS (blocking-batch visibility review) — the ONE query the
-- app's GET /api/listing-studio/ebay-extension-batches route uses to
-- render every one of an owner's non-dismissed eBay extension batches
-- (and their single item — this milestone's own "exactly one listing per
-- batch" scope, joined rather than a separate lookup). is_active is
-- computed via the SAME listing_studio_is_ebay_extension_item_active the
-- create RPC's own conflict check uses — a batch this function reports as
-- is_active = true is GUARANTEED to be exactly the batch that would block
-- a new send for that listing, and vice versa; there is no second,
-- independently-drifting definition anywhere. is_expired_unreconciled
-- flags a 'pending_claim' batch whose pairing window has genuinely
-- elapsed (expires_at <= now()) but whose status column hasn't been
-- flipped yet — nothing does that until something calls
-- listing_studio_expire_ebay_extension_batch, which a plain read (this
-- function) never does itself (kept a read-only `stable` SQL function
-- deliberately — see that flag's own doc on the app route, which is the
-- ONE place actually allowed to call the expire RPC as a result of
-- reading this). A hard no-op for a genuinely nonexistent/wrong owner
-- (returns zero rows, never an error) — this is a read, never a
-- capability an unauthenticated caller should ever reach (service-role
-- only, same as every other function here).
-- CORRECTIVE PASS (controlled pairing test review, Phase 4) — added
-- p_include_dismissed (default false, so every existing caller — the app
-- route's own default request — keeps its exact current behaviour
-- unchanged) so the SAME function also serves the new "Show dismissed
-- batches" toggle, rather than a second, parallel query. Dismissal
-- (box_dismissed_at) is a per-owner UI preference, never a deletion — a
-- dismissed row is still returned here whenever p_include_dismissed is
-- true, in full, with its own is_active/is_expired_unreconciled computed
-- exactly the same way as any other row.
create or replace function public.listing_studio_list_ebay_extension_batches(
  p_owner_id uuid,
  p_include_dismissed boolean default false
)
returns table(
  batch_id uuid, display_number integer, batch_status text,
  created_at timestamptz, expires_at timestamptz, claimed_at timestamptz, completed_at timestamptz,
  extension_id text, extension_version text, browser_label text,
  box_dismissed_at timestamptz, last_extension_activity_at timestamptz,
  item_id uuid, marketplace_draft_id uuid, item_status text, attempt_count integer,
  error_code text, error_message text, current_step text, step_detail text,
  item_started_at timestamptz, item_completed_at timestamptz,
  is_active boolean, is_expired_unreconciled boolean
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_owner_id is null then
    raise exception 'OWNER_ID_REQUIRED' using errcode = 'P0001';
  end if;

  return query
  select
    b.id, b.display_number, b.status,
    b.created_at, b.expires_at, b.claimed_at, b.completed_at,
    b.extension_id, b.extension_version, b.browser_label,
    b.box_dismissed_at, b.last_extension_activity_at,
    bi.id, bi.marketplace_draft_id, bi.status, bi.attempt_count,
    bi.error_code, bi.error_message, bi.current_step, bi.step_detail,
    bi.started_at, bi.completed_at,
    public.listing_studio_is_ebay_extension_item_active(b.status, bi.status),
    (b.status = 'pending_claim' and b.expires_at <= now())
  from public.ebay_extension_batches b
  join public.ebay_extension_batch_items bi on bi.batch_id = b.id
  where b.owner_id = p_owner_id
    and (p_include_dismissed or b.box_dismissed_at is null)
  order by b.created_at desc;
end;
$$;

revoke all on function public.listing_studio_list_ebay_extension_batches(uuid, boolean) from public;
do $$
begin
  revoke all on function public.listing_studio_list_ebay_extension_batches(uuid, boolean) from anon, authenticated;
  grant execute on function public.listing_studio_list_ebay_extension_batches(uuid, boolean) to service_role;
end $$;

-- CORRECTIVE PASS (controlled pairing test review, Phase 4) — clears a
-- TERMINAL batch's card from Listings Review without hard-deleting the
-- audit row: sets ONLY box_dismissed_at (an existing column on this
-- table, already read by this file's own list RPC above — this is the
-- FIRST function that ever WRITES it for an eBay extension batch). A hard
-- no-op for a genuinely active (pending_claim/claimed/in_progress) batch
-- — dismissal must never become a silent substitute for the guarded
-- Cancel action; only 'completed'/'cancelled'/'expired' can be
-- dismissed. Owner-checked exactly like cancel/expire: belongs to a
-- different owner is a hard no-op, never an error (never reveals whether
-- the id exists under a different owner). Idempotent — dismissing an
-- already-dismissed batch a second time leaves its original
-- box_dismissed_at untouched (coalesce), never resets a timestamp a
-- concurrent call already set.
create or replace function public.listing_studio_dismiss_ebay_extension_batch(
  p_owner_id uuid,
  p_batch_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_status text;
begin
  if p_owner_id is null or p_batch_id is null then
    raise exception 'ARGUMENTS_REQUIRED' using errcode = 'P0001';
  end if;

  select b.owner_id, b.status into v_owner_id, v_status
  from public.ebay_extension_batches b
  where b.id = p_batch_id
  for update;

  if not found or v_owner_id <> p_owner_id or v_status not in ('completed', 'cancelled', 'expired') then
    return;
  end if;

  update public.ebay_extension_batches b
  set box_dismissed_at = coalesce(b.box_dismissed_at, now())
  where b.id = p_batch_id;
end;
$$;

revoke all on function public.listing_studio_dismiss_ebay_extension_batch(uuid, uuid) from public;
do $$
begin
  revoke all on function public.listing_studio_dismiss_ebay_extension_batch(uuid, uuid) from anon, authenticated;
  grant execute on function public.listing_studio_dismiss_ebay_extension_batch(uuid, uuid) to service_role;
end $$;

-- READ-ONLY PERMISSION VERIFIER — run this manually in the Supabase SQL
-- editor AFTER applying the migration above (never as part of it). Expected
-- (not yet verified): every *_execute column true for service_role only
-- and false for anon/authenticated on ALL SEVEN functions, AND every
-- table-privilege boolean false for both anon and authenticated (proving
-- neither role can read either table directly, not just that they can't
-- call the functions).
--
-- select
--   has_function_privilege('anon', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as anon_execute_create,
--   has_function_privilege('authenticated', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as authenticated_execute_create,
--   has_function_privilege('service_role', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as service_role_execute_create,
--   has_function_privilege('anon', 'public.listing_studio_expire_ebay_extension_batch(uuid)', 'EXECUTE') as anon_execute_expire,
--   has_function_privilege('authenticated', 'public.listing_studio_expire_ebay_extension_batch(uuid)', 'EXECUTE') as authenticated_execute_expire,
--   has_function_privilege('service_role', 'public.listing_studio_expire_ebay_extension_batch(uuid)', 'EXECUTE') as service_role_execute_expire,
--   has_function_privilege('anon', 'public.listing_studio_cancel_ebay_extension_batch(uuid, uuid)', 'EXECUTE') as anon_execute_cancel,
--   has_function_privilege('authenticated', 'public.listing_studio_cancel_ebay_extension_batch(uuid, uuid)', 'EXECUTE') as authenticated_execute_cancel,
--   has_function_privilege('service_role', 'public.listing_studio_cancel_ebay_extension_batch(uuid, uuid)', 'EXECUTE') as service_role_execute_cancel,
--   has_function_privilege('anon', 'public.listing_studio_report_ebay_extension_item_result(uuid, uuid, text, text, text, text, text)', 'EXECUTE') as anon_execute_report_result,
--   has_function_privilege('authenticated', 'public.listing_studio_report_ebay_extension_item_result(uuid, uuid, text, text, text, text, text)', 'EXECUTE') as authenticated_execute_report_result,
--   has_function_privilege('service_role', 'public.listing_studio_report_ebay_extension_item_result(uuid, uuid, text, text, text, text, text)', 'EXECUTE') as service_role_execute_report_result,
--   has_function_privilege('anon', 'public.listing_studio_is_ebay_extension_item_active(text, text)', 'EXECUTE') as anon_execute_is_active,
--   has_function_privilege('authenticated', 'public.listing_studio_is_ebay_extension_item_active(text, text)', 'EXECUTE') as authenticated_execute_is_active,
--   has_function_privilege('service_role', 'public.listing_studio_is_ebay_extension_item_active(text, text)', 'EXECUTE') as service_role_execute_is_active,
--   has_function_privilege('anon', 'public.listing_studio_list_ebay_extension_batches(uuid, boolean)', 'EXECUTE') as anon_execute_list,
--   has_function_privilege('authenticated', 'public.listing_studio_list_ebay_extension_batches(uuid, boolean)', 'EXECUTE') as authenticated_execute_list,
--   has_function_privilege('service_role', 'public.listing_studio_list_ebay_extension_batches(uuid, boolean)', 'EXECUTE') as service_role_execute_list,
--   has_function_privilege('anon', 'public.listing_studio_dismiss_ebay_extension_batch(uuid, uuid)', 'EXECUTE') as anon_execute_dismiss,
--   has_function_privilege('authenticated', 'public.listing_studio_dismiss_ebay_extension_batch(uuid, uuid)', 'EXECUTE') as authenticated_execute_dismiss,
--   has_function_privilege('service_role', 'public.listing_studio_dismiss_ebay_extension_batch(uuid, uuid)', 'EXECUTE') as service_role_execute_dismiss,
--   has_table_privilege('anon', 'public.ebay_extension_batches', 'SELECT') as anon_select_batches,
--   has_table_privilege('authenticated', 'public.ebay_extension_batches', 'SELECT') as authenticated_select_batches,
--   has_table_privilege('anon', 'public.ebay_extension_batch_items', 'SELECT') as anon_select_items,
--   has_table_privilege('authenticated', 'public.ebay_extension_batch_items', 'SELECT') as authenticated_select_items;
