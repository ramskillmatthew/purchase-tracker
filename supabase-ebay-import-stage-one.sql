-- eBay UK Listing Studio importer — Stage One.
-- Safe to run repeatedly in the Supabase SQL Editor.

alter table public.listing_drafts add column if not exists source_type text not null default 'photos';
alter table public.listing_drafts drop constraint if exists listing_drafts_source_type_check;
alter table public.listing_drafts add constraint listing_drafts_source_type_check check (source_type in ('photos', 'ebay_uk'));
alter table public.listing_drafts add column if not exists source_url text;
alter table public.listing_drafts add column if not exists source_item_id text;

create table if not exists public.ebay_import_batches (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  status text not null default 'waiting' check (status in ('waiting','processing','completed')),
  total_count integer not null check (total_count > 0 and total_count <= 50),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists ebay_import_batches_owner_created_idx on public.ebay_import_batches(owner_id, created_at desc);
alter table public.ebay_import_batches enable row level security;
revoke all on public.ebay_import_batches from anon, authenticated;

create table if not exists public.ebay_import_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.ebay_import_batches(id) on delete cascade,
  owner_id uuid not null, source_url text not null, ebay_item_id text not null,
  status text not null default 'waiting' check (status in ('waiting','extracting','downloading_photos','processing','imported','failed')),
  title text, photo_count integer not null default 0 check (photo_count >= 0),
  draft_id uuid references public.listing_drafts(id) on delete set null,
  safe_error text, attempt_count integer not null default 0 check (attempt_count >= 0),
  started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists ebay_import_items_batch_created_idx on public.ebay_import_items(batch_id, created_at asc);
create index if not exists ebay_import_items_owner_item_idx on public.ebay_import_items(owner_id, ebay_item_id);
alter table public.ebay_import_items enable row level security;
revoke all on public.ebay_import_items from anon, authenticated;
