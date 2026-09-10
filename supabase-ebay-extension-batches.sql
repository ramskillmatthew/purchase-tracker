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
returns table(batch_id uuid, display_number integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_display_number integer;
  v_marketplace_draft_id uuid;
  v_product_draft_id uuid;
  v_conflicting_draft uuid;
  v_inserted_count integer;
  v_distinct_count integer;
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

  -- ---- DEFECT 2 FIX: 'waiting_for_review' now correctly counts as active. ----
  select bi.marketplace_draft_id into v_conflicting_draft
  from public.ebay_extension_batch_items bi
  join public.ebay_extension_batches b on b.id = bi.batch_id
  where bi.marketplace_draft_id = v_marketplace_draft_id
    and b.owner_id = p_owner_id
    and b.status not in ('completed', 'cancelled', 'expired')
    and bi.status not in ('failed', 'cancelled')
  limit 1;

  if v_conflicting_draft is not null then
    raise exception 'DRAFT_ALREADY_IN_ACTIVE_BATCH' using errcode = 'P0002';
  end if;

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
  insert into public.ebay_extension_batch_items (batch_id, marketplace_draft_id, product_draft_id, queue_position)
  values (v_batch_id, v_marketplace_draft_id, v_product_draft_id, 0);

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> 1 then
    raise exception 'ITEM_INSERT_MISMATCH' using errcode = 'P0004';
  end if;

  batch_id := v_batch_id;
  display_number := v_display_number;
  return next;
end;
$$;

revoke all on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) from public;
do $$
begin
  revoke all on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) from anon, authenticated;
  grant execute on function public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[]) to service_role;
end $$;

-- READ-ONLY PERMISSION VERIFIER — run this manually in the Supabase SQL
-- editor AFTER applying the migration above (never as part of it). Expected
-- (not yet verified): anon=false, authenticated=false, service_role=true
-- for the function, AND all four table-privilege booleans false for both
-- anon and authenticated (proving neither role can read either table
-- directly, not just that they can't call the function).
--
-- select
--   has_function_privilege('anon', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as anon_execute,
--   has_function_privilege('authenticated', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as authenticated_execute,
--   has_function_privilege('service_role', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as service_role_execute,
--   has_table_privilege('anon', 'public.ebay_extension_batches', 'SELECT') as anon_select_batches,
--   has_table_privilege('authenticated', 'public.ebay_extension_batches', 'SELECT') as authenticated_select_batches,
--   has_table_privilege('anon', 'public.ebay_extension_batch_items', 'SELECT') as anon_select_items,
--   has_table_privilege('authenticated', 'public.ebay_extension_batch_items', 'SELECT') as authenticated_select_items;
