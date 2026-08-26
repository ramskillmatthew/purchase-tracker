-- Sales domain v4 — operational order-process workflow.
--
-- Apply manually AFTER supabase-sales.sql, supabase-sales-v2.sql and
-- supabase-sales-v3.sql. This migration is additive and idempotent. It never
-- rewrites financial status, revenue, profit, sale items, stock, cancellation
-- timestamps, or any Investments data.

begin;

alter table public.sales_orders add column if not exists process_status text;

-- Existing active sales used "completed" as their only known state, so this
-- is the least misleading legacy mapping. A cancelled sale is only described
-- as returned when the v3 stock audit proves the exact items came back.
update public.sales_orders
set process_status = 'completed'
where process_status is null and status = 'completed';

update public.sales_orders
set process_status = 'returned_cancelled'
where process_status is null
  and status = 'cancelled'
  and cancellation_stock_action = 'returned_to_stock';

-- Cancelled records kept out of stock remain NULL: the historical data does
-- not prove an item-return event, so the UI presents them as "Sale cancelled"
-- rather than inventing one.

do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'sales_orders' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%process_status%';
  if existing_constraint is not null then
    execute format('alter table public.sales_orders drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.sales_orders
  add constraint sales_orders_process_status_check
  check (process_status in (
    'awaiting_dispatch',
    'sent',
    'delivered_awaiting_payout',
    'completed',
    'return_in_process',
    'cancelled',
    'returned_cancelled'
  ) or process_status is null);

alter table public.sales_orders alter column process_status set default 'awaiting_dispatch';

commit;

-- Optional rollback (manual only; do not run after workflow data is in use):
-- alter table public.sales_orders drop constraint if exists sales_orders_process_status_check;
-- alter table public.sales_orders drop column if exists process_status;
