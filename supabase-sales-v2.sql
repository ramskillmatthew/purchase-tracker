-- Sales domain v2 (Stage 4) — adds itemised per-line revenue for mixed-
-- product baskets (Order Sale), on top of the Stage 2/3 create_completed_sale
-- RPC. Quick Sale's existing "total"/"average" modes are UNCHANGED — same
-- equal-split behaviour, byte-for-byte, as supabase-sales.sql (v1).
--
-- REQUIRES supabase-sales.sql (v1) AND supabase-purchase-category-v2.sql to
-- have already been applied. Idempotent on its own re-runs. See "Migration
-- order and re-run caveat" below for the one real constraint on ordering.
--
-- ============================================================================
-- What's new
-- ============================================================================
-- revenue_input_mode gains a third value, 'itemised': the caller supplies
-- one explicit revenue amount per selected purchase (p_line_revenues, a
-- jsonb array of {purchase_id, revenue}) instead of one order-level amount
-- to split evenly. This is what lets a mixed basket (e.g. 3 Pokémon boxes +
-- trainers + a clothing item in ONE order) record accurate per-item revenue
-- instead of an inaccurate equal share.
--
-- The RPC re-validates everything server-side — it never trusts the
-- client's line revenues as already-reconciled:
--   * p_line_revenues must cover EXACTLY the purchases in p_purchase_ids
--     (same set, no more, no fewer, no duplicates).
--   * every line revenue must be non-negative.
--   * the lines must sum to EXACTLY p_revenue_input_value (in pence) — a
--     mismatch is rejected outright, nothing is silently rebalanced.
--   * 'total'/'average' modes reject p_line_revenues being present at all
--     (a contradictory payload), and 'itemised' requires it.
--
-- Platform fees/postage are then allocated proportionally to each line's
-- own revenue (public.allocate_proportional_pence, largest-remainder
-- method — exact to the penny, deterministic tie-break by ascending
-- purchase order), falling back to proportional-by-purchase-cost when every
-- line's revenue is zero (a legitimate free/giveaway order), and finally to
-- an equal split if costs are also all zero. 'total'/'average' modes keep
-- their original equal-split fee/postage allocation untouched.
--
-- ============================================================================
-- Migration order and re-run caveat
-- ============================================================================
-- Apply in this exact order: supabase-purchase-category.sql, then
-- supabase-purchase-category-v2.sql, then supabase-sales.sql, then THIS
-- file. This file DROPS the old 9-parameter create_completed_sale and
-- creates a new 10-parameter version (Postgres treats a changed parameter
-- list as a different function identity — `create or replace` alone would
-- leave both overloads coexisting, which risks PostgREST RPC-resolution
-- ambiguity). Consequently, DO NOT RE-RUN supabase-sales.sql (v1) after this
-- file — its own `create or replace function create_completed_sale(9 params)`
-- would resurrect the old overload alongside this one. This file itself is
-- fully safe to re-run any number of times on its own.
--
-- Preserves every existing sales_orders/sale_items row, every existing
-- constraint's meaning for 'total'/'average' orders, RLS/grant posture, and
-- the double-sell-prevention partial unique index (untouched by this file).
-- Does not modify any investment table.

begin;

-- ----------------------------------------------------------------------------
-- 1. Widen sales_orders.revenue_input_mode to also allow 'itemised' —
--    found by content, not a guessed constraint name (see
--    supabase-purchase-category-v2.sql's identical corrected pattern, itself
--    mirroring supabase-investments.sql's pricing_provider migrations).
-- ----------------------------------------------------------------------------
do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'sales_orders' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%revenue_input_mode%';
  if existing_constraint is not null then
    execute format('alter table public.sales_orders drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.sales_orders
  add constraint sales_orders_revenue_input_mode_check
  check (revenue_input_mode in ('total', 'average', 'itemised'));

-- ----------------------------------------------------------------------------
-- 2. allocate_proportional_pence — largest-remainder proportional
--    allocator, exact to the penny. Mirrors lib/sales/allocation.ts's
--    allocateProportionalPence exactly — keep the two in sync (see
--    tests/sales-itemised-allocation-sync.test.ts). Falls back to an equal
--    split when every weight is zero (or there are no positions at all).
-- ----------------------------------------------------------------------------
create or replace function public.allocate_proportional_pence(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
as $$
declare
  v_count int;
  v_sum_weights bigint;
  v_shares bigint[];
begin
  v_count := coalesce(array_length(p_weights, 1), 0);
  if v_count = 0 then
    return array[]::bigint[];
  end if;

  select coalesce(sum(w), 0) into v_sum_weights from unnest(p_weights) w;

  if v_sum_weights <= 0 then
    declare
      v_base bigint := p_total / v_count;
      v_remainder bigint := p_total - (p_total / v_count) * v_count;
      i int;
    begin
      v_shares := array[]::bigint[];
      for i in 1..v_count loop
        v_shares[i] := v_base + (case when i <= v_remainder then 1 else 0 end);
      end loop;
      return v_shares;
    end;
  end if;

  with computed as (
    select ord as idx, w,
      floor(p_total::numeric * w / v_sum_weights)::bigint as base,
      (p_total::numeric * w / v_sum_weights) - floor(p_total::numeric * w / v_sum_weights) as frac
    from unnest(p_weights) with ordinality as t(w, ord)
  ),
  totals as (
    select p_total - coalesce(sum(base), 0) as remainder from computed
  ),
  ranked as (
    select idx, base, row_number() over (order by frac desc, idx asc) as rn
    from computed
  )
  select array_agg(base + case when rn <= (select remainder from totals) then 1 else 0 end order by idx)
  into v_shares
  from ranked;

  return v_shares;
end;
$$;

revoke all on function public.allocate_proportional_pence(bigint, bigint[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.allocate_proportional_pence(bigint, bigint[]) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.allocate_proportional_pence(bigint, bigint[]) from authenticated; end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. create_completed_sale — extended with p_line_revenues (itemised mode).
--    The old 9-parameter overload is dropped explicitly first (see the
--    "Migration order and re-run caveat" note above for why).
-- ----------------------------------------------------------------------------
drop function if exists public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]);

create or replace function public.create_completed_sale(
  p_owner_id uuid,
  p_sale_date date,
  p_platform text,
  p_custom_platform_name text,
  p_revenue_input_mode text,
  p_revenue_input_value numeric,
  p_platform_fees numeric,
  p_postage numeric,
  p_purchase_ids uuid[],
  p_line_revenues jsonb default null
)
returns table (sales_order_id uuid)
language plpgsql
as $$
declare
  v_item_count int;
  v_distinct_count int;
  v_sorted_ids uuid[];
  v_line_ids uuid[];
  v_line_revenue_sum_pence bigint;
  v_total_revenue numeric;
  v_total_revenue_pence bigint;
  v_fees_pence bigint;
  v_postage_pence bigint;
  v_revenue_shares bigint[];
  v_fee_shares bigint[];
  v_postage_shares bigint[];
  v_costs bigint[];
  v_line_revenues bigint[];
  v_sum_revenue_weight bigint;
  v_base bigint;
  v_remainder bigint;
  v_order_id uuid;
  v_purchase public.purchases%rowtype;
  v_condition_group text;
  i int;
begin
  if p_platform not in ('vinted', 'ebay', 'depop', 'other') then
    raise exception 'INVALID_PLATFORM' using errcode = 'P2001';
  end if;

  if p_platform = 'other' then
    if p_custom_platform_name is null or length(trim(p_custom_platform_name)) = 0 then
      raise exception 'CUSTOM_PLATFORM_NAME_REQUIRED' using errcode = 'P2002';
    end if;
  else
    if p_custom_platform_name is not null and length(trim(p_custom_platform_name)) > 0 then
      raise exception 'CUSTOM_PLATFORM_NAME_NOT_ALLOWED' using errcode = 'P2003';
    end if;
  end if;

  if p_revenue_input_mode not in ('total', 'average', 'itemised') then
    raise exception 'INVALID_REVENUE_MODE' using errcode = 'P2004';
  end if;

  if p_revenue_input_value < 0 or p_platform_fees < 0 or p_postage < 0 then
    raise exception 'NEGATIVE_AMOUNT' using errcode = 'P2005';
  end if;

  if p_purchase_ids is null or array_length(p_purchase_ids, 1) is null then
    raise exception 'NO_ITEMS' using errcode = 'P2006';
  end if;

  v_item_count := array_length(p_purchase_ids, 1);
  if v_item_count > 100 then
    raise exception 'TOO_MANY_ITEMS' using errcode = 'P2007';
  end if;

  select count(distinct x) into v_distinct_count from unnest(p_purchase_ids) x;
  if v_distinct_count <> v_item_count then
    raise exception 'DUPLICATE_PURCHASE_IDS' using errcode = 'P2008';
  end if;

  -- Deterministic order for remainder assignment below — always sorted
  -- ascending by UUID, never the caller's submission order.
  select array_agg(x order by x) into v_sorted_ids from unnest(p_purchase_ids) x;

  -- Itemised-mode payload validation — before any purchase is touched.
  if p_revenue_input_mode = 'itemised' then
    if p_line_revenues is null or jsonb_typeof(p_line_revenues) is distinct from 'array' or jsonb_array_length(p_line_revenues) = 0 then
      raise exception 'ITEMISED_LINES_REQUIRED' using errcode = 'P2012';
    end if;
    if jsonb_array_length(p_line_revenues) <> v_item_count then
      raise exception 'ITEMISED_LINE_COUNT_MISMATCH' using errcode = 'P2013';
    end if;

    select array_agg((elem->>'purchase_id')::uuid order by (elem->>'purchase_id')::uuid) into v_line_ids
      from jsonb_array_elements(p_line_revenues) elem;
    if v_line_ids is distinct from v_sorted_ids then
      raise exception 'ITEMISED_LINE_PURCHASE_MISMATCH' using errcode = 'P2014';
    end if;

    if exists (select 1 from jsonb_array_elements(p_line_revenues) elem where (elem->>'revenue')::numeric < 0) then
      raise exception 'NEGATIVE_AMOUNT' using errcode = 'P2005';
    end if;

    select round(sum((elem->>'revenue')::numeric) * 100) into v_line_revenue_sum_pence
      from jsonb_array_elements(p_line_revenues) elem;
    if v_line_revenue_sum_pence is distinct from round(p_revenue_input_value * 100) then
      raise exception 'ITEMISED_REVENUE_MISMATCH' using errcode = 'P2015';
    end if;

    -- Populate v_line_revenues in the SAME sorted order as v_sorted_ids, so
    -- index i always refers to the same purchase in every array below.
    for i in 1..v_item_count loop
      v_line_revenues[i] := (
        select round((elem->>'revenue')::numeric * 100)
        from jsonb_array_elements(p_line_revenues) elem
        where (elem->>'purchase_id')::uuid = v_sorted_ids[i]
      );
    end loop;
  elsif p_line_revenues is not null then
    raise exception 'ITEMISED_DATA_NOT_ALLOWED' using errcode = 'P2016';
  end if;

  v_total_revenue := case when p_revenue_input_mode = 'average' then p_revenue_input_value * v_item_count else p_revenue_input_value end;
  v_total_revenue_pence := round(v_total_revenue * 100);
  v_fees_pence := round(p_platform_fees * 100);
  v_postage_pence := round(p_postage * 100);

  -- Pass 1: lock + validate every purchase BEFORE any writes. Also collects
  -- each purchase's cost (needed for itemised mode's zero-revenue
  -- fee/postage fallback, computed after this loop).
  for i in 1..v_item_count loop
    select * into v_purchase from public.purchases where id = v_sorted_ids[i] for update;
    if not found then
      raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P2009';
    end if;
    if v_purchase.stock_status <> 'in_stock' then
      raise exception 'PURCHASE_NOT_AVAILABLE' using errcode = 'P2010';
    end if;
    if exists (select 1 from public.sale_items where purchase_id = v_purchase.id and is_active) then
      raise exception 'PURCHASE_ALREADY_SOLD' using errcode = 'P2011';
    end if;
    v_costs[i] := round(v_purchase.price_purchased * 100);
  end loop;

  -- Revenue allocation: itemised mode uses each line's own explicit
  -- (already sum-reconciled) revenue directly; total/average keep the
  -- original equal-split-with-deterministic-remainder rule, unchanged.
  if p_revenue_input_mode = 'itemised' then
    v_revenue_shares := v_line_revenues;
  else
    v_base := v_total_revenue_pence / v_item_count;
    v_remainder := v_total_revenue_pence - v_base * v_item_count;
    for i in 1..v_item_count loop
      v_revenue_shares[i] := v_base + (case when i <= v_remainder then 1 else 0 end);
    end loop;
  end if;

  -- Fee/postage allocation: itemised mode allocates proportionally to each
  -- line's own revenue share (falling back to purchase cost when every
  -- line's revenue is zero); total/average keep the original equal-split
  -- rule, unchanged — mathematically identical to proportional-by-equal-
  -- revenue anyway, but left as the original code path for zero behaviour
  -- risk to already-relied-upon Quick Sale calls.
  if p_revenue_input_mode = 'itemised' then
    select coalesce(sum(x), 0) into v_sum_revenue_weight from unnest(v_revenue_shares) x;
    if v_sum_revenue_weight > 0 then
      v_fee_shares := public.allocate_proportional_pence(v_fees_pence, v_revenue_shares);
      v_postage_shares := public.allocate_proportional_pence(v_postage_pence, v_revenue_shares);
    else
      v_fee_shares := public.allocate_proportional_pence(v_fees_pence, v_costs);
      v_postage_shares := public.allocate_proportional_pence(v_postage_pence, v_costs);
    end if;
  else
    v_base := v_fees_pence / v_item_count;
    v_remainder := v_fees_pence - v_base * v_item_count;
    for i in 1..v_item_count loop
      v_fee_shares[i] := v_base + (case when i <= v_remainder then 1 else 0 end);
    end loop;

    v_base := v_postage_pence / v_item_count;
    v_remainder := v_postage_pence - v_base * v_item_count;
    for i in 1..v_item_count loop
      v_postage_shares[i] := v_base + (case when i <= v_remainder then 1 else 0 end);
    end loop;
  end if;

  insert into public.sales_orders (
    owner_id, sale_date, platform, custom_platform_name, revenue_input_mode, revenue_input_value,
    total_revenue, platform_fees, postage, status
  ) values (
    p_owner_id, p_sale_date, p_platform, nullif(trim(p_custom_platform_name), ''), p_revenue_input_mode, p_revenue_input_value,
    v_total_revenue, p_platform_fees, p_postage, 'completed'
  ) returning id into v_order_id;

  -- Pass 2: re-lock, snapshot fresh, insert, flip stock.
  for i in 1..v_item_count loop
    select * into v_purchase from public.purchases where id = v_sorted_ids[i] for update;

    -- Mirrors lib/condition-group.ts's deriveConditionGroup mapping exactly —
    -- see tests/sales-condition-group-sync.test.ts.
    v_condition_group := case
      when v_purchase.item_condition in ('Brand new', 'Brand new without tags') then 'new'
      when v_purchase.item_condition in ('Labelled as very good condition', 'Good condition from photos', 'Decent condition from photos') then 'used'
      else 'unknown'
    end;

    insert into public.sale_items (
      sales_order_id, purchase_id, sku_snapshot, item_description_snapshot, category_snapshot,
      item_condition_snapshot, condition_group_snapshot, purchase_cost_snapshot, purchased_from_snapshot,
      allocated_revenue, allocated_platform_fee, allocated_postage, profit, is_active
    ) values (
      v_order_id, v_purchase.id, v_purchase.sku, v_purchase.item_description, v_purchase.category,
      v_purchase.item_condition, v_condition_group, v_purchase.price_purchased, v_purchase.purchased_from,
      v_revenue_shares[i] / 100.0, v_fee_shares[i] / 100.0, v_postage_shares[i] / 100.0,
      (v_revenue_shares[i] - round(v_purchase.price_purchased * 100) - v_fee_shares[i] - v_postage_shares[i]) / 100.0,
      true
    );

    update public.purchases set stock_status = 'no_longer_in_stock' where id = v_purchase.id;
  end loop;

  sales_order_id := v_order_id;
  return next;
end;
$$;

revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[], jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[], jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[], jsonb) from authenticated; end if;
end $$;

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed, and
-- deliberately OUTSIDE the committed migration transaction above)
-- ============================================================================
-- Safe only if no 'itemised' sales_orders row has been created since this
-- migration ran (such a row would violate the old two-value constraint) —
-- a data decision only you should make, so no rollback statement is
-- offered here as a one-liner. Restoring the exact old 9-parameter
-- create_completed_sale is possible in principle (its full body is in
-- supabase-sales.sql/git history) but is not offered as a one-liner either,
-- for the same reason.
