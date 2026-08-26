-- Listing Studio — marketplace-aware drafts (Stage 2). Run manually in the
-- Supabase SQL editor; nothing in this app runs it automatically. Safe to
-- re-run: every statement is idempotent (`if not exists` / drop+add for
-- CHECK constraints), matching every other supabase-*.sql file's convention.
--
-- ARCHITECTURE DECISION (read before touching this file): a product's
-- Vinted draft is NOT moved into a new table. `listing_drafts` (see
-- supabase-listing-studio.sql) keeps meaning exactly what it means today —
-- one row is one product group AND, implicitly, its Vinted marketplace
-- draft (title/description/category/condition/price all live on that row
-- exactly as before). This is deliberate: every existing Vinted-generation,
-- Vinted-category-assignment, Listings Review, and Chrome-extension code
-- path keeps working completely untouched, because nothing about how a
-- Vinted draft is stored or read has changed.
--
-- A product's OTHER marketplace drafts (initially just eBay UK) live in the
-- new `listing_marketplace_drafts` table below, one row per
-- (product, marketplace), referencing `listing_drafts` as the parent
-- product/shared-facts/shared-photos record. This is the least-disruptive
-- way to reach "one product, several marketplace drafts": the existing
-- table's meaning never changes, and the new table only ever ADDS
-- marketplace-specific data alongside it. `marketplace` accepts 'VINTED' as
-- well as 'EBAY_UK' for forward-compatibility (widening a CHECK constraint
-- safely later is exactly the kind of change this file's own established
-- pattern makes painful — see listing_analysis_runs_stage_check's own
-- comment in supabase-listing-studio.sql — so the full intended value set
-- is declared now even though no row uses 'VINTED' yet).

create table if not exists public.listing_marketplace_drafts (
  id uuid primary key default gen_random_uuid(),

  -- The shared product/photos/facts record this marketplace draft belongs
  -- to — see supabase-listing-studio.sql's listing_drafts.
  product_draft_id uuid not null
    references public.listing_drafts (id)
    on delete cascade,
  owner_id uuid not null,

  marketplace text not null
    check (marketplace in ('VINTED', 'EBAY_UK')),

  -- How this marketplace draft came to exist. 'generated' = created from
  -- the product's own photos via the AI pipeline (mirrors listing_drafts'
  -- own source_type='photos'). 'imported_ebay' = created from an eBay URL
  -- import (mirrors source_type='ebay_uk'). 'imported_vinted' and
  -- 'converted' are reserved for later marketplace-import/conversion work
  -- (out of scope for this milestone, never written yet). 'manual' covers
  -- a draft entirely hand-entered with no generation step at all.
  source_type text not null default 'generated'
    check (source_type in ('generated', 'imported_ebay', 'imported_vinted', 'converted', 'manual')),

  -- 'exact_copy' preserves imported title/description verbatim, never
  -- rewritten. 'seo_optimised' may generate marketplace-specific copy from
  -- verified facts. New photo-generated drafts default to seo_optimised;
  -- eBay-imported drafts default to exact_copy — enforced at the
  -- application layer when a row is first created, not by this default
  -- (which only applies when a caller omits the column entirely).
  content_mode text not null default 'seo_optimised'
    check (content_mode in ('seo_optimised', 'exact_copy')),

  title text,
  description text,

  -- Never free text — always a real category id/name/path the marketplace
  -- itself returned (see Stage 4's category-suggestion service). category_id
  -- is text (not bigint, unlike vinted_categories.id) because eBay's own
  -- category ids are opaque strings in their API responses.
  category_id text,
  category_name text,
  category_path text,
  category_source text
    check (category_source is null or category_source in ('ai', 'manual')),
  category_confidence text
    check (category_confidence is null or category_confidence in ('high', 'medium', 'low')),

  condition_value text,

  price_pence integer
    check (price_pence is null or price_pence >= 0),
  quantity integer
    check (quantity is null or quantity >= 0),
  currency text not null default 'GBP',

  -- 'draft' = not yet generated/completed. 'needs_information' = generation
  -- ran but required data is missing (see readiness_json). 'ready' = every
  -- readiness requirement met — "draft details complete", deliberately
  -- never "publishable", since live eBay publishing doesn't exist yet (see
  -- this file's own header). 'failed' = the last generation attempt itself
  -- errored. 'archived' mirrors listing_drafts' own status vocabulary.
  status text not null default 'draft'
    check (status in ('draft', 'needs_information', 'ready', 'failed', 'archived')),

  -- Structured readiness output: { ready: boolean, completionPercent,
  -- requiredComplete, requiredTotal, recommendedComplete, recommendedTotal }
  -- — see lib/listing-studio/marketplace-readiness.ts. Recomputed on every
  -- read, not trusted as stale stored state, but persisted too so Listings
  -- Review can filter/sort without recomputing every row's readiness from
  -- scratch.
  readiness_json jsonb not null default '{}'::jsonb,

  -- Blocking issues and review warnings, each identifying the affected
  -- field — mirrors listing_drafts.warnings_json/conflicts_json's own
  -- established shape exactly.
  validation_messages_json jsonb not null default '[]'::jsonb,

  -- Raw last-generation-output, audit/debug only — never read back as
  -- trusted input, exactly like listing_drafts.ai_result_json's own rule.
  ai_generation_json jsonb,

  -- Set when this draft was created by converting another marketplace's
  -- draft into this one (e.g. a future Vinted-to-eBay conversion) — self-
  -- referencing, nullable, never set by anything in this milestone.
  source_draft_id uuid
    references public.listing_marketplace_drafts (id)
    on delete set null,
  -- Set when this draft's content mode is exact_copy and it originated
  -- from an eBay URL import — the real eBay item id, mirrors
  -- listing_drafts.source_item_id.
  source_ebay_item_id text,

  -- Stage 5's per-category dynamic item-specifics: { [aspectName]: { value,
  -- confidence, source, appliedAutomatically, needsReview, userConfirmed,
  -- updatedAt } } — see lib/listing-studio/marketplace-types.ts's
  -- MarketplaceDynamicData (the Stage 5 aspect-fetching/matching service is
  -- a later addition; this column exists now so it has somewhere to write
  -- to). Empty until a category is selected and its aspect definitions are
  -- fetched.
  dynamic_data_json jsonb not null default '{}'::jsonb,

  -- Stage 3's per-draft settings override (format, quantity, postage/
  -- return/payment profile placeholders, allow-offers, automation mode) —
  -- see lib/listing-studio/marketplace-settings.ts. A key absent here falls
  -- through to the batch settings passed at generation time, then to
  -- listing_marketplace_settings_defaults below — the per-draft value
  -- always wins once present.
  settings_json jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One marketplace draft per product per marketplace. Also the natural
  -- upsert target (on conflict do update) that makes "generate" idempotent
  -- — a double-click or a retried request can never create two eBay drafts
  -- for the same product.
  unique (product_draft_id, marketplace)
);

create index if not exists listing_marketplace_drafts_product_idx
  on public.listing_marketplace_drafts (product_draft_id);
create index if not exists listing_marketplace_drafts_owner_marketplace_idx
  on public.listing_marketplace_drafts (owner_id, marketplace, status);

alter table public.listing_marketplace_drafts enable row level security;
revoke all on public.listing_marketplace_drafts from anon, authenticated;

-- Account-level default draft settings, one row per (owner, marketplace).
-- Batch-level settings (applied to every product generated together) are
-- deliberately NOT a stored table — this app has no persisted "batch"
-- entity for Listing Studio generation (a batch is just the set of product
-- groups selected in the UI at generate-time), so batch settings are passed
-- straight through in the generate request body and never outlive it. The
-- three-level hierarchy is: this row (lowest priority) -> batch settings
-- from the request (middle) -> listing_marketplace_drafts.settings_json
-- (highest, once a draft has its own override) — see
-- lib/listing-studio/marketplace-settings.ts's resolveMarketplaceSettings.
create table if not exists public.listing_marketplace_settings_defaults (
  owner_id uuid not null,
  marketplace text not null
    check (marketplace in ('VINTED', 'EBAY_UK')),

  content_mode text
    check (content_mode is null or content_mode in ('seo_optimised', 'exact_copy')),
  listing_format text not null default 'buy_it_now'
    check (listing_format in ('buy_it_now')),
  default_quantity integer not null default 1
    check (default_quantity > 0),
  allow_offers boolean not null default false,

  -- Never a real eBay policy id (eBay OAuth/account-policy retrieval is out
  -- of scope for this milestone — see this file's own header). A local,
  -- honestly-unconnected label the owner sets themselves, carried forward
  -- so the schema doesn't need to change again once real policy ids exist.
  postage_profile_label text,
  return_profile_label text,
  payment_profile_label text,

  package_size text
    check (package_size is null or package_size in ('large_letter', 'small_parcel', 'medium_parcel', 'custom')),

  automation_mode text not null default 'balanced'
    check (automation_mode in ('fast', 'balanced', 'strict')),

  updated_at timestamptz not null default now(),

  primary key (owner_id, marketplace)
);

alter table public.listing_marketplace_settings_defaults enable row level security;
revoke all on public.listing_marketplace_settings_defaults from anon, authenticated;

-- Shared, marketplace-agnostic product facts with provenance — additive and
-- empty by default, so no existing row needs backfilling and no existing
-- read path is affected. Distinct from listing_drafts.field_data_json
-- (which stays exactly as it is: the fixed Vinted-oriented field set
-- lib/listing-studio/types.ts's ListingFieldName enumerates, keyed by that
-- closed list) — shared_facts_json holds the OPEN-ENDED fact set Stage 2
-- describes (ean/upc/mpn/language/manufacturer/set/configuration/
-- numberOfBoxes and more), each value wrapped in the same
-- {value,source,confidence,confirmed} shape as field_data_json's envelope
-- for consistency, but keyed by an extensible fact name rather than a
-- fixed TypeScript union. See lib/listing-studio/marketplace-types.ts's
-- SharedFact/SharedFacts and lib/validation/listing-studio-marketplace.ts's
-- sharedFactsSchema.
alter table public.listing_drafts add column if not exists shared_facts_json jsonb not null default '{}'::jsonb;
