-- ============================================================================
-- eBay Seller Hub extension drafter — additive migration (NOT YET APPLIED)
-- ============================================================================
-- Presented for approval per this task's own explicit constraint: "Do not
-- apply Supabase SQL unless a genuinely necessary additive migration is
-- identified and presented for approval." This file is that presentation.
-- It has NOT been run against the live database. No tool in this
-- environment can apply DDL directly (established earlier this session) —
-- applying this requires the user to paste it into the Supabase SQL Editor
-- themselves, the same procedure used for supabase-ebay-feed-drafts-atomic-
-- retry.sql earlier in this project's history.
--
-- Mirrors vinted_extension_batches / vinted_extension_batch_items
-- (supabase-listing-studio.sql) as closely as the real difference in
-- payload shape allows — same pairing-code-hash + owner-scoped-advisory-
-- lock + atomic-create-RPC design, same soft-dismiss display-number
-- pattern (built in from the start here, rather than needing a follow-up
-- migration the way the Vinted table did). Deliberately a SEPARATE table
-- pair, not a shared/marketplace-discriminated one — this is a genuinely
-- different payload (eBay category/condition/item-specifics/policies, no
-- Vinted category/audience fields at all) and a deliberately narrower
-- status vocabulary for THIS milestone (see below), and the task's own
-- "eBay-specific queue type... do not let eBay messages enter the Vinted
-- processing path or vice versa" requirement is easiest to prove true when
-- it's true at the schema level too, not just in application code.
--
-- STATUS VOCABULARY — narrower than Vinted's on purpose. This milestone
-- never clicks Save Draft, so there is no 'saving' stage and no meaningful
-- 'completed' outcome yet (a genuinely confirmed Seller Hub draft is a
-- LATER milestone). 'waiting_for_review' is the real terminal-for-now
-- state: the form is populated, photos are uploaded and verified, and a
-- human needs to look at it and save it themselves. When automatic Save
-- Draft is enabled in a future task, 'saving' and 'completed' can be added
-- with a plain ALTER ... DROP CONSTRAINT / ADD CONSTRAINT (additive,
-- non-breaking) — never by reusing 'waiting_for_review' to mean something
-- else.

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
    check (listing_count between 1 and 1),

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

  -- Mirrors vinted_extension_batches.last_extension_activity_at exactly —
  -- bumped by the heartbeat route and every item-result report, used by
  -- lib/listing-studio/extension-batch-recovery.ts's own (marketplace-
  -- agnostic) staleness classification.
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

create table if not exists public.ebay_extension_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.ebay_extension_batches (id)
    on delete cascade,
  -- References the EBAY_UK marketplace draft row, never listing_drafts
  -- directly — the eBay-specific title/description/category/condition/
  -- price/policies this payload needs all live on
  -- listing_marketplace_drafts, not the Vinted-oriented product draft.
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

  -- Only ever set once eBay's own Seller Hub has genuinely confirmed a
  -- draft exists (a later milestone) — never guessed, never set merely
  -- because a save action was attempted. Deliberately distinct from
  -- listing_marketplace_drafts.ebay_feed_draft_created_at (the separate
  -- Seller Hub Feed pipeline's own confirmation field) — this column
  -- belongs to the extension-drafted path only.
  ebay_seller_hub_draft_confirmed_at timestamptz,

  started_at timestamptz,
  completed_at timestamptz,

  unique (batch_id, marketplace_draft_id),
  unique (batch_id, queue_position)
);

create index if not exists ebay_extension_batch_items_batch_idx
  on public.ebay_extension_batch_items (batch_id, queue_position);

alter table public.ebay_extension_batch_items enable row level security;
revoke all on public.ebay_extension_batch_items from anon, authenticated;

-- Mirrors listing_studio_create_extension_batch exactly (see that
-- function's own extensive comments in supabase-listing-studio.sql for the
-- full reasoning on the advisory lock and sequential display-number
-- allocation) — this is the eBay-scoped equivalent, operating on the
-- tables above instead. One eBay marketplace draft may never sit in two
-- still-live eBay extension batches at once, exactly like the Vinted rule
-- for listing_drafts.
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
  v_conflicting_draft uuid;
begin
  if p_marketplace_draft_ids is null or coalesce(array_length(p_marketplace_draft_ids, 1), 0) = 0 then
    raise exception 'NO_DRAFTS' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_owner_id::text));

  select bi.marketplace_draft_id into v_conflicting_draft
  from public.ebay_extension_batch_items bi
  join public.ebay_extension_batches b on b.id = bi.batch_id
  where bi.marketplace_draft_id = any(p_marketplace_draft_ids)
    and b.owner_id = p_owner_id
    and b.status not in ('completed', 'cancelled', 'expired')
    and bi.status not in ('waiting_for_review', 'failed', 'cancelled')
  limit 1;

  if v_conflicting_draft is not null then
    raise exception 'DRAFT_ALREADY_IN_ACTIVE_BATCH' using errcode = 'P0002', detail = v_conflicting_draft::text;
  end if;

  select coalesce(max(ob.display_number), 0) + 1 into v_display_number
  from public.ebay_extension_batches ob
  where ob.owner_id = p_owner_id and ob.box_dismissed_at is null;

  insert into public.ebay_extension_batches (owner_id, pairing_code_hash, expires_at, listing_count, display_number)
  values (p_owner_id, p_pairing_code_hash, p_expires_at, coalesce(array_length(p_marketplace_draft_ids, 1), 0), v_display_number)
  returning id into v_batch_id;

  insert into public.ebay_extension_batch_items (batch_id, marketplace_draft_id, product_draft_id, queue_position)
  select v_batch_id, md.id, md.product_draft_id, row_number() over (order by ord.ordinality) - 1
  from unnest(p_marketplace_draft_ids) with ordinality as ord(draft_id, ordinality)
  join public.listing_marketplace_drafts md on md.id = ord.draft_id and md.owner_id = p_owner_id and md.marketplace = 'EBAY_UK';

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
-- (not yet verified): anon=false, authenticated=false, service_role=true.
--
-- select
--   has_function_privilege('anon', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as anon,
--   has_function_privilege('authenticated', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as authenticated,
--   has_function_privilege('service_role', 'public.listing_studio_create_ebay_extension_batch(uuid, text, timestamptz, uuid[])', 'EXECUTE') as service_role;
