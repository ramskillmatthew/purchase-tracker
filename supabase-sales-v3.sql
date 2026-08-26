-- Sales domain v3 (bulk cancellation) — adds safe, audited cancellation of
-- completed sales on top of supabase-sales.sql (v1) and
-- supabase-sales-v2.sql (v2). Completed financial records are NEVER
-- hard-deleted through this feature: cancelling a sale flips its status,
-- deactivates its line items, and optionally restores stock — the
-- sales_orders/sale_items rows themselves, and every snapshot/money field on
-- them, are kept exactly as they were for audit history.
--
-- REQUIRES supabase-sales.sql AND supabase-sales-v2.sql to have already been
-- applied. Idempotent — every statement is safe to run more than once, and
-- this file does not touch anything created before it in a way that would
-- break a re-run.
--
-- Does NOT modify any investment table, does NOT touch create_completed_sale
-- or allocate_proportional_pence, does NOT weaken the existing double-sell-
-- prevention partial unique index on sale_items (left completely untouched),
-- and does NOT add an order-reference field.
--
-- ============================================================================
-- What's new
-- ============================================================================
-- 1. Two new nullable audit columns on sales_orders:
--      cancelled_at timestamptz — when the order was cancelled (null for an
--        order that has never been cancelled).
--      cancellation_stock_action text — 'returned_to_stock' or
--        'kept_out_of_stock', recorded at the moment of cancellation. This
--        is the durable record of the user's stock decision; it must never
--        be inferred later from the linked purchases' CURRENT stock_status,
--        since that status can legitimately change again afterwards (e.g.
--        the item gets sold again in a later, separate sale).
--
-- 2. cancel_completed_sales(p_owner_id, p_sales_order_ids, p_return_to_stock)
--    — one atomic, transactional RPC that, for every selected order:
--      * confirms it exists, belongs to p_owner_id, and is currently
--        'completed' (an already-cancelled/refunded order is rejected, not
--        silently re-cancelled);
--      * locks the order row and every purchase row it will touch BEFORE any
--        write, exactly mirroring create_completed_sale's own two-pass
--        lock-then-write discipline — so a failure on any ONE selected sale
--        aborts the whole call with nothing written for any of them;
--      * flips the order to 'cancelled' and records cancelled_at +
--        cancellation_stock_action;
--      * sets every one of its currently-active sale_items rows to
--        is_active = false (making the linked purchase sellable again in
--        principle — the double-sell partial unique index already supports
--        this with no further migration);
--      * when p_return_to_stock is true, restores stock_status = 'in_stock'
--        on the EXACT purchase UUIDs linked by those sale_items — never by
--        SKU or description, only the real foreign-key purchase_id already
--        recorded on each sale_items row from when the sale was created.
--    Every raised exception uses a distinct, stable code string (mirrors
--    create_completed_sale's own convention — see lib/sales/rpc-errors.ts).
--
-- ============================================================================
-- Applying this migration
-- ============================================================================
-- Review and run manually in the Supabase SQL Editor when ready. Not
-- executed automatically by this change.

begin;

-- ----------------------------------------------------------------------------
-- 1. sales_orders audit columns for cancellation.
-- ----------------------------------------------------------------------------
alter table public.sales_orders add column if not exists cancelled_at timestamptz;
alter table public.sales_orders add column if not exists cancellation_stock_action text;

-- Found by content, not a guessed name — same pattern as
-- supabase-sales-v2.sql's revenue_input_mode widening.
do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'sales_orders' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%cancellation_stock_action%';
  if existing_constraint is not null then
    execute format('alter table public.sales_orders drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.sales_orders
  add constraint sales_orders_cancellation_stock_action_check
  check (cancellation_stock_action in ('returned_to_stock', 'kept_out_of_stock') or cancellation_stock_action is null);

-- ----------------------------------------------------------------------------
-- 2. cancel_completed_sales — atomic, transactional bulk cancellation.
-- ----------------------------------------------------------------------------
create or replace function public.cancel_completed_sales(
  p_owner_id uuid,
  p_sales_order_ids uuid[],
  p_return_to_stock boolean
)
returns table (orders_cancelled int, units_affected int)
language plpgsql
as $$
declare
  v_order_count int;
  v_distinct_count int;
  v_sorted_order_ids uuid[];
  v_purchase_ids uuid[];
  v_order public.sales_orders%rowtype;
  v_units_affected int;
  i int;
begin
  if p_sales_order_ids is null or array_length(p_sales_order_ids, 1) is null then
    raise exception 'EMPTY_SELECTION' using errcode = 'P2017';
  end if;

  v_order_count := array_length(p_sales_order_ids, 1);
  if v_order_count > 200 then
    raise exception 'TOO_MANY_SALES' using errcode = 'P2018';
  end if;

  select count(distinct x) into v_distinct_count from unnest(p_sales_order_ids) x;
  if v_distinct_count <> v_order_count then
    raise exception 'DUPLICATE_SALE_IDS' using errcode = 'P2019';
  end if;

  -- Deterministic lock order — always sorted ascending by UUID, never the
  -- caller's submission order (avoids lock-order deadlocks against a
  -- concurrent cancellation of an overlapping batch).
  select array_agg(x order by x) into v_sorted_order_ids from unnest(p_sales_order_ids) x;

  -- Pass 1: lock + validate every selected order BEFORE any write. A
  -- missing order and an order belonging to another owner are reported
  -- identically (SALE_NOT_FOUND) — never distinguished — so this can never
  -- be used to probe which sale ids exist for someone else.
  for i in 1..v_order_count loop
    select * into v_order from public.sales_orders where id = v_sorted_order_ids[i] for update;
    if not found then
      raise exception 'SALE_NOT_FOUND' using errcode = 'P2020';
    end if;
    if v_order.owner_id <> p_owner_id then
      raise exception 'SALE_NOT_FOUND' using errcode = 'P2020';
    end if;
    if v_order.status <> 'completed' then
      raise exception 'SALE_NOT_COMPLETED' using errcode = 'P2021';
    end if;
  end loop;

  -- Purchases are identified ONLY through the selected orders' own active
  -- sale_items.purchase_id — never by SKU/description/any other lookup —
  -- and locked, in deterministic order, before any purchase is touched.
  select array_agg(distinct si.purchase_id order by si.purchase_id)
    into v_purchase_ids
    from public.sale_items si
    where si.sales_order_id = any(v_sorted_order_ids) and si.is_active;

  if v_purchase_ids is not null then
    for i in 1..array_length(v_purchase_ids, 1) loop
      perform 1 from public.purchases where id = v_purchase_ids[i] for update;
    end loop;
  end if;

  -- Pass 2: every change, now that every row involved is locked and valid.
  select count(*) into v_units_affected
    from public.sale_items
    where sales_order_id = any(v_sorted_order_ids) and is_active;

  update public.sales_orders
    set status = 'cancelled',
        cancelled_at = now(),
        cancellation_stock_action = case when p_return_to_stock then 'returned_to_stock' else 'kept_out_of_stock' end,
        updated_at = now()
    where id = any(v_sorted_order_ids);

  update public.sale_items
    set is_active = false
    where sales_order_id = any(v_sorted_order_ids) and is_active;

  if p_return_to_stock and v_purchase_ids is not null then
    update public.purchases set stock_status = 'in_stock' where id = any(v_purchase_ids);
  end if;

  orders_cancelled := v_order_count;
  units_affected := v_units_affected;
  return next;
end;
$$;

revoke all on function public.cancel_completed_sales(uuid, uuid[], boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.cancel_completed_sales(uuid, uuid[], boolean) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.cancel_completed_sales(uuid, uuid[], boolean) from authenticated; end if;
end $$;

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed, and
-- deliberately OUTSIDE the committed migration transaction above)
-- ============================================================================
-- Safe only if no sale has ever actually been cancelled through this RPC
-- since it was applied (a cancelled sale's audit columns are the exact kind
-- of record this migration exists to keep — clearing them is a data
-- decision only you should make, so no rollback statement is offered here
-- as a one-liner):
--   drop function if exists public.cancel_completed_sales(uuid, uuid[], boolean);
--   alter table public.sales_orders drop constraint if exists sales_orders_cancellation_stock_action_check;
--   alter table public.sales_orders drop column if exists cancellation_stock_action;
--   alter table public.sales_orders drop column if exists cancelled_at;
