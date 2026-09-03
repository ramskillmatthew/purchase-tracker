-- ===========================================================================
-- Returns/Losses schema upgrade:  live v2 (Stage 1)  ->  v3 (audit-corrected)
-- ===========================================================================
-- The live database already runs the v2 hardened migration. This script
-- applies ONLY the six v3 corrections, each additive and idempotent. It is
-- the minimal, reviewable alternative to re-running the whole (also idempotent)
-- supabase-returns-losses.sql.
--
-- NOTHING here drops a table, deletes/updates a business row, or rewrites
-- purchases / expenses / sales_orders / sale_items / investments data.
--
-- Apply manually in Supabase -> SQL Editor. All-or-nothing (begin/commit).
-- Expected runtime: well under 1 second (return/loss/movement tables are tiny).
-- ===========================================================================

-- ---- OPTIONAL read-only pre-checks (run first, on their own; all must pass) --
-- 1) No completed return is missing a historical field (the new constraint is a
--    SUPERSET of the current biconditional, so this is expected to be 0):
--      select count(*) from public.return_records
--      where workflow_status = 'return_completed'
--        and (outcome is null or recognition_month is null or completed_on is null);
-- 2) Confirm the current (pre-upgrade) state:
--      select pg_get_constraintdef(oid) from pg_constraint
--      where conname = 'return_records_completed_shape';           -- expect biconditional
--      select conname, confdeltype from pg_constraint
--      where conname in ('inventory_movements_return_record_id_fkey',
--                        'inventory_movements_loss_record_id_fkey'); -- expect 'n' (SET NULL)
--      select 1 from information_schema.columns
--      where table_name='loss_records' and column_name='idempotency_key';  -- expect 0 rows
--      select proname, proconfig from pg_proc
--      where proname='next_return_loss_reference';                  -- expect proconfig NULL

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---- Delta 1 (audit Defect 1) ---------------------------------------------
-- return_records_completed_shape: biconditional  ->  one-directional implication.
-- A completed return still MUST carry outcome + recognition_month + completed_on;
-- a return later cancelled / soft-deleted / reactivated may KEEP those fields.
-- Every existing row already satisfies the stricter biconditional, so the
-- implication (a superset of allowed states) cannot be violated by live data.
alter table public.return_records drop constraint if exists return_records_completed_shape;
alter table public.return_records add constraint return_records_completed_shape check (
  workflow_status <> 'return_completed'
  or (
    outcome is not null
    and recognition_month is not null
    and completed_on is not null
  )
);

-- ---- Delta 4 (audit Defect 4) -------------------------------------------------
-- inventory_movements parent FKs: ON DELETE SET NULL  ->  ON DELETE RESTRICT.
-- SET NULL on a hard parent delete would null exactly one of the two links and
-- instantly break inventory_movements_one_source; RESTRICT states that intent.
-- Re-adding the FK re-validates existing rows against the SAME parent/columns
-- it was already enforcing, so validation is immediate and no row changes.
-- (For a large table you would ADD ... NOT VALID then VALIDATE CONSTRAINT
--  separately; inventory_movements here is tiny, so a plain re-add is fine.)
alter table public.inventory_movements drop constraint if exists inventory_movements_return_record_id_fkey;
alter table public.inventory_movements add constraint inventory_movements_return_record_id_fkey
  foreign key (return_record_id) references public.return_records (id) on delete restrict;

alter table public.inventory_movements drop constraint if exists inventory_movements_loss_record_id_fkey;
alter table public.inventory_movements add constraint inventory_movements_loss_record_id_fkey
  foreign key (loss_record_id) references public.loss_records (id) on delete restrict;

-- ---- Delta 3 (audit Defect 3) -------------------------------------------------
-- Pin a safe search_path on the one function that lacked it. ALTER FUNCTION
-- ... SET adds the config without touching the body; re-running is a no-op.
alter function public.next_return_loss_reference(uuid, text)
  set search_path = public, pg_temp;

-- ---- Delta 5 (audit Defect 5) -------------------------------------------------
-- Loss-creation idempotency: a nullable client request key + a PARTIAL unique
-- index (NULL keys stay unconstrained, so legitimate distinct losses are never
-- blocked) + the create path returning the existing row on a key collision.
alter table public.loss_records add column if not exists idempotency_key text;

create unique index if not exists loss_records_owner_idempotency_key_uidx
  on public.loss_records (owner_id, idempotency_key)
  where idempotency_key is not null;

-- Replace ONLY rl_apply_loss_transition (signature unchanged: 7 args).
-- New create path: insert ... on conflict (owner_id, idempotency_key) where
-- idempotency_key is not null do nothing; on a suppressed insert, return the
-- pre-existing row with already_applied=true BEFORE re-applying movements/audit.
-- NULL / absent key => plain insert, identical to the previous behaviour.
create or replace function public.rl_apply_loss_transition(
  p_owner_id uuid, p_loss_id uuid, p_loss jsonb, p_movements jsonb,
  p_stock_checks jsonb, p_audit jsonb, p_mode text  -- 'create' | 'edit' | 'reverse'
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_rec public.loss_records; v_id uuid;
begin
  if p_mode = 'create' then
    insert into public.loss_records (
      id, owner_id, reference, idempotency_key, loss_type, purchase_id, sales_order_id, quantity, unit_cost,
      stock_value_removed, customer_refund, other_costs, net_profit_impact,
      event_date, event_precision, event_month, logged_date, logged_precision, logged_by,
      stock_action, written_off_purchase_ids, sale_item_ids, applied, notes, created_by
    ) values (
      coalesce(nullif(p_loss->>'id', '')::uuid, gen_random_uuid()),
      p_owner_id, p_loss->>'reference', nullif(p_loss->>'idempotency_key', ''), p_loss->>'loss_type',
      nullif(p_loss->>'purchase_id','')::uuid, nullif(p_loss->>'sales_order_id','')::uuid,
      (p_loss->>'quantity')::int, (p_loss->>'unit_cost')::numeric,
      (p_loss->>'stock_value_removed')::numeric, (p_loss->>'customer_refund')::numeric,
      (p_loss->>'other_costs')::numeric, (p_loss->>'net_profit_impact')::numeric,
      (p_loss->>'event_date')::date, p_loss->>'event_precision', p_loss->>'event_month',
      (p_loss->>'logged_date')::date, p_loss->>'logged_precision', p_loss->>'logged_by',
      p_loss->>'stock_action',
      coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_loss->'written_off_purchase_ids') x), '{}'),
      coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_loss->'sale_item_ids') x), '{}'),
      false, p_loss->>'notes', p_loss->>'created_by'
    )
    on conflict (owner_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into v_id;

    -- Suppressed insert -> this (owner, idempotency_key) already created a
    -- loss. Return it unchanged: its movements + audit were applied by the
    -- first call, and re-running them here would double-touch. This is what
    -- makes an accidental double-submit / network retry of "Log loss" safe,
    -- including for refund_without_return / other_write_off which carry no
    -- purchase and so have no stock-movement key to fall back on.
    if v_id is null then
      select * into v_rec from public.loss_records
        where owner_id = p_owner_id
          and idempotency_key = nullif(p_loss->>'idempotency_key', '')
        order by created_at asc
        limit 1;
      if found then
        return jsonb_build_object('record', to_jsonb(v_rec), 'already_applied', true);
      end if;
      raise exception 'loss_create_failed' using errcode = 'P0001';
    end if;
  else
    select id into v_id from public.loss_records
      where id = p_loss_id and owner_id = p_owner_id and deleted_at is null for update;
    if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  end if;

  perform public.rl_assert_stock(p_stock_checks);
  perform public.rl_apply_movements(p_owner_id, p_movements, p_audit->0->>'actor');

  update public.loss_records set
    loss_type                 = coalesce(p_loss->>'loss_type', loss_type),
    purchase_id               = case when p_loss ? 'purchase_id' then nullif(p_loss->>'purchase_id','')::uuid else purchase_id end,
    sales_order_id            = case when p_loss ? 'sales_order_id' then nullif(p_loss->>'sales_order_id','')::uuid else sales_order_id end,
    quantity                  = coalesce((p_loss->>'quantity')::int, quantity),
    unit_cost                 = coalesce((p_loss->>'unit_cost')::numeric, unit_cost),
    stock_value_removed       = coalesce((p_loss->>'stock_value_removed')::numeric, stock_value_removed),
    customer_refund           = coalesce((p_loss->>'customer_refund')::numeric, customer_refund),
    other_costs               = coalesce((p_loss->>'other_costs')::numeric, other_costs),
    net_profit_impact         = coalesce((p_loss->>'net_profit_impact')::numeric, net_profit_impact),
    event_date                = coalesce((p_loss->>'event_date')::date, event_date),
    event_precision           = coalesce(p_loss->>'event_precision', event_precision),
    event_month               = coalesce(p_loss->>'event_month', event_month),
    logged_date               = coalesce((p_loss->>'logged_date')::date, logged_date),
    logged_precision          = coalesce(p_loss->>'logged_precision', logged_precision),
    stock_action              = coalesce(p_loss->>'stock_action', stock_action),
    written_off_purchase_ids  = case when p_loss ? 'written_off_purchase_ids'
                                  then coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_loss->'written_off_purchase_ids') x), '{}')
                                  else written_off_purchase_ids end,
    sale_item_ids             = case when p_loss ? 'sale_item_ids'
                                  then coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_loss->'sale_item_ids') x), '{}')
                                  else sale_item_ids end,
    applied                   = coalesce((p_loss->>'applied')::boolean, applied),
    reversed_movement_gen     = coalesce((p_loss->>'reversed_movement_gen')::int, reversed_movement_gen),
    deleted_at                = case when p_loss ? 'deleted_at' then (p_loss->>'deleted_at')::timestamptz else deleted_at end,
    deleted_by                = case when p_loss ? 'deleted_by' then p_loss->>'deleted_by' else deleted_by end,
    notes                     = case when p_loss ? 'notes' then p_loss->>'notes' else notes end,
    updated_at                = now()
  where id = v_id
  returning * into v_rec;

  perform public.rl_add_audit(p_owner_id, null, v_id, p_audit);
  return jsonb_build_object('record', to_jsonb(v_rec), 'already_applied', false);
end $$;

-- ---- Delta 2 (audit Defect 2) -------------------------------------------------
-- For all eight functions: (1) REVOKE EXECUTE from PUBLIC, (2) REVOKE from
-- anon / authenticated when present, (3) explicitly GRANT EXECUTE to
-- service_role when present.
--
-- Step 3 is REQUIRED. A function's only default EXECUTE grant is to PUBLIC;
-- anon, authenticated AND service_role reach it only by inheriting that PUBLIC
-- grant, so `revoke ... from public` ALSO removes service_role's access unless
-- service_role holds its own explicit grant. Supabase default privileges
-- usually add one, but that is environment-dependent and must not be relied
-- on. The server (PostgREST + service key -> SET ROLE service_role) calls
-- every rl_* / next_return_loss_reference RPC, so we grant it back here,
-- explicitly and idempotently. Literal SQL, no dynamic execute. postgres
-- (object owner) always retains EXECUTE and is never named.
revoke all on function public.next_return_loss_reference(uuid, text) from public;
revoke all on function public.rl_touch_updated_at() from public;
revoke all on function public.rl_apply_movements(uuid, jsonb, text) from public;
revoke all on function public.rl_assert_stock(jsonb) from public;
revoke all on function public.rl_add_audit(uuid, uuid, uuid, jsonb) from public;
revoke all on function public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text) from public;
revoke all on function public.rl_create_return(uuid, jsonb, text, jsonb) from public;
revoke all on function public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) from public;

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
  end if;
  -- Re-grant the access the PUBLIC revoke just removed from service_role.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.next_return_loss_reference(uuid, text) to service_role;
    grant execute on function public.rl_touch_updated_at() to service_role;
    grant execute on function public.rl_apply_movements(uuid, jsonb, text) to service_role;
    grant execute on function public.rl_assert_stock(jsonb) to service_role;
    grant execute on function public.rl_add_audit(uuid, uuid, uuid, jsonb) to service_role;
    grant execute on function public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text) to service_role;
    grant execute on function public.rl_create_return(uuid, jsonb, text, jsonb) to service_role;
    grant execute on function public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) to service_role;
  end if;
end $$;

commit;

-- ===========================================================================
-- POST-UPGRADE VERIFICATION (read-only; run after commit)
-- ===========================================================================
-- select pg_get_constraintdef(oid) from pg_constraint where conname='return_records_completed_shape';
--   -> expect:  CHECK ((workflow_status <> 'return_completed'::text) OR ((outcome IS NOT NULL) AND (recognition_month IS NOT NULL) AND (completed_on IS NOT NULL)))
-- select conname, confdeltype from pg_constraint
--   where conname in ('inventory_movements_return_record_id_fkey','inventory_movements_loss_record_id_fkey');
--   -> expect confdeltype = 'r' (RESTRICT) for both
-- select column_name from information_schema.columns
--   where table_name='loss_records' and column_name='idempotency_key';                 -> 1 row
-- select indexname from pg_indexes where indexname='loss_records_owner_idempotency_key_uidx'; -> 1 row
-- select proname, proconfig from pg_proc where proname='next_return_loss_reference';
--   -> proconfig contains 'search_path=public, pg_temp'
-- EXECUTE privileges on all eight (aclexplode makes this unambiguous):
--   select p.proname, r.rolname, a.privilege_type
--   from pg_proc p
--   cross join lateral aclexplode(p.proacl) a
--   join pg_roles r on r.oid = a.grantee
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname in ('next_return_loss_reference','rl_touch_updated_at','rl_apply_movements',
--                       'rl_assert_stock','rl_add_audit','rl_apply_return_transition',
--                       'rl_create_return','rl_apply_loss_transition')
--   order by 1,2;
--   -> EXPECT: every one of the 8 has an EXECUTE row for rolname='service_role'.
--             NO EXECUTE row for 'anon' or 'authenticated'.
--   Also: select proacl::text ... -> must NOT contain '=X/' (that token is the
--             PUBLIC EXECUTE grant; its absence proves PUBLIC has none).
-- Functional smoke test in the app (server uses the service key = service_role):
--   * complete a return, then CANCEL it            -> must succeed (Defect 1 path)
--   * double-submit "Log loss" in one dialog       -> exactly one loss row (Defect 5)
--   * any Returns/Losses action (they all go through an rl_* RPC) -> works,
--     confirming service_role kept EXECUTE after the lockdown.
-- ===========================================================================
