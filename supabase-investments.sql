-- ============================================================================
-- Investments feature — additive schema.
-- ============================================================================
-- Follows this repo's established conventions (see supabase-listing-studio.sql):
-- `create table if not exists`, owner_id uuid references auth.users(id) for
-- app-level ownership isolation, RLS enabled with NO policies (this app is
-- single-owner and every request goes through the service-role key —
-- requireOwner() in lib/auth/server.ts is the real authorization boundary,
-- matching every other feature in this codebase), anon/authenticated grants
-- revoked as defence in depth, numeric() for money/quantity (never floats
-- for authoritative financial values), and `check` constraints for closed
-- enums rather than a separate lookup table (matches every other status
-- column in this schema).
--
-- Money columns use numeric(14,2) (GBP, always 2dp). Quantity/native-price
-- columns use numeric(20,8) (enough precision for fractional shares and
-- sub-penny per-share prices) and numeric(20,10) for FX rates (rates are
-- often quoted to 4-6dp; 10dp leaves generous headroom without ever
-- rounding a provider's own rate). All arithmetic on these values must
-- happen in code via a decimal-safe path (see lib/investments/decimal.ts) —
-- never native JS floating point — before being written back.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- investment_accounts — a real, user-created investment/collection account.
-- Initial concepts (Stocks & Shares ISA, Pokémon Collection, LEGO Collection)
-- are created via onboarding/first-use, never seeded as fake production rows
-- — see app/api/investments/accounts/route.ts.
-- ----------------------------------------------------------------------------
create table if not exists public.investment_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  name text not null,
  account_type text not null
    check (account_type in ('isa', 'gia', 'pokemon_collection', 'lego_collection', 'cash', 'other')),
  institution text,
  reporting_currency text not null default 'GBP',
  cash_tracking_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

alter table public.investment_accounts enable row level security;
revoke all on public.investment_accounts from anon, authenticated;

create index if not exists investment_accounts_owner_idx on public.investment_accounts (owner_id) where archived_at is null;

-- ----------------------------------------------------------------------------
-- investment_assets — one row per distinct holding IDENTITY (a ticker, a
-- specific PokePulse card/sealed URL, a LEGO set). Never one row per lot —
-- lots/quantity live in investment_transactions and are aggregated at read
-- time (weighted-average cost basis — see lib/investments/cost-basis.ts).
--
-- Critical calculation fields (ticker, native_currency, pricing_provider,
-- source_url, external_id) are real columns, never buried only inside
-- `metadata` — metadata is exclusively for non-critical, provider-specific
-- extras (e.g. a cached PokePulse set name) that nothing here calculates
-- from directly.
-- ----------------------------------------------------------------------------
create table if not exists public.investment_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  category text not null check (category in ('stock', 'pokemon', 'lego', 'cash')),
  display_name text not null,
  ticker text,
  exchange text,
  native_currency text not null default 'GBP',
  -- 'none' covers cash (never priced) and any future manually-tracked
  -- category that hasn't been wired to a provider yet. 'eodhd' covers
  -- LSE-listed instruments Twelve Data's configured plan doesn't reach
  -- (see the ALTER block near the end of this file for the migration
  -- that adds it to an already-existing database, and the project's own
  -- "never chain narrower-then-wider ALTER blocks" lesson for why that
  -- migration finds and replaces the constraint by content, not by a
  -- guessed name).
  pricing_provider text not null default 'manual'
    check (pricing_provider in ('twelve_data', 'pokepulse', 'eodhd', 'manual', 'none')),
  -- The EXPLICIT unit a provider quotes this instrument's price in — never
  -- inferred from magnitude (a real, confirmed-dangerous bug: a naive
  -- "divide by 100 if >= 1000" heuristic would treat V3AB's genuine ~588
  -- GBX reading as £588, a ~100x error, since 588 < 1000). Required before
  -- routing an asset to a provider whose raw value isn't already known to
  -- be plain GBP (i.e. required for 'eodhd'; null/irrelevant for
  -- 'twelve_data' and 'pokepulse', which already return whole-currency-unit
  -- values). See lib/investments/providers/eodhd.ts's normalizeProviderPrice().
  provider_quote_unit text check (provider_quote_unit is null or provider_quote_unit in ('GBP', 'GBX', 'USD', 'EUR')),
  source_url text,
  external_id text,
  image_url text,
  lego_set_number text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

alter table public.investment_assets enable row level security;
revoke all on public.investment_assets from anon, authenticated;

create index if not exists investment_assets_owner_idx on public.investment_assets (owner_id) where archived_at is null;
create index if not exists investment_assets_category_idx on public.investment_assets (owner_id, category) where archived_at is null;
-- Prevents adding the exact same real-world asset (same ticker, same
-- PokePulse URL identity, same LEGO set) twice for one owner while it's
-- still active — a re-added identical asset after archiving is allowed
-- (the partial index only covers non-archived rows).
create unique index if not exists investment_assets_owner_identity_idx
  on public.investment_assets (owner_id, category, external_id)
  where archived_at is null and external_id is not null;

-- ----------------------------------------------------------------------------
-- investment_transactions — the authoritative ledger. Dividends are
-- deliberately NOT a supported transaction_type (out of scope for this
-- tracker, per explicit product decision). Never hard-deleted or
-- destructively cascaded — account_id/asset_id use `on delete restrict` so
-- an account/asset with real transaction history can never be removed out
-- from under them by a careless FK cascade; archiving is the only supported
-- removal path (see investment_accounts.archived_at / investment_assets.archived_at).
-- ----------------------------------------------------------------------------
create table if not exists public.investment_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  account_id uuid not null references public.investment_accounts (id) on delete restrict,
  -- null only for a pure cash deposit/withdrawal with no associated asset.
  asset_id uuid references public.investment_assets (id) on delete restrict,
  transaction_type text not null
    check (transaction_type in ('buy', 'sell', 'fee', 'deposit', 'withdrawal', 'adjustment')),
  trade_at timestamptz not null,
  -- Fractional quantity (shares, cards, sets). Null for a pure cash
  -- deposit/withdrawal/fee-only row.
  quantity numeric(20, 8),
  native_unit_price numeric(20, 8),
  native_currency text not null default 'GBP',
  -- The AUTHORITATIVE GBP amount actually charged/received — see this
  -- feature's own decomposition rules (lib/investments/cost-basis.ts):
  -- when supplied, this is what cost basis and cash movements are built
  -- from, never a client-side recomputation from native_unit_price alone.
  gbp_total numeric(14, 2) not null,
  -- The GBP-per-native-unit rate used at trade time — null when
  -- native_currency = 'GBP' (there is no FX effect to record).
  fx_rate_at_trade numeric(20, 10),
  gbp_fees numeric(14, 2) not null default 0,
  notes text,
  -- Spreadsheet-import idempotency key — see lib/investments/import/*.
  import_reference text,
  -- Soft "this transaction no longer counts" flag (a corrected import row,
  -- or an explicit reversal) — never hard-deleted, so realised history
  -- always stays auditable.
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quantity is null or quantity >= 0),
  check (gbp_fees >= 0)
);

alter table public.investment_transactions enable row level security;
revoke all on public.investment_transactions from anon, authenticated;

create index if not exists investment_transactions_owner_idx on public.investment_transactions (owner_id, trade_at desc);
create index if not exists investment_transactions_account_idx on public.investment_transactions (account_id, trade_at desc);
create index if not exists investment_transactions_asset_idx on public.investment_transactions (asset_id, trade_at asc) where asset_id is not null;
create unique index if not exists investment_transactions_import_reference_idx
  on public.investment_transactions (owner_id, import_reference)
  where import_reference is not null;

-- ----------------------------------------------------------------------------
-- investment_price_snapshots — every successful valuation is INSERTED, never
-- overwritten, so historical charts and data-quality auditing both stay
-- possible. `data_quality` distinguishes genuine market data from a manual
-- entry and from the purchase-price fallback used before any real market
-- history exists for an asset (see lib/investments/reconstruction.ts) —
-- the fallback is never labelled as live market data.
-- ----------------------------------------------------------------------------
create table if not exists public.investment_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  asset_id uuid not null references public.investment_assets (id) on delete cascade,
  native_unit_price numeric(20, 8) not null,
  gbp_unit_price numeric(20, 8) not null,
  fx_rate numeric(20, 10),
  price_at timestamptz not null,
  -- 'eodhd' covers LSE-listed instruments (see investment_assets.pricing_provider's
  -- own comment) — the ALTER block near the end of this file adds it to an
  -- already-existing database using the same content-based constraint lookup.
  provider text not null check (provider in ('twelve_data', 'pokepulse', 'eodhd', 'manual', 'purchase_price_fallback')),
  -- Full unit provenance — preserved alongside the already-normalized
  -- native_unit_price so a normalization mistake is always auditable after
  -- the fact, never just trusted. All three null for providers that never
  -- needed sub-unit normalization (Twelve Data, PokePulse, manual) — only
  -- populated when a real conversion happened.
  raw_provider_price numeric(20, 8),
  provider_quote_unit text check (provider_quote_unit is null or provider_quote_unit in ('GBP', 'GBX', 'USD', 'EUR')),
  normalization_multiplier numeric(20, 10),
  source_url text,
  data_quality text not null default 'market' check (data_quality in ('market', 'manual', 'purchase_price_fallback')),
  created_at timestamptz not null default now()
);

alter table public.investment_price_snapshots enable row level security;
revoke all on public.investment_price_snapshots from anon, authenticated;

create index if not exists investment_price_snapshots_asset_idx on public.investment_price_snapshots (asset_id, price_at desc);
-- Prevents an accidental duplicate write for the exact same asset/provider/
-- moment (e.g. a retried refresh) without blocking two genuinely distinct
-- prices at different timestamps, or a manual correction from a different
-- provider label.
create unique index if not exists investment_price_snapshots_dedup_idx
  on public.investment_price_snapshots (asset_id, provider, price_at);

-- ----------------------------------------------------------------------------
-- investment_fx_rates — a shared cache (not owner-scoped: an FX rate is not
-- personal data, and caching it once per owner would multiply pointless
-- provider calls for a single-owner app anyway). GBP-per-native-currency
-- direction is used consistently throughout this feature — base_currency is
-- always the NATIVE currency being priced, quote_currency is always 'GBP'.
-- ----------------------------------------------------------------------------
create table if not exists public.investment_fx_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency text not null,
  quote_currency text not null,
  rate_at date not null,
  rate numeric(20, 10) not null,
  provider text not null default 'frankfurter',
  created_at timestamptz not null default now()
);

alter table public.investment_fx_rates enable row level security;
revoke all on public.investment_fx_rates from anon, authenticated;

create unique index if not exists investment_fx_rates_dedup_idx
  on public.investment_fx_rates (base_currency, quote_currency, rate_at, provider);

-- ----------------------------------------------------------------------------
-- investment_refresh_runs — one row per refresh attempt (manual button,
-- auto-on-page-open, or cron), so the UI can show "last successful sync",
-- per-provider partial-failure detail, and support retrying just the
-- failed assets.
-- ----------------------------------------------------------------------------
create table if not exists public.investment_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  trigger text not null check (trigger in ('manual', 'auto_page_open', 'cron')),
  status text not null default 'running' check (status in ('running', 'completed', 'partial_failure', 'failed')),
  -- One entry per asset attempted this run: [{assetId, provider, ok, error}].
  -- Small, bounded (one owner's real holding count), so jsonb here is
  -- appropriate — this is refresh telemetry, not a calculation input.
  results jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.investment_refresh_runs enable row level security;
revoke all on public.investment_refresh_runs from anon, authenticated;

create index if not exists investment_refresh_runs_owner_idx on public.investment_refresh_runs (owner_id, started_at desc);

-- ----------------------------------------------------------------------------
-- investment_portfolio_snapshots — a cache of one row per (owner, day) for
-- efficient chart rendering, upserted from the same reconstruction function
-- the on-demand chart endpoint itself uses (lib/investments/reconstruction.ts)
-- — never a second, independently-computed source of truth.
-- ----------------------------------------------------------------------------
create table if not exists public.investment_portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  snapshot_date date not null,
  total_gbp_value numeric(14, 2) not null,
  total_cost_basis_gbp numeric(14, 2) not null,
  data_quality text not null default 'market' check (data_quality in ('market', 'mixed', 'purchase_price_fallback')),
  created_at timestamptz not null default now()
);

alter table public.investment_portfolio_snapshots enable row level security;
revoke all on public.investment_portfolio_snapshots from anon, authenticated;

create unique index if not exists investment_portfolio_snapshots_dedup_idx
  on public.investment_portfolio_snapshots (owner_id, snapshot_date);

-- ----------------------------------------------------------------------------
-- Storage bucket for LEGO-uploaded images — mirrors the listing-studio
-- image bucket's own setup pattern (private bucket, signed upload/read URLs
-- via lib/listing-studio/storage-rest.ts, reused unchanged for this
-- feature). Run once; safe to re-run (idempotent upsert).
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('investment-images', 'investment-images', false)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- MIGRATION — adds 'eodhd' to investment_assets.pricing_provider's allowed
-- values (a secondary provider for LSE-listed instruments Twelve Data's
-- configured plan doesn't cover — VWRP/V3AB/VUAG). Additive only: no data
-- is touched, no column is dropped, every existing row's pricing_provider
-- value ('twelve_data'/'pokepulse'/'manual'/'none') is still valid under
-- the replacement constraint.
--
-- The constraint is found and dropped BY CONTENT (searching pg_constraint
-- for a CHECK on this table mentioning pricing_provider), not by a
-- guessed name — a prior real bug in this project came from chaining a
-- narrower-then-wider ALTER assuming a specific auto-generated name;
-- this migration is the corrected pattern: always end up with exactly
-- ONE constraint holding the full, current, cumulative allowed list.
-- Safe to re-run.
-- ----------------------------------------------------------------------------
do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'investment_assets' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%pricing_provider%';
  if existing_constraint is not null then
    execute format('alter table public.investment_assets drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.investment_assets
  add constraint investment_assets_pricing_provider_check
  check (pricing_provider in ('twelve_data', 'pokepulse', 'eodhd', 'manual', 'none'));

-- ----------------------------------------------------------------------------
-- MIGRATION — the same 'eodhd' addition, for investment_price_snapshots'
-- OWN separate provider CHECK constraint (a distinct constraint on a
-- distinct table — writing a real eodhd snapshot would otherwise be
-- rejected even after the assets-table migration above). Same
-- find-by-content, safe-to-re-run pattern.
-- ----------------------------------------------------------------------------
do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'investment_price_snapshots' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%provider%' and pg_get_constraintdef(con.oid) ilike '%twelve_data%';
  if existing_constraint is not null then
    execute format('alter table public.investment_price_snapshots drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.investment_price_snapshots
  add constraint investment_price_snapshots_provider_check
  check (provider in ('twelve_data', 'pokepulse', 'eodhd', 'manual', 'purchase_price_fallback'));

-- ============================================================================
-- PHASE A — schema support only. Safe to run now: adds columns/constraints
-- and populates verified reference metadata, but changes NO asset's
-- pricing_provider and writes NO price snapshot. Twelve Data stays the
-- routed provider for VWRP/V3AB/VUAG after this block — they keep showing
-- "Purchase-price fallback" exactly as before, honestly, until Phase B.
-- Idempotent (every statement is create-if-not-exists / content-based
-- constraint replacement / a scoped, re-runnable update) — safe to re-run.
-- ============================================================================

-- Adds provider_quote_unit to investment_assets for a database created
-- before this column existed in the inline CREATE TABLE above.
alter table public.investment_assets
  add column if not exists provider_quote_unit text;

do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'investment_assets' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%provider_quote_unit%';
  if existing_constraint is not null then
    execute format('alter table public.investment_assets drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.investment_assets
  add constraint investment_assets_provider_quote_unit_check
  check (provider_quote_unit is null or provider_quote_unit in ('GBP', 'GBX', 'USD', 'EUR'));

-- Same additive columns on investment_price_snapshots, for full unit
-- provenance on every future EODHD-sourced row.
alter table public.investment_price_snapshots
  add column if not exists raw_provider_price numeric(20, 8),
  add column if not exists provider_quote_unit text,
  add column if not exists normalization_multiplier numeric(20, 10);

do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'investment_price_snapshots' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%provider_quote_unit%';
  if existing_constraint is not null then
    execute format('alter table public.investment_price_snapshots drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.investment_price_snapshots
  add constraint investment_price_snapshots_provider_quote_unit_check
  check (provider_quote_unit is null or provider_quote_unit in ('GBP', 'GBX', 'USD', 'EUR'));

-- ----------------------------------------------------------------------------
-- Verified reference metadata for the three Vanguard LSE ETFs — populated
-- now (Phase A) so it's already in place before Phase B ever runs, but
-- provider_quote_unit alone does nothing until an asset's pricing_provider
-- is actually 'eodhd' (still 'twelve_data' for all three after this block).
--
-- provider_quote_unit is 'GBP' — CONFIRMED, not a hypothesis. The initial
-- working hypothesis here was 'GBX' (standard LSE market convention quotes
-- exchange-listed ETFs in pence on the raw exchange tape), and it was
-- WRONG for this provider: the read-only dry run (scripts/eodhd-dry-run.mjs)
-- was run live on 2026-08-17 against real EODHD responses and caught it —
-- treating EODHD's raw values as GBX produced a ~99% (~0.01x) understatement
-- for all three funds, correctly refused by the sanity guard before
-- anything was written. Re-run with 'GBP', the same raw values matched the
-- independent reference prices below within 0.3% for all three, confirming
-- EODHD's `/api/eod` endpoint returns these three funds' prices already in
-- whole GBP pounds, not GBX pence. This is exactly why the unit is
-- verified against a real response before activation rather than trusted
-- from market convention alone — see this feature's own completion report
-- for the full before/after dry-run evidence.
--
-- Sources (fetched 2026-08-17): ISIN/SEDOL/share-class from justetf.com
-- and hl.co.uk (Vanguard's own fund-docs PDFs independently confirm ISIN
-- and Accumulating share class); reference GBP prices from hl.co.uk
-- (VWRP £144.62, V3AB £6.65) and stockanalysis.com (VUAG £111.08) — see
-- this feature's own completion report for the full citation list.
-- ----------------------------------------------------------------------------
update public.investment_assets
set provider_quote_unit = 'GBP',
    metadata = metadata || jsonb_build_object(
      'isin', 'IE00BK5BQT80', 'sedol', 'BK5XT51',
      'verified_reference_gbp_price', 144.62, 'verified_reference_source', 'hl.co.uk', 'verified_at', '2026-08-17'
    )
where ticker = 'VWRP' and exchange = 'LSE';

update public.investment_assets
set provider_quote_unit = 'GBP',
    metadata = metadata || jsonb_build_object(
      'isin', 'IE00BNG8L278', 'sedol', 'BMV7ZL9',
      'verified_reference_gbp_price', 6.65, 'verified_reference_source', 'hl.co.uk', 'verified_at', '2026-08-17'
    )
where ticker = 'V3AB' and exchange = 'LSE';

update public.investment_assets
set provider_quote_unit = 'GBP',
    metadata = metadata || jsonb_build_object(
      'isin', 'IE00BFMXXD54', 'sedol', 'BH3JG59',
      'verified_reference_gbp_price', 111.08, 'verified_reference_source', 'stockanalysis.com', 'verified_at', '2026-08-17'
    )
where ticker = 'VUAG' and exchange = 'LSE';

-- ============================================================================
-- PHASE B — DO NOT RUN YET. Only run this block after:
--   1. EODHD_API_KEY is configured and the read-only dry run
--      (scripts/eodhd-dry-run.mjs) has been run against real EODHD
--      responses for all three symbols;
--   2. the dry run's reconciliation table shows PASS for all three
--      (normalized price close to the independent reference price, no
--      ~100x/~0.01x scale mismatch, plausible observation date);
--   3. you have explicitly reviewed and approved that reconciliation.
-- Running this before the dry run passes could route real holdings to
-- EODHD with an unverified/wrong unit — exactly the risk this whole
-- feature exists to prevent. Scoped tightly (exact tickers + exchange +
-- only rows still on twelve_data) so it only ever touches these three
-- rows, and is a no-op once already applied — safe to re-run, but only
-- ever run it once the above is true.
-- ============================================================================
-- update public.investment_assets
-- set pricing_provider = 'eodhd'
-- where ticker in ('VWRP', 'V3AB', 'VUAG') and exchange = 'LSE' and pricing_provider = 'twelve_data';

-- ============================================================================
-- SAME-DAY PRICE REVISION SUPPORT — confirmed-live bug fix (2026-08-17):
-- investment_price_snapshots_dedup_idx was (asset_id, provider, price_at).
-- PokePulse (and, in principle, any provider) reports its observation at
-- DATE granularity (`price_at` is the aggregation date, not a real instant —
-- see lib/investments/providers/pokepulse.ts's normaliseAggregationDate).
-- A second refresh later the SAME day, with a genuinely different price,
-- collided on that narrow key: `resolution=ignore-duplicates` silently
-- discarded the new row, the stored/displayed price stayed on the FIRST
-- value seen that day, and the run's own result JSON still said "updated"
-- because the classification ran before the insert conflict was checked.
-- Confirmed live: asset 467edf3c-9388-421b-985a-9b6e9b00544a (Chaos Rising
-- Elite Trainer Box) had a stored £69.64 (written 07:57), then two more
-- refreshes that day genuinely returned £70.31 (12:57) and £67.52 (13:39) —
-- both silently dropped; the holding stayed stuck at £69.64 all day.
--
-- FIX: widen the uniqueness key to (asset_id, provider, price_at,
-- native_unit_price, gbp_unit_price) — a NEW row is only rejected when it
-- is an EXACT duplicate of an already-stored revision (same provider
-- observation date AND same native price AND same GBP price); a genuinely
-- different price on the same observation date is now a new, auditable
-- revision row, never an overwrite (the append-only design this table's
-- own top comment already commits to is unchanged — this only widens what
-- counts as "the same row", it never deletes or rewrites one).
--
-- This is a strict WIDENING of the uniqueness key (more columns = a more
-- permissive constraint, never a stricter one) — every row that already
-- satisfied the narrow 3-column key trivially still satisfies the wider
-- 5-column key, so no existing row can violate it and no data cleanup is
-- required before this runs. (Provable directly: two rows with the same
-- asset_id+provider+price_at only violated the OLD index if they were both
-- attempted — but ignore-duplicates already meant at most one of them was
-- ever actually stored, so no asset_id+provider+price_at pair exists twice
-- in the table today. You can confirm this with the query below before
-- running the migration, though it is expected to always return zero rows.)
--
--   select asset_id, provider, price_at, count(*)
--   from public.investment_price_snapshots
--   group by asset_id, provider, price_at
--   having count(*) > 1;
--
-- Idempotent via content-based lookup (matches this file's own established
-- convention for the provider-check migrations above) — safe to re-run.
-- ============================================================================
do $$
declare
  current_def text;
begin
  select pg_get_indexdef(pg_index.indexrelid) into current_def
  from pg_index
  join pg_class on pg_class.oid = pg_index.indexrelid
  join pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_class.relname = 'investment_price_snapshots_dedup_idx' and pg_namespace.nspname = 'public';

  if current_def is null or current_def not ilike '%native_unit_price%' then
    execute 'drop index if exists public.investment_price_snapshots_dedup_idx';
    execute 'create unique index investment_price_snapshots_dedup_idx on public.investment_price_snapshots (asset_id, provider, price_at, native_unit_price, gbp_unit_price)';
  end if;
end $$;

-- A sanitized, human-readable reason when a refresh run finalizes as
-- 'failed' without any per-asset results to explain why (an unexpected
-- exception before/between assets, or a stale 'running' row reclaimed after
-- a defensible timeout because the process that started it never finalized
-- it — e.g. a killed dev server, a client disconnect mid-stream). Null for
-- every ordinary completed/partial_failure run, where `results` already
-- explains everything per-asset.
alter table public.investment_refresh_runs
  add column if not exists failure_reason text;

-- ============================================================================
-- PENDING — prepared, NOT YET APPLIED (2026-08-17 forensic financial-
-- integrity audit). Pause here and confirm with the user before running.
--
-- Problem: the FX-only-revision fix (refresh.ts's maybeWriteFxOnlyRevision,
-- added earlier this same audit cycle) carries a native price forward
-- unchanged and writes a NEW snapshot row dated `price_at = now` (the
-- instant the new FX rate was discovered), because that new GBP valuation
-- genuinely IS current as of now. But `price_at` is read by several
-- consumers as "when was the underlying market price observed" — most
-- concretely lib/investments/holding-status.ts's `Latest close · {date}`
-- label (isPriceCurrentForLatestSession + formatShortMarketDate on
-- h.priceAt). An FX-only revision on, say, a Monday for a stock whose real
-- last trade was Friday would make that label read "Latest close · Monday"
-- — falsely implying the exchange supplied a new price on a date it never
-- traded. `price_at` is doing two jobs at once (ordering/selecting the
-- current valuation, AND describing when the underlying market observation
-- happened) and an FX-only revision is exactly the case where those two
-- jobs disagree.
--
-- Fix: one nullable, additive column. NULL for every ordinary snapshot
-- (native price and valuation observed at the same instant — no ambiguity,
-- no need to duplicate price_at). Populated ONLY by an FX-only revision,
-- carrying the ORIGINAL native-price observation's date/time forward, so a
-- consumer that wants "when did the market last actually move this stock"
-- can read `native_price_observed_at ?? price_at` instead of `price_at`
-- alone. `price_at` itself keeps its existing meaning and existing
-- consumers (latest-snapshot selection, chart chronology) unchanged — an
-- FX-only revision correctly continues to win "latest" and correctly
-- continues to land on today's date in the chart, because the GBP value
-- genuinely did change today.
--
-- Idempotent (add column if not exists) and fully backward compatible: no
-- existing row is touched, no existing query breaks, PostgREST inserts
-- that omit this column are unaffected. Safe to run at any time.
--
-- NOT wired into any code path yet — refresh.ts's maybeWriteFxOnlyRevision
-- still writes ordinary price_at=now rows until this migration has run
-- live and been confirmed; shipping code that references this column
-- before it exists would make every snapshot insert fail with an unknown-
-- column error, breaking the already-working FX-only-revision fix. The
-- planned follow-up, once this is confirmed applied:
--   1. maybeWriteFxOnlyRevision (refresh.ts) sets native_price_observed_at
--      to the CARRIED-FORWARD native price's own original price_at.
--   2. holding-status.ts's holdingPriceStatusLabel/isHoldingPriceCurrent
--      read native_price_observed_at ?? price_at instead of price_at alone.
--   3. Any "Provider observation" / refresh-details display showing a raw
--      snapshot date does the same.
-- ============================================================================
alter table public.investment_price_snapshots
  add column if not exists native_price_observed_at timestamptz;
