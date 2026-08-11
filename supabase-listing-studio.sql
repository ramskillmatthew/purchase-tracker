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

-- Milestone 6 (Vinted-aware colours/materials): `colour` above was a
-- single free-text field ("Cream & Grey & Tan") — Vinted only accepts a
-- value from its own fixed colour list (lib/listing-studio/listing-generation-schemas.ts's
-- VINTED_COLOURS), and allows at most two per listing. `colour` (singular,
-- free text) is no longer written by the app at all, superseded by
-- `colours` below (a Postgres array of up to two exact Vinted colour-list
-- values). The old column is deliberately left in place, not dropped —
-- so any already-generated listing's prior value isn't destroyed — it
-- simply stops being read or written going forward.
alter table public.listing_drafts add column if not exists colours text[];

-- Milestone 6: the single primary material, restricted to Vinted's exact
-- material list (VINTED_MATERIALS, same file) — null whenever it can't be
-- confidently identified, never invented. A genuinely new field: no prior
-- material column existed to supersede.
alter table public.listing_drafts add column if not exists material text;
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

-- Milestone 4 sizing coverage correction: the category the label itself
-- stated (mens/womens/unisex/childrens — sourceSize.gender), alongside the
-- raw system/value above. Never inferred, only ever what the AI actually
-- read off the label; null whenever the label didn't state one.
alter table public.listing_drafts add column if not exists source_size_gender text;

-- Milestone 4 sizing coverage correction: records HOW `uk_size` above was
-- obtained — 'observed' (read directly off the label), 'brand_converted'
-- (matched an exact brand-specific chart entry), 'fallback_converted'
-- (matched the generic category-separated fallback chart), or 'manual'
-- (typed by the user via Edit fields). Never shown in the UI; exists so a
-- later regeneration and the manual-entry protection above can tell these
-- apart without re-deriving anything.
alter table public.listing_drafts add column if not exists uk_size_source text;

-- Milestone 5 (Listings Review workspace). The review status shown in the
-- UI (Ready/Needs Review/Edited) is otherwise computed entirely from data
-- that already exists (missing required fields -> Needs Review; current
-- field values differing from the frozen ai_result_json snapshot, or
-- uk_size_source = 'manual' -> Edited; lib/listing-studio/listing-review.ts
-- is the single source of truth for that logic) — genuinely no schema
-- change was needed for either of those. This ONE column exists only for
-- the explicit "Mark Ready" action: a user confirming an Edited listing is
-- fine as-is. Null until first marked ready; a later edit (which bumps
-- updated_at past this timestamp) makes the listing show as Edited again
-- without needing to clear this column — see isListingEdited's own comment.
alter table public.listing_drafts add column if not exists review_marked_ready_at timestamptz;


-- ============================================================================
-- Milestone 7 (Vinted category catalogue sync).
--
-- Source: Vinted UK's own authenticated "Sell an item" (Create Listing)
-- page, which loads its real category tree from
--   GET https://www.vinted.co.uk/api/v2/item_upload/catalogs
-- Verified/accessed: 2026-08-03. This is NOT a documented public API — it
-- is a live endpoint observed from Vinted's own web app, and may change,
-- start requiring authentication, or be rate-limited/blocked at any time.
-- Confirmed live from this project's own environment during this
-- milestone: a direct unauthenticated request returned HTTP 403 with a
-- Cloudflare "Please wait" JS-challenge page (text/html, not JSON) — see
-- lib/listing-studio/vinted-catalogue-client.ts's own comment and this
-- milestone's completion report for the exact finding. Every piece of
-- code that talks to this endpoint is written to fail safely and never
-- destroy the last known-good catalogue when that happens.
--
-- Categories are never deleted once seen — only marked inactive
-- (is_active = false) — so a historical draft's chosen category always
-- stays joinable/readable even after a later refresh removes it from
-- Vinted's live tree. Not owner-scoped (no owner_id, no per-row RLS
-- policy beyond the blanket revoke below): this is shared reference data
-- for the single Vinted UK catalogue, not per-user content, matching how
-- e.g. a lookup/reference table would be modelled if this app had
-- multiple owners — every access still goes through a requireOwner()-gated
-- route using the service-role key, same as every other table here.
create table if not exists public.vinted_categories (
  -- Vinted's own real numeric category id — the stable external
  -- identifier, never one this app invents.
  id bigint primary key
    check (id > 0),

  code text,
  label text not null,

  -- "Men > Shoes > Sports shoes > Running" — root-to-here, " > "-separated,
  -- built once during flattening (lib/listing-studio/vinted-catalogue.ts)
  -- from each node's own supplied `path` + `title`.
  full_path text not null,

  parent_id bigint
    references public.vinted_categories (id)
    on delete set null
    deferrable initially deferred,
  root_id bigint not null,
  depth integer not null
    check (depth >= 0),
  sort_order integer not null default 0,

  is_leaf boolean not null default false,
  -- Whether this category can actually be chosen as a listing's final
  -- publishing category. Verified 2026-08-03 directly against the live
  -- Create Listing UI (leaf rows expose a radio control and enable Save;
  -- parent rows only navigate to their children and expose no selection
  -- control) — is_leaf is a reliable proxy for selectability, not merely
  -- the documented assumption this started as.
  is_selectable boolean not null default false,
  is_active boolean not null default true,

  -- Normalised helpers, derived only from verified root ids/codes/ancestry
  -- (lib/listing-studio/vinted-catalogue.ts) — never guessed from
  -- arbitrary English words. `id` + `full_path` above remain authoritative;
  -- these exist purely to narrow AI category-candidate searches.
  audience text
    check (audience is null or audience in ('mens', 'womens', 'kids', 'unisex')),
  item_family text
    check (item_family is null or item_family in ('footwear', 'clothing', 'accessories', 'home', 'electronics', 'entertainment', 'sports', 'collectables', 'other')),

  vinted_url text,

  -- Vinted field-visibility metadata, normalised to a real boolean
  -- regardless of whether Vinted's response represented a given flag as
  -- 0/1 or true/false (both were observed in the one verified example
  -- response) — see the transformer's own comment.
  color_field_visibility boolean,
  size_field_visibility boolean,
  measurements_field_visibility boolean,
  brand_field_visibility boolean,

  -- The node as returned by Vinted (minus its nested `catalogs`, which is
  -- flattened into separate rows instead) — forward compatibility, so a
  -- later field becomes usable without needing a new migration first.
  raw_json jsonb,

  source_endpoint text not null,
  source_market text not null default 'vinted_uk',
  -- Which exact refresh (see vinted_category_sync_status.fingerprint)
  -- last touched this row.
  source_fingerprint text,

  -- Follow-up correction (2026-08-03): the live endpoint above returned a
  -- Cloudflare challenge page in every test performed against it (see
  -- lib/listing-studio/vinted-catalogue-client.ts's own comment) — the
  -- ONLY genuine full catalogue actually obtained so far was a verified
  -- snapshot exported from Vinted UK's own signed-in Create Listing page
  -- (`https://www.vinted.co.uk/items/new`, embedded `catalogTree`), never
  -- the live_endpoint path. source_type records which one produced this
  -- row; captured_at is when the browser session captured it (snapshot
  -- only, null for a live refresh); imported_at is when THIS application
  -- actually applied it, always set.
  source_type text not null default 'live_endpoint'
    check (source_type in ('live_endpoint', 'verified_browser_snapshot')),
  captured_at timestamptz,
  imported_at timestamptz,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now()
);

-- Safe on an already-existing install from before this correction — a
-- fresh install's create table above already has these columns.
alter table public.vinted_categories add column if not exists source_type text not null default 'live_endpoint';
alter table public.vinted_categories drop constraint if exists vinted_categories_source_type_check;
alter table public.vinted_categories add constraint vinted_categories_source_type_check
  check (source_type in ('live_endpoint', 'verified_browser_snapshot'));
alter table public.vinted_categories add column if not exists captured_at timestamptz;
alter table public.vinted_categories add column if not exists imported_at timestamptz;

create index if not exists vinted_categories_parent_idx on public.vinted_categories (parent_id);
create index if not exists vinted_categories_root_idx on public.vinted_categories (root_id);
create index if not exists vinted_categories_active_selectable_idx on public.vinted_categories (source_market, is_active, is_selectable);
create index if not exists vinted_categories_audience_family_idx on public.vinted_categories (audience, item_family) where is_active;

alter table public.vinted_categories enable row level security;
revoke all on public.vinted_categories from anon, authenticated;

-- One row per market (currently just 'vinted_uk') — always the LATEST
-- attempt's outcome, success or failure. A failed attempt updates
-- last_attempted_at/last_status/last_error but leaves last_succeeded_at
-- and the counts exactly as they were after the last SUCCESSFUL refresh —
-- this row never has to be reconciled against vinted_categories itself to
-- know whether the last attempt actually changed anything.
create table if not exists public.vinted_category_sync_status (
  source_market text primary key,
  source_endpoint text not null,
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_status text
    check (last_status is null or last_status in ('success', 'failed', 'rejected_shrinkage', 'rejected_invalid_response')),
  last_error text,
  fetched_count integer,
  active_count integer,
  fingerprint text,
  duration_ms integer,
  -- Follow-up correction (2026-08-03) — see vinted_categories.source_type's
  -- own comment. Records which path produced the LAST successful import,
  -- so the Settings UI can show "Current source: verified browser
  -- snapshot (captured 2026-08-03)" honestly instead of always claiming
  -- the live endpoint.
  last_source_type text
    check (last_source_type is null or last_source_type in ('live_endpoint', 'verified_browser_snapshot')),
  last_captured_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.vinted_category_sync_status add column if not exists last_source_type text;
alter table public.vinted_category_sync_status drop constraint if exists vinted_category_sync_status_last_source_type_check;
alter table public.vinted_category_sync_status add constraint vinted_category_sync_status_last_source_type_check
  check (last_source_type is null or last_source_type in ('live_endpoint', 'verified_browser_snapshot'));
alter table public.vinted_category_sync_status add column if not exists last_captured_at timestamptz;

alter table public.vinted_category_sync_status enable row level security;
revoke all on public.vinted_category_sync_status from anon, authenticated;

-- Milestone 7 follow-up (AI category-selection cost tracking) — one row
-- per bounded category-selection AI call actually made (never when
-- deterministic filtering already produced one unambiguous candidate —
-- see lib/listing-studio/vinted-category-selection.ts). Append-only; lets
-- the owner see how often the extra call is needed and its running cost.
create table if not exists public.vinted_category_selection_ai_calls (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,
  owner_id uuid not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  prompt_version text not null,
  schema_version text not null,
  candidate_count integer not null
    check (candidate_count >= 0),
  estimated_cost_usd numeric(10, 6),
  status text not null
    check (status in ('success', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists vinted_category_selection_ai_calls_draft_idx
  on public.vinted_category_selection_ai_calls (draft_id, created_at desc);

alter table public.vinted_category_selection_ai_calls enable row level security;
revoke all on public.vinted_category_selection_ai_calls from anon, authenticated;

-- Follow-up correction (2026-08-05): this table now also logs the new
-- audience-reassessment AI calls (text-only, automatic; photo-based, the
-- explicit "Reassess audience" action) alongside the original
-- category-selection calls — one shared cost-tracking table rather than
-- three near-identical ones. call_type distinguishes which kind of call
-- produced a row; candidate_count only ever applies to category_selection
-- rows, so it's relaxed to nullable here.
alter table public.vinted_category_selection_ai_calls add column if not exists call_type text not null default 'category_selection';
alter table public.vinted_category_selection_ai_calls drop constraint if exists vinted_category_selection_ai_calls_call_type_check;
alter table public.vinted_category_selection_ai_calls add constraint vinted_category_selection_ai_calls_call_type_check
  check (call_type in ('category_selection', 'audience_reassessment_text', 'audience_reassessment_photo'));
alter table public.vinted_category_selection_ai_calls alter column candidate_count drop not null;

-- A listing's chosen Vinted publishing category — never free text, always
-- a real numeric id from vinted_categories above. The FK uses ON DELETE
-- SET NULL purely as a defensive fallback for a deletion that should never
-- actually happen in normal operation (categories are only ever
-- deactivated, never deleted) — never a mechanism this app relies on. A
-- category later becoming inactive does NOT clear these columns: the
-- draft still remembers what was picked; Listings Review is what decides
-- an inactive/unknown/non-selectable category means "Needs Review" again
-- (see lib/listing-studio/listing-review.ts).
alter table public.listing_drafts add column if not exists vinted_category_id bigint
  references public.vinted_categories (id) on delete set null;
alter table public.listing_drafts add column if not exists vinted_category_path text;
alter table public.listing_drafts add column if not exists vinted_category_source text
  check (vinted_category_source is null or vinted_category_source in ('ai', 'manual'));

-- Follow-up correction (2026-08-04): a real bug traced Vinted category
-- assignment silently failing whenever sourceSize.gender (a size-scale
-- signal, very often null for footwear) was used as the sole audience
-- source — see lib/listing-studio/listing-generation-schemas.ts's own
-- comment on vintedAudience. vinted_audience is now the persisted,
-- independently-AI-determined (or manually chosen) source of truth for
-- which Vinted marketplace audience this listing belongs under.
-- vinted_category_status records WHY automatic category selection landed
-- where it did (or didn't) — never a raw database/Anthropic error, always
-- one of a fixed, safe set the UI translates into an actionable message
-- (see lib/listing-studio/vinted-category-assignment.ts).
alter table public.listing_drafts add column if not exists vinted_audience text;
alter table public.listing_drafts drop constraint if exists listing_drafts_vinted_audience_check;
alter table public.listing_drafts add constraint listing_drafts_vinted_audience_check
  check (vinted_audience is null or vinted_audience in ('mens', 'womens', 'boys', 'girls', 'unisex', 'unknown'));

-- Mirrors vinted_category_source's own sticky-once-manual pattern exactly
-- (and uk_size_source before it): once the owner manually picks an
-- audience via Edit Fields, a later "Generate Listings" regenerate must
-- never silently overwrite that correction with a fresh (possibly still
-- wrong) AI guess.
alter table public.listing_drafts add column if not exists vinted_audience_source text;
alter table public.listing_drafts drop constraint if exists listing_drafts_vinted_audience_source_check;
alter table public.listing_drafts add constraint listing_drafts_vinted_audience_source_check
  check (vinted_audience_source is null or vinted_audience_source in ('ai', 'manual'));

-- Follow-up correction (2026-08-05): the short factual evidence
-- statements (e.g. "Model identified as the men's version") that
-- justified the current vinted_audience value — persisted for debugging/
-- audit always, but only ever SURFACED in the UI when the audience still
-- needs manual review (see lib/listing-studio/listing-review.ts). Cleared
-- whenever the owner manually sets an audience via Edit Fields — a manual
-- pick has no AI evidence behind it, and stale AI evidence next to a
-- manually-overridden value would be misleading.
alter table public.listing_drafts add column if not exists vinted_audience_evidence jsonb;

alter table public.listing_drafts add column if not exists vinted_category_status text;
alter table public.listing_drafts drop constraint if exists listing_drafts_vinted_category_status_check;
alter table public.listing_drafts add constraint listing_drafts_vinted_category_status_check
  check (
    vinted_category_status is null
    or vinted_category_status in (
      'audience_missing', 'item_family_uncertain', 'no_candidates', 'too_many_candidates',
      'ai_selection_failed', 'ai_selection_invalid', 'category_assigned'
    )
  );

-- Milestone 7 (revised) — Vinted Draft Export. Three separate, independent
-- nullable timestamps/ids — deliberately NOT a single status enum column
-- — mirroring review_marked_ready_at's own "nullable timestamp = did this
-- happen, and when" convention exactly. These three states are genuinely
-- independent facts about a listing, not a linear progression a single
-- enum could represent: a listing can be re-exported any number of times
-- (vinted_exported_at/vinted_export_id simply get overwritten with the
-- latest export's own values every time — re-export is always allowed,
-- never blocked), while vinted_draft_created_at is reserved entirely for a
-- SEPARATE, future milestone that actually confirms a Vinted draft exists
-- — nothing in this export feature ever sets it. Exporting a ZIP package
-- is not the same claim as "a Vinted draft was created", and these columns
-- keep that distinction real in the data, not just in UI wording.
alter table public.listing_drafts add column if not exists vinted_exported_at timestamptz;
alter table public.listing_drafts add column if not exists vinted_export_id text;
alter table public.listing_drafts add column if not exists vinted_draft_created_at timestamptz;


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

  -- Kept as the COMPLETE, current stage list (not just what existed when
  -- this table was first created) — see the single widening ALTER block
  -- below for why: on a brand-new install this inline check is never
  -- superseded by anything narrower, so it must already be correct on its
  -- own rather than relying on later ALTERs to fill in missing values.
  stage text not null
    check (
      stage in (
        'image_quality',
        'label_extraction',
        'visual_identification',
        'consistency_check',
        'generation',
        'product_grouping',
        'category_selection',
        'audience_reassessment'
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

-- Widens the `stage` check constraint on an already-deployed database,
-- since `create table if not exists` above only affects a brand-new
-- install — an existing table's constraint must be explicitly replaced to
-- accept a new stage value. Stages were added over several milestones:
-- 'product_grouping' (Milestone 3, automatic AI product grouping),
-- 'category_selection' (Milestone 7, Vinted category catalogue sync — see
-- lib/listing-studio/vinted-category-selection-ai.ts, a bounded text-only
-- call made after 'generation' that picks a Vinted category id from a
-- small candidate list), and 'audience_reassessment' (follow-up
-- correction 2026-08-05 — see
-- lib/listing-studio/vinted-audience-reassessment-ai.ts, which
-- re-determines vintedAudience alone for an already-generated draft,
-- either from stored text or by re-examining stored photos via the
-- explicit "Reassess audience" action).
--
-- Deliberately kept as exactly ONE drop+add, listing every stage this
-- table has EVER accepted (not just the stage introduced by the most
-- recent change): this whole file is a single flat script that gets
-- rerun in full against an already-populated database, never applied as
-- one-shot numbered migrations. A `check` constraint validates every
-- existing row the instant it's added — so a version of this block that
-- lists only "what's new" (omitting a stage older rows already use, e.g.
-- an early version of this block omitted 'category_selection') fails the
-- ADD CONSTRAINT outright on any database that already has rows using
-- that older stage. Keeping a single block with the full cumulative list
-- is the only form that is safe to rerun regardless of history or row
-- data. Never split this back into sequential narrower blocks.
alter table public.listing_analysis_runs drop constraint if exists listing_analysis_runs_stage_check;
alter table public.listing_analysis_runs add constraint listing_analysis_runs_stage_check
  check (
    stage in (
      'image_quality',
      'label_extraction',
      'visual_identification',
      'consistency_check',
      'generation',
      'product_grouping',
      'category_selection',
      'audience_reassessment'
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

-- Listings Review redesign — the single most-recent extension-batch-item
-- row per draft, across EVERY batch the owner has ever sent (not just the
-- currently-open one), so per-row workflow status and the Drafts/Sent
-- summary counts stay correct after a page reload, a browser restart, or
-- opening the app on another device. Read-only, owner-scoped (RLS is
-- irrelevant here since this is only ever invoked via the service-role
-- key, same as every other function in this file — see the revoke block
-- below), every table reference fully qualified with `public.` so the
-- query can never be redirected by a caller-controlled search_path.
-- "Most recent" = greatest(completed_at, started_at, batch.created_at) —
-- a real timestamp always exists on at least the batch row, so this never
-- falls back to an arbitrary tiebreak except in the vanishingly rare case
-- of an exact timestamp collision, where batch.created_at then item.id
-- give a final, still-deterministic order. Cancelled items are excluded
-- (a cancelled attempt never happened, from a review perspective) so a
-- draft's last REAL attempt is always what surfaces.
create or replace function public.listing_studio_latest_extension_status(p_owner_id uuid)
returns table (
  draft_id uuid,
  batch_id uuid,
  batch_status text,
  item_status text,
  queue_position integer,
  error_code text,
  error_message text,
  vinted_draft_id text,
  started_at timestamptz,
  completed_at timestamptz,
  current_step text,
  step_detail text
)
language sql
stable
as $$
  select distinct on (bi.draft_id)
    bi.draft_id,
    b.id as batch_id,
    b.status as batch_status,
    bi.status as item_status,
    bi.queue_position,
    bi.error_code,
    bi.error_message,
    bi.vinted_draft_id,
    bi.started_at,
    bi.completed_at,
    bi.current_step,
    bi.step_detail
  from public.vinted_extension_batch_items bi
  join public.vinted_extension_batches b on b.id = bi.batch_id
  where b.owner_id = p_owner_id
    and bi.status <> 'cancelled'
  order by bi.draft_id, greatest(bi.completed_at, bi.started_at, b.created_at) desc, b.created_at desc, bi.id desc;
$$;

-- Milestone 7 (Vinted category catalogue sync) — applies one fetched,
-- flattened, already-Zod-validated catalogue snapshot atomically. A
-- concurrent refresh for the same market fails fast
-- (pg_try_advisory_xact_lock — never queues/blocks, since two interleaved
-- refreshes could otherwise corrupt each other's created/updated/
-- deactivated counts), an implausible catalogue shrinkage is refused
-- outright unless explicitly forced, and every category from the new
-- snapshot is upserted while any category missing from it is marked
-- inactive rather than deleted — all inside one transaction, so a failure
-- partway through never leaves a half-applied catalogue and the previous
-- snapshot remains exactly as it was. p_categories is a JSON array of
-- flattened category objects (see lib/listing-studio/vinted-catalogue.ts's
-- FlattenedVintedCategory shape); this function re-validates ids and
-- duplicates defensively even though the caller already validated them,
-- exactly like every other RPC in this file re-verifies ownership/
-- membership regardless of what the client already checked. Safe to
-- retry: re-applying the identical snapshot again produces
-- created_count=0, updated_count=0, unchanged_count=total.
-- Follow-up correction (2026-08-03): widens this function's signature with
-- two new trailing (defaulted) params, p_source_type/p_captured_at — see
-- vinted_categories.source_type's own comment. Postgres identifies a
-- function by name+argument-TYPES, so `create or replace` on a widened
-- parameter list creates a second overload rather than replacing an
-- already-installed 6-arg version; the explicit drop below removes that
-- old signature first so re-running this file always leaves exactly one
-- version installed, regardless of which one (if any) was run before.
drop function if exists public.vinted_categories_apply_refresh(text, text, jsonb, text, integer, boolean);

create or replace function public.vinted_categories_apply_refresh(
  p_source_market text,
  p_source_endpoint text,
  p_categories jsonb,
  p_fingerprint text,
  p_duration_ms integer default null,
  p_force boolean default false,
  p_source_type text default 'live_endpoint',
  p_captured_at timestamptz default null
)
returns table(
  fetched_count integer, active_count integer, created_count integer, updated_count integer,
  unchanged_count integer, deactivated_count integer, leaf_count integer, selectable_count integer,
  fingerprint text, refreshed_at timestamptz
)
language plpgsql
as $$
declare
  v_lock_key bigint;
  v_new_count integer;
  v_current_active_count integer;
  v_created integer;
  v_updated integer;
  v_deactivated integer;
  v_active_count integer;
  v_leaf_count integer;
  v_selectable_count integer;
  v_now timestamptz := now();
begin
  if p_source_market is null or trim(p_source_market) = '' then
    raise exception 'INVALID_SOURCE_MARKET' using errcode = 'P0001';
  end if;

  if p_categories is null or jsonb_typeof(p_categories) <> 'array' then
    raise exception 'INVALID_CATEGORIES_PAYLOAD' using errcode = 'P0002';
  end if;

  if p_source_type not in ('live_endpoint', 'verified_browser_snapshot') then
    raise exception 'INVALID_SOURCE_TYPE' using errcode = 'P0008';
  end if;

  v_new_count := jsonb_array_length(p_categories);
  if v_new_count = 0 then
    raise exception 'EMPTY_CATALOGUE_REJECTED' using errcode = 'P0003';
  end if;

  v_lock_key := ('x' || substr(md5('vinted_categories_refresh:' || p_source_market), 1, 15))::bit(60)::bigint;
  if not pg_try_advisory_xact_lock(v_lock_key) then
    raise exception 'REFRESH_ALREADY_IN_PROGRESS' using errcode = 'P0004';
  end if;

  create temporary table tmp_vinted_categories on commit drop as
  select
    (elem ->> 'id')::bigint as id,
    elem ->> 'code' as code,
    elem ->> 'label' as label,
    elem ->> 'full_path' as full_path,
    nullif(elem ->> 'parent_id', '')::bigint as parent_id,
    (elem ->> 'root_id')::bigint as root_id,
    (elem ->> 'depth')::integer as depth,
    (elem ->> 'sort_order')::integer as sort_order,
    (elem ->> 'is_leaf')::boolean as is_leaf,
    (elem ->> 'is_selectable')::boolean as is_selectable,
    elem ->> 'audience' as audience,
    elem ->> 'item_family' as item_family,
    elem ->> 'vinted_url' as vinted_url,
    (elem ->> 'color_field_visibility')::boolean as color_field_visibility,
    (elem ->> 'size_field_visibility')::boolean as size_field_visibility,
    (elem ->> 'measurements_field_visibility')::boolean as measurements_field_visibility,
    (elem ->> 'brand_field_visibility')::boolean as brand_field_visibility,
    elem -> 'raw_json' as raw_json
  from jsonb_array_elements(p_categories) as elem;

  if exists (select 1 from tmp_vinted_categories where id is null or id <= 0) then
    raise exception 'INVALID_CATEGORY_ID' using errcode = 'P0005';
  end if;

  if exists (select 1 from (select id from tmp_vinted_categories group by id having count(*) > 1) dup) then
    raise exception 'DUPLICATE_CATEGORY_ID_IN_PAYLOAD' using errcode = 'P0006';
  end if;

  select count(*) into v_current_active_count
  from public.vinted_categories
  where source_market = p_source_market and is_active;

  -- Suspicious-shrinkage guard: refuse to activate a refresh that would
  -- lose more than half of an already-substantial catalogue, unless
  -- explicitly forced (p_force) — see this function's own top comment.
  if not p_force and v_current_active_count > 20 and v_new_count < ceil(v_current_active_count * 0.5) then
    raise exception 'SUSPICIOUS_CATALOGUE_SHRINKAGE' using errcode = 'P0007',
      detail = format('new fetched count %s vs current active count %s for market %s', v_new_count, v_current_active_count, p_source_market);
  end if;

  select count(*) into v_created
  from tmp_vinted_categories t
  where not exists (select 1 from public.vinted_categories v where v.id = t.id);

  select count(*) into v_updated
  from tmp_vinted_categories t
  join public.vinted_categories v on v.id = t.id
  where v.label is distinct from t.label
     or v.full_path is distinct from t.full_path
     or v.parent_id is distinct from t.parent_id
     or v.root_id is distinct from t.root_id
     or v.depth is distinct from t.depth
     or v.sort_order is distinct from t.sort_order
     or v.is_leaf is distinct from t.is_leaf
     or v.is_selectable is distinct from t.is_selectable
     or v.is_active is distinct from true
     or v.audience is distinct from t.audience
     or v.item_family is distinct from t.item_family
     or v.vinted_url is distinct from t.vinted_url;

  insert into public.vinted_categories (
    id, code, label, full_path, parent_id, root_id, depth, sort_order,
    is_leaf, is_selectable, is_active, audience, item_family, vinted_url,
    color_field_visibility, size_field_visibility, measurements_field_visibility, brand_field_visibility,
    raw_json, source_endpoint, source_market, source_fingerprint, source_type, captured_at, imported_at,
    first_seen_at, last_seen_at, last_updated_at
  )
  select
    t.id, t.code, t.label, t.full_path, t.parent_id, t.root_id, t.depth, t.sort_order,
    t.is_leaf, t.is_selectable, true, t.audience, t.item_family, t.vinted_url,
    t.color_field_visibility, t.size_field_visibility, t.measurements_field_visibility, t.brand_field_visibility,
    t.raw_json, p_source_endpoint, p_source_market, p_fingerprint, p_source_type, p_captured_at, v_now,
    v_now, v_now, v_now
  from tmp_vinted_categories t
  on conflict (id) do update set
    code = excluded.code, label = excluded.label, full_path = excluded.full_path,
    parent_id = excluded.parent_id, root_id = excluded.root_id, depth = excluded.depth, sort_order = excluded.sort_order,
    is_leaf = excluded.is_leaf, is_selectable = excluded.is_selectable, is_active = true,
    audience = excluded.audience, item_family = excluded.item_family, vinted_url = excluded.vinted_url,
    color_field_visibility = excluded.color_field_visibility, size_field_visibility = excluded.size_field_visibility,
    measurements_field_visibility = excluded.measurements_field_visibility, brand_field_visibility = excluded.brand_field_visibility,
    raw_json = excluded.raw_json, source_endpoint = excluded.source_endpoint, source_market = excluded.source_market,
    source_fingerprint = excluded.source_fingerprint, source_type = excluded.source_type,
    captured_at = excluded.captured_at, imported_at = excluded.imported_at,
    last_seen_at = v_now, last_updated_at = v_now;

  -- Never deleted — a category missing from this refresh is marked
  -- inactive so any draft that already chose it keeps a joinable,
  -- readable reference (see this table's own top comment).
  with deactivated as (
    update public.vinted_categories v
    set is_active = false, last_updated_at = v_now
    where v.source_market = p_source_market
      and v.is_active = true
      and not exists (select 1 from tmp_vinted_categories t where t.id = v.id)
    returning 1
  )
  select count(*) into v_deactivated from deactivated;

  select count(*) into v_active_count from public.vinted_categories where source_market = p_source_market and is_active;
  select count(*) into v_leaf_count from public.vinted_categories where source_market = p_source_market and is_active and is_leaf;
  select count(*) into v_selectable_count from public.vinted_categories where source_market = p_source_market and is_active and is_selectable;

  insert into public.vinted_category_sync_status (
    source_market, source_endpoint, last_attempted_at, last_succeeded_at, last_status, last_error,
    fetched_count, active_count, fingerprint, duration_ms, last_source_type, last_captured_at, updated_at
  )
  values (p_source_market, p_source_endpoint, v_now, v_now, 'success', null, v_new_count, v_active_count, p_fingerprint, p_duration_ms, p_source_type, p_captured_at, v_now)
  on conflict (source_market) do update set
    source_endpoint = excluded.source_endpoint, last_attempted_at = excluded.last_attempted_at,
    last_succeeded_at = excluded.last_succeeded_at, last_status = excluded.last_status, last_error = null,
    fetched_count = excluded.fetched_count, active_count = excluded.active_count,
    fingerprint = excluded.fingerprint, duration_ms = excluded.duration_ms,
    last_source_type = excluded.last_source_type, last_captured_at = excluded.last_captured_at, updated_at = v_now;

  fetched_count := v_new_count;
  active_count := v_active_count;
  created_count := v_created;
  updated_count := v_updated;
  unchanged_count := v_new_count - v_created - v_updated;
  deactivated_count := v_deactivated;
  leaf_count := v_leaf_count;
  selectable_count := v_selectable_count;
  fingerprint := p_fingerprint;
  refreshed_at := v_now;
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
revoke all on function public.listing_studio_latest_extension_status(uuid) from public;
revoke all on function public.vinted_categories_apply_refresh(text, text, jsonb, text, integer, boolean, text, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.listing_studio_move_images(uuid, uuid[], uuid) from anon;
    revoke all on function public.listing_studio_reorder_images(uuid, uuid, uuid[]) from anon;
    revoke all on function public.listing_studio_split_group(uuid, uuid, uuid[], text) from anon;
    revoke all on function public.listing_studio_merge_groups(uuid, uuid, uuid) from anon;
    revoke all on function public.listing_studio_delete_group(uuid, uuid, text) from anon;
    revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from anon;
    revoke all on function public.listing_studio_clear_workspace(uuid) from anon;
    revoke all on function public.listing_studio_latest_extension_status(uuid) from anon;
    revoke all on function public.vinted_categories_apply_refresh(text, text, jsonb, text, integer, boolean, text, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.listing_studio_move_images(uuid, uuid[], uuid) from authenticated;
    revoke all on function public.listing_studio_reorder_images(uuid, uuid, uuid[]) from authenticated;
    revoke all on function public.listing_studio_split_group(uuid, uuid, uuid[], text) from authenticated;
    revoke all on function public.listing_studio_delete_group(uuid, uuid, text) from authenticated;
    revoke all on function public.listing_studio_merge_groups(uuid, uuid, uuid) from authenticated;
    revoke all on function public.listing_studio_apply_boundary_session(uuid, uuid, jsonb) from authenticated;
    revoke all on function public.listing_studio_clear_workspace(uuid) from authenticated;
    revoke all on function public.listing_studio_latest_extension_status(uuid) from authenticated;
    revoke all on function public.vinted_categories_apply_refresh(text, text, jsonb, text, integer, boolean, text, timestamptz) from authenticated;
  end if;
end $$;

-- Milestone 7 (Chrome extension draft queue) — a completely separate,
-- clean implementation from the (never-committed-to-this-repo) old
-- extension work; see the app-side lib/routes for the full flow. This app
-- never talks to Vinted itself and the extension never talks to Supabase
-- directly — every extension request goes through this app's own API
-- routes (using the SAME service-role access every other route already
-- uses), so no new direct-database exposure is introduced at all.
--
-- Two tables: one batch (the pairing/claim/expiry envelope) and its
-- ordered items (one per selected listing, up to 5). The pairing SECRET
-- itself is never stored — only a keyed HMAC-SHA256 hash of it
-- (pairing_code_hash), matching this app's existing "never store a raw
-- credential, hash or sign with a server-only secret" convention (see
-- lib/yahoo/tokens.ts's EMAIL_ID_SECRET-keyed JWT signing, which the
-- restricted batch token issued after a successful claim also reuses).
create table if not exists public.vinted_extension_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,

  -- HMAC-SHA256(pairing code, EXTENSION_BATCH_SECRET), hex — never the
  -- plaintext code. Looked up by exact match on claim; the code itself
  -- carries enough entropy (see lib/listing-studio/extension-pairing-code.ts)
  -- that this is a safe single lookup, not a per-row compare loop.
  pairing_code_hash text not null,

  status text not null default 'pending_claim'
    check (status in ('pending_claim', 'claimed', 'in_progress', 'completed', 'expired', 'cancelled')),

  listing_count integer not null
    check (listing_count between 1 and 5),

  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  expires_at timestamptz not null,
  completed_at timestamptz,

  -- Self-reported by the claiming extension (chrome.runtime.id / its own
  -- manifest version) — informational only for support/diagnosis, never
  -- trusted as an authorization check.
  extension_id text,
  extension_version text
);

-- One lookup per claim attempt, by hash — never a table scan.
create unique index if not exists vinted_extension_batches_pairing_code_hash_idx
  on public.vinted_extension_batches (pairing_code_hash);
create index if not exists vinted_extension_batches_owner_idx
  on public.vinted_extension_batches (owner_id, created_at desc);

alter table public.vinted_extension_batches enable row level security;
revoke all on public.vinted_extension_batches from anon, authenticated;

create table if not exists public.vinted_extension_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.vinted_extension_batches (id)
    on delete cascade,
  draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,

  -- 0-indexed processing order within this batch — always the same order
  -- the owner selected/the app validated in, never re-sorted by the
  -- extension itself.
  queue_position integer not null,

  status text not null default 'queued'
    check (status in ('queued', 'preparing', 'filling', 'saving', 'completed', 'failed', 'paused', 'cancelled')),

  -- Bumped on every real attempt (a fresh Save Draft try) — the extension
  -- checks this alongside status before retrying, so a page reload/service-
  -- worker restart can never silently re-save an item that's already
  -- mid-flight or already completed (duplicate-draft protection).
  attempt_count integer not null default 0,

  error_code text,
  error_message text,

  -- Only ever set once Vinted itself has confirmed a draft exists (a real
  -- id/reference read back from Vinted's own result) — never guessed,
  -- never set merely because a save action was clicked.
  vinted_draft_id text,

  started_at timestamptz,
  completed_at timestamptz,

  unique (batch_id, draft_id),
  unique (batch_id, queue_position)
);

create index if not exists vinted_extension_batch_items_batch_idx
  on public.vinted_extension_batch_items (batch_id, queue_position);

alter table public.vinted_extension_batch_items enable row level security;
revoke all on public.vinted_extension_batch_items from anon, authenticated;

-- Listings Review redesign follow-up — forwarded from the extension's own
-- already-computed local step tracking (form-steps.js's report(status,
-- {currentStep, detail})), which previously never left the extension.
-- Free text only (a step name / a short human-readable line), same
-- trust level as error_code/error_message above — never a token, URL, or
-- secret. Cleared back to null whenever a fresh attempt starts
-- (status -> 'preparing') and finalised to null on completion/failure —
-- see app/api/extension/batch/items/[itemId]/result/route.ts — so a
-- completed or retried item never shows a stale "Uploading photo…" line.
alter table public.vinted_extension_batch_items add column if not exists current_step text;
alter table public.vinted_extension_batch_items add column if not exists step_detail text;

-- Milestone 7 (Chrome extension draft queue) follow-up: vinted_draft_created_at
-- (added by the ZIP-export migration above, alongside vinted_exported_at/
-- vinted_export_id) is set for the FIRST time by this feature, and only
-- ever from the extension's own result-reporting route, and only once
-- Vinted has authoritatively confirmed the draft — never during export
-- (export never sets it — see that section's own comment) and never
-- merely because a batch item's status reached 'saving'.
