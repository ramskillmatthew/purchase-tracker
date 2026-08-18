-- Purchase category v2 — replaces "Lorcana" with the broader "Non-Pokémon
-- TCG" bucket in the canonical category list.
--
-- REQUIRES supabase-purchase-category.sql to have already been applied
-- (this script updates and re-constrains the `category` column that
-- migration adds — running this first would fail with "column category
-- does not exist").
--
-- Idempotent — every statement is safe to run more than once. Wrapped in
-- one explicit transaction, matching this repo's established convention
-- (see supabase-add-stock-status.sql, supabase-purchase-import-v2.sql).
--
-- Does not touch any investment table, does not recreate or drop
-- public.purchases, does not lose any purchase row or unrelated column.

begin;

-- Step 1: drop the existing category CHECK constraint, found BY CONTENT
-- (searching pg_constraint for a CHECK on this table mentioning `category`)
-- rather than a guessed auto-generated name — mirrors the corrected pattern
-- already used in this repo for exactly this situation (see
-- supabase-investments.sql's own pricing_provider migrations, and this
-- project's own "never assume a specific auto-generated constraint name"
-- lesson). Re-running this script finds and drops the constraint Step 4
-- below just added, which is what makes the whole script safe to re-run.
do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'purchases' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%category%';
  if existing_constraint is not null then
    execute format('alter table public.purchases drop constraint %I', existing_constraint);
  end if;
end $$;

-- Step 2: the one confident, investigated mapping — any casing/whitespace
-- variant of "Lorcana" (e.g. "lorcana", " Lorcana ") becomes the new
-- "Non-Pokémon TCG" bucket. Idempotent: once migrated, no row matches this
-- WHERE clause again on a re-run.
update public.purchases
  set category = 'Non-Pokémon TCG'
  where lower(trim(category)) = 'lorcana';

-- Step 3: anything else that would not satisfy the new five-value
-- constraint safely defaults to "Other" — never guessed into a specific
-- category. The only confident, investigated remapping is Step 2's Lorcana
-- rule; every other pre-existing value was already one of Pokémon /
-- Clothing / Footwear / Other (all still valid) or already "Other" itself
-- (see supabase-purchase-category.sql), so this step is a defensive
-- catch-all for anything unexpected (a stray NULL/blank, or free text from
-- an insert path outside this app's own validated forms), not an active
-- remapping of known data. Idempotent for the same reason as Step 2.
update public.purchases
  set category = 'Other'
  where category is distinct from 'Pokémon' and category is distinct from 'Non-Pokémon TCG'
    and category is distinct from 'Clothing' and category is distinct from 'Footwear' and category is distinct from 'Other';

-- Step 4: the new, single, cumulative constraint — every existing row now
-- satisfies it (Steps 2–3 above ran first, in this same transaction).
alter table public.purchases
  add constraint purchases_category_check
  check (category in ('Pokémon', 'Non-Pokémon TCG', 'Clothing', 'Footwear', 'Other'));

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed)
-- ============================================================================
-- Restoring the exact old five-value constraint is safe only if no purchase
-- has been categorised "Non-Pokémon TCG" since this migration ran (that
-- value would violate the old constraint) — this is a data decision only
-- you should make, so no rollback statement is offered here as a one-liner.
