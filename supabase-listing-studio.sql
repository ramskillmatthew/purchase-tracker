-- Listing Studio Stage 1 (Milestone 1) — schema only. Run manually in the
-- Supabase SQL editor; nothing in this app runs it automatically. Safe to
-- re-run: every statement is idempotent (`if not exists` / `create or
-- replace`).
--
-- Follows this project's established single-owner conventions exactly
-- (see tasks/vinted_import_candidates): owner_id uuid + application-level
-- filtering, RLS enabled with no policies (the service-role key bypasses
-- RLS and is the only role this app's server routes ever use — see
-- lib/auth/server.ts's requireOwner() + lib/supabase.ts), and an explicit
-- `revoke all ... from anon, authenticated` on every table as defence in
-- depth beyond RLS alone, matching supabase-add-tasks.sql.
--
-- updated_at is NOT trigger-maintained anywhere else in this codebase
-- (checked: no trigger sets it on any existing table) — every UPDATE that
-- touches listing_drafts must set updated_at = now() itself, same as the
-- existing candidate-import RPC does for vinted_import_candidates.

create table if not exists public.listing_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,

  sku text,
  style_code text,

  title text,
  description text,

  brand text,
  model text,
  silhouette text,

  category text,
  subcategory text,

  condition text,

  -- Human-display size (e.g. "UK 9", "M", "One size") — category-specific
  -- size systems (UK/EU/US shoe sizing) live per-field, with their own
  -- confidence/source, inside field_data_json.sizeUk/sizeEu/sizeUs. This
  -- column is what's confirmed for display/search/sort, never a
  -- shoe-size-shaped column forced onto a clothing item.
  size_label text,

  suggested_price_pence integer
    check (suggested_price_pence is null or suggested_price_pence >= 0),
  confirmed_price_pence integer
    check (confirmed_price_pence is null or confirmed_price_pence >= 0),

  status text not null default 'uploading'
    check (
      status in (
        'uploading',
        'grouping',
        'analysing',
        'needs_review',
        'ready',
        'failed',
        'archived'
      )
    ),

  overall_confidence text
    check (
      overall_confidence is null
      or overall_confidence in ('high', 'medium', 'low', 'unconfirmed', 'conflict')
    ),

  -- Strongly typed at the application layer (lib/listing-studio/types.ts's
  -- ListingFieldData, validated by lib/validation/listing-studio.ts's
  -- listingFieldDataSchema before ever being written) — jsonb only because
  -- Postgres has no first-class "map of field name to {value, confidence,
  -- source, sourceImageId, aiGenerated, userConfirmed, conflict}" type.
  -- This single column is the one place a field's confirmation state lives
  -- — deliberately not split into a second, separate confirmed-values
  -- column, so a field's AI value and its confirmed status can never
  -- disagree with each other by living in two JSON blobs that drift apart.
  field_data_json jsonb not null default '{}'::jsonb,

  -- Each entry identifies its affected field (Stage 1 spec: "warnings and
  -- conflicts should identify the affected field") via lib/listing-studio
  -- /types.ts's ListingWarning/ListingConflict shape.
  warnings_json jsonb not null default '[]'::jsonb,
  conflicts_json jsonb not null default '[]'::jsonb,

  -- Raw last-pipeline-output, audit/debug only — never read back as trusted
  -- input by anything; field_data_json is the only trusted, merged state.
  ai_result_json jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists listing_drafts_owner_status_idx
on public.listing_drafts (
    owner_id,
    status
);

create index if not exists listing_drafts_owner_sku_idx
on public.listing_drafts (
    owner_id,
    sku
);

alter table public.listing_drafts
enable row level security;

revoke all
on public.listing_drafts
from anon,
authenticated;


create table if not exists public.listing_draft_images (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,
  owner_id uuid not null,

  -- listing-drafts/{owner_id}/{draft_id}/{image_id}-{safe_filename} — see
  -- lib/listing-studio/storage-paths.ts. Never the raw client-supplied
  -- filename alone; ownership/traversal are re-validated server-side from
  -- this exact path, not trusted from client metadata.
  storage_path text not null unique,

  original_filename text not null,
  mime_type text not null,
  file_size integer not null
    check (file_size > 0),

  width integer,
  height integer,

  -- Image order is stored here, never inferred from filenames (Stage 1
  -- spec §15: "Store image order in the database rather than relying on
  -- filenames").
  sort_order integer not null,

  detected_role text
    check (
      detected_role is null
      or detected_role in ('main', 'side', 'rear', 'sole', 'label', 'size_label', 'sku_label', 'damage', 'detail', 'unknown')
    ),
  confirmed_role text
    check (
      confirmed_role is null
      or confirmed_role in ('main', 'side', 'rear', 'sole', 'label', 'size_label', 'sku_label', 'damage', 'detail', 'unknown')
    ),

  -- Milestone 2: per-image upload lifecycle, independent of the draft's own
  -- coarser status — one failed photo must never take down the rest of its
  -- group (Milestone 2 spec §10). "uploaded" is only ever set by the
  -- upload-confirmation route after it has independently verified the
  -- Storage object exists — never set directly from a client claim.
  upload_state text not null default 'pending'
    check (upload_state in ('pending', 'uploading', 'uploaded', 'failed')),

  -- Milestone 2: whether a renderable thumbnail/preview exists for this
  -- image. True for JPG/PNG/WEBP always; for HEIC/HEIF this reflects
  -- whether client-side conversion (see lib/listing-studio
  -- /client-image-processing.ts) succeeded — a failed HEIC conversion still
  -- uploads the original file untouched, just with preview_available=false,
  -- never discarding or corrupting the upload itself.
  preview_available boolean not null default true,

  ai_metadata_json jsonb,

  created_at timestamptz not null default now()
);

create index if not exists listing_draft_images_draft_order_idx
on public.listing_draft_images (
    draft_id,
    sort_order
);

alter table public.listing_draft_images
enable row level security;

revoke all
on public.listing_draft_images
from anon,
authenticated;


create table if not exists public.listing_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,
  owner_id uuid not null,

  stage text not null
    check (
      stage in (
        'image_quality',
        'label_extraction',
        'visual_identification',
        'consistency_check',
        'generation'
      )
    ),

  status text not null
    check (status in ('running', 'success', 'failed')),

  model text,

  -- See lib/listing-studio/prompt-versions.ts — always populated, never
  -- inferred, so a later prompt change can never lose track of which
  -- version produced a stored result.
  prompt_version text not null,

  -- See lib/listing-studio/schema-versions.ts — versioned independently of
  -- prompt_version so prompt wording and the expected JSON response shape
  -- can each change on their own schedule without the other silently
  -- losing track of which one produced/validated a stored result.
  schema_version text not null,

  response_json jsonb,
  error_message text,

  started_at timestamptz not null default now(),
  completed_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists listing_analysis_runs_draft_stage_idx
on public.listing_analysis_runs (
    draft_id,
    stage,
    started_at desc
);

alter table public.listing_analysis_runs
enable row level security;

revoke all
on public.listing_analysis_runs
from anon,
authenticated;


create table if not exists public.listing_status_history (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,
  owner_id uuid not null,

  previous_status text
    check (
      previous_status is null
      or previous_status in ('uploading', 'grouping', 'analysing', 'needs_review', 'ready', 'failed', 'archived')
    ),
  new_status text not null
    check (
      new_status in ('uploading', 'grouping', 'analysing', 'needs_review', 'ready', 'failed', 'archived')
    ),

  reason text,

  created_at timestamptz not null default now()
);

create index if not exists listing_status_history_draft_idx
on public.listing_status_history (
    draft_id,
    created_at desc
);

alter table public.listing_status_history
enable row level security;

revoke all
on public.listing_status_history
from anon,
authenticated;


-- Private Storage bucket for original listing photos. Creating a bucket is
-- just an insert into storage.buckets, so it's included here rather than
-- as a separate manual step — but if your Supabase project's SQL editor
-- role lacks insert privilege on storage.buckets (some managed setups
-- restrict this), create it manually instead:
--   Dashboard -> Storage -> New bucket -> name "listing-drafts",
--   toggle "Public bucket" OFF, leave file size/MIME restrictions blank
--   (enforced in application code instead — see lib/listing-studio
--   /storage-paths.ts and Milestone 2's upload-confirmation route).
--
-- No storage.objects RLS policies are added: every upload is mediated by a
-- server route that calls requireOwner() first and then uses the service-
-- role key (which bypasses storage RLS the same way it bypasses table RLS)
-- to mint a short-lived signed upload URL restricted to one exact path —
-- consistent with how every other table/bucket-adjacent access in this app
-- works. No anonymous or end-user Postgres role is ever used to touch
-- storage directly.
insert into storage.buckets (id, name, public)
values ('listing-drafts', 'listing-drafts', false)
on conflict (id) do nothing;


-- ============================================================================
-- Milestone 2 — transactional RPCs for multi-record grouping operations.
-- Each function body is one implicit transaction (matching
-- import_purchase_order's convention in supabase-purchase-import-v2.sql):
-- any exception rolls back every effect of that same call automatically, so
-- a move/split/merge/reorder can never leave images half-moved or
-- duplicated. p_owner_id is always the server's own requireOwner()-derived
-- id, never taken from the client directly — every function still
-- independently re-verifies every draft_id/image_id it touches belongs to
-- that owner before changing anything.
-- ============================================================================

-- Moves one or more images into a different group, appending them after the
-- target group's existing photos (never overwriting/colliding with the
-- target's existing sort_order values). Rejects the whole call if any image
-- id doesn't exist or doesn't belong to this owner — never a partial move.
create or replace function public.listing_studio_move_images(p_owner_id uuid, p_image_ids uuid[], p_target_draft_id uuid)
returns void
language plpgsql
as $$
declare
  v_base_sort integer;
  v_image_count integer;
begin
  if p_image_ids is null or array_length(p_image_ids, 1) is null then
    raise exception 'NO_IMAGES' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.listing_drafts where id = p_target_draft_id and owner_id = p_owner_id for update) then
    raise exception 'TARGET_DRAFT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*) into v_image_count
  from public.listing_draft_images
  where id = any(p_image_ids) and owner_id = p_owner_id;

  if v_image_count <> array_length(p_image_ids, 1) then
    raise exception 'IMAGE_NOT_FOUND_OR_NOT_OWNED' using errcode = 'P0003';
  end if;

  select coalesce(max(sort_order), -1) into v_base_sort
  from public.listing_draft_images
  where draft_id = p_target_draft_id;

  with ordered as (
    select id, row_number() over (order by sort_order) as rn
    from public.listing_draft_images
    where id = any(p_image_ids) and owner_id = p_owner_id
  )
  update public.listing_draft_images img
  set draft_id = p_target_draft_id,
      sort_order = v_base_sort + ordered.rn
  from ordered
  where img.id = ordered.id;
end;
$$;

-- Sets sort_order to exactly match the given ordered list. Requires the
-- list to be exactly this draft's current image set (same size, same ids) —
-- never a silent partial reorder that could drop an image out of view or
-- collide two images onto the same position.
create or replace function public.listing_studio_reorder_images(p_owner_id uuid, p_draft_id uuid, p_ordered_image_ids uuid[])
returns void
language plpgsql
as $$
declare
  v_existing_count integer;
  v_given_count integer;
begin
  if p_ordered_image_ids is null or array_length(p_ordered_image_ids, 1) is null then
    raise exception 'NO_IMAGES' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.listing_drafts where id = p_draft_id and owner_id = p_owner_id for update) then
    raise exception 'DRAFT_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_given_count := array_length(p_ordered_image_ids, 1);
  select count(*) into v_existing_count from public.listing_draft_images where draft_id = p_draft_id and owner_id = p_owner_id;

  if v_existing_count <> v_given_count
     or exists (
       select 1 from unnest(p_ordered_image_ids) as given_id
       where not exists (
         select 1 from public.listing_draft_images
         where id = given_id and draft_id = p_draft_id and owner_id = p_owner_id
       )
     )
  then
    raise exception 'IMAGE_SET_MISMATCH' using errcode = 'P0003';
  end if;

  with ordered as (
    select unnest(p_ordered_image_ids) as id, generate_subscripts(p_ordered_image_ids, 1) as rn
  )
  update public.listing_draft_images img
  set sort_order = ordered.rn
  from ordered
  where img.id = ordered.id and img.draft_id = p_draft_id and img.owner_id = p_owner_id;
end;
$$;

-- Creates a brand-new group and moves the selected images into it (fresh
-- 0-based sort_order), atomically — a failure partway through never leaves
-- an orphaned new group with only some of the intended photos.
create or replace function public.listing_studio_split_group(p_owner_id uuid, p_source_draft_id uuid, p_image_ids uuid[], p_new_title text)
returns uuid
language plpgsql
as $$
declare
  v_new_draft_id uuid;
  v_image_count integer;
begin
  if p_image_ids is null or array_length(p_image_ids, 1) is null then
    raise exception 'NO_IMAGES' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.listing_drafts where id = p_source_draft_id and owner_id = p_owner_id for update) then
    raise exception 'SOURCE_DRAFT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*) into v_image_count
  from public.listing_draft_images
  where id = any(p_image_ids) and draft_id = p_source_draft_id and owner_id = p_owner_id;

  if v_image_count <> array_length(p_image_ids, 1) then
    raise exception 'IMAGE_NOT_IN_SOURCE_DRAFT' using errcode = 'P0003';
  end if;

  insert into public.listing_drafts (owner_id, title, status)
  values (p_owner_id, coalesce(nullif(trim(p_new_title), ''), 'Untitled group'), 'grouping')
  returning id into v_new_draft_id;

  with ordered as (
    select id, row_number() over (order by sort_order) as rn
    from public.listing_draft_images
    where id = any(p_image_ids) and draft_id = p_source_draft_id and owner_id = p_owner_id
  )
  update public.listing_draft_images img
  set draft_id = v_new_draft_id,
      sort_order = ordered.rn - 1
  from ordered
  where img.id = ordered.id;

  insert into public.listing_status_history (draft_id, owner_id, previous_status, new_status, reason)
  values (v_new_draft_id, p_owner_id, null, 'grouping', 'split from another group');

  return v_new_draft_id;
end;
$$;

-- Moves every image from the source group into the target group (appended
-- after the target's existing photos) and deletes the now-empty source
-- group. Atomic: a failure partway through never leaves images duplicated
-- across both groups or the source group deleted while images remain.
create or replace function public.listing_studio_merge_groups(p_owner_id uuid, p_source_draft_id uuid, p_target_draft_id uuid)
returns void
language plpgsql
as $$
declare
  v_base_sort integer;
begin
  if p_source_draft_id = p_target_draft_id then
    raise exception 'CANNOT_MERGE_GROUP_INTO_ITSELF' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.listing_drafts where id = p_source_draft_id and owner_id = p_owner_id for update) then
    raise exception 'SOURCE_DRAFT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.listing_drafts where id = p_target_draft_id and owner_id = p_owner_id for update) then
    raise exception 'TARGET_DRAFT_NOT_FOUND' using errcode = 'P0003';
  end if;

  select coalesce(max(sort_order), -1) into v_base_sort
  from public.listing_draft_images
  where draft_id = p_target_draft_id;

  with ordered as (
    select id, row_number() over (order by sort_order) as rn
    from public.listing_draft_images
    where draft_id = p_source_draft_id and owner_id = p_owner_id
  )
  update public.listing_draft_images img
  set draft_id = p_target_draft_id,
      sort_order = v_base_sort + ordered.rn
  from ordered
  where img.id = ordered.id;

  -- The source group's own listing_draft_images rows are already moved
  -- away by the update above, so this delete only ever removes a now-empty
  -- group; its listing_status_history rows cascade-delete with it.
  delete from public.listing_drafts where id = p_source_draft_id and owner_id = p_owner_id;
end;
$$;

-- Deletes a group, disposing of its photos one of two explicit,
-- user-chosen ways: 'move_to_unsorted' (safe default — moves every photo
-- into the owner's Unsorted inbox group, creating it if it doesn't
-- currently exist, before deleting the now-empty source group) or
-- 'delete_photos' (destructive — permanently deletes the image rows too;
-- the returned storage paths are the caller's signal for which Storage
-- objects it must now also delete, since Postgres itself has no access to
-- Storage). Deleting a genuinely empty group needs no mode at all; the
-- app layer only requires one when the group still has photos.
--
-- There is no hard "cannot delete the last Unsorted group" rule — Unsorted
-- is a lazily-created, ordinary group (see app/api/listing-studio/uploads
-- /route.ts's find-or-create logic), not a structurally-required row, so a
-- fresh one is simply created next time photos are uploaded with no
-- explicit target. The one real guard is narrower and load-bearing:
-- 'move_to_unsorted' is rejected when the group being deleted IS ITSELF
-- the Unsorted group, since there is no other Unsorted to move its photos
-- into.
create or replace function public.listing_studio_delete_group(p_owner_id uuid, p_draft_id uuid, p_mode text)
returns table(deleted_storage_paths text[])
language plpgsql
as $$
declare
  v_is_unsorted boolean;
  v_unsorted_id uuid;
  v_base_sort integer;
  v_paths text[];
begin
  if p_mode not in ('move_to_unsorted', 'delete_photos') then
    raise exception 'INVALID_MODE' using errcode = 'P0001';
  end if;

  select (title = 'Unsorted') into v_is_unsorted
  from public.listing_drafts
  where id = p_draft_id and owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'DRAFT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_mode = 'move_to_unsorted' and v_is_unsorted then
    raise exception 'CANNOT_MOVE_UNSORTED_TO_ITSELF' using errcode = 'P0003';
  end if;

  if p_mode = 'move_to_unsorted' then
    select id into v_unsorted_id
    from public.listing_drafts
    where owner_id = p_owner_id and title = 'Unsorted' and status in ('uploading', 'grouping') and id <> p_draft_id
    order by created_at desc
    limit 1
    for update;

    if v_unsorted_id is null then
      insert into public.listing_drafts (owner_id, title, status)
      values (p_owner_id, 'Unsorted', 'grouping')
      returning id into v_unsorted_id;
    end if;

    select coalesce(max(sort_order), -1) into v_base_sort
    from public.listing_draft_images
    where draft_id = v_unsorted_id;

    with ordered as (
      select id, row_number() over (order by sort_order) as rn
      from public.listing_draft_images
      where draft_id = p_draft_id and owner_id = p_owner_id
    )
    update public.listing_draft_images img
    set draft_id = v_unsorted_id,
        sort_order = v_base_sort + ordered.rn
    from ordered
    where img.id = ordered.id;

    v_paths := '{}';
  else
    select coalesce(array_agg(storage_path), '{}') into v_paths
    from public.listing_draft_images
    where draft_id = p_draft_id and owner_id = p_owner_id;

    delete from public.listing_draft_images where draft_id = p_draft_id and owner_id = p_owner_id;
  end if;

  delete from public.listing_drafts where id = p_draft_id and owner_id = p_owner_id;

  return query select v_paths;
end;
$$;

-- Matches the existing function-access pattern (supabase-purchase-import-v2.sql):
-- the application only ever calls these via the service-role key, which is
-- unaffected by these revokes. anon/authenticated are explicitly denied
-- direct execution.
revoke all on function public.listing_studio_move_images(uuid, uuid[], uuid) from public;
revoke all on function public.listing_studio_reorder_images(uuid, uuid, uuid[]) from public;
revoke all on function public.listing_studio_split_group(uuid, uuid, uuid[], text) from public;
revoke all on function public.listing_studio_merge_groups(uuid, uuid, uuid) from public;
revoke all on function public.listing_studio_delete_group(uuid, uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.listing_studio_move_images(uuid, uuid[], uuid) from anon;
    revoke all on function public.listing_studio_reorder_images(uuid, uuid, uuid[]) from anon;
    revoke all on function public.listing_studio_split_group(uuid, uuid, uuid[], text) from anon;
    revoke all on function public.listing_studio_merge_groups(uuid, uuid, uuid) from anon;
    revoke all on function public.listing_studio_delete_group(uuid, uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.listing_studio_move_images(uuid, uuid[], uuid) from authenticated;
    revoke all on function public.listing_studio_reorder_images(uuid, uuid, uuid[]) from authenticated;
    revoke all on function public.listing_studio_split_group(uuid, uuid, uuid[], text) from authenticated;
    revoke all on function public.listing_studio_delete_group(uuid, uuid, text) from authenticated;
    revoke all on function public.listing_studio_merge_groups(uuid, uuid, uuid) from authenticated;
  end if;
end $$;
