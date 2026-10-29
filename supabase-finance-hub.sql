-- Finance Hub — additive schema (DRAFT; DO NOT APPLY until the feature and
-- migration audit are complete). Existing Sales, Purchases, Expenses and
-- Returns tables are referenced, never replaced.
begin;

create table if not exists public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  provider text not null check (char_length(trim(provider)) between 1 and 100),
  masked_details text,
  opening_balance_pence bigint not null default 0,
  current_balance_pence bigint not null default 0,
  last_reconciled_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists public.finance_cards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  provider text not null check (char_length(trim(provider)) between 1 and 100),
  masked_details text,
  opening_balance_pence bigint not null default 0,
  opening_business_pence bigint not null default 0,
  opening_personal_pence bigint not null default 0,
  current_balance_pence bigint not null default 0,
  business_balance_pence bigint not null default 0,
  personal_balance_pence bigint not null default 0,
  credit_limit_pence bigint not null check (credit_limit_pence >= 0),
  statement_balance_pence bigint not null default 0,
  statement_date date,
  payment_due_date date,
  statement_cycle_day smallint check (statement_cycle_day between 1 and 31),
  last_updated_at timestamptz not null default now(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_cards_portions_match check (business_balance_pence + personal_balance_pence = current_balance_pence),
  unique (owner_id, name)
);

create table if not exists public.finance_allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.finance_accounts(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 100),
  balance_pence bigint not null default 0 check (balance_pence >= 0),
  target_pence bigint check (target_pence is null or target_pence >= 0),
  deadline date,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists public.finance_incoming (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  marketplace text not null check (marketplace in ('vinted','ebay','other')),
  source_name text,
  description text not null,
  category text,
  payment_reference text,
  amount_pence bigint not null check (amount_pence >= 0),
  received_pence bigint not null default 0 check (received_pence >= 0),
  refunded_pence bigint not null default 0 check (refunded_pence >= 0),
  confidence text not null default 'confirmed' check (confidence in ('confirmed','estimated')),
  date_kind text not null default 'unknown' check (date_kind in ('exact','range','unknown')),
  expected_date date,
  range_start date,
  range_end date,
  destination_account_id uuid references public.finance_accounts(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','partially_received','received','reversed','cancelled')),
  notes text,
  idempotency_key uuid not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_incoming_date_shape check (
    (date_kind = 'exact' and expected_date is not null and range_start is null and range_end is null)
    or (date_kind = 'range' and expected_date is null and range_start is not null and range_end is not null and range_start <= range_end)
    or (date_kind = 'unknown' and expected_date is null and range_start is null and range_end is null)
  ),
  constraint finance_incoming_totals check (received_pence + refunded_pence <= amount_pence),
  unique (owner_id,idempotency_key)
);

-- Sales remain authoritative in sales_orders. This row stores Finance-only
-- metadata (expected date and partial-refund amount) without copying revenue
-- or workflow status into a second source of truth.
create table if not exists public.finance_sale_payment_details (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  sales_order_id uuid not null references public.sales_orders(id) on delete restrict,
  date_kind text not null default 'unknown' check (date_kind in ('exact','range','unknown')),
  expected_date date,
  range_start date,
  range_end date,
  refunded_pence bigint not null default 0 check (refunded_pence >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, sales_order_id),
  constraint finance_sale_payment_date_shape check (
    (date_kind = 'exact' and expected_date is not null and range_start is null and range_end is null)
    or (date_kind = 'range' and expected_date is null and range_start is not null and range_end is not null and range_start <= range_end)
    or (date_kind = 'unknown' and expected_date is null and range_start is null and range_end is null)
  )
);

create table if not exists public.finance_payouts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  marketplace text not null check (marketplace in ('vinted','ebay','other')),
  expected_pence bigint not null check (expected_pence >= 0),
  received_pence bigint not null check (received_pence >= 0),
  account_id uuid not null references public.finance_accounts(id) on delete restrict,
  received_on date not null,
  payment_reference text,
  variance_explanation text,
  idempotency_key uuid not null,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint finance_payout_variance_reason check (
    expected_pence = received_pence or char_length(trim(coalesce(variance_explanation,''))) > 0
  ),
  unique (owner_id, idempotency_key)
);

create table if not exists public.finance_payout_items (
  owner_id uuid not null references auth.users(id) on delete cascade,
  payout_id uuid not null references public.finance_payouts(id) on delete restrict,
  incoming_id uuid references public.finance_incoming(id) on delete restrict,
  sales_order_id uuid references public.sales_orders(id) on delete restrict,
  expected_pence bigint not null check (expected_pence >= 0),
  id uuid primary key default gen_random_uuid(),
  constraint finance_payout_item_source check ((incoming_id is not null) <> (sales_order_id is not null)),
  unique (payout_id, incoming_id),
  unique (payout_id, sales_order_id)
);

create table if not exists public.finance_planned_outgoings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('stock_purchase','expense','subscription','card_payment','other')),
  description text not null,
  category text,
  payee text,
  payment_reference text,
  total_pence bigint not null check (total_pence >= 0),
  paid_pence bigint not null default 0 check (paid_pence >= 0),
  actual_total_pence bigint check (actual_total_pence is null or actual_total_pence >= 0),
  date_kind text not null check (date_kind in ('exact','range','unknown')),
  due_date date,
  range_start date,
  range_end date,
  status text not null default 'planned' check (status in ('planned','partially_paid','paid','cancelled')),
  preferred_account_id uuid references public.finance_accounts(id) on delete restrict,
  preferred_card_id uuid references public.finance_cards(id) on delete restrict,
  allocation_id uuid references public.finance_allocations(id) on delete restrict,
  recurring_monthly boolean not null default false,
  recurrence_parent_id uuid references public.finance_planned_outgoings(id) on delete restrict,
  planned_payload jsonb not null default '{}'::jsonb,
  actual_payload jsonb,
  converted_purchase_ids uuid[] not null default '{}',
  converted_expense_id uuid references public.expenses(id) on delete restrict,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_outgoing_date_shape check (
    (date_kind = 'exact' and due_date is not null and range_start is null and range_end is null)
    or (date_kind = 'range' and due_date is null and range_start is not null and range_end is not null and range_start <= range_end)
    or (date_kind = 'unknown' and due_date is null and range_start is null and range_end is null)
  ),
  constraint finance_outgoing_preferred_method check (not (preferred_account_id is not null and preferred_card_id is not null))
);

create table if not exists public.finance_payment_parts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  outgoing_id uuid not null references public.finance_planned_outgoings(id) on delete restrict,
  account_id uuid references public.finance_accounts(id) on delete restrict,
  card_id uuid references public.finance_cards(id) on delete restrict,
  amount_pence bigint not null check (amount_pence > 0),
  payment_on date,
  status text not null default 'scheduled' check (status in ('scheduled','paid','cancelled')),
  spend_scope text not null default 'business' check (spend_scope in ('business','personal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_payment_part_method check ((account_id is not null) <> (card_id is not null))
);

create table if not exists public.finance_outgoing_payments (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  outgoing_id uuid not null references public.finance_planned_outgoings(id) on delete restrict,
  amount_pence bigint not null check(amount_pence>0), paid_on date not null, idempotency_key uuid not null,
  created_at timestamptz not null default now(), unique(owner_id,idempotency_key)
);

create table if not exists public.finance_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  entry_type text not null check (entry_type in ('opening_balance','incoming','outgoing','transfer','allocation','card_charge','card_refund','card_payment','reconciliation','reversal')),
  amount_pence bigint not null,
  account_id uuid references public.finance_accounts(id) on delete restrict,
  card_id uuid references public.finance_cards(id) on delete restrict,
  counterparty_account_id uuid references public.finance_accounts(id) on delete restrict,
  incoming_id uuid references public.finance_incoming(id) on delete restrict,
  outgoing_id uuid references public.finance_planned_outgoings(id) on delete restrict,
  allocation_id uuid references public.finance_allocations(id) on delete restrict,
  payout_id uuid references public.finance_payouts(id) on delete restrict,
  sales_order_id uuid references public.sales_orders(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete restrict,
  expense_id uuid references public.expenses(id) on delete restrict,
  effective_on date not null,
  reference text,
  reason text,
  business_pence bigint,
  personal_pence bigint,
  statement_date date,
  reverses_entry_id uuid references public.finance_ledger_entries(id) on delete restrict,
  idempotency_key uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key),
  constraint finance_ledger_card_portions check (
    (business_pence is null and personal_pence is null)
    or coalesce(business_pence,0) + coalesce(personal_pence,0) = amount_pence
  )
);

create table if not exists public.finance_allocation_movements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  allocation_id uuid not null references public.finance_allocations(id) on delete restrict,
  other_allocation_id uuid references public.finance_allocations(id) on delete restrict,
  movement_type text not null check (movement_type in ('add','release','move')),
  amount_pence bigint not null check (amount_pence > 0),
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.finance_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null,
  importance text not null default 'normal' check (importance in ('normal','important')),
  title text not null,
  body text,
  due_date date,
  resolved_at timestamptz,
  task_id uuid references public.tasks(id) on delete set null,
  source_type text,
  source_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.finance_attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('incoming','outgoing','planned_outgoing','payout','allocation','account','card','ledger')),
  source_id uuid not null,
  storage_path text not null,
  original_name text not null,
  mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png','image/webp')),
  size_bytes bigint not null check (size_bytes > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.finance_audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  source_type text not null,
  source_id uuid,
  summary text not null,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists finance_incoming_owner_status_idx on public.finance_incoming(owner_id,status,expected_date) where deleted_at is null;
create index if not exists finance_outgoing_owner_status_idx on public.finance_planned_outgoings(owner_id,status,due_date) where deleted_at is null;
create index if not exists finance_ledger_owner_date_idx on public.finance_ledger_entries(owner_id,effective_on desc,created_at desc);
create index if not exists finance_notifications_owner_open_idx on public.finance_notifications(owner_id,due_date,created_at desc) where resolved_at is null;
create index if not exists finance_attachments_source_idx on public.finance_attachments(owner_id,source_type,source_id,created_at);
create index if not exists finance_audit_owner_created_idx on public.finance_audit_events(owner_id,created_at desc);

alter table public.finance_accounts enable row level security;
alter table public.finance_cards enable row level security;
alter table public.finance_allocations enable row level security;
alter table public.finance_incoming enable row level security;
alter table public.finance_sale_payment_details enable row level security;
alter table public.finance_payouts enable row level security;
alter table public.finance_payout_items enable row level security;
alter table public.finance_planned_outgoings enable row level security;
alter table public.finance_payment_parts enable row level security;
alter table public.finance_outgoing_payments enable row level security;
alter table public.finance_ledger_entries enable row level security;
alter table public.finance_allocation_movements enable row level security;
alter table public.finance_notifications enable row level security;
alter table public.finance_attachments enable row level security;
alter table public.finance_audit_events enable row level security;

-- Finance mutations are server-only. The app's trusted service-role routes
-- always include owner_id filters and transactional RPCs will be added before
-- this migration is approved. Direct browser roles receive no table access.
revoke all on public.finance_accounts, public.finance_cards, public.finance_allocations,
  public.finance_incoming, public.finance_sale_payment_details, public.finance_payouts, public.finance_payout_items,
  public.finance_planned_outgoings, public.finance_payment_parts, public.finance_outgoing_payments,
  public.finance_ledger_entries, public.finance_allocation_movements,
  public.finance_notifications, public.finance_attachments,
  public.finance_audit_events from anon, authenticated;

create or replace function public.fh_confirm_marketplace_payout(
  p_owner_id uuid,
  p_sale_ids uuid[],
  p_received_pence bigint,
  p_account_id uuid,
  p_received_on date,
  p_payment_reference text,
  p_variance_explanation text,
  p_idempotency_key uuid,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.finance_payouts;
  v_account public.finance_accounts;
  v_count integer;
  v_marketplace_count integer;
  v_expected bigint;
  v_marketplace text;
  v_payout public.finance_payouts;
begin
  if p_owner_id is null or p_idempotency_key is null then raise exception 'invalid_request'; end if;
  if p_received_pence < 0 then raise exception 'invalid_received_amount'; end if;
  if coalesce(array_length(p_sale_ids,1),0) = 0 then raise exception 'no_sales'; end if;
  if (select count(distinct x) from unnest(p_sale_ids) x) <> array_length(p_sale_ids,1) then raise exception 'duplicate_sales'; end if;

  select * into v_existing from public.finance_payouts where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then return to_jsonb(v_existing); end if;

  select * into v_account from public.finance_accounts where id = p_account_id and owner_id = p_owner_id and archived_at is null for update;
  if not found then raise exception 'account_not_found'; end if;

  select count(*),
         count(distinct case when s.platform = 'vinted' then 'vinted' when s.platform = 'ebay' then 'ebay' else 'other' end),
         coalesce(sum(round(s.total_revenue * 100)::bigint - coalesce(d.refunded_pence,0)),0),
         min(case when s.platform = 'vinted' then 'vinted' when s.platform = 'ebay' then 'ebay' else 'other' end)
    into v_count, v_marketplace_count, v_expected, v_marketplace
  from public.sales_orders s
  left join public.finance_sale_payment_details d on d.owner_id = p_owner_id and d.sales_order_id = s.id
  where s.owner_id = p_owner_id
    and s.id = any(p_sale_ids)
    and s.status = 'completed'
    and s.process_status in ('awaiting_dispatch','sent','delivered_awaiting_payout');
  if v_count <> array_length(p_sale_ids,1) then raise exception 'sale_not_pending'; end if;
  if v_marketplace_count <> 1 then raise exception 'mixed_marketplaces'; end if;
  if v_expected <> p_received_pence and nullif(trim(coalesce(p_variance_explanation,'')),'') is null then raise exception 'variance_explanation_required'; end if;

  insert into public.finance_payouts(owner_id,marketplace,expected_pence,received_pence,account_id,received_on,payment_reference,variance_explanation,idempotency_key)
  values(p_owner_id,v_marketplace,v_expected,p_received_pence,p_account_id,p_received_on,nullif(trim(coalesce(p_payment_reference,'')),''),nullif(trim(coalesce(p_variance_explanation,'')),''),p_idempotency_key)
  returning * into v_payout;

  insert into public.finance_payout_items(owner_id,payout_id,sales_order_id,expected_pence)
  select p_owner_id,v_payout.id,s.id,round(s.total_revenue * 100)::bigint - coalesce(d.refunded_pence,0)
  from public.sales_orders s
  left join public.finance_sale_payment_details d on d.owner_id = p_owner_id and d.sales_order_id = s.id
  where s.owner_id = p_owner_id and s.id = any(p_sale_ids);

  update public.sales_orders set process_status = 'completed', updated_at = now()
  where owner_id = p_owner_id and id = any(p_sale_ids);
  update public.finance_accounts set current_balance_pence = current_balance_pence + p_received_pence, updated_at = now(), last_reconciled_at = coalesce(last_reconciled_at,now())
  where id = p_account_id and owner_id = p_owner_id;

  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,payout_id,effective_on,reference,reason,idempotency_key,metadata)
  values(p_owner_id,'incoming',p_received_pence,p_account_id,v_payout.id,p_received_on,p_payment_reference,p_variance_explanation,p_idempotency_key,jsonb_build_object('sales_order_ids',p_sale_ids,'expected_pence',v_expected));
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,after_state,metadata)
  values(p_owner_id,'marketplace_payout_confirmed','payout',v_payout.id,'Marketplace payout confirmed',to_jsonb(v_payout),jsonb_build_object('actor',p_actor,'sales_order_ids',p_sale_ids,'variance_pence',p_received_pence-v_expected));

  return to_jsonb(v_payout);
end;
$$;

revoke all on function public.fh_confirm_marketplace_payout(uuid,uuid[],bigint,uuid,date,text,text,uuid,text) from public, anon, authenticated;

create or replace function public.fh_create_manual_incoming(p_owner_id uuid,p_payload jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_incoming public.finance_incoming;v_account public.finance_accounts;v_key uuid:=(p_payload->>'idempotencyKey')::uuid;v_confirmed boolean:=(p_payload->>'status'='confirmed');
begin
  select * into v_incoming from public.finance_incoming where owner_id=p_owner_id and idempotency_key=v_key;if found then return jsonb_build_object('incoming',to_jsonb(v_incoming),'idempotent',true);end if;
  if v_confirmed then select * into v_account from public.finance_accounts where id=(p_payload->>'destinationAccountId')::uuid and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'account_not_found';end if;end if;
  insert into public.finance_incoming(owner_id,marketplace,source_name,description,category,payment_reference,amount_pence,received_pence,confidence,date_kind,expected_date,range_start,range_end,destination_account_id,status,notes,idempotency_key)
  values(p_owner_id,p_payload->>'marketplace',p_payload->>'sourceName',p_payload->>'description',p_payload->>'category',nullif(p_payload->>'paymentReference',''),(p_payload->>'amountPence')::bigint,case when v_confirmed then (p_payload->>'amountPence')::bigint else 0 end,case when v_confirmed then 'confirmed' else 'estimated' end,p_payload->>'dateKind',nullif(p_payload->>'expectedDate','')::date,nullif(p_payload->>'rangeStart','')::date,nullif(p_payload->>'rangeEnd','')::date,nullif(p_payload->>'destinationAccountId','')::uuid,case when v_confirmed then 'received' else 'pending' end,nullif(p_payload->>'notes',''),v_key) returning * into v_incoming;
  if v_confirmed then
    update public.finance_accounts set current_balance_pence=current_balance_pence+v_incoming.amount_pence,updated_at=now() where id=v_account.id;
    insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,incoming_id,effective_on,reference,reason,idempotency_key,metadata) values(p_owner_id,'incoming',v_incoming.amount_pence,v_account.id,v_incoming.id,coalesce(v_incoming.expected_date,current_date),v_incoming.payment_reference,v_incoming.notes,v_key,jsonb_build_object('actor',p_actor,'source_name',v_incoming.source_name));
  end if;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,after_state,metadata) values(p_owner_id,case when v_confirmed then 'manual_incoming_received' else 'manual_incoming_planned' end,'incoming',v_incoming.id,'Manual incoming money recorded',to_jsonb(v_incoming),jsonb_build_object('actor',p_actor));
  return jsonb_build_object('incoming',to_jsonb(v_incoming),'idempotent',false);
end $$;
revoke all on function public.fh_create_manual_incoming(uuid,jsonb,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_create_manual_incoming(uuid,jsonb,text) to service_role;end if;end $$;

create or replace function public.fh_receive_manual_incoming(p_owner_id uuid,p_payload jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_incoming public.finance_incoming;v_account public.finance_accounts;v_existing public.finance_ledger_entries;v_amount bigint:=(p_payload->>'receivedPence')::bigint;v_key uuid:=(p_payload->>'idempotencyKey')::uuid;v_new_received bigint;
begin
  select * into v_existing from public.finance_ledger_entries where owner_id=p_owner_id and idempotency_key=v_key;if found then return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',true);end if;
  select * into v_incoming from public.finance_incoming where id=(p_payload->>'incomingId')::uuid and owner_id=p_owner_id and deleted_at is null for update;if not found then raise exception 'incoming_not_found';end if;
  if v_incoming.status in('received','reversed','cancelled') then raise exception 'incoming_not_receivable';end if;
  if v_amount<=0 or v_incoming.received_pence+v_incoming.refunded_pence+v_amount>v_incoming.amount_pence then raise exception 'receipt_exceeds_outstanding';end if;
  select * into v_account from public.finance_accounts where id=(p_payload->>'accountId')::uuid and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'account_not_found';end if;
  v_new_received:=v_incoming.received_pence+v_amount;
  update public.finance_incoming set received_pence=v_new_received,destination_account_id=v_account.id,status=case when v_new_received+refunded_pence=amount_pence then 'received' else 'partially_received' end,payment_reference=coalesce(nullif(p_payload->>'paymentReference',''),payment_reference),notes=coalesce(nullif(p_payload->>'notes',''),notes),updated_at=now() where id=v_incoming.id;
  update public.finance_accounts set current_balance_pence=current_balance_pence+v_amount,updated_at=now() where id=v_account.id;
  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,incoming_id,effective_on,reference,reason,idempotency_key,metadata) values(p_owner_id,'incoming',v_amount,v_account.id,v_incoming.id,(p_payload->>'receivedOn')::date,nullif(p_payload->>'paymentReference',''),nullif(p_payload->>'notes',''),v_key,jsonb_build_object('actor',p_actor,'partial',v_new_received+v_incoming.refunded_pence<v_incoming.amount_pence)) returning * into v_existing;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'manual_incoming_receipt','incoming',v_incoming.id,'Manual incoming payment received',to_jsonb(v_incoming),(select to_jsonb(i) from public.finance_incoming i where i.id=v_incoming.id),jsonb_build_object('actor',p_actor,'received_pence',v_amount,'account_id',v_account.id,'ledger_entry_id',v_existing.id));
  return jsonb_build_object('entry',to_jsonb(v_existing),'status',case when v_new_received+v_incoming.refunded_pence=v_incoming.amount_pence then 'received' else 'partially_received' end,'idempotent',false);
end $$;
revoke all on function public.fh_receive_manual_incoming(uuid,jsonb,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_receive_manual_incoming(uuid,jsonb,text) to service_role;end if;end $$;

create or replace function public.fh_cancel_manual_incoming(p_owner_id uuid,p_incoming_id uuid,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_incoming public.finance_incoming;
begin
  if char_length(trim(coalesce(p_reason,'')))=0 then raise exception 'reason_required';end if;
  select * into v_incoming from public.finance_incoming where id=p_incoming_id and owner_id=p_owner_id and deleted_at is null for update;if not found then raise exception 'incoming_not_found';end if;
  if v_incoming.status in('received','reversed','cancelled') then raise exception 'incoming_not_cancellable';end if;
  update public.finance_incoming set status='cancelled',deleted_at=now(),updated_at=now() where id=v_incoming.id;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'manual_incoming_cancelled','incoming',v_incoming.id,'Pending incoming money removed',to_jsonb(v_incoming),(select to_jsonb(i) from public.finance_incoming i where i.id=v_incoming.id),jsonb_build_object('actor',p_actor,'reason',p_reason));
  return jsonb_build_object('ok',true,'received_pence_retained',v_incoming.received_pence);
end $$;
revoke all on function public.fh_cancel_manual_incoming(uuid,uuid,text,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_cancel_manual_incoming(uuid,uuid,text,text) to service_role;end if;end $$;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function public.fh_confirm_marketplace_payout(uuid,uuid[],bigint,uuid,date,text,text,uuid,text) to service_role;
  end if;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('finance-files','finance-files',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp']) on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists "owner accesses finance files" on storage.objects;
create policy "owner accesses finance files" on storage.objects for all using(bucket_id='finance-files' and (storage.foldername(name))[1]=auth.uid()::text) with check(bucket_id='finance-files' and (storage.foldername(name))[1]=auth.uid()::text);

create or replace function public.fh_create_planned_outgoing(p_owner_id uuid,p_payload jsonb,p_actor text)
returns public.finance_planned_outgoings language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_out public.finance_planned_outgoings; v_parts bigint; v_total bigint := (p_payload->>'totalPence')::bigint; v_method_type text := p_payload->>'preferredMethodType'; v_method_id uuid := nullif(p_payload->>'preferredMethodId','')::uuid;
begin
  if p_owner_id is null or v_total <= 0 then raise exception 'invalid_outgoing'; end if;
  if v_method_type='account' and not exists(select 1 from public.finance_accounts where id=v_method_id and owner_id=p_owner_id and archived_at is null) then raise exception 'payment_method_not_found'; end if;
  if v_method_type='card' and not exists(select 1 from public.finance_cards where id=v_method_id and owner_id=p_owner_id and archived_at is null) then raise exception 'payment_method_not_found'; end if;
  if nullif(p_payload->>'allocationId','') is not null and not exists(select 1 from public.finance_allocations where id=(p_payload->>'allocationId')::uuid and owner_id=p_owner_id and archived_at is null) then raise exception 'allocation_not_found'; end if;
  select coalesce(sum(x.amount_pence),0) into v_parts from jsonb_to_recordset(coalesce(p_payload->'paymentParts','[]'::jsonb)) as x("methodType" text,"methodId" uuid,"amountPence" bigint,"paymentOn" date);
  if v_parts>v_total then raise exception 'payment_parts_exceed_total'; end if;
  if exists(select 1 from jsonb_to_recordset(coalesce(p_payload->'paymentParts','[]'::jsonb)) as x("methodType" text,"methodId" uuid,"amountPence" bigint,"paymentOn" date) where (x."methodType"='account' and not exists(select 1 from public.finance_accounts a where a.id=x."methodId" and a.owner_id=p_owner_id and a.archived_at is null)) or (x."methodType"='card' and not exists(select 1 from public.finance_cards c where c.id=x."methodId" and c.owner_id=p_owner_id and c.archived_at is null))) then raise exception 'payment_method_not_found'; end if;
  insert into public.finance_planned_outgoings(owner_id,kind,description,category,payee,payment_reference,total_pence,date_kind,due_date,range_start,range_end,preferred_account_id,preferred_card_id,allocation_id,recurring_monthly,planned_payload,notes)
  values(p_owner_id,p_payload->>'kind',p_payload->>'description',nullif(p_payload->>'category',''),nullif(p_payload->>'payee',''),nullif(p_payload->>'paymentReference',''),v_total,p_payload->>'dateKind',nullif(p_payload->>'dueDate','')::date,nullif(p_payload->>'rangeStart','')::date,nullif(p_payload->>'rangeEnd','')::date,case when v_method_type='account' then v_method_id end,case when v_method_type='card' then v_method_id end,nullif(p_payload->>'allocationId','')::uuid,coalesce((p_payload->>'recurringMonthly')::boolean,false),jsonb_build_object('purchase',p_payload->'purchase','expense',p_payload->'expense'),nullif(p_payload->>'notes','')) returning * into v_out;
  insert into public.finance_payment_parts(owner_id,outgoing_id,account_id,card_id,amount_pence,payment_on)
  select p_owner_id,v_out.id,case when x."methodType"='account' then x."methodId" end,case when x."methodType"='card' then x."methodId" end,x."amountPence",x."paymentOn" from jsonb_to_recordset(coalesce(p_payload->'paymentParts','[]'::jsonb)) as x("methodType" text,"methodId" uuid,"amountPence" bigint,"paymentOn" date);
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,after_state,metadata) values(p_owner_id,'planned_outgoing_created','planned_outgoing',v_out.id,'Planned outgoing created',to_jsonb(v_out),jsonb_build_object('actor',p_actor));
  return v_out;
end $$;
revoke all on function public.fh_create_planned_outgoing(uuid,jsonb,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_create_planned_outgoing(uuid,jsonb,text) to service_role; end if; end $$;

create or replace function public.fh_pay_planned_outgoing(p_owner_id uuid,p_outgoing_id uuid,p_amount_pence bigint,p_paid_on date,p_finalise boolean,p_parts jsonb,p_actual_purchase jsonb,p_actual_expense jsonb,p_idempotency_key uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_out public.finance_planned_outgoings; v_existing public.finance_outgoing_payments; v_payment public.finance_outgoing_payments; v_parts_total bigint; v_new_paid bigint; v_release bigint:=0; v_payload jsonb; v_quantity integer; v_sku text; v_purchase_ids uuid[] := '{}'; v_expense_id uuid; x record;
begin
  select * into v_existing from public.finance_outgoing_payments where owner_id=p_owner_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('payment',to_jsonb(v_existing),'idempotent',true); end if;
  select * into v_out from public.finance_planned_outgoings where id=p_outgoing_id and owner_id=p_owner_id and deleted_at is null for update;
  if not found then raise exception 'outgoing_not_found'; end if;
  if v_out.status in ('paid','cancelled') then raise exception 'outgoing_not_payable'; end if;
  select coalesce(sum(q."amountPence"),0) into v_parts_total from jsonb_to_recordset(coalesce(p_parts,'[]'::jsonb)) as q("methodType" text,"methodId" uuid,"amountPence" bigint,"paymentOn" date,"spendScope" text);
  if p_amount_pence<=0 or v_parts_total<>p_amount_pence then raise exception 'payment_parts_mismatch'; end if;
  v_new_paid:=v_out.paid_pence+p_amount_pence;if not p_finalise and v_new_paid>v_out.total_pence then raise exception 'payment_exceeds_outstanding';end if;
  for x in select * from jsonb_to_recordset(p_parts) as q("methodType" text,"methodId" uuid,"amountPence" bigint,"paymentOn" date,"spendScope" text) loop
    if x."methodType"='account' then
      update public.finance_accounts set current_balance_pence=current_balance_pence-x."amountPence",updated_at=now() where id=x."methodId" and owner_id=p_owner_id and archived_at is null; if not found then raise exception 'payment_method_not_found'; end if;
      insert into public.finance_payment_parts(owner_id,outgoing_id,account_id,amount_pence,payment_on,status,spend_scope) values(p_owner_id,v_out.id,x."methodId",x."amountPence",coalesce(x."paymentOn",p_paid_on),'paid',x."spendScope");
      insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,outgoing_id,effective_on,idempotency_key,metadata) values(p_owner_id,'outgoing',-x."amountPence",x."methodId",v_out.id,p_paid_on,gen_random_uuid(),jsonb_build_object('spend_scope',x."spendScope"));
    elsif x."methodType"='card' then
      update public.finance_cards set current_balance_pence=current_balance_pence+x."amountPence",business_balance_pence=business_balance_pence+case when x."spendScope"='business' then x."amountPence" else 0 end,personal_balance_pence=personal_balance_pence+case when x."spendScope"='personal' then x."amountPence" else 0 end,statement_balance_pence=statement_balance_pence+case when statement_date is not null and coalesce(x."paymentOn",p_paid_on)<=statement_date then x."amountPence" else 0 end,last_updated_at=now(),updated_at=now() where id=x."methodId" and owner_id=p_owner_id and archived_at is null; if not found then raise exception 'payment_method_not_found'; end if;
      insert into public.finance_payment_parts(owner_id,outgoing_id,card_id,amount_pence,payment_on,status,spend_scope) values(p_owner_id,v_out.id,x."methodId",x."amountPence",coalesce(x."paymentOn",p_paid_on),'paid',x."spendScope");
      insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,card_id,outgoing_id,effective_on,idempotency_key,metadata) values(p_owner_id,'card_charge',x."amountPence",x."methodId",v_out.id,p_paid_on,gen_random_uuid(),jsonb_build_object('spend_scope',x."spendScope"));
    else raise exception 'payment_method_not_found'; end if;
  end loop;
  insert into public.finance_outgoing_payments(owner_id,outgoing_id,amount_pence,paid_on,idempotency_key) values(p_owner_id,v_out.id,p_amount_pence,p_paid_on,p_idempotency_key) returning * into v_payment;
  update public.finance_planned_outgoings set paid_pence=v_new_paid,status=case when p_finalise then 'paid' else 'partially_paid' end,actual_total_pence=case when p_finalise then v_new_paid else null end,actual_payload=case when p_finalise then jsonb_build_object('purchase',p_actual_purchase,'expense',p_actual_expense) else actual_payload end,updated_at=now() where id=v_out.id;
  if v_out.allocation_id is not null then
    select least(balance_pence,p_amount_pence) into v_release from public.finance_allocations where id=v_out.allocation_id and owner_id=p_owner_id and archived_at is null for update;
    if coalesce(v_release,0)>0 then update public.finance_allocations set balance_pence=balance_pence-v_release,updated_at=now() where id=v_out.allocation_id;insert into public.finance_allocation_movements(owner_id,allocation_id,movement_type,amount_pence,reason) values(p_owner_id,v_out.allocation_id,'release',v_release,'Automatically released when linked outgoing was paid');end if;
  end if;
  if p_finalise then
    update public.finance_payment_parts set status='cancelled',updated_at=now() where outgoing_id=v_out.id and status='scheduled';
    if v_out.kind='stock_purchase' then
      v_payload:=coalesce(p_actual_purchase,v_out.planned_payload->'purchase'); if v_payload is null or v_payload='null'::jsonb then raise exception 'actual_details_required'; end if;
      v_quantity:=(v_payload->>'quantity')::integer; perform pg_advisory_xact_lock(2147483000);
      select (coalesce(max(sku::bigint),0)+1)::text into v_sku from public.purchases where sku~'^[0-9]+$';
      with created as (insert into public.purchases(order_date,purchased_from,seller_name,sku,item_description,item_size,quantity,item_condition,category,price_purchased,arrived)
        select p_paid_on,v_payload->>'purchasedFrom',nullif(v_payload->>'sellerName',''),v_sku,v_payload->>'itemDescription',v_payload->>'itemSize',1,v_payload->>'itemCondition',v_payload->>'category',((v_new_paid/v_quantity)+case when g<=v_new_paid%v_quantity then 1 else 0 end)/100.0,case when v_payload->>'arrived' is null then null else (v_payload->>'arrived')::boolean end from generate_series(1,v_quantity) g returning id)
      select array_agg(id) into v_purchase_ids from created;
      update public.finance_planned_outgoings set converted_purchase_ids=v_purchase_ids where id=v_out.id;
    elsif v_out.kind='expense' then
      v_payload:=coalesce(p_actual_expense,v_out.planned_payload->'expense'); if v_payload is null or v_payload='null'::jsonb then raise exception 'actual_details_required'; end if;
      insert into public.expenses(purchase_date,purchased_from,arrived,item_description,cost) values(p_paid_on,v_payload->>'purchasedFrom',case when v_payload->>'arrived' is null then null else (v_payload->>'arrived')::boolean end,v_payload->>'itemDescription',v_new_paid/100.0) returning id into v_expense_id;
      update public.finance_planned_outgoings set converted_expense_id=v_expense_id where id=v_out.id;
    end if;
    if v_out.recurring_monthly and not exists(select 1 from public.finance_planned_outgoings where recurrence_parent_id=v_out.id and deleted_at is null) then
      insert into public.finance_planned_outgoings(owner_id,kind,description,category,payee,payment_reference,total_pence,date_kind,due_date,range_start,range_end,status,preferred_account_id,preferred_card_id,allocation_id,recurring_monthly,recurrence_parent_id,planned_payload,notes)
      values(p_owner_id,v_out.kind,v_out.description,v_out.category,v_out.payee,v_out.payment_reference,v_out.total_pence,v_out.date_kind,case when v_out.due_date is not null then (v_out.due_date+interval '1 month')::date end,case when v_out.range_start is not null then (v_out.range_start+interval '1 month')::date end,case when v_out.range_end is not null then (v_out.range_end+interval '1 month')::date end,'planned',v_out.preferred_account_id,v_out.preferred_card_id,v_out.allocation_id,true,v_out.id,v_out.planned_payload,v_out.notes);
    end if;
  end if;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'planned_outgoing_payment','planned_outgoing',v_out.id,'Planned outgoing payment recorded',to_jsonb(v_out),(select to_jsonb(o) from public.finance_planned_outgoings o where o.id=v_out.id),jsonb_build_object('actor',p_actor,'payment_id',v_payment.id,'allocation_released_pence',v_release,'recurring_created',v_out.recurring_monthly and p_finalise,'finalised',p_finalise,'planned_total_pence',v_out.total_pence,'actual_total_pence',case when p_finalise then v_new_paid else null end));
  return jsonb_build_object('payment',to_jsonb(v_payment),'status',case when p_finalise then 'paid' else 'partially_paid' end,'purchase_ids',to_jsonb(v_purchase_ids),'expense_id',v_expense_id,'idempotent',false);
end $$;

create or replace function public.fh_cancel_planned_outgoing(p_owner_id uuid,p_outgoing_id uuid,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_out public.finance_planned_outgoings;
begin
  if char_length(trim(coalesce(p_reason,'')))=0 then raise exception 'reason_required';end if;
  select * into v_out from public.finance_planned_outgoings where id=p_outgoing_id and owner_id=p_owner_id and deleted_at is null for update;if not found then raise exception 'outgoing_not_found';end if;
  if v_out.paid_pence>0 then raise exception 'paid_outgoing_cannot_be_removed';end if;
  update public.finance_planned_outgoings set status='cancelled',deleted_at=now(),updated_at=now() where id=v_out.id;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'planned_outgoing_cancelled','outgoing',v_out.id,'Planned outgoing removed',to_jsonb(v_out),(select to_jsonb(o) from public.finance_planned_outgoings o where o.id=v_out.id),jsonb_build_object('actor',p_actor,'reason',p_reason));
  return jsonb_build_object('ok',true,'outgoing_id',v_out.id);
end $$;
revoke all on function public.fh_cancel_planned_outgoing(uuid,uuid,text,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_cancel_planned_outgoing(uuid,uuid,text,text) to service_role;end if;end $$;
revoke all on function public.fh_pay_planned_outgoing(uuid,uuid,bigint,date,boolean,jsonb,jsonb,jsonb,uuid,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_pay_planned_outgoing(uuid,uuid,bigint,date,boolean,jsonb,jsonb,jsonb,uuid,text) to service_role; end if; end $$;

create or replace function public.fh_create_allocation(p_owner_id uuid,p_name text,p_account_id uuid,p_starting_pence bigint,p_target_pence bigint,p_deadline date,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_pot public.finance_allocations; v_account_balance bigint; v_reserved bigint;
begin
  if p_starting_pence<0 or p_target_pence<0 then raise exception 'invalid_amount'; end if;
  select current_balance_pence into v_account_balance from public.finance_accounts where id=p_account_id and owner_id=p_owner_id and archived_at is null for update; if not found then raise exception 'account_not_found'; end if;
  select coalesce(sum(balance_pence),0) into v_reserved from public.finance_allocations where owner_id=p_owner_id and account_id=p_account_id and archived_at is null;
  insert into public.finance_allocations(owner_id,account_id,name,balance_pence,target_pence,deadline) values(p_owner_id,p_account_id,trim(p_name),p_starting_pence,p_target_pence,p_deadline) returning * into v_pot;
  if p_starting_pence>0 then insert into public.finance_allocation_movements(owner_id,allocation_id,movement_type,amount_pence,reason) values(p_owner_id,v_pot.id,'add',p_starting_pence,p_reason); end if;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,after_state,metadata) values(p_owner_id,'allocation_created','allocation',v_pot.id,'Allocation pot created',to_jsonb(v_pot),jsonb_build_object('actor',p_actor));
  return jsonb_build_object('allocation',to_jsonb(v_pot),'over_allocated',v_reserved+p_starting_pence>v_account_balance);
end $$;

create or replace function public.fh_move_allocation(p_owner_id uuid,p_type text,p_allocation_id uuid,p_other_allocation_id uuid,p_amount_pence bigint,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_source public.finance_allocations; v_other public.finance_allocations; v_account_balance bigint; v_reserved bigint;
begin
  if p_amount_pence<=0 or p_type not in('add','release','move') then raise exception 'invalid_movement'; end if;
  select * into v_source from public.finance_allocations where id=p_allocation_id and owner_id=p_owner_id and archived_at is null for update; if not found then raise exception 'allocation_not_found'; end if;
  if p_type in('release','move') and v_source.balance_pence<p_amount_pence then raise exception 'insufficient_allocation'; end if;
  if p_type='move' then select * into v_other from public.finance_allocations where id=p_other_allocation_id and owner_id=p_owner_id and archived_at is null for update; if not found then raise exception 'destination_not_found'; end if; if v_other.account_id<>v_source.account_id then raise exception 'different_backing_accounts'; end if; end if;
  update public.finance_allocations set balance_pence=balance_pence+case when p_type='add' then p_amount_pence else -p_amount_pence end,updated_at=now() where id=v_source.id;
  if p_type='move' then update public.finance_allocations set balance_pence=balance_pence+p_amount_pence,updated_at=now() where id=v_other.id; end if;
  insert into public.finance_allocation_movements(owner_id,allocation_id,other_allocation_id,movement_type,amount_pence,reason) values(p_owner_id,v_source.id,case when p_type='move' then v_other.id end,p_type,p_amount_pence,p_reason);
  select current_balance_pence into v_account_balance from public.finance_accounts where id=v_source.account_id;
  select coalesce(sum(balance_pence),0) into v_reserved from public.finance_allocations where owner_id=p_owner_id and account_id=v_source.account_id and archived_at is null;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'allocation_movement','allocation',v_source.id,'Allocation funds changed',to_jsonb(v_source),(select to_jsonb(a) from public.finance_allocations a where a.id=v_source.id),jsonb_build_object('actor',p_actor,'type',p_type,'amount_pence',p_amount_pence,'other_allocation_id',p_other_allocation_id));
  return jsonb_build_object('ok',true,'over_allocated',v_reserved>v_account_balance);
end $$;
create or replace function public.fh_archive_allocation(p_owner_id uuid,p_allocation_id uuid,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_pot public.finance_allocations;begin
  if char_length(trim(coalesce(p_reason,'')))=0 then raise exception 'reason_required';end if;
  select * into v_pot from public.finance_allocations where id=p_allocation_id and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'allocation_not_found';end if;
  if v_pot.balance_pence>0 then insert into public.finance_allocation_movements(owner_id,allocation_id,movement_type,amount_pence,reason) values(p_owner_id,v_pot.id,'release',v_pot.balance_pence,p_reason);end if;
  update public.finance_allocations set balance_pence=0,archived_at=now(),updated_at=now() where id=v_pot.id;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'allocation_archived','allocation',v_pot.id,'Allocation pot closed',to_jsonb(v_pot),(select to_jsonb(a) from public.finance_allocations a where a.id=v_pot.id),jsonb_build_object('actor',p_actor,'reason',p_reason,'released_pence',v_pot.balance_pence));return jsonb_build_object('ok',true,'released_pence',v_pot.balance_pence);end $$;
revoke all on function public.fh_create_allocation(uuid,text,uuid,bigint,bigint,date,text,text) from public,anon,authenticated;
revoke all on function public.fh_move_allocation(uuid,text,uuid,uuid,bigint,text,text) from public,anon,authenticated;
revoke all on function public.fh_archive_allocation(uuid,uuid,text,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_create_allocation(uuid,text,uuid,bigint,bigint,date,text,text) to service_role; grant execute on function public.fh_move_allocation(uuid,text,uuid,uuid,bigint,text,text) to service_role;grant execute on function public.fh_archive_allocation(uuid,uuid,text,text) to service_role; end if; end $$;

create or replace function public.fh_transfer_account(p_owner_id uuid,p_from_id uuid,p_to_id uuid,p_amount_pence bigint,p_effective_on date,p_reference text,p_reason text,p_idempotency_key uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_existing public.finance_ledger_entries; v_from public.finance_accounts; v_to public.finance_accounts;
begin
  select * into v_existing from public.finance_ledger_entries where owner_id=p_owner_id and idempotency_key=p_idempotency_key; if found then return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',true); end if;
  if p_amount_pence<=0 or p_from_id=p_to_id or char_length(trim(coalesce(p_reason,'')))=0 then raise exception 'invalid_transfer'; end if;
  select * into v_from from public.finance_accounts where id=p_from_id and owner_id=p_owner_id and archived_at is null for update; if not found then raise exception 'account_not_found'; end if;
  select * into v_to from public.finance_accounts where id=p_to_id and owner_id=p_owner_id and archived_at is null for update; if not found then raise exception 'account_not_found'; end if;
  update public.finance_accounts set current_balance_pence=current_balance_pence-p_amount_pence,updated_at=now() where id=p_from_id;
  update public.finance_accounts set current_balance_pence=current_balance_pence+p_amount_pence,updated_at=now() where id=p_to_id;
  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,counterparty_account_id,effective_on,reference,reason,idempotency_key,metadata) values(p_owner_id,'transfer',-p_amount_pence,p_from_id,p_to_id,p_effective_on,nullif(trim(coalesce(p_reference,'')),''),p_reason,p_idempotency_key,jsonb_build_object('actor',p_actor)) returning * into v_existing;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'account_transfer','ledger',v_existing.id,'Account transfer completed',jsonb_build_object('from',to_jsonb(v_from),'to',to_jsonb(v_to)),jsonb_build_object('from_balance_pence',v_from.current_balance_pence-p_amount_pence,'to_balance_pence',v_to.current_balance_pence+p_amount_pence),jsonb_build_object('actor',p_actor));
  return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',false);
end $$;

create or replace function public.fh_create_account(p_owner_id uuid,p_name text,p_provider text,p_masked_details text,p_opening_pence bigint,p_actor text)
returns public.finance_accounts language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_account public.finance_accounts;
begin
  insert into public.finance_accounts(owner_id,name,provider,masked_details,opening_balance_pence,current_balance_pence,last_reconciled_at) values(p_owner_id,trim(p_name),trim(p_provider),nullif(trim(coalesce(p_masked_details,'')),''),p_opening_pence,p_opening_pence,now()) returning * into v_account;
  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,effective_on,reason,idempotency_key,metadata) values(p_owner_id,'opening_balance',p_opening_pence,v_account.id,current_date,'Opening balance',gen_random_uuid(),jsonb_build_object('actor',p_actor));
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,after_state,metadata) values(p_owner_id,'account_created','account',v_account.id,'Finance account created',to_jsonb(v_account),jsonb_build_object('actor',p_actor));
  return v_account;
end $$;

create or replace function public.fh_reconcile_account(p_owner_id uuid,p_account_id uuid,p_new_balance_pence bigint,p_effective_on date,p_reason text,p_idempotency_key uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_existing public.finance_ledger_entries; v_account public.finance_accounts; v_difference bigint;
begin
  select * into v_existing from public.finance_ledger_entries where owner_id=p_owner_id and idempotency_key=p_idempotency_key; if found then return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',true); end if;
  if char_length(trim(coalesce(p_reason,'')))=0 then raise exception 'reason_required'; end if;
  select * into v_account from public.finance_accounts where id=p_account_id and owner_id=p_owner_id and archived_at is null for update; if not found then raise exception 'account_not_found'; end if;
  v_difference:=p_new_balance_pence-v_account.current_balance_pence;
  update public.finance_accounts set current_balance_pence=p_new_balance_pence,last_reconciled_at=now(),updated_at=now() where id=p_account_id;
  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,effective_on,reason,idempotency_key,metadata) values(p_owner_id,'reconciliation',v_difference,p_account_id,p_effective_on,p_reason,p_idempotency_key,jsonb_build_object('actor',p_actor,'before_pence',v_account.current_balance_pence,'after_pence',p_new_balance_pence)) returning * into v_existing;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'account_reconciled','account',p_account_id,'Account balance reconciled',to_jsonb(v_account),(select to_jsonb(a) from public.finance_accounts a where a.id=p_account_id),jsonb_build_object('actor',p_actor,'reason',p_reason));
  return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',false);
end $$;
create or replace function public.fh_archive_account(p_owner_id uuid,p_account_id uuid,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_account public.finance_accounts;begin
  if char_length(trim(coalesce(p_reason,'')))=0 then raise exception 'reason_required';end if;select * into v_account from public.finance_accounts where id=p_account_id and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'account_not_found';end if;
  if v_account.current_balance_pence<>0 then raise exception 'account_balance_must_be_zero';end if;if exists(select 1 from public.finance_allocations where account_id=v_account.id and archived_at is null and balance_pence<>0) then raise exception 'account_has_allocations';end if;if exists(select 1 from public.finance_planned_outgoings where preferred_account_id=v_account.id and deleted_at is null and status in('planned','partially_paid')) then raise exception 'account_has_planned_outgoings';end if;
  update public.finance_accounts set archived_at=now(),updated_at=now() where id=v_account.id;insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'account_archived','account',v_account.id,'Finance account closed',to_jsonb(v_account),(select to_jsonb(a) from public.finance_accounts a where a.id=v_account.id),jsonb_build_object('actor',p_actor,'reason',p_reason));return jsonb_build_object('ok',true);end $$;
revoke all on function public.fh_transfer_account(uuid,uuid,uuid,bigint,date,text,text,uuid,text) from public,anon,authenticated;
revoke all on function public.fh_reconcile_account(uuid,uuid,bigint,date,text,uuid,text) from public,anon,authenticated;
revoke all on function public.fh_create_account(uuid,text,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.fh_archive_account(uuid,uuid,text,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_create_account(uuid,text,text,text,bigint,text) to service_role; grant execute on function public.fh_transfer_account(uuid,uuid,uuid,bigint,date,text,text,uuid,text) to service_role; grant execute on function public.fh_reconcile_account(uuid,uuid,bigint,date,text,uuid,text) to service_role;grant execute on function public.fh_archive_account(uuid,uuid,text,text) to service_role; end if; end $$;

create or replace function public.fh_create_card(p_owner_id uuid,p_payload jsonb,p_actor text)
returns public.finance_cards language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_card public.finance_cards; begin
  insert into public.finance_cards(owner_id,name,provider,masked_details,opening_balance_pence,opening_business_pence,opening_personal_pence,current_balance_pence,business_balance_pence,personal_balance_pence,credit_limit_pence,statement_balance_pence,statement_date,payment_due_date,statement_cycle_day)
  values(p_owner_id,p_payload->>'name',p_payload->>'provider',nullif(p_payload->>'maskedDetails',''),(p_payload->>'openingBalancePence')::bigint,(p_payload->>'openingBusinessPence')::bigint,(p_payload->>'openingPersonalPence')::bigint,(p_payload->>'openingBalancePence')::bigint,(p_payload->>'openingBusinessPence')::bigint,(p_payload->>'openingPersonalPence')::bigint,(p_payload->>'creditLimitPence')::bigint,(p_payload->>'statementBalancePence')::bigint,nullif(p_payload->>'statementDate','')::date,nullif(p_payload->>'paymentDueDate','')::date,nullif(p_payload->>'statementCycleDay','')::smallint) returning * into v_card;
  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,card_id,effective_on,business_pence,personal_pence,idempotency_key,metadata) values(p_owner_id,'opening_balance',v_card.current_balance_pence,v_card.id,current_date,v_card.business_balance_pence,v_card.personal_balance_pence,gen_random_uuid(),jsonb_build_object('actor',p_actor));
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,after_state,metadata) values(p_owner_id,'card_created','card',v_card.id,'Credit card added',to_jsonb(v_card),jsonb_build_object('actor',p_actor)); return v_card; end $$;

create or replace function public.fh_update_card(p_owner_id uuid,p_payload jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_card public.finance_cards; v_existing public.finance_ledger_entries; v_key uuid:=(p_payload->>'idempotencyKey')::uuid; v_diff bigint; v_business_diff bigint; v_personal_diff bigint; begin
  select * into v_existing from public.finance_ledger_entries where owner_id=p_owner_id and idempotency_key=v_key;if found then return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',true);end if;
  select * into v_card from public.finance_cards where id=(p_payload->>'cardId')::uuid and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'card_not_found';end if;
  v_diff:=(p_payload->>'currentBalancePence')::bigint-v_card.current_balance_pence;v_business_diff:=(p_payload->>'businessBalancePence')::bigint-v_card.business_balance_pence;v_personal_diff:=(p_payload->>'personalBalancePence')::bigint-v_card.personal_balance_pence;
  update public.finance_cards set current_balance_pence=(p_payload->>'currentBalancePence')::bigint,business_balance_pence=(p_payload->>'businessBalancePence')::bigint,personal_balance_pence=(p_payload->>'personalBalancePence')::bigint,credit_limit_pence=(p_payload->>'creditLimitPence')::bigint,statement_balance_pence=(p_payload->>'statementBalancePence')::bigint,statement_date=nullif(p_payload->>'statementDate','')::date,payment_due_date=nullif(p_payload->>'paymentDueDate','')::date,last_updated_at=now(),updated_at=now() where id=v_card.id;
  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,card_id,effective_on,reason,business_pence,personal_pence,idempotency_key,metadata) values(p_owner_id,'reconciliation',v_diff,v_card.id,current_date,p_payload->>'reason',v_business_diff,v_personal_diff,v_key,jsonb_build_object('actor',p_actor,'before',to_jsonb(v_card))) returning * into v_existing;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'card_reconciled','card',v_card.id,'Credit card balance updated',to_jsonb(v_card),(select to_jsonb(c) from public.finance_cards c where c.id=v_card.id),jsonb_build_object('actor',p_actor,'reason',p_payload->>'reason'));return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',false);end $$;

create or replace function public.fh_pay_card(p_owner_id uuid,p_payload jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_card public.finance_cards;v_account public.finance_accounts;v_existing public.finance_ledger_entries;v_amount bigint:=(p_payload->>'amountPence')::bigint;v_business bigint:=(p_payload->>'businessPence')::bigint;v_personal bigint:=(p_payload->>'personalPence')::bigint;v_key uuid:=(p_payload->>'idempotencyKey')::uuid;begin
  select * into v_existing from public.finance_ledger_entries where owner_id=p_owner_id and idempotency_key=v_key;if found then return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',true);end if;
  select * into v_card from public.finance_cards where id=(p_payload->>'cardId')::uuid and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'card_not_found';end if;select * into v_account from public.finance_accounts where id=(p_payload->>'accountId')::uuid and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'account_not_found';end if;
  update public.finance_accounts set current_balance_pence=current_balance_pence-v_amount,updated_at=now() where id=v_account.id;
  update public.finance_cards set current_balance_pence=current_balance_pence-v_amount,business_balance_pence=business_balance_pence-v_business,personal_balance_pence=personal_balance_pence-v_personal,statement_balance_pence=case when p_payload->>'paymentType'='full_statement' then 0 else statement_balance_pence-v_amount end,last_updated_at=now(),updated_at=now() where id=v_card.id;
  insert into public.finance_ledger_entries(owner_id,entry_type,amount_pence,account_id,card_id,effective_on,idempotency_key,metadata) values(p_owner_id,'card_payment',-v_amount,v_account.id,v_card.id,(p_payload->>'paidOn')::date,v_key,jsonb_build_object('actor',p_actor,'business_pence',v_business,'personal_pence',v_personal,'payment_type',p_payload->>'paymentType')) returning * into v_existing;
  insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'card_payment','card',v_card.id,'Credit card payment completed',jsonb_build_object('card',to_jsonb(v_card),'account',to_jsonb(v_account)),jsonb_build_object('card',(select to_jsonb(c) from public.finance_cards c where c.id=v_card.id),'account',(select to_jsonb(a) from public.finance_accounts a where a.id=v_account.id)),jsonb_build_object('actor',p_actor,'amount_pence',v_amount,'ledger_entry_id',v_existing.id));return jsonb_build_object('entry',to_jsonb(v_existing),'idempotent',false);end $$;
create or replace function public.fh_archive_card(p_owner_id uuid,p_card_id uuid,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$ declare v_card public.finance_cards;begin
  if char_length(trim(coalesce(p_reason,'')))=0 then raise exception 'reason_required';end if;select * into v_card from public.finance_cards where id=p_card_id and owner_id=p_owner_id and archived_at is null for update;if not found then raise exception 'card_not_found';end if;if v_card.current_balance_pence<>0 or v_card.statement_balance_pence<>0 then raise exception 'card_balance_must_be_zero';end if;if exists(select 1 from public.finance_planned_outgoings where preferred_card_id=v_card.id and deleted_at is null and status in('planned','partially_paid')) then raise exception 'card_has_planned_outgoings';end if;
  update public.finance_cards set archived_at=now(),updated_at=now() where id=v_card.id;insert into public.finance_audit_events(owner_id,event_type,source_type,source_id,summary,before_state,after_state,metadata) values(p_owner_id,'card_archived','card',v_card.id,'Credit card closed',to_jsonb(v_card),(select to_jsonb(c) from public.finance_cards c where c.id=v_card.id),jsonb_build_object('actor',p_actor,'reason',p_reason));return jsonb_build_object('ok',true);end $$;
revoke all on function public.fh_create_card(uuid,jsonb,text) from public,anon,authenticated;revoke all on function public.fh_update_card(uuid,jsonb,text) from public,anon,authenticated;revoke all on function public.fh_pay_card(uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.fh_archive_card(uuid,uuid,text,text) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.fh_create_card(uuid,jsonb,text) to service_role;grant execute on function public.fh_update_card(uuid,jsonb,text) to service_role;grant execute on function public.fh_pay_card(uuid,jsonb,text) to service_role;grant execute on function public.fh_archive_card(uuid,uuid,text,text) to service_role;end if;end $$;

commit;
