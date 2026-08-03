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

-- Milestone 4 (AI listing generation): the structured product fields the AI
-- returns for a product group (see lib/listing-studio/listing-generation-schemas.ts),
-- plus the application-generated marketplace title/description derived from
-- them (lib/listing-studio/listing-template.ts — pure functions, no AI call,
-- so a future template change can regenerate every listing from these
-- stored structured fields alone). Deliberately separate columns from
-- `title`/`description` above, which remain each group's own editable
-- *display name* inside the Create workspace (confirmed still in active use
-- by GroupingWorkspace.tsx's rename UX) — colliding the two would either
-- break renaming or silently overwrite a generated listing's marketplace
-- title, so they never share a column. `brand`, `model`, `sku`, `condition`,
-- and `ai_result_json` above are reused as-is: `ai_result_json` is exactly
-- "raw last-pipeline-output, audit/debug only" per its own comment, which is
-- also where this milestone's per-field confidence lives — internal-only,
-- never surfaced in the UI, exactly as required, so no new confidence
-- column is needed. `alter table ... add column if not exists` is
-- idempotent, safe to re-run on an already-deployed database exactly like
-- every other statement in this file.
alter table public.listing_drafts add column if not exists product_type text;
alter table public.listing_drafts add column if not exists colour text;
alter table public.listing_drafts add column if not exists uk_size text;
alter table public.listing_drafts add column if not exists generated_title text;
alter table public.listing_drafts add column if not exists generated_description text;

-- Milestone 4 sizing correction: the AI never converts a size itself — it
-- only ever reports the system and value exactly as printed on the label
-- (lib/listing-studio/listing-generation-schemas.ts's sourceSize field);
-- any EU/US -> UK conversion happens deterministically, brand-aware, in
-- lib/listing-studio/size-conversion.ts. These two columns persist that
-- raw source reading for audit/traceability, independently of `uk_size`
-- above (which holds the directly-observed UK size, or the converted
-- result, or whatever the user has since entered manually via Edit
-- fields — uk_size is never overwritten by a later generate call once set).
alter table public.listing_drafts add column if not exists source_size_system text;
alter table public.listing_drafts add column if not exists source_size_value text;

-- Milestone 4 sizing coverage correction: records HOW `uk_size` above was
-- obtained — 'observed' (read directly off the label), 'brand_converted'
-- (matched an exact brand-specific chart entry), 'fallback_converted'
-- (matched the generic category-separated fallback chart), or 'manual'
-- (typed by the user via Edit fields). Never shown in the UI; exists so a
-- later regeneration and the manual-entry protection above can tell these
-- apart without re-deriving anything.
alter table public.listing_drafts add column if not exists uk_size_source text;


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
        'generation',
        'product_grouping'
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

-- Milestone 3 (automatic AI product grouping): widens the `stage` check
-- constraint on an already-deployed database, since `create table if not
-- exists` above only affects a brand-new install — an existing table's
-- constraint must be explicitly replaced to accept the new
-- 'product_grouping' value. Safe to re-run: drops the constraint only if
-- it currently exists, under whatever name Postgres auto-assigned it
-- ("<table>_<column>_check" is Postgres's own default naming for an inline
-- column check), then recreates it with the widened list.
alter table public.listing_analysis_runs drop constraint if exists listing_analysis_runs_stage_check;
alter table public.listing_analysis_runs add constraint listing_analysis_runs_stage_check
  check (
    stage in (
      'image_quality',
      'label_extraction',
      'visual_identification',
      'consistency_check',
      'generation',
      'product_grouping'
    )
  );


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

-- Milestone 3 (automatic AI product grouping) v3 — ordered boundary
-- detection: applies a WHOLE "Auto-group products" session's accepted
-- groups in ONE transaction, only after every chunk has been analysed and
-- reconciled across chunk boundaries (see
-- lib/listing-studio/auto-group-schemas.ts's reconcileAutoGroupSession,
-- called from app/api/listing-studio/groups/auto-group/apply-session/route.ts) —
-- never applying one chunk's groups before the rest of the session is
-- known, which previously risked a physical product being split across a
-- chunk boundary with no way to put it back together. p_groups is a JSON
-- array of {"title": text, "image_ids": [uuid, ...]}, one entry per
-- accepted group, in the order they should be created. Every image id in
-- every group must currently belong to p_source_draft_id (the Unsorted
-- group) and this owner — the exact same ownership/membership check as
-- listing_studio_split_group, just for every group in one call instead of
-- one. If ANY group fails validation, the exception aborts the whole
-- function and every effect of every earlier iteration in the same call
-- rolls back with it (a single plpgsql function body is one implicit
-- transaction) — so a session's application is genuinely all-or-nothing,
-- never leaving some groups created and others missing.
-- DIAGNOSTIC INSTRUMENTATION (temporary — see this function's own callers
-- for the removal condition): every raise below now attaches a `detail`
-- naming the exact group index/title/image count/image ids involved, and
-- the per-group loop body is wrapped in its own exception handler that
-- captures GET STACKED DIAGNOSTICS (SQLSTATE, message, detail, hint) for
-- ANY error — including one this function never anticipated (a constraint
-- violation, a trigger failure, etc.) — and re-raises it with all of that
-- plus the failing group's own index/title/image ids embedded in one
-- message, so the calling route's catch block (which already logs the raw
-- error text in development — see apply-session/route.ts) can surface the
-- precise failing statement instead of a bare "rolled back". This changes
-- NO validation rule and NO control flow: the same checks fire in the same
-- order for the same reasons, and any exception still aborts the whole
-- function (one plpgsql function body is one implicit transaction) exactly
-- as before — only the message/detail attached to that same exception is
-- richer.
--
-- REGRESSION (SQLSTATE 42702 "column reference \"draft_id\" is ambiguous",
-- confirmed live on the first group of a real apply): `returns table
-- (draft_id uuid, title text)` implicitly declares `draft_id` and `title`
-- as OUT-parameter PL/pgSQL variables, visible for the whole function body
-- — exactly like any other local variable. listing_draft_images also has
-- its own `draft_id` column, so every bare (unqualified) `draft_id`
-- reference inside a query below could mean either one, and Postgres
-- correctly refuses to guess. The OUT parameter names can't be renamed —
-- they ARE the RPC's returned column names (draft_id/title), which
-- app/api/listing-studio/groups/auto-group/apply-session/route.ts already
-- reads by those exact keys; renaming them would change this RPC's API
-- contract. The correct fix is the other direction: every table reference
-- below is now aliased (ld/ldi) and every column in every query is
-- qualified with it, so no query can ever be ambiguous regardless of what
-- local/OUT-parameter names this function happens to declare. Only two
-- statements actually triggered the bug (the image-count check and the
-- `ordered` CTE, both via listing_draft_images.draft_id) — every other
-- table reference is qualified too, defensively, so no future
-- variable/column name collision (owner_id, image_id, group_id, etc.) can
-- reintroduce this class of failure.
create or replace function public.listing_studio_apply_boundary_session(p_owner_id uuid, p_source_draft_id uuid, p_groups jsonb)
returns table(draft_id uuid, title text)
language plpgsql
as $$
declare
  v_group jsonb;
  v_group_index integer := 0;
  v_title text;
  v_image_ids uuid[];
  v_image_count integer;
  v_new_draft_id uuid;
  v_diag_sqlstate text;
  v_diag_message text;
  v_diag_detail text;
  v_diag_hint text;
begin
  if p_groups is null or jsonb_typeof(p_groups) <> 'array' or jsonb_array_length(p_groups) = 0 then
    raise exception 'NO_GROUPS' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.listing_drafts ld where ld.id = p_source_draft_id and ld.owner_id = p_owner_id for update) then
    raise exception 'SOURCE_DRAFT_NOT_FOUND' using errcode = 'P0002';
  end if;

  begin
    for v_group in select * from jsonb_array_elements(p_groups)
    loop
      v_group_index := v_group_index + 1;
      v_title := nullif(trim(v_group ->> 'title'), '');
      select array_agg(value::uuid) into v_image_ids from jsonb_array_elements_text(v_group -> 'image_ids');

      if v_title is null then
        raise exception 'INVALID_GROUP_TITLE' using errcode = 'P0003',
          detail = format('group index %s (0-based) had no usable title', v_group_index - 1);
      end if;
      if v_image_ids is null or array_length(v_image_ids, 1) is null then
        raise exception 'NO_IMAGES' using errcode = 'P0001',
          detail = format('group index %s (0-based, title "%s") had no image ids', v_group_index - 1, v_title);
      end if;

      select count(*) into v_image_count
      from public.listing_draft_images ldi
      where ldi.id = any(v_image_ids) and ldi.draft_id = p_source_draft_id and ldi.owner_id = p_owner_id;

      if v_image_count <> array_length(v_image_ids, 1) then
        raise exception 'IMAGE_NOT_IN_SOURCE_DRAFT' using errcode = 'P0004',
          detail = format(
            'group index %s (0-based, title "%s"): expected %s image(s), only %s currently match owner %s + source draft %s (duplicates within the group, an id already moved elsewhere, or an id belonging to a different owner all look identical here) — image_ids requested: %s',
            v_group_index - 1, v_title, array_length(v_image_ids, 1), v_image_count, p_owner_id, p_source_draft_id, v_image_ids
          );
      end if;

      insert into public.listing_drafts (owner_id, title, status)
      values (p_owner_id, v_title, 'grouping')
      returning id into v_new_draft_id;

      with ordered as (
        select ldi.id, row_number() over (order by ldi.sort_order) as rn
        from public.listing_draft_images ldi
        where ldi.id = any(v_image_ids) and ldi.draft_id = p_source_draft_id and ldi.owner_id = p_owner_id
      )
      update public.listing_draft_images img
      set draft_id = v_new_draft_id,
          sort_order = ordered.rn - 1
      from ordered
      where img.id = ordered.id;

      insert into public.listing_status_history (draft_id, owner_id, previous_status, new_status, reason)
      values (v_new_draft_id, p_owner_id, null, 'grouping', 'created by automatic AI product grouping');

      draft_id := v_new_draft_id;
      title := v_title;
      return next;
    end loop;
  exception when others then
    get stacked diagnostics
      v_diag_sqlstate = returned_sqlstate,
      v_diag_message = message_text,
      v_diag_detail = pg_exception_detail,
      v_diag_hint = pg_exception_hint;
    raise exception 'APPLY_BOUNDARY_SESSION_FAILED at group index % (0-based, title "%"): sqlstate=% message=% detail=% hint=%',
      coalesce(v_group_index - 1, -1), coalesce(v_title, '(unknown)'), v_diag_sqlstate, v_diag_message,
      coalesce(v_diag_detail, '(none)'), coalesce(v_diag_hint, '(none)')
      using errcode = 'P0009', detail = coalesce(v_diag_detail, v_diag_message), hint = coalesce(v_diag_hint, '(none)');
  end;
end;
$$;

-- "Clear all" (Listing Studio workspace-wide reset): deletes every Listing
-- Studio database row this owner has — every listing_drafts row (every
-- product group AND Unsorted; there is no separate "draft" table, a group
-- IS a listing_drafts row, so deleting these covers both at once) plus
-- every listing_draft_images/listing_analysis_runs/listing_status_history
-- row. Those three already cascade-delete when their listing_drafts row is
-- removed (`on delete cascade`, confirmed by
-- tests/listing-studio-migration.test.ts's own cascade-count assertion), so
-- a single `delete from listing_drafts` would already remove everything —
-- but this deletes each table explicitly, in dependency order, specifically
-- to return an accurate per-table count to the caller (cascade deletes
-- don't give you a row count for the table the cascade fired into). Not
-- duplicated safety logic, just deliberately not relying on RETURNING
-- through a cascade for something this function needs to report.
--
-- Ownership is enforced the only way every other RPC in this file enforces
-- it: every delete filters on `owner_id = p_owner_id`, and p_owner_id is
-- never something the client can spoof — the calling route derives it from
-- requireOwner() (see app/api/listing-studio/workspace/route.ts's DELETE
-- handler), never from the request body. One plpgsql function body is one
-- implicit transaction, so if any statement fails, every prior delete in
-- the same call rolls back with it — the same all-or-nothing guarantee
-- every other multi-step RPC in this file has.
--
-- Storage cleanup is NOT done here (Postgres has no access to Storage) —
-- the calling route resolves and deletes every Storage object BEFORE
-- calling this function at all (the opposite order from
-- listing_studio_delete_group's single-group delete above), specifically
-- so a Storage-deletion failure can abort before any database row is
-- touched, and so a retry after a failure has something to re-resolve from
-- (nothing here would have run yet). See that route's own comment for why
-- this order is deliberately reversed from the single-group case.
create or replace function public.listing_studio_clear_workspace(p_owner_id uuid)
returns table(deleted_image_count integer, deleted_group_count integer, deleted_analysis_run_count integer, deleted_status_history_count integer)
language plpgsql
as $$
declare
  v_image_count integer;
  v_group_count integer;
  v_run_count integer;
  v_history_count integer;
begin
  with deleted as (delete from public.listing_draft_images where owner_id = p_owner_id returning 1)
  select count(*) into v_image_count from deleted;

  with deleted as (delete from public.listing_analysis_runs where owner_id = p_owner_id returning 1)
  select count(*) into v_run_count from deleted;

  with deleted as (delete from public.listing_status_history where owner_id = p_owner_id returning 1)
  select count(*) into v_history_count from deleted;

  with deleted as (delete from public.listing_drafts where owner_id = p_owner_id returning 1)
  select count(*) into v_group_count from deleted;

  deleted_image_count := v_image_count;
  deleted_group_count := v_group_count;
  deleted_analysis_run_count := v_run_count;
  deleted_status_history_count := v_history_count;
  return next;
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
revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from public;
revoke all on function public.listing_studio_clear_workspace(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.listing_studio_move_images(uuid, uuid[], uuid) from anon;
    revoke all on function public.listing_studio_reorder_images(uuid, uuid, uuid[]) from anon;
    revoke all on function public.listing_studio_split_group(uuid, uuid, uuid[], text) from anon;
    revoke all on function public.listing_studio_merge_groups(uuid, uuid, uuid) from anon;
    revoke all on function public.listing_studio_delete_group(uuid, uuid, text) from anon;
    revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from anon;
    revoke all on function public.listing_studio_clear_workspace(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.listing_studio_move_images(uuid, uuid[], uuid) from authenticated;
    revoke all on function public.listing_studio_reorder_images(uuid, uuid, uuid[]) from authenticated;
    revoke all on function public.listing_studio_split_group(uuid, uuid, uuid[], text) from authenticated;
    revoke all on function public.listing_studio_delete_group(uuid, uuid, text) from authenticated;
    revoke all on function public.listing_studio_merge_groups(uuid, uuid, uuid) from authenticated;
    revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from authenticated;
    revoke all on function public.listing_studio_clear_workspace(uuid) from authenticated;
  end if;
end $$;
