-- Sales domain (Stage 2) — sales_orders/sale_items schema plus the atomic
-- create_completed_sale() RPC. Follows this repo's established migration
-- conventions (see supabase-purchase-import-v2.sql and
-- supabase-investments.sql): `create table/index if not exists`,
-- `create or replace function`, owner_id uuid references auth.users(id) for
-- app-level ownership isolation, RLS enabled with NO policies (this app is
-- single-owner and every request goes through the service-role key —
-- requireOwner() in lib/auth/server.ts is the real authorization boundary),
-- anon/authenticated grants revoked as defence in depth, numeric(10,2) for
-- every GBP value (matching public.purchases.price_purchased), and `check`
-- constraints for closed enums. Wrapped in one explicit transaction; every
-- statement is safe to run more than once.
--
-- Does NOT modify public.investment_* tables, does NOT recreate or
-- destroy public.purchases, does NOT mark any existing purchase as sold,
-- and does NOT generate any fake/example sales data.
--
-- ============================================================================
-- Data model
-- ============================================================================
-- sales_orders: one row per sale transaction (order-level facts: date,
--   platform, revenue, fees, postage, status). No order-reference field —
--   deliberately omitted per the Stage 2 spec.
--
-- sale_items: one row per exact purchase UUID included in a sale. Snapshots
--   (sku/description/category/condition/condition-group/cost/supplier) are
--   captured at sale-creation time and NEVER updated afterwards, even if the
--   source purchase row is later edited — so historical profit/reporting
--   can never silently change underneath an already-completed sale. This is
--   why every snapshot column exists as a real column here rather than a
--   join back to public.purchases at read time.
--
-- ============================================================================
-- Preventing double-selling
-- ============================================================================
-- sale_items.is_active is true for every currently-completed (i.e. not yet
-- refunded/cancelled) sale item. sale_items_active_purchase_unique is a
-- PARTIAL unique index on (purchase_id) WHERE is_active — so at most one
-- active sale item can ever reference the same purchase UUID at a time,
-- enforced by Postgres itself (not just application code), and race-safe
-- under concurrent requests. A future refund/cancellation stage flips
-- is_active to false (transactionally, alongside restoring the purchase's
-- stock_status) and the purchase becomes sellable again — the index alone
-- already supports that; no further migration is required for it. Every
-- sale_items row created by THIS migration's RPC is always is_active = true,
-- since create_completed_sale only ever creates 'completed' orders.
--
-- create_completed_sale() additionally re-checks, transactionally and under
-- a row lock, that each purchase's stock_status is still 'in_stock' AND
-- that it has no existing active sale_items row — belt-and-braces alongside
-- the partial unique index, and what actually prevents two concurrent
-- requests from both "succeeding" against the same purchase (the second one
-- to acquire the lock always sees the first one's already-committed
-- effects, or the index rejects it if timing allows both to reach the
-- insert).
--
-- ============================================================================
-- Revenue/fee/postage allocation
-- ============================================================================
-- The RPC computes the allocation itself (equal split across the sorted-by-
-- UUID purchase list, with any leftover penny handed to the first N
-- purchases in that sorted order) from just the order-level totals and the
-- purchase-ID list — it never trusts a client-submitted per-line
-- breakdown. This closes a time-of-check/time-of-use gap on the money math:
-- nothing about what actually gets written is derived from anything other
-- than this same transaction's own fresh, locked reads. The identical
-- algorithm also exists as a pure, directly-unit-tested TypeScript function
-- (lib/sales/allocation.ts's splitEvenlyPence) for future UI live-preview
-- use before a sale is submitted — keep the two in sync if this changes.
--
-- ============================================================================
-- Applying this migration
-- ============================================================================
-- Review and run manually in the Supabase SQL Editor when ready. Not
-- executed automatically by this change. Requires supabase-purchase-category.sql
-- to have already been applied (sale_items.category_snapshot copies
-- public.purchases.category).

begin;

-- ----------------------------------------------------------------------------
-- sales_orders
-- ----------------------------------------------------------------------------
create table if not exists public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  sale_date date not null,
  platform text not null check (platform in ('vinted', 'ebay', 'depop', 'other')),
  custom_platform_name text,
  revenue_input_mode text not null check (revenue_input_mode in ('total', 'average')),
  revenue_input_value numeric(10,2) not null check (revenue_input_value >= 0),
  total_revenue numeric(10,2) not null check (total_revenue >= 0),
  platform_fees numeric(10,2) not null default 0 check (platform_fees >= 0),
  postage numeric(10,2) not null default 0 check (postage >= 0),
  status text not null default 'completed' check (status in ('completed', 'refunded', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A custom name is required exactly when platform is 'other', and must be
  -- blank/absent for every other platform — never a contradictory payload.
  constraint sales_orders_custom_platform_name_check check (
    (platform = 'other' and custom_platform_name is not null and length(trim(custom_platform_name)) > 0)
    or (platform <> 'other' and custom_platform_name is null)
  )
);

alter table public.sales_orders enable row level security;
revoke all on public.sales_orders from anon, authenticated;

create index if not exists sales_orders_owner_idx on public.sales_orders (owner_id, sale_date desc, created_at desc);

-- ----------------------------------------------------------------------------
-- sale_items
-- ----------------------------------------------------------------------------
create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sales_order_id uuid not null references public.sales_orders (id) on delete cascade,
  purchase_id uuid not null references public.purchases (id),
  -- Immutable snapshots — see the "Data model" note above.
  sku_snapshot text not null,
  item_description_snapshot text not null,
  category_snapshot text not null,
  item_condition_snapshot text not null,
  condition_group_snapshot text not null check (condition_group_snapshot in ('new', 'used', 'unknown')),
  purchase_cost_snapshot numeric(10,2) not null,
  purchased_from_snapshot text not null,
  allocated_revenue numeric(10,2) not null check (allocated_revenue >= 0),
  allocated_platform_fee numeric(10,2) not null default 0 check (allocated_platform_fee >= 0),
  allocated_postage numeric(10,2) not null default 0 check (allocated_postage >= 0),
  -- Deliberately not constrained non-negative: profit is a genuine loss
  -- (negative) whenever allocated revenue doesn't cover cost + fees + postage.
  profit numeric(10,2) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.sale_items enable row level security;
revoke all on public.sale_items from anon, authenticated;

create index if not exists sale_items_sales_order_idx on public.sale_items (sales_order_id);
create index if not exists sale_items_purchase_idx on public.sale_items (purchase_id);

-- THE double-sell-prevention constraint — see the header note above.
create unique index if not exists sale_items_active_purchase_unique on public.sale_items (purchase_id) where is_active;

-- ----------------------------------------------------------------------------
-- create_completed_sale — atomic, transactional sale creation.
-- ----------------------------------------------------------------------------
-- One call performs, in order, inside one implicit PL/pgSQL transaction (any
-- raised exception rolls back every effect of this same call, including
-- earlier loop iterations — no explicit BEGIN/COMMIT/ROLLBACK needed):
--   1. Validates the order-level payload (platform, custom name
--      requiredness, revenue mode, non-negative amounts, item count).
--   2. Validates the purchase-ID array (present, within the size ceiling,
--      no duplicates).
--   3. Normalises revenue-input-mode + value to one authoritative total.
--   4. Computes the deterministic equal-split-with-remainder allocation for
--      revenue, platform fees, and postage across the purchases, sorted by
--      UUID (see the "Revenue/fee/postage allocation" header note).
--   5. Locks and validates every purchase row (exists, in_stock, not
--      already actively sold) BEFORE any writes — mirrors
--      import_purchase_order's own two-pass discipline.
--   6. Inserts the sales_orders row.
--   7. For each purchase: re-locks it, snapshots its fields fresh, derives
--      condition_group_snapshot (mirrors lib/condition-group.ts's mapping —
--      see tests/sales-condition-group-sync.test.ts, which cross-checks the
--      two never drift apart), inserts the sale_items row, and flips the
--      purchase to no_longer_in_stock.
--   8. Returns the new sales_orders.id.
--
-- Every raised exception uses a distinct, stable code string (via `raise
-- exception 'CODE' using errcode = '...'`) that the application layer
-- classifies via lib/sales/rpc-errors.ts — mirrors
-- lib/purchase-import/rpc-errors.ts's exact pattern for import_purchase_order.
create or replace function public.create_completed_sale(
  p_owner_id uuid,
  p_sale_date date,
  p_platform text,
  p_custom_platform_name text,
  p_revenue_input_mode text,
  p_revenue_input_value numeric,
  p_platform_fees numeric,
  p_postage numeric,
  p_purchase_ids uuid[]
)
returns table (sales_order_id uuid)
language plpgsql
as $$
declare
  v_item_count int;
  v_distinct_count int;
  v_sorted_ids uuid[];
  v_total_revenue numeric;
  v_total_revenue_pence bigint;
  v_fees_pence bigint;
  v_postage_pence bigint;
  v_revenue_shares bigint[];
  v_fee_shares bigint[];
  v_postage_shares bigint[];
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

  if p_revenue_input_mode not in ('total', 'average') then
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

  v_total_revenue := case when p_revenue_input_mode = 'average' then p_revenue_input_value * v_item_count else p_revenue_input_value end;
  v_total_revenue_pence := round(v_total_revenue * 100);
  v_fees_pence := round(p_platform_fees * 100);
  v_postage_pence := round(p_postage * 100);

  v_base := v_total_revenue_pence / v_item_count;
  v_remainder := v_total_revenue_pence - v_base * v_item_count;
  for i in 1..v_item_count loop
    v_revenue_shares[i] := v_base + (case when i <= v_remainder then 1 else 0 end);
  end loop;

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

  -- Pass 1: lock + validate every purchase BEFORE any writes.
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
  end loop;

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

-- Matches the existing table-level access pattern (see import_purchase_order
-- above it in supabase-purchase-import-v2.sql): the application only ever
-- calls this via the service-role key, which is unaffected by these
-- revokes. anon/authenticated are explicitly denied direct execution.
revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]) from authenticated; end if;
end $$;

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed, and
-- deliberately OUTSIDE the committed migration transaction above)
-- ============================================================================
-- Safe only before any sale has ever been created (a real sale, once
-- created, is the exact kind of financial/audit record this schema exists
-- to keep — dropping these tables after that point is a data-loss decision
-- only you should make, and is deliberately not offered as a one-liner
-- here):
--   drop function if exists public.create_completed_sale(uuid, date, text, text, text, numeric, numeric, numeric, uuid[]);
--   drop table if exists public.sale_items;
--   drop table if exists public.sales_orders;
