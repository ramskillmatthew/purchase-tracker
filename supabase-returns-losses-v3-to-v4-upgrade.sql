-- ===========================================================================
-- Returns/Losses schema upgrade:  v3 (audit-corrected)  ->  v4 (active-return
-- accounting + safe cancelled-sale purge)
-- ===========================================================================
-- Narrow, additive, idempotent. Contains NO schema/column/constraint change:
-- every column rl_create_return now writes (original_sale_revenue,
-- original_sale_profit, original_stock_cost, revenue_reversed, profit_reversed,
-- net_profit_impact) already exists on return_records from the v2 hardening
-- block. This upgrade only:
--
--   1. REPLACES rl_create_return so an active (in-progress) return stores its
--      authoritative net-profit impact = -(selected units' sale profit) from
--      'return_started' onward. Omitted keys default to 0 -> older callers and
--      re-runs are unaffected.
--   2. ADDS rl_purge_deletable_sale(uuid, uuid[]) — permanent deletion of an
--      already-cancelled sale together with its safely-inactive return history,
--      in one transaction, refusing to run while any active return/loss owns
--      the sale. FK integrity (inventory_movements RESTRICT) is preserved: the
--      RESTRICT rows are removed explicitly, in dependency order, inside the
--      txn.
--   3. Re-asserts the FULL nine-function EXECUTE lockdown (PUBLIC / anon /
--      authenticated denied; service_role explicitly granted) so the new
--      function is locked down and the set is complete after this upgrade.
--
-- NOTHING here rewrites a business row. Apply manually in Supabase -> SQL
-- Editor. All-or-nothing (begin/commit). Do NOT apply until reviewed.
-- ===========================================================================

-- ---- OPTIONAL read-only pre-checks (run first, on their own) --------------
-- 1) The six columns rl_create_return will write already exist (expect 6 rows):
--      select column_name from information_schema.columns
--      where table_schema='public' and table_name='return_records'
--        and column_name in ('original_sale_revenue','original_sale_profit',
--          'original_stock_cost','revenue_reversed','profit_reversed','net_profit_impact');
-- 2) Current rl_create_return does NOT yet insert the money columns (expect the
--    body to lack 'net_profit_impact'):
--      select pg_get_functiondef('public.rl_create_return(uuid, jsonb, text, jsonb)'::regprocedure);
-- 3) rl_purge_deletable_sale does not exist yet (expect 0 rows):
--      select 1 from pg_proc where proname = 'rl_purge_deletable_sale';
-- 4) FK delete actions are unchanged by this upgrade (expect confdeltype 'r'):
--      select conname, confdeltype from pg_constraint
--      where conname in ('inventory_movements_return_record_id_fkey',
--                        'inventory_movements_loss_record_id_fkey');

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---- 1. rl_create_return: store the active return's accounting -------------
create or replace function public.rl_create_return(
  p_owner_id uuid, p_return jsonb, p_sale_process_status text, p_audit jsonb
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_rec public.return_records; v_id uuid;
begin
  insert into public.return_records (
    owner_id, reference, sales_order_id, quantity, sale_item_ids, workflow_status,
    started_on, started_precision, prev_process_status, notes, created_by,
    original_sale_revenue, original_sale_profit, original_stock_cost,
    revenue_reversed, profit_reversed, net_profit_impact
  ) values (
    p_owner_id, p_return->>'reference', (p_return->>'sales_order_id')::uuid,
    (p_return->>'quantity')::int,
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_return->'sale_item_ids') x), '{}'),
    'return_started',
    (p_return->>'started_on')::date, p_return->>'started_precision',
    nullif(p_return->>'prev_process_status', ''), p_return->>'notes', p_return->>'created_by',
    coalesce((p_return->>'original_sale_revenue')::numeric, 0),
    coalesce((p_return->>'original_sale_profit')::numeric, 0),
    coalesce((p_return->>'original_stock_cost')::numeric, 0),
    coalesce((p_return->>'revenue_reversed')::numeric, 0),
    coalesce((p_return->>'profit_reversed')::numeric, 0),
    coalesce((p_return->>'net_profit_impact')::numeric, 0)
  ) returning * into v_rec;
  v_id := v_rec.id;

  update public.sales_orders set process_status = p_sale_process_status, updated_at = now()
    where id = v_rec.sales_order_id and owner_id = p_owner_id;

  perform public.rl_add_audit(p_owner_id, v_id, null, p_audit);
  return jsonb_build_object('record', to_jsonb(v_rec));
end $$;

-- ---- 2. rl_purge_deletable_sale ------------------------------------------------
create or replace function public.rl_purge_deletable_sale(
  p_owner_id uuid, p_sales_order_ids uuid[]
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_status text;
  v_blockers int;
  v_ret_ids uuid[];
  v_deleted_sales int := 0;
  v_deleted_returns int := 0;
  v_detached_losses int := 0;
begin
  if p_sales_order_ids is null or array_length(p_sales_order_ids, 1) is null then
    raise exception 'empty_selection' using errcode = 'P0001';
  end if;
  if array_length(p_sales_order_ids, 1) > 100 then
    raise exception 'too_many_sales' using errcode = 'P0001';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_sales_order_ids) x;

  foreach v_id in array v_ids loop
    select status into v_status from public.sales_orders
      where id = v_id and owner_id = p_owner_id for update;
    if not found then raise exception 'sale_not_found' using errcode = 'P0001'; end if;
    if v_status = 'completed' then raise exception 'sale_still_active' using errcode = 'P0001'; end if;

    select count(*) into v_blockers from public.return_records
      where sales_order_id = v_id and owner_id = p_owner_id
        and deleted_at is null and workflow_status <> 'return_cancelled';
    if v_blockers > 0 then raise exception 'active_return_blocks_delete' using errcode = 'P0001'; end if;

    select count(*) into v_blockers from public.loss_records
      where sales_order_id = v_id and owner_id = p_owner_id and deleted_at is null;
    if v_blockers > 0 then raise exception 'active_loss_blocks_delete' using errcode = 'P0001'; end if;

    select array_agg(id) into v_ret_ids from public.return_records
      where sales_order_id = v_id and owner_id = p_owner_id;
    if v_ret_ids is not null then
      delete from public.inventory_movements where return_record_id = any(v_ret_ids);
      delete from public.return_records where id = any(v_ret_ids);
      v_deleted_returns := v_deleted_returns + array_length(v_ret_ids, 1);
    end if;

    update public.loss_records set sales_order_id = null, updated_at = now()
      where sales_order_id = v_id and owner_id = p_owner_id and deleted_at is not null;
    get diagnostics v_blockers = row_count;
    v_detached_losses := v_detached_losses + v_blockers;

    delete from public.sales_orders where id = v_id;
    v_deleted_sales := v_deleted_sales + 1;
  end loop;

  return jsonb_build_object(
    'deleted_sales', v_deleted_sales,
    'deleted_returns', v_deleted_returns,
    'detached_losses', v_detached_losses
  );
end $$;

-- ---- 3. FULL nine-function EXECUTE lockdown ---------------------------------
-- Identical guarded-literal outcomes to the canonical migration: PUBLIC / anon
-- / authenticated denied, service_role explicitly re-granted (a PUBLIC revoke
-- also strips service_role's inherited access). postgres (owner) never named.
-- No dynamic SQL. Idempotent.
revoke all on function public.next_return_loss_reference(uuid, text) from public;
revoke all on function public.rl_touch_updated_at() from public;
revoke all on function public.rl_apply_movements(uuid, jsonb, text) from public;
revoke all on function public.rl_assert_stock(jsonb) from public;
revoke all on function public.rl_add_audit(uuid, uuid, uuid, jsonb) from public;
revoke all on function public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text) from public;
revoke all on function public.rl_create_return(uuid, jsonb, text, jsonb) from public;
revoke all on function public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) from public;
revoke all on function public.rl_purge_deletable_sale(uuid, uuid[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.next_return_loss_reference(uuid, text) from anon;
    revoke all on function public.rl_touch_updated_at() from anon;
    revoke all on function public.rl_apply_movements(uuid, jsonb, text) from anon;
    revoke all on function public.rl_assert_stock(jsonb) from anon;
    revoke all on function public.rl_add_audit(uuid, uuid, uuid, jsonb) from anon;
    revoke all on function public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text) from anon;
    revoke all on function public.rl_create_return(uuid, jsonb, text, jsonb) from anon;
    revoke all on function public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) from anon;
    revoke all on function public.rl_purge_deletable_sale(uuid, uuid[]) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.next_return_loss_reference(uuid, text) from authenticated;
    revoke all on function public.rl_touch_updated_at() from authenticated;
    revoke all on function public.rl_apply_movements(uuid, jsonb, text) from authenticated;
    revoke all on function public.rl_assert_stock(jsonb) from authenticated;
    revoke all on function public.rl_add_audit(uuid, uuid, uuid, jsonb) from authenticated;
    revoke all on function public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text) from authenticated;
    revoke all on function public.rl_create_return(uuid, jsonb, text, jsonb) from authenticated;
    revoke all on function public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) from authenticated;
    revoke all on function public.rl_purge_deletable_sale(uuid, uuid[]) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.next_return_loss_reference(uuid, text) to service_role;
    grant execute on function public.rl_touch_updated_at() to service_role;
    grant execute on function public.rl_apply_movements(uuid, jsonb, text) to service_role;
    grant execute on function public.rl_assert_stock(jsonb) to service_role;
    grant execute on function public.rl_add_audit(uuid, uuid, uuid, jsonb) to service_role;
    grant execute on function public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text) to service_role;
    grant execute on function public.rl_create_return(uuid, jsonb, text, jsonb) to service_role;
    grant execute on function public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) to service_role;
    grant execute on function public.rl_purge_deletable_sale(uuid, uuid[]) to service_role;
  end if;
end $$;

commit;

-- ===========================================================================
-- POST-UPGRADE VERIFICATION (read-only; run after commit)
-- ===========================================================================
-- select pg_get_functiondef('public.rl_create_return(uuid, jsonb, text, jsonb)'::regprocedure) ilike '%net_profit_impact%';
--   -> true (body now inserts the six money columns)
-- select 1 from pg_proc where proname = 'rl_purge_deletable_sale';         -> 1 row
-- EXECUTE privileges on all NINE (aclexplode makes this unambiguous):
--   select p.proname, r.rolname, a.privilege_type
--   from pg_proc p
--   cross join lateral aclexplode(p.proacl) a
--   join pg_roles r on r.oid = a.grantee
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname in ('next_return_loss_reference','rl_touch_updated_at','rl_apply_movements',
--                       'rl_assert_stock','rl_add_audit','rl_apply_return_transition',
--                       'rl_create_return','rl_apply_loss_transition','rl_purge_deletable_sale')
--   order by 1,2;
--   -> EXPECT: every one of the 9 has an EXECUTE row for rolname='service_role';
--             NO EXECUTE row for 'anon' or 'authenticated'.
-- Functional smoke test in the app (server = service_role):
--   * log a return against a completed sale -> its Returns row shows
--     net-profit impact = -(unit profit) immediately, and Home Net Profit
--     drops by the same amount for that period.
--   * cancel the return -> impact returns to 0; sale restored to the chosen
--     status; Home Net Profit back to original.
--   * cancel then permanently delete that sale -> succeeds; no orphan
--     return/movement/audit rows remain.
-- ===========================================================================
