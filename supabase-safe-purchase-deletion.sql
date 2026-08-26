-- Safe purchase deletion — fixes purchase deletion now that purchases can be
-- referenced by Sales history (supabase-sales.sql onward).
--
-- ============================================================================
-- The failure this fixes
-- ============================================================================
-- public.sale_items.purchase_id is `not null references public.purchases
-- (id)` — an UNNAMED single-column foreign key, which Postgres auto-names
-- `sale_items_purchase_id_fkey` (confirmed: this is exactly the constraint
-- named in the reported error). With no ON DELETE clause, that FK defaults
-- to NO ACTION: deleting a purchases row that any sale_items row still
-- references — active or not — is correctly rejected by Postgres itself
-- with error 23503. The application never told the user why; it just
-- reported a generic "Could not delete the selected purchases." This
-- migration doesn't remove that protection — it teaches the application to
-- work safely WITH it: null out only the sale_items references that are
-- genuinely safe to drop (cancelled/refunded, inactive), leave every active
-- or completed-order reference exactly as it is, and delete only what's
-- left safe to delete — all inside one atomic, transactional RPC.
--
-- REQUIRES supabase-sales.sql, supabase-sales-v2.sql, and
-- supabase-sales-v3.sql to have already been applied (sale_items and its
-- is_active/sales_orders.status columns must exist). Idempotent — safe to
-- run more than once.
--
-- Does NOT modify any investment table, does NOT touch create_completed_sale
-- or cancel_completed_sales, does NOT weaken the double-sell-prevention
-- partial unique index, does NOT add any cascading delete behaviour
-- anywhere, and never removes the sale_items_purchase_id_fkey constraint
-- itself — only widens
-- the column it targets to allow null.
--
-- ============================================================================
-- Business rules this RPC enforces
-- ============================================================================
-- Rule 1 (unreferenced): no sale_items row at all -> delete normally.
-- Rule 2 (active/completed): any sale_items row referencing the purchase is
--   still is_active -> PROTECTED. Never deleted, never detached.
-- Rule 3 (safely cancelled): every sale_items row referencing the purchase
--   is inactive AND its order is not 'completed' -> eligible. Those
--   sale_items rows have purchase_id set to NULL (their snapshots and every
--   money field are untouched), then the purchase is deleted.
-- Rule 4 (inconsistent data safety net): an inactive sale_items row whose
--   order is STILL 'completed' is data that should never exist under normal
--   operation (create_completed_sale only ever creates active items on a
--   completed order; cancel_completed_sales always cancels the order at the
--   same instant it deactivates its items) — but if it's ever found, this
--   RPC treats the purchase as PROTECTED rather than guessing it's safe.
--
-- purchases has no owner_id column (a single-owner table — see
-- supabase-schema.sql; requireOwner() at the API layer is the real
-- authorization boundary, matching every other purchases route already).
-- This RPC therefore takes no owner parameter, exactly like every other
-- purchases-table operation in this codebase, and unlike the sales RPCs
-- (which scope by sales_orders.owner_id because that table has one).
--
-- ============================================================================
-- Applying this migration
-- ============================================================================
-- Review and run manually in the Supabase SQL Editor when ready. Not
-- executed automatically by this change.

begin;

-- ----------------------------------------------------------------------------
-- 1. Allow sale_items.purchase_id to be null — the FK itself (and its
--    default NO ACTION behaviour) is left completely untouched, so a raw,
--    accidental `delete from purchases` remains blocked by Postgres itself
--    whenever ANY sale_items row (active or not) still references it. Only
--    this RPC — which nulls out the specific safe references first, inside
--    the same transaction as the delete — can ever actually remove such a
--    purchase.
-- ----------------------------------------------------------------------------
alter table public.sale_items alter column purchase_id drop not null;

-- ----------------------------------------------------------------------------
-- 2. safe_delete_purchases — atomic, transactional, shared by every purchase
--    deletion path (single delete, bulk delete, Clear All).
-- ----------------------------------------------------------------------------
create or replace function public.safe_delete_purchases(p_purchase_ids uuid[])
returns table (
  requested_count int,
  deleted_count int,
  protected_count int,
  protected_ids uuid[],
  missing_count int
)
language plpgsql
as $$
declare
  v_requested_count int;
  v_distinct_count int;
  v_sorted_ids uuid[];
  v_protected_ids uuid[] := array[]::uuid[];
  v_deletable_ids uuid[] := array[]::uuid[];
  v_missing_count int := 0;
  v_purchase_id uuid;
  v_has_blocking boolean;
  rec record;
  i int;
begin
  if p_purchase_ids is null or array_length(p_purchase_ids, 1) is null then
    raise exception 'EMPTY_SELECTION' using errcode = 'P2030';
  end if;

  v_requested_count := array_length(p_purchase_ids, 1);
  if v_requested_count > 500 then
    raise exception 'TOO_MANY_PURCHASES' using errcode = 'P2031';
  end if;

  select count(distinct x) into v_distinct_count from unnest(p_purchase_ids) x;
  if v_distinct_count <> v_requested_count then
    raise exception 'DUPLICATE_PURCHASE_IDS' using errcode = 'P2032';
  end if;

  -- Deterministic lock order — always sorted ascending by UUID, never the
  -- caller's submission order (avoids lock-order deadlocks against a
  -- concurrent deletion of an overlapping batch).
  select array_agg(x order by x) into v_sorted_ids from unnest(p_purchase_ids) x;

  -- Pass 1: lock + classify every requested purchase BEFORE any write.
  -- Locking the purchase row here (and holding it for the rest of this
  -- transaction) is what makes this race-safe against a concurrent sale
  -- creation or cancellation touching the SAME purchase — both
  -- create_completed_sale and cancel_completed_sales lock the purchase row
  -- themselves before writing to it, so either operation simply waits for
  -- this one to finish rather than racing it.
  for i in 1..v_requested_count loop
    v_purchase_id := v_sorted_ids[i];

    perform 1 from public.purchases where id = v_purchase_id for update;
    if not found then
      v_missing_count := v_missing_count + 1;
      continue;
    end if;

    -- Every sale_items row that references this purchase is locked and
    -- inspected — protected the moment any one of them is still active, or
    -- is inactive but its order is still 'completed' (Rule 4).
    v_has_blocking := false;
    for rec in
      select si.is_active, so.status as order_status
      from public.sale_items si
      join public.sales_orders so on so.id = si.sales_order_id
      where si.purchase_id = v_purchase_id
      for update of si
    loop
      if rec.is_active or rec.order_status = 'completed' then
        v_has_blocking := true;
      end if;
    end loop;

    if v_has_blocking then
      v_protected_ids := array_append(v_protected_ids, v_purchase_id);
    else
      v_deletable_ids := array_append(v_deletable_ids, v_purchase_id);
    end if;
  end loop;

  -- Pass 2: for every eligible purchase, null out ONLY its safe (inactive,
  -- non-completed-order) sale_items references — every snapshot and money
  -- field on those rows is untouched — then delete the purchase itself.
  -- Nothing here can ever touch a protected purchase's sale_items rows.
  if array_length(v_deletable_ids, 1) is not null then
    update public.sale_items
      set purchase_id = null
      where purchase_id = any(v_deletable_ids);

    delete from public.purchases where id = any(v_deletable_ids);
  end if;

  requested_count := v_requested_count;
  deleted_count := coalesce(array_length(v_deletable_ids, 1), 0);
  protected_count := coalesce(array_length(v_protected_ids, 1), 0);
  protected_ids := v_protected_ids;
  missing_count := v_missing_count;
  return next;
end;
$$;

-- Matches the existing sales-RPC access pattern exactly: the application
-- only ever calls this via the service-role key (requireOwner() at the API
-- layer is the real authorization boundary — purchases has no owner_id to
-- scope by, see the header note above). anon/authenticated are explicitly
-- denied direct execution.
revoke all on function public.safe_delete_purchases(uuid[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.safe_delete_purchases(uuid[]) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.safe_delete_purchases(uuid[]) from authenticated; end if;
end $$;

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed, and
-- deliberately OUTSIDE the committed migration transaction above)
-- ============================================================================
-- Restoring `purchase_id not null` is safe only if no sale_items row has
-- actually been nulled by this RPC since it was applied (any cancelled
-- sale's audit snapshot survives its purchase's deletion specifically
-- because of this — reverting would either fail outright on existing null
-- rows or silently discard that link) — a data decision only you should
-- make, so no rollback statement is offered here as a one-liner:
--   drop function if exists public.safe_delete_purchases(uuid[]);
--   alter table public.sale_items alter column purchase_id set not null;
