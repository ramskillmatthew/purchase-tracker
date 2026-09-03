-- ============================================================================
-- Returns, Losses & Write-offs — additive, idempotent migration.
-- ============================================================================
-- Apply manually in Supabase -> SQL Editor -> New query, AFTER
-- supabase-sales-v4-process-status.sql. Every statement is safe to run more
-- than once. This migration NEVER rewrites or deletes any existing
-- purchases / expenses / sales_orders / sale_items / investments data.
--
-- MONEY: numeric(10,2), matching every table this feature links to
-- (purchases, expenses, sales_orders, sale_items). All arithmetic in the
-- application layer is done in INTEGER PENCE via lib/sales/money.ts, exactly
-- as the existing sales domain already does — the DB stores the rounded
-- 2dp result, the app never does float maths on money.
--
-- OWNERSHIP: this app is single-owner (lib/auth/server.ts requireOwner ->
-- OWNER_EMAIL). sales_orders/sale_items carry owner_id -> auth.users; the
-- purchases table does not (it predates owner scoping and is effectively
-- single-tenant). The new tables below all carry owner_id and every
-- application query filters owner_id = eq.<user.id>; RLS is enabled and all
-- grants revoked from anon/authenticated as defence-in-depth (the server
-- uses the secret key, like the rest of the app).
--
-- DATE PRECISION: a *_precision column is 'exact' (a real calendar day is
-- known) or 'month' (only the month is known). For 'month', the paired date
-- column stores the FIRST of that month as a canonical, sortable anchor and
-- must never be displayed as a day — the UI shows "August 2026". The
-- canonical YYYY-MM filter key is stored explicitly (recognition_month /
-- event_month) so period filtering never has to re-derive it.
-- ============================================================================

begin;

-- ============================================================================
-- return_records — one row per return, matched to an existing sales_orders row.
-- ============================================================================
create table if not exists public.return_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  reference text not null,
  sales_order_id uuid not null references public.sales_orders (id),

  -- Units being returned. The app additionally enforces
  -- quantity <= (units sold on the sale) - (units already tied up in other
  -- active/completed returns) before insert.
  quantity integer not null check (quantity >= 1),
  -- The exact sale_items rows this return covers, chosen and locked in at
  -- creation time — this is what makes "a unit cannot be returned twice"
  -- precise (rather than a count-only guard) once a sale spans multiple
  -- different items. array_length(...) must equal `quantity`.
  sale_item_ids uuid[] not null default '{}',

  workflow_status text not null default 'return_started'
    check (workflow_status in (
      'return_started', 'item_sent', 'return_delivered', 'return_completed', 'return_cancelled'
    )),
  -- Set only when workflow_status = 'return_completed'. Exactly two outcomes
  -- (deliberately no "returned damaged" — a physically returned item always
  -- restocks at its original purchase cost).
  outcome text check (outcome in ('returned_safely', 'buyer_refunded_no_return')),

  -- Per-stage dates + precision.
  started_on date not null,
  started_precision text not null default 'exact' check (started_precision in ('exact', 'month')),
  item_sent_on date,
  item_sent_precision text check (item_sent_precision in ('exact', 'month')),
  delivered_on date,
  delivered_precision text check (delivered_precision in ('exact', 'month')),
  completed_on date,
  completed_precision text check (completed_precision in ('exact', 'month')),

  -- Canonical YYYY-MM the financial reversal is recognised in. Set on
  -- completion. Return financial KPIs and the Home dashboard net-profit
  -- adjustment key on THIS, never on the linked sale's original sale_date
  -- (the August-sale / September-return rule).
  recognition_month text check (recognition_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  -- Money snapshots (numeric(10,2)); populated on completion, edited via the
  -- difference-only edit path.
  revenue_reversed numeric(10,2) not null default 0,
  profit_reversed numeric(10,2) not null default 0,
  original_stock_cost numeric(10,2) not null default 0,
  refund_amount numeric(10,2) not null default 0 check (refund_amount >= 0),
  partial_refund_amount numeric(10,2) check (partial_refund_amount >= 0),
  return_postage numeric(10,2) not null default 0 check (return_postage >= 0),
  unrecovered_costs numeric(10,2) not null default 0 check (unrecovered_costs >= 0),

  -- The linked sale's process_status BEFORE this return moved it to
  -- 'return_in_process' — restored verbatim on cancel/delete unless the user
  -- explicitly picks a different existing status.
  prev_process_status text,
  -- The exact purchases rows restocked by a 'returned_safely' completion, so
  -- a later cancel/delete reverses precisely those units and no others.
  restock_purchase_ids uuid[] not null default '{}',

  -- Idempotency: completion / cancellation effects apply at most once even
  -- if the request is retried or double-submitted.
  completed_applied boolean not null default false,
  cancelled_applied boolean not null default false,

  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One-directional implication (NOT a biconditional): a row that IS
  -- 'return_completed' must carry outcome + recognition_month + completed_on.
  -- A return later moved to 'return_cancelled' (or soft-deleted, or
  -- reactivated) is free to KEEP those historical completion fields — the
  -- Stage 1 design never overwrites them, and cancelling a completed return
  -- must not trip this constraint. The v2 hardening block below re-adds the
  -- exact same rule idempotently.
  constraint return_records_completed_shape check (
    workflow_status <> 'return_completed'
    or (
      outcome is not null
      and recognition_month is not null
      and completed_on is not null
    )
  ),
  constraint return_records_reference_owner_unique unique (owner_id, reference)
);

alter table public.return_records enable row level security;
revoke all on public.return_records from anon, authenticated;
create index if not exists return_records_owner_month_idx on public.return_records (owner_id, recognition_month);
create index if not exists return_records_sale_idx on public.return_records (sales_order_id);
create index if not exists return_records_owner_status_idx on public.return_records (owner_id, workflow_status);

-- ============================================================================
-- loss_records — one row per loss / write-off, matched to a purchase
-- (mandatory for lost_inventory / unsellable_purchase) and optionally to a
-- sale (refund_without_return).
-- ============================================================================
create table if not exists public.loss_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  reference text not null,

  loss_type text not null check (loss_type in (
    'lost_inventory', 'unsellable_purchase', 'refund_without_return', 'other_write_off'
  )),

  -- Mandatory purchase match for the two inventory loss types. The app also
  -- persists the exact affected unit rows in written_off_purchase_ids.
  purchase_id uuid references public.purchases (id),
  sales_order_id uuid references public.sales_orders (id),

  quantity integer not null check (quantity >= 1),
  unit_cost numeric(10,2) not null check (unit_cost >= 0),
  stock_value_removed numeric(10,2) not null default 0 check (stock_value_removed >= 0),
  customer_refund numeric(10,2) not null default 0 check (customer_refund >= 0),
  other_costs numeric(10,2) not null default 0 check (other_costs >= 0),

  -- The loss/event date drives the reporting + dashboard month.
  event_date date not null,
  event_precision text not null default 'exact' check (event_precision in ('exact', 'month')),
  event_month text not null check (event_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  -- When the record was entered. Never used for financial reporting.
  logged_date date not null default current_date,
  logged_precision text not null default 'exact' check (logged_precision in ('exact', 'month')),
  logged_by text,

  stock_action text not null default 'remove_from_stock'
    check (stock_action in ('remove_from_stock', 'keep_in_stock')),
  -- The exact purchases rows this loss marked out of stock.
  written_off_purchase_ids uuid[] not null default '{}',

  applied boolean not null default false,

  -- Client-supplied stable request key (a UUID minted once per "Log loss"
  -- dialog session). Retried / double-submitted creates carry the SAME key
  -- and are de-duplicated by loss_records_owner_idempotency_key_uidx below —
  -- the RPC returns the already-created row instead of inserting a second.
  -- Nullable so pre-key rows and non-UI callers are unaffected; two genuinely
  -- separate losses always have two different keys, so legitimate distinct
  -- events are never blocked.
  idempotency_key text,

  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint loss_records_purchase_required check (
    loss_type not in ('lost_inventory', 'unsellable_purchase') or purchase_id is not null
  ),
  constraint loss_records_reference_owner_unique unique (owner_id, reference)
);

alter table public.loss_records enable row level security;
revoke all on public.loss_records from anon, authenticated;
create index if not exists loss_records_owner_month_idx on public.loss_records (owner_id, event_month);
create index if not exists loss_records_purchase_idx on public.loss_records (purchase_id);
create index if not exists loss_records_owner_type_idx on public.loss_records (owner_id, loss_type);

-- ============================================================================
-- inventory_movements — the ledger of every stock transition THIS feature
-- causes. purchases.stock_status stays the denormalised "current" state;
-- this table is the source of truth for WHY and WHEN, and its
-- idempotency_key unique index is the hard guarantee that the same unit is
-- never taken out of / put back into stock twice by a retried request.
-- ============================================================================
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  purchase_id uuid not null references public.purchases (id),
  direction text not null check (direction in ('out_of_stock', 'back_in_stock')),
  -- The four "out because it was ..." reasons the spec requires kept
  -- distinct from a sale, plus the two reversal reasons.
  reason text not null check (reason in (
    'lost', 'unsellable', 'refunded_no_return', 'returned_to_stock',
    'loss_reversed', 'return_reversed'
  )),
  -- RESTRICT, not SET NULL: a hard delete of a parent return/loss must be
  -- refused while ledger rows point at it (SET NULL would null exactly one of
  -- the two links and instantly break inventory_movements_one_source anyway).
  -- The app never hard-deletes — it soft-deletes (deleted_at) and keeps the
  -- ledger — so this only guards a manual DELETE. The v2 block converts an
  -- existing SET NULL definition.
  return_record_id uuid references public.return_records (id) on delete restrict,
  loss_record_id uuid references public.loss_records (id) on delete restrict,
  unit_cost numeric(10,2) not null check (unit_cost >= 0),
  idempotency_key text not null,
  created_by text,
  created_at timestamptz not null default now(),

  constraint inventory_movements_one_source check (
    (return_record_id is not null)::int + (loss_record_id is not null)::int = 1
  )
);

alter table public.inventory_movements enable row level security;
revoke all on public.inventory_movements from anon, authenticated;
create unique index if not exists inventory_movements_idempotency_key_uidx
  on public.inventory_movements (idempotency_key);
create index if not exists inventory_movements_purchase_idx on public.inventory_movements (purchase_id);
create index if not exists inventory_movements_return_idx on public.inventory_movements (return_record_id);
create index if not exists inventory_movements_loss_idx on public.inventory_movements (loss_record_id);

-- ============================================================================
-- return_loss_audit_events — the visible audit trail for both record types.
-- ============================================================================
create table if not exists public.return_loss_audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  return_record_id uuid references public.return_records (id) on delete cascade,
  loss_record_id uuid references public.loss_records (id) on delete cascade,
  event_type text not null check (event_type in (
    'record_created', 'status_changed', 'sale_linked', 'purchase_linked',
    'quantity_changed', 'amount_changed', 'inventory_restored', 'inventory_written_off',
    'return_completed', 'return_cancelled', 'record_edited', 'record_reversed', 'record_deleted'
  )),
  detail jsonb not null default '{}'::jsonb,
  actor text,
  created_at timestamptz not null default now(),

  constraint return_loss_audit_events_one_target check (
    (return_record_id is not null)::int + (loss_record_id is not null)::int = 1
  )
);

alter table public.return_loss_audit_events enable row level security;
revoke all on public.return_loss_audit_events from anon, authenticated;
create index if not exists return_loss_audit_return_idx on public.return_loss_audit_events (return_record_id, created_at desc);
create index if not exists return_loss_audit_loss_idx on public.return_loss_audit_events (loss_record_id, created_at desc);

-- ============================================================================
-- next_return_loss_reference — human-friendly, per-owner sequential reference
-- (RET-00001 / LOS-00001). A dedicated tiny counter table keeps generation
-- race-free without a sequence-per-owner. Called once per record create,
-- inside the same request; the unique (owner_id, reference) constraints
-- above are the final backstop.
-- ============================================================================
create table if not exists public.return_loss_counters (
  owner_id uuid not null references auth.users (id),
  kind text not null check (kind in ('return', 'loss')),
  next_value integer not null default 1,
  primary key (owner_id, kind)
);
alter table public.return_loss_counters enable row level security;
revoke all on public.return_loss_counters from anon, authenticated;

create or replace function public.next_return_loss_reference(p_owner_id uuid, p_kind text)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_value integer;
  v_prefix text;
begin
  if p_kind not in ('return', 'loss') then
    raise exception 'invalid_reference_kind' using errcode = 'P0001';
  end if;
  insert into public.return_loss_counters (owner_id, kind, next_value)
    values (p_owner_id, p_kind, 2)
    on conflict (owner_id, kind)
    do update set next_value = public.return_loss_counters.next_value + 1
    returning next_value - 1 into v_value;
  v_prefix := case when p_kind = 'return' then 'RET-' else 'LOS-' end;
  return v_prefix || lpad(v_value::text, 5, '0');
end;
$$;

-- ============================================================================
-- v2 HARDENING — additive, idempotent. Safe to run whether or not the block
-- above has already been applied. Adds: soft-delete columns, the full
-- separate financial-component columns the spec requires preserved, the
-- expanded audit-event enum, updated_at auto-touch triggers, and the
-- narrower CHECK constraints. No DROP of a table/column anywhere.
-- ============================================================================

-- --- return_records: soft delete + full financial component breakdown -------
alter table public.return_records add column if not exists deleted_at timestamptz;
alter table public.return_records add column if not exists deleted_by text;
alter table public.return_records add column if not exists original_sale_revenue numeric(10,2) not null default 0;
alter table public.return_records add column if not exists original_sale_profit numeric(10,2) not null default 0;
alter table public.return_records add column if not exists inventory_write_off numeric(10,2) not null default 0;
alter table public.return_records add column if not exists stock_value_restored numeric(10,2) not null default 0;
alter table public.return_records add column if not exists other_costs numeric(10,2) not null default 0;
alter table public.return_records add column if not exists net_profit_impact numeric(10,2) not null default 0;
alter table public.return_records add column if not exists reversed_movement_gen integer not null default 0;

alter table public.loss_records add column if not exists deleted_at timestamptz;
alter table public.loss_records add column if not exists deleted_by text;
alter table public.loss_records add column if not exists net_profit_impact numeric(10,2) not null default 0;
alter table public.loss_records add column if not exists sale_item_ids uuid[] not null default '{}';
alter table public.loss_records add column if not exists reversed_movement_gen integer not null default 0;
alter table public.loss_records add column if not exists idempotency_key text;

-- Non-negative money guards on the added columns (guarded so a re-run is a no-op).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'return_records_new_amounts_nonneg') then
    alter table public.return_records add constraint return_records_new_amounts_nonneg check (
      original_sale_revenue >= 0 and inventory_write_off >= 0 and stock_value_restored >= 0 and other_costs >= 0
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'return_records_sale_item_count') then
    alter table public.return_records add constraint return_records_sale_item_count check (
      coalesce(array_length(sale_item_ids, 1), 0) = quantity
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loss_records_new_amounts_nonneg') then
    alter table public.loss_records add constraint loss_records_new_amounts_nonneg check (net_profit_impact <= 0 or net_profit_impact = 0);
  end if;
end $$;

-- "Completed shape" as a ONE-DIRECTIONAL IMPLICATION: if a row IS
-- 'return_completed' it must carry outcome + recognition_month + completed_on.
-- It says nothing about non-completed rows, so a return moved to
-- 'return_cancelled' (or soft-deleted, or reactivated to 'return_started')
-- may keep its historical completion fields — the cancel/delete appliers
-- deliberately never clear them (they are the audit of what WAS applied).
-- This means: cancelling a completed return does not violate the constraint,
-- and re-running this migration when such a row already exists cannot fail.
-- Fresh install (inline constraint above) and this re-run/hardening path both
-- end at this exact rule.
do $$
declare c text;
begin
  select conname into c from pg_constraint where conname = 'return_records_completed_shape';
  if c is not null then alter table public.return_records drop constraint return_records_completed_shape; end if;
  alter table public.return_records add constraint return_records_completed_shape check (
    workflow_status <> 'return_completed'
    or (
      outcome is not null
      and recognition_month is not null
      and completed_on is not null
    )
  );
end $$;

-- Convert the inventory_movements parent FKs from SET NULL to RESTRICT for any
-- database created by an earlier revision of this file. Idempotent: once the
-- delete action is already 'r' (RESTRICT) the block is a no-op. Fresh installs
-- get RESTRICT directly from the create table above.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.inventory_movements'::regclass
      and conname = 'inventory_movements_return_record_id_fkey'
      and confdeltype = 'n'
  ) then
    alter table public.inventory_movements drop constraint inventory_movements_return_record_id_fkey;
    alter table public.inventory_movements add constraint inventory_movements_return_record_id_fkey
      foreign key (return_record_id) references public.return_records (id) on delete restrict;
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.inventory_movements'::regclass
      and conname = 'inventory_movements_loss_record_id_fkey'
      and confdeltype = 'n'
  ) then
    alter table public.inventory_movements drop constraint inventory_movements_loss_record_id_fkey;
    alter table public.inventory_movements add constraint inventory_movements_loss_record_id_fkey
      foreign key (loss_record_id) references public.loss_records (id) on delete restrict;
  end if;
end $$;

-- Expanded audit-event enum.
do $$
declare c text;
begin
  select con.conname into c
  from pg_constraint con join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'return_loss_audit_events' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%event_type%';
  if c is not null then execute format('alter table public.return_loss_audit_events drop constraint %I', c); end if;
  alter table public.return_loss_audit_events add constraint return_loss_audit_events_event_type_check check (event_type in (
    'record_created', 'status_changed', 'sale_linked', 'purchase_linked',
    'quantity_changed', 'amount_changed', 'inventory_restored', 'inventory_written_off',
    'return_completed', 'outcome_selected', 'return_cancelled', 'record_edited', 'record_reversed',
    'record_deleted', 'recognition_month_changed', 'sales_status_changed'
  ));
end $$;

-- updated_at auto-touch, matching the app's manual convention as a backstop.
create or replace function public.rl_touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists return_records_touch_updated_at on public.return_records;
create trigger return_records_touch_updated_at before update on public.return_records
  for each row execute function public.rl_touch_updated_at();
drop trigger if exists loss_records_touch_updated_at on public.loss_records;
create trigger loss_records_touch_updated_at before update on public.loss_records
  for each row execute function public.rl_touch_updated_at();

-- Filter indexes for soft delete + list views.
create index if not exists return_records_owner_live_idx on public.return_records (owner_id, created_at desc) where deleted_at is null;
create index if not exists loss_records_owner_live_idx on public.loss_records (owner_id, created_at desc) where deleted_at is null;

-- Loss-creation idempotency: at most one loss per (owner, client request key).
-- The predicate keeps NULL keys (legacy / non-UI callers) unconstrained, and
-- because a distinct real loss always carries a distinct key, this never
-- blocks two legitimately separate losses. rl_apply_loss_transition inserts
-- with `on conflict (owner_id, idempotency_key) where idempotency_key is not
-- null do nothing` and, on a suppressed insert, returns the existing row.
create unique index if not exists loss_records_owner_idempotency_key_uidx
  on public.loss_records (owner_id, idempotency_key)
  where idempotency_key is not null;

-- ============================================================================
-- TRANSACTIONAL APPLIERS — every multi-table lifecycle transition runs inside
-- ONE of these functions so a partial failure (ledger applied but stock not,
-- record completed but sale status not, ...) is impossible: any exception
-- rolls back the whole call. They contain NO business logic — the caller
-- computes plans/field values with the tested lib/returns/* TypeScript and
-- passes them in as jsonb. LANGUAGE plpgsql, default SECURITY INVOKER (the
-- server calls these with the secret key, exactly like create_completed_sale);
-- every function still validates ownership and locks the target row, and
-- pins search_path. No dynamic SQL.
-- ============================================================================

-- Atomic ledger + stock: insert each movement (idempotent on idempotency_key)
-- and set the affected purchase's stock_status. Setting stock_status to the
-- value it already holds is a harmless no-op, so a retry is safe.
create or replace function public.rl_apply_movements(p_owner_id uuid, p_movements jsonb, p_actor text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare m jsonb;
begin
  for m in select value from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) loop
    insert into public.inventory_movements
      (owner_id, purchase_id, direction, reason, return_record_id, loss_record_id, unit_cost, idempotency_key, created_by)
    values (
      p_owner_id, (m->>'purchase_id')::uuid, m->>'direction', m->>'reason',
      nullif(m->>'return_record_id', '')::uuid, nullif(m->>'loss_record_id', '')::uuid,
      (m->>'unit_cost')::numeric, m->>'idempotency_key', p_actor
    )
    on conflict (idempotency_key) do nothing;
    update public.purchases set stock_status = m->>'resulting_stock_status'
      where id = (m->>'purchase_id')::uuid;
  end loop;
end $$;

-- Precondition check for a reversal — raises 'stock_conflict' (rolling back
-- the caller) with the offending purchase ids in DETAIL when a unit is not in
-- the state the reversal expects (e.g. sold again since a return restocked it).
create or replace function public.rl_assert_stock(p_checks jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
declare c jsonb; v_actual text; v_bad text := '';
begin
  for c in select value from jsonb_array_elements(coalesce(p_checks, '[]'::jsonb)) loop
    select stock_status into v_actual from public.purchases where id = (c->>'purchase_id')::uuid;
    if v_actual is distinct from (c->>'expected') then v_bad := v_bad || (c->>'purchase_id') || ' '; end if;
  end loop;
  if length(v_bad) > 0 then
    raise exception 'stock_conflict' using detail = btrim(v_bad), errcode = 'P0001';
  end if;
end $$;

create or replace function public.rl_add_audit(p_owner_id uuid, p_return_id uuid, p_loss_id uuid, p_events jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
declare e jsonb;
begin
  for e in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    insert into public.return_loss_audit_events (owner_id, return_record_id, loss_record_id, event_type, detail, actor)
    values (p_owner_id, p_return_id, p_loss_id, e->>'event_type', coalesce(e->'detail', '{}'::jsonb), e->>'actor');
  end loop;
end $$;

-- Apply an arbitrary column set to a return_records row (only whitelisted
-- keys), + movements + audit + (optional) linked-sale process_status, all
-- atomically, after locking the row and asserting ownership + not-deleted.
create or replace function public.rl_apply_return_transition(
  p_owner_id uuid, p_return_id uuid, p_updates jsonb, p_movements jsonb,
  p_stock_checks jsonb, p_sale_process_status text, p_audit jsonb,
  p_expect_not_applied text  -- 'completed' | 'cancelled' | '' — the flag that must currently be false
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v_rec public.return_records;
begin
  select * into v_rec from public.return_records
    where id = p_return_id and owner_id = p_owner_id and deleted_at is null
    for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;

  if p_expect_not_applied = 'completed' and v_rec.completed_applied then
    return jsonb_build_object('record', to_jsonb(v_rec), 'already_applied', true);
  end if;
  if p_expect_not_applied = 'cancelled' and v_rec.cancelled_applied then
    return jsonb_build_object('record', to_jsonb(v_rec), 'already_applied', true);
  end if;

  perform public.rl_assert_stock(p_stock_checks);
  perform public.rl_apply_movements(p_owner_id, p_movements, p_audit->0->>'actor');

  update public.return_records set
    workflow_status       = coalesce(p_updates->>'workflow_status', workflow_status),
    outcome               = case when p_updates ? 'outcome' then nullif(p_updates->>'outcome','') else outcome end,
    started_on            = coalesce((p_updates->>'started_on')::date, started_on),
    started_precision     = coalesce(p_updates->>'started_precision', started_precision),
    item_sent_on          = case when p_updates ? 'item_sent_on' then (p_updates->>'item_sent_on')::date else item_sent_on end,
    item_sent_precision   = case when p_updates ? 'item_sent_precision' then p_updates->>'item_sent_precision' else item_sent_precision end,
    delivered_on          = case when p_updates ? 'delivered_on' then (p_updates->>'delivered_on')::date else delivered_on end,
    delivered_precision   = case when p_updates ? 'delivered_precision' then p_updates->>'delivered_precision' else delivered_precision end,
    completed_on          = case when p_updates ? 'completed_on' then (p_updates->>'completed_on')::date else completed_on end,
    completed_precision   = case when p_updates ? 'completed_precision' then p_updates->>'completed_precision' else completed_precision end,
    recognition_month     = case when p_updates ? 'recognition_month' then nullif(p_updates->>'recognition_month','') else recognition_month end,
    quantity              = coalesce((p_updates->>'quantity')::int, quantity),
    sale_item_ids         = case when p_updates ? 'sale_item_ids'
                              then coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_updates->'sale_item_ids') x), '{}')
                              else sale_item_ids end,
    sales_order_id        = coalesce((p_updates->>'sales_order_id')::uuid, sales_order_id),
    revenue_reversed      = coalesce((p_updates->>'revenue_reversed')::numeric, revenue_reversed),
    profit_reversed       = coalesce((p_updates->>'profit_reversed')::numeric, profit_reversed),
    original_sale_revenue = coalesce((p_updates->>'original_sale_revenue')::numeric, original_sale_revenue),
    original_sale_profit  = coalesce((p_updates->>'original_sale_profit')::numeric, original_sale_profit),
    original_stock_cost   = coalesce((p_updates->>'original_stock_cost')::numeric, original_stock_cost),
    inventory_write_off   = coalesce((p_updates->>'inventory_write_off')::numeric, inventory_write_off),
    stock_value_restored  = coalesce((p_updates->>'stock_value_restored')::numeric, stock_value_restored),
    net_profit_impact     = coalesce((p_updates->>'net_profit_impact')::numeric, net_profit_impact),
    refund_amount         = coalesce((p_updates->>'refund_amount')::numeric, refund_amount),
    partial_refund_amount = case when p_updates ? 'partial_refund_amount' then nullif(p_updates->>'partial_refund_amount','')::numeric else partial_refund_amount end,
    return_postage        = coalesce((p_updates->>'return_postage')::numeric, return_postage),
    unrecovered_costs     = coalesce((p_updates->>'unrecovered_costs')::numeric, unrecovered_costs),
    other_costs           = coalesce((p_updates->>'other_costs')::numeric, other_costs),
    restock_purchase_ids  = case when p_updates ? 'restock_purchase_ids'
                              then coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_updates->'restock_purchase_ids') x), '{}')
                              else restock_purchase_ids end,
    prev_process_status   = coalesce(p_updates->>'prev_process_status', prev_process_status),
    completed_applied     = coalesce((p_updates->>'completed_applied')::boolean, completed_applied),
    cancelled_applied     = coalesce((p_updates->>'cancelled_applied')::boolean, cancelled_applied),
    reversed_movement_gen = coalesce((p_updates->>'reversed_movement_gen')::int, reversed_movement_gen),
    deleted_at            = case when p_updates ? 'deleted_at' then (p_updates->>'deleted_at')::timestamptz else deleted_at end,
    deleted_by            = case when p_updates ? 'deleted_by' then p_updates->>'deleted_by' else deleted_by end,
    notes                 = case when p_updates ? 'notes' then p_updates->>'notes' else notes end,
    updated_at            = now()
  where id = p_return_id
  returning * into v_rec;

  if p_sale_process_status is not null and p_sale_process_status <> '' then
    update public.sales_orders set process_status = p_sale_process_status, updated_at = now()
      where id = v_rec.sales_order_id and owner_id = p_owner_id;
  end if;

  perform public.rl_add_audit(p_owner_id, p_return_id, null, p_audit);
  return jsonb_build_object('record', to_jsonb(v_rec), 'already_applied', false);
end $$;

-- Return: create + link the sale + move it to return_in_process + audit,
-- atomically. p_return carries every column value the app computed, including
-- the historical figures of the exact selected units (original_sale_revenue /
-- original_sale_profit / original_stock_cost) and the PROVISIONAL full
-- reversal (revenue_reversed / profit_reversed) + net_profit_impact — so an
-- active return's stored accounting is authoritative from 'return_started'
-- onward. Any of those keys omitted defaults to 0 (older callers unaffected).
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

-- Loss: create-and-apply, edit, or reverse (delete) — one atomic call.
-- p_loss_row is the full desired row on create (id absent) or the update set
-- on edit; p_loss_id is null on create.
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

-- ============================================================================
-- rl_purge_deletable_sale — permanent deletion of an ALREADY-CANCELLED sale
-- together with its safely-inactive return history, atomically.
--
--   * A sale that is still financially 'completed' is refused (cancel it
--     first — that path owns the stock decision).
--   * A genuinely ACTIVE return (logged, not cancelled, not soft-deleted) is
--     refused: it still owns accounting + stock transitions for the sale.
--   * A genuinely ACTIVE (not soft-deleted) loss is refused for the same
--     reason.
--   * The remaining returns are all 'return_cancelled' or soft-deleted — both
--     had their ledger reversed to net zero by their own routes — so this
--     removes them (and their audit trail via ON DELETE CASCADE, and their
--     net-zero inventory_movements) as part of the same transaction, then
--     deletes the sale (sale_items cascade). Any soft-deleted loss still
--     pointing at the sale is DETACHED (sales_order_id -> null), never
--     deleted, preserving it as immutable history.
--
-- No active financial effect is ever silently dropped; FK integrity is kept
-- (inventory_movements.*_fkey stay RESTRICT — the RESTRICT rows are removed
-- explicitly, in dependency order, inside the txn).
-- ============================================================================
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

-- ============================================================================
-- FUNCTION EXECUTION LOCKDOWN — for every one of the functions this
-- migration defines:
--   1. REVOKE EXECUTE from PUBLIC (this removes the DEFAULT grant), and
--   2. REVOKE EXECUTE from anon / authenticated when those roles exist, and
--   3. explicitly GRANT EXECUTE to service_role when it exists.
--
-- Step 3 is NOT optional. A newly created function's only EXECUTE grant is to
-- PUBLIC; anon, authenticated AND service_role all reach it only by INHERITING
-- that PUBLIC grant. `revoke ... from public` therefore also removes
-- service_role's ability to run the function unless service_role holds its own
-- explicit grant. Supabase's default privileges usually add one, but that is
-- environment-dependent and must not be relied on — the server (PostgREST with
-- the service key -> SET ROLE service_role) calls every rl_* / next_return_
-- loss_reference RPC, so we grant it back here, explicitly and idempotently.
--
-- Guarded-literal style, matching supabase-sales-v2.sql / supabase-listing-
-- studio.sql. No dynamic SQL. Idempotent: re-revoking an absent grant and
-- re-granting an existing one are both no-ops. postgres (object owner) always
-- retains EXECUTE regardless and is never named.
-- ============================================================================
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
    grant execute on function public.rl_purge_deletable_sale(uuid, uuid[]) to service_role;
  end if;
end $$;

commit;

-- ============================================================================
-- ROLLBACK (manual only — never run once real records exist)
-- ============================================================================
--   drop trigger if exists return_records_touch_updated_at on public.return_records;
--   drop trigger if exists loss_records_touch_updated_at on public.loss_records;
--   drop function if exists public.rl_touch_updated_at();
--   drop function if exists public.rl_apply_movements(uuid, jsonb, text);
--   drop function if exists public.rl_assert_stock(jsonb);
--   drop function if exists public.rl_add_audit(uuid, uuid, uuid, jsonb);
--   drop function if exists public.rl_purge_deletable_sale(uuid, uuid[]);
--   drop function if exists public.rl_apply_return_transition(uuid, uuid, jsonb, jsonb, jsonb, text, jsonb, text);
--   drop function if exists public.rl_create_return(uuid, jsonb, text, jsonb);
--   drop function if exists public.rl_apply_loss_transition(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text);
--   drop function if exists public.next_return_loss_reference(uuid, text);
--   drop table if exists public.return_loss_counters;
--   drop table if exists public.return_loss_audit_events;
--   drop table if exists public.inventory_movements;
--   drop table if exists public.loss_records;
--   drop table if exists public.return_records;
