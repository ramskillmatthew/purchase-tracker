-- Listing Studio — eBay UK category suggestion service (Stage 4). Run
-- manually in the Supabase SQL editor; nothing in this app runs it
-- automatically. Safe to re-run: every statement is idempotent, matching
-- every other supabase-*.sql file's convention.
--
-- Requires supabase-listing-studio-marketplace.sql (Stage 2) to already be
-- applied — this file only adds to listing_marketplace_drafts and adds new,
-- independent cache tables.
--
-- eBay's category tree id/version and its per-category aspect definitions
-- (Stage 5) are the two genuinely expensive, slow-changing things the spec
-- explicitly calls out as needing a server-side cache ("category trees and
-- aspect definitions should not be fetched redundantly for every product").
-- Category SUGGESTIONS themselves are cheap, per-search-query results with
-- no natural shared cache key across different products, so they are
-- deliberately NOT cached here — only the two genuinely reusable pieces.

-- One row per eBay marketplace (currently just 'EBAY_GB'). category_tree_id
-- rarely changes; category_tree_version changes only when eBay itself
-- revises that marketplace's tree. A stale version is detected by comparing
-- against a fresh get_default_category_tree_id response — see
-- lib/listing-studio/ebay-taxonomy-cache.ts.
create table if not exists public.ebay_category_tree_cache (
  ebay_marketplace_id text primary key,
  category_tree_id text not null,
  category_tree_version text not null,
  fetched_at timestamptz not null default now()
);

alter table public.ebay_category_tree_cache enable row level security;
revoke all on public.ebay_category_tree_cache from anon, authenticated;

-- One row per (category tree, category) whose item-aspect definitions
-- (Stage 5) have been fetched. Keyed on category_tree_version too, so a
-- tree revision naturally invalidates every cached category under the old
-- version without needing an explicit bulk-delete step — a lookup that
-- specifies the CURRENT version simply won't match an old-version row.
create table if not exists public.ebay_category_aspects_cache (
  category_tree_id text not null,
  category_id text not null,
  category_tree_version text not null,
  aspects_json jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (category_tree_id, category_id, category_tree_version)
);

alter table public.ebay_category_aspects_cache enable row level security;
revoke all on public.ebay_category_aspects_cache from anon, authenticated;

-- The top alternative suggestions eBay returned alongside the selected
-- category — { categoryId, categoryName, categoryPath, rank, confidence,
-- reason }[] — see lib/listing-studio/marketplace-types.ts's
-- EbayCategoryAlternative. Lets "Manual change" offer the same short list
-- shown at generation time without a redundant live re-fetch, and lets the
-- PATCH category-confirm endpoint verify a chosen id was genuinely one eBay
-- returned rather than trusting an arbitrary client-supplied id.
alter table public.listing_marketplace_drafts add column if not exists category_alternatives_json jsonb not null default '[]'::jsonb;

-- The exact search terms actually sent to eBay's Taxonomy API for the
-- current category_id/category_alternatives_json — audit/debug and lets a
-- "why was this suggested" explanation be shown without re-deriving it.
alter table public.listing_marketplace_drafts add column if not exists category_search_terms text;
