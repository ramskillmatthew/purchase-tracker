-- Listings Review — eBay draft batches (Stage 6). Run manually in the
-- Supabase SQL editor; nothing in this app runs it automatically. Safe to
-- re-run: every statement is idempotent (`if not exists` / `add column if
-- not exists`), matching every other supabase-*.sql file's own convention.
--
-- ARCHITECTURE DECISION (read before touching this file): this deliberately
-- mirrors supabase-listing-studio.sql's own vinted_extension_batches /
-- vinted_extension_batch_items / listing_studio_create_extension_batch /
-- listing_studio_latest_extension_status pattern as closely as the two
-- systems' real differences allow — same "batch + items, one RPC to create
-- atomically, one RPC to read the latest status per item, box/activity
-- soft-dismiss" shape. The genuine differences: an eBay batch has no
-- browser-extension pairing code (this app calls eBay's own API directly,
-- server-side, so there is nothing to "pair" with), and its item status
-- vocabulary reflects real eBay Inventory API steps
-- (uploading_photos/creating_inventory_item/creating_draft/verifying_draft)
-- rather than a remote-controlled browser form-fill.
--
-- Batch numbering ("Batch N") is INDEPENDENT of the Vinted extension
-- batches' own numbering — a separate per-owner sequence on this table,
-- not a shared counter across both marketplaces. This is a deliberate,
-- disclosed simplification: sharing one sequence across two independent
-- tables would need a second, cross-table advisory-lock/unique-index
-- scheme for a purely cosmetic label, which is not worth the extra
-- complexity/risk this stage would otherwise avoid.

-- ---------------------------------------------------------------------
-- eBay-specific columns on the existing per-product eBay marketplace draft
-- row (see supabase-listing-studio-marketplace.sql's listing_marketplace_drafts
-- for why eBay content already lives there rather than in a new table).
-- Additive only — every column defaults to null/empty so no existing row
-- needs backfilling and no existing read path is affected.
alter table public.listing_marketplace_drafts add column if not exists ebay_fulfillment_policy_id text;
alter table public.listing_marketplace_drafts add column if not exists ebay_return_policy_id text;
alter table public.listing_marketplace_drafts add column if not exists ebay_payment_policy_id text;
alter table public.listing_marketplace_drafts add column if not exists ebay_merchant_location_key text;

-- Set only once eBay's own Inventory API has confirmed an offer exists (a
-- real id read back from eBay's own createOffer response) — never guessed,
-- never set merely because a create attempt was started. Presence of this
-- column is exactly "this SKU already has an eBay draft" — the signal
-- Create eBay drafts uses to exclude an already-drafted listing.
alter table public.listing_marketplace_drafts add column if not exists ebay_offer_id text;
alter table public.listing_marketplace_drafts add column if not exists ebay_inventory_synced_at timestamptz;
alter table public.listing_marketplace_drafts add column if not exists ebay_last_draft_error text;

-- Per-photo upload state for THIS marketplace draft's eBay draft attempt —
-- { [imageId]: { status: 'pending'|'uploading'|'uploaded'|'failed', url,
-- checkedAt, error } } — see lib/listing-studio/ebay-draft-batches.ts. Never
-- a second copy of the photo itself; only its eBay-facing transfer state.
alter table public.listing_marketplace_drafts add column if not exists ebay_photo_state_json jsonb not null default '{}'::jsonb;

-- UNIQUE (not just indexed) — a real database-level guarantee that the
-- same eBay offer id can never be recorded against two different local
-- marketplace drafts, defense in depth alongside the application-level
-- "check for an existing offer by SKU before creating a new one" logic in
-- lib/ebay-account/inventory-client.ts's getOffersBySku.
create unique index if not exists listing_marketplace_drafts_ebay_offer_idx
  on public.listing_marketplace_drafts (ebay_offer_id)
  where ebay_offer_id is not null;

-- ---------------------------------------------------------------------
-- Synced eBay inventory (merchant) locations — mirrors ebay_policies'
-- exact shape/conventions (see supabase-ebay-account-connection.sql).
-- Read-only sync: this app never creates/edits/enables/disables/deletes a
-- location, only reads and displays whatever the connected account already
-- has configured on eBay's side.
create table if not exists public.ebay_inventory_locations (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.ebay_connections (id)
    on delete cascade,
  owner_id uuid not null,

  merchant_location_key text not null,
  name text,
  status text,
  address_summary text,

  available boolean not null default true,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (connection_id, merchant_location_key)
);

create index if not exists ebay_inventory_locations_connection_idx
  on public.ebay_inventory_locations (connection_id, available);

alter table public.ebay_inventory_locations enable row level security;
revoke all on public.ebay_inventory_locations from anon, authenticated;

-- ---------------------------------------------------------------------
-- ebay_draft_batches / ebay_draft_batch_items — see this file's own header
-- for how closely this mirrors vinted_extension_batches/_items.
create table if not exists public.ebay_draft_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,

  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'cancelled')),

  listing_count integer not null
    check (listing_count between 1 and 25),

  display_number integer not null,
  box_dismissed_at timestamptz,
  activity_dismissed_at timestamptz,

  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists ebay_draft_batches_owner_display_number_idx
  on public.ebay_draft_batches (owner_id, display_number)
  where box_dismissed_at is null;
create index if not exists ebay_draft_batches_owner_idx
  on public.ebay_draft_batches (owner_id, created_at desc);

alter table public.ebay_draft_batches enable row level security;
revoke all on public.ebay_draft_batches from anon, authenticated;

create table if not exists public.ebay_draft_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.ebay_draft_batches (id)
    on delete cascade,
  marketplace_draft_id uuid not null
    references public.listing_marketplace_drafts (id)
    on delete cascade,
  product_draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,

  queue_position integer not null,

  status text not null default 'queued'
    check (status in ('queued', 'uploading_photos', 'creating_inventory_item', 'creating_draft', 'verifying_draft', 'completed', 'failed', 'cancelled')),

  attempt_count integer not null default 0,

  error_code text,
  error_message text,

  -- Only ever set once eBay's own createOffer response has confirmed an
  -- offer id — same "real, confirmed, never guessed" rule as the parent
  -- draft's own ebay_offer_id column above (this is a per-attempt copy for
  -- this batch item's own audit trail).
  ebay_offer_id text,

  -- Corrective pass — persistent, resumable, claim-based processing
  -- (replaces the earlier fire-and-forget in-process loop entirely; see
  -- rpc/listing_studio_claim_ebay_draft_batch_items below). claimed_at/
  -- lease_expires_at/claimed_by together make "claim atomically, hold a
  -- time-bounded lease, allow safe reclaim once the lease expires" a real
  -- database-level guarantee rather than an in-memory assumption — the
  -- SAME invariant this app's own vinted_extension_batches already relies
  -- on for a DIFFERENT reason (an external browser extension can vanish
  -- silently); here it protects against two concurrent process-tick
  -- invocations (two open tabs, or a tab plus a cron tick) racing the same
  -- item. claimed_by is a short opaque per-invocation label — diagnostic
  -- only, never a security/authorization boundary (ownership is enforced
  -- by the RPC's own owner_id-scoped query, exactly like every other
  -- claim/lock pattern in this codebase).
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  claimed_by text,

  started_at timestamptz,
  completed_at timestamptz,

  unique (batch_id, marketplace_draft_id),
  unique (batch_id, queue_position)
);

create index if not exists ebay_draft_batch_items_batch_idx
  on public.ebay_draft_batch_items (batch_id, queue_position);
-- Supports the claim RPC's own "find claimable items across every
-- non-terminal batch" query pattern (used by the cron tick, which is not
-- scoped to one batch_id) without a sequential scan.
create index if not exists ebay_draft_batch_items_claimable_idx
  on public.ebay_draft_batch_items (status, lease_expires_at)
  where status not in ('completed', 'failed', 'cancelled');

alter table public.ebay_draft_batch_items enable row level security;
revoke all on public.ebay_draft_batch_items from anon, authenticated;

-- ---------------------------------------------------------------------
-- listing_studio_create_ebay_draft_batch — atomic create, mirroring
-- listing_studio_create_extension_batch exactly (advisory per-owner lock,
-- conflict check against any OTHER still-live eBay batch already holding
-- one of the same marketplace drafts, sequential-within-a-run display
-- number allocation). No pairing code / expiry — an eBay batch is
-- processed by this application's own server code, not claimed by an
-- external browser extension.
create or replace function public.listing_studio_create_ebay_draft_batch(
  p_owner_id uuid,
  p_marketplace_draft_ids uuid[],
  p_product_draft_ids uuid[]
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
  if coalesce(array_length(p_marketplace_draft_ids, 1), 0) <> coalesce(array_length(p_product_draft_ids, 1), 0) then
    raise exception 'MISMATCHED_ARRAYS' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_owner_id::text || ':ebay'));

  select bi.marketplace_draft_id into v_conflicting_draft
  from public.ebay_draft_batch_items bi
  join public.ebay_draft_batches b on b.id = bi.batch_id
  where bi.marketplace_draft_id = any(p_marketplace_draft_ids)
    and b.owner_id = p_owner_id
    and b.status not in ('completed', 'cancelled')
    and bi.status not in ('completed', 'failed', 'cancelled')
  limit 1;

  if v_conflicting_draft is not null then
    raise exception 'DRAFT_ALREADY_IN_ACTIVE_EBAY_BATCH' using errcode = 'P0002', detail = v_conflicting_draft::text;
  end if;

  select coalesce(max(ob.display_number), 0) + 1 into v_display_number
  from public.ebay_draft_batches ob
  where ob.owner_id = p_owner_id and ob.box_dismissed_at is null;

  insert into public.ebay_draft_batches (owner_id, status, listing_count, created_at, display_number)
  values (p_owner_id, 'pending', array_length(p_marketplace_draft_ids, 1), now(), v_display_number)
  returning id into v_batch_id;

  insert into public.ebay_draft_batch_items (batch_id, marketplace_draft_id, product_draft_id, queue_position, status)
  select v_batch_id, d.marketplace_draft_id, d.product_draft_id, d.ord - 1, 'queued'
  from (
    select unnest(p_marketplace_draft_ids) as marketplace_draft_id, unnest(p_product_draft_ids) as product_draft_id, generate_subscripts(p_marketplace_draft_ids, 1) as ord
  ) d;

  batch_id := v_batch_id;
  display_number := v_display_number;
  return next;
end;
$$;

revoke all on function public.listing_studio_create_ebay_draft_batch(uuid, uuid[], uuid[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.listing_studio_create_ebay_draft_batch(uuid, uuid[], uuid[]) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.listing_studio_create_ebay_draft_batch(uuid, uuid[], uuid[]) from authenticated; end if;
end $$;

-- ---------------------------------------------------------------------
-- listing_studio_latest_ebay_draft_status — the eBay equivalent of
-- listing_studio_latest_extension_status: one row per marketplace draft,
-- its most recent (non-cancelled) batch-item status across every eBay
-- draft batch this owner has ever created.
create or replace function public.listing_studio_latest_ebay_draft_status(p_owner_id uuid)
returns table (
  marketplace_draft_id uuid,
  batch_id uuid,
  batch_status text,
  item_status text,
  queue_position integer,
  error_code text,
  error_message text,
  ebay_offer_id text,
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
    bi.error_code,
    bi.error_message,
    bi.ebay_offer_id,
    bi.started_at,
    bi.completed_at
  from public.ebay_draft_batch_items bi
  join public.ebay_draft_batches b on b.id = bi.batch_id
  where b.owner_id = p_owner_id
    and bi.status <> 'cancelled'
  order by bi.marketplace_draft_id, greatest(bi.completed_at, bi.started_at, b.created_at) desc, b.created_at desc, bi.id desc;
$$;

revoke all on function public.listing_studio_latest_ebay_draft_status(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.listing_studio_latest_ebay_draft_status(uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.listing_studio_latest_ebay_draft_status(uuid) from authenticated; end if;
end $$;

-- ---------------------------------------------------------------------
-- Corrective pass — listing_studio_claim_ebay_draft_batch_items: the ONE
-- atomic claim operation the whole persistent/resumable processing model
-- depends on. Replaces the earlier fire-and-forget
-- lib/listing-studio/ebay-draft-batches.ts processEbayDraftBatch (an
-- unawaited promise that processed an entire batch to completion inside
-- one request handler — safe only on a long-lived local `next dev`
-- process, and explicitly disclosed as unsuitable for a real serverless
-- deployment). This RPC instead claims AT MOST p_limit items — never a
-- whole batch — atomically: `for update skip locked` inside the same
-- transaction as the UPDATE means two concurrent invocations (two open
-- tabs, or a tab racing a cron tick) can never claim the same row, no
-- matter how close together they run. A claim is only valid for
-- p_lease_seconds; an item whose lease has expired (the claiming
-- invocation crashed, was killed, or simply never finished) becomes
-- claimable again automatically — no separate "unstick" action needed,
-- unlike the Vinted extension batches' own manual recovery flow (that one
-- protects against a genuinely external, unaccountable actor going
-- silent; this one only ever protects against THIS application's own
-- short-lived server invocations).
--
-- Deliberately NOT scoped to one batch_id — p_batch_id is optional
-- (null = claim across every one of this owner's non-terminal batches,
-- oldest queue position first) so the SAME function serves both the
-- per-batch "process this batch" API route and a future/cron-driven
-- sweep across all of an owner's outstanding work, without a second
-- near-duplicate RPC.
create or replace function public.listing_studio_claim_ebay_draft_batch_items(
  p_owner_id uuid,
  p_batch_id uuid default null,
  p_limit integer default 3,
  p_claimed_by text default null,
  p_lease_seconds integer default 120
)
returns table (
  item_id uuid, batch_id uuid, marketplace_draft_id uuid, product_draft_id uuid,
  status text, attempt_count integer, queue_position integer
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
    select bi.id
    from public.ebay_draft_batch_items bi
    join public.ebay_draft_batches b on b.id = bi.batch_id
    where b.owner_id = p_owner_id
      and (p_batch_id is null or bi.batch_id = p_batch_id)
      and bi.status not in ('completed', 'failed', 'cancelled')
      and (bi.claimed_at is null or bi.lease_expires_at < v_now)
    order by b.created_at asc, bi.queue_position asc
    limit p_limit
    for update of bi skip locked
  )
  update public.ebay_draft_batch_items bi
  set claimed_at = v_now, lease_expires_at = v_lease_expires, claimed_by = p_claimed_by,
      started_at = coalesce(bi.started_at, v_now)
  from claimable
  where bi.id = claimable.id
  returning bi.id, bi.batch_id, bi.marketplace_draft_id, bi.product_draft_id, bi.status, bi.attempt_count, bi.queue_position;
end;
$$;

revoke all on function public.listing_studio_claim_ebay_draft_batch_items(uuid, uuid, integer, text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.listing_studio_claim_ebay_draft_batch_items(uuid, uuid, integer, text, integer) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.listing_studio_claim_ebay_draft_batch_items(uuid, uuid, integer, text, integer) from authenticated; end if;
end $$;

-- listing_studio_owners_with_claimable_ebay_work — the bounded lookup a
-- future/cron sweep uses to find WHICH owners currently have claimable
-- eBay batch work, without scanning every owner in the system on every
-- tick. Read-only.
create or replace function public.listing_studio_owners_with_claimable_ebay_work(p_limit integer default 20)
returns table (owner_id uuid)
language sql
stable
as $$
  select distinct b.owner_id
  from public.ebay_draft_batch_items bi
  join public.ebay_draft_batches b on b.id = bi.batch_id
  where bi.status not in ('completed', 'failed', 'cancelled')
    and (bi.claimed_at is null or bi.lease_expires_at < now())
  limit greatest(p_limit, 1);
$$;

revoke all on function public.listing_studio_owners_with_claimable_ebay_work(integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.listing_studio_owners_with_claimable_ebay_work(integer) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.listing_studio_owners_with_claimable_ebay_work(integer) from authenticated; end if;
end $$;
