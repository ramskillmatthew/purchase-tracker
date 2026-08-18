-- Purchase category: a structured product-category field on public.purchases
-- (Pokémon / Clothing / Footwear / Lorcana / Other), used by later reporting
-- and by sale-item snapshots (see supabase-sales.sql). The canonical value
-- list lives in exactly one place in application code —
-- lib/validation/purchase.ts's `purchaseCategories` — this migration's CHECK
-- constraint must be kept in sync with it by hand if that list ever changes.
--
-- Same three-step ordering discipline as supabase-add-stock-status.sql, for
-- the same reason: a column DEFAULT in PostgreSQL is never applied
-- retroactively to rows that already exist, so backfilling must happen
-- BEFORE the default is set, or an old row and a genuinely-new row with no
-- category chosen yet would become indistinguishable:
--   1. Add the column with NO default yet (every existing row gets NULL).
--   2. Backfill every row that is NULL right now to 'Other' — this is
--      explicitly a safe default, never a keyword-guessed category; no
--      historical description is inspected or reclassified.
--   3. ONLY THEN set the column's default to 'Other', and require NOT NULL.
--
-- Wrapped in one explicit transaction; every statement is safe to run more
-- than once (idempotent) — matching this repo's established migration
-- convention (see supabase-add-stock-status.sql, supabase-purchase-import-v2.sql).
--
-- Deployment compatibility: existing API routes/pages that don't yet send a
-- `category` value (Vinted email import, AI extraction, any row inserted via
-- a code path this change didn't touch) simply receive the column default
-- ('Other') from the database itself — nothing about this migration requires
-- every insert path to be updated in lockstep before or after it runs.

begin;

alter table public.purchases
  add column if not exists category text check (category in ('Pokémon', 'Clothing', 'Footwear', 'Lorcana', 'Other'));

-- Only ever matches rows that predate this migration (or a prior,
-- interrupted run of it) — once every row has a non-null value, this is a
-- permanent no-op, which is what makes the whole script idempotent.
update public.purchases
  set category = 'Other'
  where category is null;

alter table public.purchases
  alter column category set default 'Other';

alter table public.purchases
  alter column category set not null;

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed)
-- ============================================================================
--   alter table public.purchases alter column category drop not null;
--   alter table public.purchases alter column category drop default;
--   alter table public.purchases drop column if exists category;
