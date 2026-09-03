-- Listings Review — genuine Seller Hub eBay drafts via the Sell Feed API
-- (FX_LISTING, Action=Draft only). Run manually in the Supabase SQL editor;
-- nothing in this app runs it automatically. Safe to re-run: every
-- statement is idempotent (`if not exists` / `add column if not exists`),
-- matching every other supabase-*.sql file's own convention.
--
-- ARCHITECTURE DECISION (read before touching this file): this is a NEW,
-- ADDITIVE table pair — ebay_feed_batches / ebay_feed_batch_items —
-- deliberately SEPARATE from ebay_draft_batches / ebay_draft_batch_items in
-- supabase-ebay-draft-batches.sql, which drove the Inventory API's
-- createOffer pipeline. That pipeline is RETIRED from the active
-- Create-eBay-Draft path (see lib/listing-studio/ebay-feed/README.md and
-- this application's routing — the legacy table/RPCs are left entirely
-- alone, never dropped, never renamed, still valid for their own historical
-- rows) because an Inventory API offer is never visible in eBay Seller Hub
-- and this application's actual product requirement is a genuine, editable
-- Seller Hub draft. Nothing in this file touches, reads, or migrates a
-- single row of the legacy tables.
--
-- The processing shape is intentionally DIFFERENT from the legacy
-- per-item-claim design, because a Feed API upload is inherently one
-- serial pipeline per BATCH (one CSV file -> one task -> one result file
-- covering every row in it), not independently parallelisable per item the
-- way per-item Inventory API calls were. So this migration claims and
-- advances a BATCH through its stages
-- (queued -> generating_csv -> creating_task -> uploading -> processing ->
-- downloading_result -> parsing_result -> completed | completed_with_errors
-- | failed | cancelled), and only writes individual
-- ebay_feed_batch_items rows once the task's real result file has actually
-- been downloaded and parsed — never before, because there is no such
-- thing as a "per-row remote status" until eBay's own result file exists.
--
-- Per-row correlation back to eBay's own result file is by SKU (the exact
-- "Custom label (SKU)" cell value this application wrote into the upload
-- CSV for that row — see lib/listing-studio/ebay-feed/csv-generator.ts) —
-- the one stable, always-present identifier both the upload CSV and eBay's
-- own result CSV carry for every row.

-- ---------------------------------------------------------------------
-- One additive column on the existing per-product eBay marketplace draft
-- row (see supabase-listing-studio-marketplace.sql), mirroring
-- ebay_inventory_synced_at's own "set only once genuinely confirmed" rule
-- exactly, but for THIS pipeline: set only once
-- listing_studio_finish_ebay_feed_batch_items has recorded a real
-- 'succeeded' result for this draft's row, parsed from eBay's own
-- downloaded result file — never merely because an attempt started. This
-- is the signal Create eBay drafts uses to exclude a listing that already
-- has a genuine Seller Hub draft, and is completely independent of the
-- legacy ebay_offer_id / ebay_inventory_synced_at columns above (a listing
-- could in principle have both an old, retired-pipeline Inventory API
-- offer AND a new Seller Hub draft — this application tracks them
-- separately because they are genuinely different eBay-side objects).
alter table public.listing_marketplace_drafts add column if not exists ebay_feed_draft_created_at timestamptz;
alter table public.listing_marketplace_drafts add column if not exists ebay_feed_last_error text;

create table if not exists public.ebay_feed_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,

  status text not null default 'queued'
    check (status in (
      'queued', 'generating_csv', 'creating_task', 'uploading', 'processing',
      'downloading_result', 'parsing_result',
      'completed', 'completed_with_errors', 'failed', 'cancelled'
    )),

  -- Deliberately conservative, not an eBay-imposed ceiling — keeps one
  -- CSV upload's failure blast-radius small and matches this app's own
  -- existing "select up to 25 listings" UI pattern (see
  -- ebay_draft_batches.listing_count's identical cap in
  -- supabase-ebay-draft-batches.sql). eBay's own documented per-file
  -- Feed API limits are far higher; this is this application's own
  -- choice, not a translation of an eBay limit.
  listing_count integer not null
    check (listing_count between 1 and 25),

  display_number integer not null,
  box_dismissed_at timestamptz,
  activity_dismissed_at timestamptz,

  -- Set only once lib/ebay-account/feed-client.ts's createFeedTask has
  -- returned a real task ID read back from eBay's own Location response
  -- header — never guessed, never set merely because an attempt started.
  ebay_task_id text,
  csv_row_count integer,

  attempt_count integer not null default 0,
  error_code text,
  error_message text,

  -- Same claim-with-lease shape as ebay_draft_batch_items in
  -- supabase-ebay-draft-batches.sql (see that file's own long comment for
  -- the full rationale) — applied here at the BATCH level, because the
  -- unit of work this pipeline claims and drives to completion is one
  -- whole CSV upload/task, not an individual row.
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  claimed_by text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create unique index if not exists ebay_feed_batches_owner_display_number_idx
  on public.ebay_feed_batches (owner_id, display_number)
  where box_dismissed_at is null;
create index if not exists ebay_feed_batches_owner_idx
  on public.ebay_feed_batches (owner_id, created_at desc);
-- A real eBay task ID, once recorded, can never be attached to a second
-- local batch — defence in depth alongside the application's own
-- "create the task, then immediately persist its ID before any other
-- write" ordering.
create unique index if not exists ebay_feed_batches_task_id_idx
  on public.ebay_feed_batches (ebay_task_id)
  where ebay_task_id is not null;
create index if not exists ebay_feed_batches_claimable_idx
  on public.ebay_feed_batches (status, lease_expires_at)
  where status not in ('completed', 'completed_with_errors', 'failed', 'cancelled');

alter table public.ebay_feed_batches enable row level security;
revoke all on public.ebay_feed_batches from anon, authenticated;

create table if not exists public.ebay_feed_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.ebay_feed_batches (id)
    on delete cascade,
  marketplace_draft_id uuid not null
    references public.listing_marketplace_drafts (id)
    on delete cascade,
  product_draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,

  queue_position integer not null,

  -- The exact "Custom label (SKU)" cell value written into the upload
  -- CSV's row for this item — the one field both the upload file and
  -- eBay's own downloaded result file carry for every row, and therefore
  -- the only reliable way to correlate a result row back to this item.
  sku text not null,

  status text not null default 'queued'
    check (status in ('queued', 'uploaded', 'awaiting_result', 'succeeded', 'failed', 'cancelled')),

  error_code text,
  error_message text,

  started_at timestamptz,
  completed_at timestamptz,

  unique (batch_id, marketplace_draft_id),
  unique (batch_id, sku),
  unique (batch_id, queue_position)
);

create index if not exists ebay_feed_batch_items_batch_idx
  on public.ebay_feed_batch_items (batch_id, queue_position);

alter table public.ebay_feed_batch_items enable row level security;
revoke all on public.ebay_feed_batch_items from anon, authenticated;

-- ---------------------------------------------------------------------
-- listing_studio_create_ebay_feed_batch — atomic create, mirroring
-- listing_studio_create_ebay_draft_batch's own advisory-lock + conflict-
-- check + sequential-display-number shape exactly, but conflict-checked
-- ONLY against other ebay_feed_batches rows — the legacy ebay_draft_batches
-- table is retired from active creation (see this file's own header) and
-- is deliberately never read here.
create or replace function public.listing_studio_create_ebay_feed_batch(
  p_owner_id uuid,
  p_marketplace_draft_ids uuid[],
  p_product_draft_ids uuid[],
  p_skus text[]
)
returns table(batch_id uuid, display_number integer)
language plpgsql
as $$
declare
  v_batch_id uuid;
  v_display_number integer;
  v_conflicting_draft uuid;
begin
  if p_marketplace_draft_ids is null or coalesce(array_length(p_marketplace_draft_ids, 1), 0) = 0 then
    raise exception 'NO_DRAFTS' using errcode = 'P0001';
  end if;
  if coalesce(array_length(p_marketplace_draft_ids, 1), 0) <> coalesce(array_length(p_product_draft_ids, 1), 0)
     or coalesce(array_length(p_marketplace_draft_ids, 1), 0) <> coalesce(array_length(p_skus, 1), 0) then
    raise exception 'MISMATCHED_ARRAYS' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_owner_id::text || ':ebay_feed'));

  select bi.marketplace_draft_id into v_conflicting_draft
  from public.ebay_feed_batch_items bi
  join public.ebay_feed_batches b on b.id = bi.batch_id
  where bi.marketplace_draft_id = any(p_marketplace_draft_ids)
    and b.owner_id = p_owner_id
    and b.status not in ('completed', 'completed_with_errors', 'failed', 'cancelled')
    and bi.status not in ('succeeded', 'failed', 'cancelled')
  limit 1;

  if v_conflicting_draft is not null then
    raise exception 'DRAFT_ALREADY_IN_ACTIVE_EBAY_FEED_BATCH' using errcode = 'P0002', detail = v_conflicting_draft::text;
  end if;

  select coalesce(max(fb.display_number), 0) + 1 into v_display_number
  from public.ebay_feed_batches fb
  where fb.owner_id = p_owner_id and fb.box_dismissed_at is null;

  insert into public.ebay_feed_batches (owner_id, status, listing_count, created_at, display_number)
  values (p_owner_id, 'queued', array_length(p_marketplace_draft_ids, 1), now(), v_display_number)
  returning id into v_batch_id;

  insert into public.ebay_feed_batch_items (batch_id, marketplace_draft_id, product_draft_id, queue_position, sku, status)
  select v_batch_id, d.marketplace_draft_id, d.product_draft_id, d.ord - 1, d.sku, 'queued'
  from (
    select unnest(p_marketplace_draft_ids) as marketplace_draft_id, unnest(p_product_draft_ids) as product_draft_id,
           unnest(p_skus) as sku, generate_subscripts(p_marketplace_draft_ids, 1) as ord
  ) d;

  batch_id := v_batch_id;
  display_number := v_display_number;
  return next;
end;
$$;

revoke all on function public.listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[]) from public;

-- ---------------------------------------------------------------------
-- listing_studio_latest_ebay_feed_status — the Feed-pipeline equivalent of
-- listing_studio_latest_ebay_draft_status: one row per marketplace draft,
-- its most recent (non-cancelled) batch-item status across every eBay feed
-- batch this owner has ever created.
create or replace function public.listing_studio_latest_ebay_feed_status(p_owner_id uuid)
returns table (
  marketplace_draft_id uuid,
  batch_id uuid,
  batch_status text,
  item_status text,
  queue_position integer,
  ebay_task_id text,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz
)
language sql
stable
as $$
  select distinct on (bi.marketplace_draft_id)
    bi.marketplace_draft_id,
    b.id as batch_id,
    b.status as batch_status,
    bi.status as item_status,
    bi.queue_position,
    b.ebay_task_id,
    bi.error_code,
    bi.error_message,
    bi.started_at,
    bi.completed_at
  from public.ebay_feed_batch_items bi
  join public.ebay_feed_batches b on b.id = bi.batch_id
  where b.owner_id = p_owner_id
    and bi.status <> 'cancelled'
  order by bi.marketplace_draft_id, greatest(bi.completed_at, bi.started_at, b.created_at) desc, b.created_at desc, bi.id desc;
$$;

revoke all on function public.listing_studio_latest_ebay_feed_status(uuid) from public;

-- ---------------------------------------------------------------------
-- listing_studio_claim_ebay_feed_batches — claims at most p_limit whole
-- BATCHES (never individual items — see this file's own header for why),
-- atomically, via the same `for update skip locked` + lease-expiry pattern
-- as listing_studio_claim_ebay_draft_batch_items. An item-level claim is
-- unnecessary here: only one worker ever drives a given batch's task
-- lifecycle at a time, so claiming the batch is claiming all the work.
create or replace function public.listing_studio_claim_ebay_feed_batches(
  p_owner_id uuid,
  p_batch_id uuid default null,
  p_limit integer default 1,
  p_claimed_by text default null,
  p_lease_seconds integer default 120
)
returns table (
  batch_id uuid, status text, ebay_task_id text, attempt_count integer, listing_count integer
)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_lease_expires timestamptz := now() + make_interval(secs => greatest(p_lease_seconds, 1));
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'INVALID_LIMIT' using errcode = 'P0001';
  end if;

  return query
  with claimable as (
    select b.id
    from public.ebay_feed_batches b
    where b.owner_id = p_owner_id
      and (p_batch_id is null or b.id = p_batch_id)
      and b.status not in ('completed', 'completed_with_errors', 'failed', 'cancelled')
      and (b.claimed_at is null or b.lease_expires_at < v_now)
    order by b.created_at asc
    limit p_limit
    for update of b skip locked
  )
  update public.ebay_feed_batches b
  set claimed_at = v_now, lease_expires_at = v_lease_expires, claimed_by = p_claimed_by,
      started_at = coalesce(b.started_at, v_now),
      attempt_count = b.attempt_count + 1
  from claimable
  where b.id = claimable.id
  returning b.id, b.status, b.ebay_task_id, b.attempt_count, b.listing_count;
end;
$$;

revoke all on function public.listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer) from public;

-- ---------------------------------------------------------------------
-- listing_studio_advance_ebay_feed_batch — the ONE state-transition
-- function every stage of the background worker calls
-- (generating_csv -> creating_task -> uploading -> processing ->
-- downloading_result -> parsing_result -> a terminal status). Requires the
-- caller to present the exact claimed_by token the claim call returned —
-- protects against a stale/crashed worker whose lease has since expired
-- and been reclaimed by someone else from ever clobbering a newer claim's
-- work (raises CLAIM_NOT_HELD rather than silently no-op-ing, so a caller
-- can distinguish "this failed" from "I no longer own this").
--
-- ALWAYS releases the claim (claimed_at/lease_expires_at/claimed_by all
-- reset to null), on a terminal status AND on a non-terminal one alike —
-- mirroring listing_studio_claim_ebay_draft_batch_items's own item-level
-- "release after every step, whether terminal or not" discipline in
-- supabase-ebay-draft-batches.sql (see lib/listing-studio/ebay-draft-batches.ts's
-- own releaseClaim). The lease exists ONLY to protect against a worker
-- that crashes mid-step (between claiming and this call); once a step's
-- progress is successfully persisted here, there is no reason to keep
-- holding the batch — releasing immediately is what lets the very next
-- tick (however soon it's actually invoked; that pacing is entirely the
-- caller's own choice, never enforced here) continue the pipeline without
-- an artificial wait for a lease that was never protecting anything at
-- that point.
create or replace function public.listing_studio_advance_ebay_feed_batch(
  p_batch_id uuid,
  p_claimed_by text,
  p_status text,
  p_ebay_task_id text default null,
  p_csv_row_count integer default null,
  p_error_code text default null,
  p_error_message text default null,
  p_lease_seconds integer default 120
)
returns void
language plpgsql
as $$
declare
  v_is_terminal boolean := p_status in ('completed', 'completed_with_errors', 'failed', 'cancelled');
  v_now timestamptz := now();
  v_updated integer;
begin
  if p_status not in (
    'queued', 'generating_csv', 'creating_task', 'uploading', 'processing',
    'downloading_result', 'parsing_result',
    'completed', 'completed_with_errors', 'failed', 'cancelled'
  ) then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;

  update public.ebay_feed_batches b
  set status = p_status,
      ebay_task_id = coalesce(p_ebay_task_id, b.ebay_task_id),
      csv_row_count = coalesce(p_csv_row_count, b.csv_row_count),
      error_code = case when p_status in ('failed', 'completed_with_errors') then p_error_code else b.error_code end,
      error_message = case when p_status in ('failed', 'completed_with_errors') then p_error_message else b.error_message end,
      lease_expires_at = null,
      claimed_at = null,
      claimed_by = null,
      completed_at = case when v_is_terminal then v_now else b.completed_at end
  where b.id = p_batch_id
    and b.claimed_by = p_claimed_by;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'CLAIM_NOT_HELD' using errcode = 'P0003';
  end if;
end;
$$;

revoke all on function public.listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer) from public;

-- ---------------------------------------------------------------------
-- listing_studio_finish_ebay_feed_batch_items — bulk-records the real,
-- per-row outcome parsed from eBay's own downloaded result file, correlated
-- by SKU (see this file's own header on why SKU is the correlation key).
-- p_results is a jsonb array of {"sku": text, "status": "succeeded"|"failed",
-- "error_code": text|null, "error_message": text|null}. Same claimed_by
-- ownership check as listing_studio_advance_ebay_feed_batch, for the same
-- reason. A SKU present in p_results with no matching row for this batch is
-- silently a no-op (the WHERE join simply matches nothing) — never an
-- error, since eBay's result file is the authority on what it processed,
-- not this table's own row set.
create or replace function public.listing_studio_finish_ebay_feed_batch_items(
  p_batch_id uuid,
  p_claimed_by text,
  p_results jsonb
)
returns void
language plpgsql
as $$
declare
  v_owner_id uuid;
  v_now timestamptz := now();
begin
  select owner_id into v_owner_id
  from public.ebay_feed_batches
  where id = p_batch_id and claimed_by = p_claimed_by;

  if v_owner_id is null then
    raise exception 'CLAIM_NOT_HELD' using errcode = 'P0003';
  end if;

  update public.ebay_feed_batch_items bi
  set status = r.status,
      error_code = r.error_code,
      error_message = r.error_message,
      completed_at = v_now
  from jsonb_to_recordset(p_results) as r(sku text, status text, error_code text, error_message text)
  where bi.batch_id = p_batch_id
    and bi.sku = r.sku
    and r.status in ('succeeded', 'failed');
end;
$$;

revoke all on function public.listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb) from public;

-- listing_studio_owners_with_claimable_ebay_feed_work — the bounded lookup
-- a future/cron sweep uses to find WHICH owners currently have claimable
-- eBay feed batch work, without scanning every owner in the system on every
-- tick. Read-only.
create or replace function public.listing_studio_owners_with_claimable_ebay_feed_work(p_limit integer default 20)
returns table (owner_id uuid)
language sql
stable
as $$
  select distinct b.owner_id
  from public.ebay_feed_batches b
  where b.status not in ('completed', 'completed_with_errors', 'failed', 'cancelled')
    and (b.claimed_at is null or b.lease_expires_at < now())
  limit greatest(p_limit, 1);
$$;

revoke all on function public.listing_studio_owners_with_claimable_ebay_feed_work(integer) from public;

-- ============================================================================
-- FUNCTION EXECUTION LOCKDOWN — identical pattern and rationale to
-- supabase-ebay-draft-batches.sql's own "FUNCTION EXECUTION LOCKDOWN"
-- section; see that file's comment for the full explanation of why step 3
-- (the explicit service_role grant) is not optional.
-- ============================================================================
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[]) from anon;
    revoke all on function public.listing_studio_latest_ebay_feed_status(uuid) from anon;
    revoke all on function public.listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer) from anon;
    revoke all on function public.listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer) from anon;
    revoke all on function public.listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb) from anon;
    revoke all on function public.listing_studio_owners_with_claimable_ebay_feed_work(integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[]) from authenticated;
    revoke all on function public.listing_studio_latest_ebay_feed_status(uuid) from authenticated;
    revoke all on function public.listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer) from authenticated;
    revoke all on function public.listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer) from authenticated;
    revoke all on function public.listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb) from authenticated;
    revoke all on function public.listing_studio_owners_with_claimable_ebay_feed_work(integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[]) to service_role;
    grant execute on function public.listing_studio_latest_ebay_feed_status(uuid) to service_role;
    grant execute on function public.listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer) to service_role;
    grant execute on function public.listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer) to service_role;
    grant execute on function public.listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb) to service_role;
    grant execute on function public.listing_studio_owners_with_claimable_ebay_feed_work(integer) to service_role;
  end if;
end $$;
