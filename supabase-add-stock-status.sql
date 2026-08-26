-- Stock status: an explicit in_stock / no_longer_in_stock state for STOCK
-- purchases only (public.purchases). public.expenses is a completely
-- separate table (see supabase-schema.sql) and is never touched here —
-- expenses have no inventory concept and never will.
--
-- Arrival (`arrived`) already answers "has this physically turned up?".
-- stock_status answers a genuinely different question: "is this still
-- part of my inventory at all?" An item can be in_stock and unarrived
-- (ordered, still in the post), in_stock and arrived (on the shelf), or
-- no_longer_in_stock regardless of its arrived value (sold, returned,
-- cancelled, written off, ...). The two columns are deliberately kept
-- independent — this migration never reads or writes `arrived`.
--
-- Order of operations is the entire point of this migration:
--   1. Add the column with NO default yet (every existing row gets NULL).
--   2. Backfill every row that is NULL right now — i.e. every purchase
--      that already existed before this migration ran — to
--      'no_longer_in_stock'.
--   3. ONLY THEN set the column's default to 'in_stock'.
-- A column default in PostgreSQL is never applied retroactively to rows
-- that already exist — it only ever affects rows inserted AFTER the
-- default is set. Doing this in the reverse order (default first, then
-- backfill) would be unable to distinguish "an old purchase" from "a new
-- purchase" once both show the same default value, which is exactly the
-- ambiguity this ordering avoids. The whole thing runs in one transaction
-- so a failure at any step leaves nothing partially applied, and every
-- statement is written to be safe to run more than once.
--
-- This is a ONE-TIME, MANUAL historical reset only. There is no
-- spreadsheet importer, SKU matcher, or automatic restoration tool here or
-- planned — after this migration runs, every purchase that existed before
-- it is `no_longer_in_stock`, and the owner manually flips their real
-- current stock back to "In stock", one purchase at a time, via the
-- Purchases page's own stock-status control.

begin;

alter table public.purchases
  add column if not exists stock_status text check (stock_status in ('in_stock', 'no_longer_in_stock'));

-- Only ever matches rows that predate this migration (or a from a prior,
-- interrupted run of it) — once every row has a non-null value, this is a
-- permanent no-op, which is what makes the whole script idempotent.
update public.purchases
  set stock_status = 'no_longer_in_stock'
  where stock_status is null;

-- From this point on, every newly inserted purchase (manual entry, bulk
-- paste, spreadsheet import, Vinted email import) automatically gets
-- 'in_stock' without any application code needing to set it explicitly —
-- including every row created by splitting a quantity > 1 purchase into
-- its individual unit rows (app/api/purchases/route.ts), since none of
-- those insert paths ever set stock_status themselves.
alter table public.purchases
  alter column stock_status set default 'in_stock';

alter table public.purchases
  alter column stock_status set not null;

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed)
-- ============================================================================
--   alter table public.purchases alter column stock_status drop not null;
--   alter table public.purchases alter column stock_status drop default;
--   alter table public.purchases drop column if exists stock_status;
