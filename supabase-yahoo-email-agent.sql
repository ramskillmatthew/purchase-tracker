-- Idempotent Yahoo Mail / Vinted assistant migration. Run after the existing purchase migrations.
create extension if not exists pgcrypto;

create table if not exists public.yahoo_sync_history (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, sync_type text not null check (sync_type in ('date_range','incremental')),
  range_start date, range_end date, status text not null check (status in ('running','completed','failed')), messages_scanned integer not null default 0,
  candidates_parsed integer not null default 0, safe_error text, created_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists public.vinted_import_candidates (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, sync_id uuid references public.yahoo_sync_history(id) on delete set null,
  yahoo_message_id text not null, email_date timestamptz not null, sender text not null, subject text not null, order_reference text,
  item_title text, seller_name text, item_size text, price_paid numeric(10,2), purchase_date date, dispatch_status text, delivery_status text,
  cancellation_refund_status text, parser_confidence numeric(4,3) not null check (parser_confidence between 0 and 1), fingerprint text not null,
  sanitized_excerpt text, import_status text not null default 'pending' check (import_status in ('pending','imported','rejected')),
  imported_purchase_id uuid, imported_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists vinted_candidates_message_unique on public.vinted_import_candidates(yahoo_message_id);
create index if not exists vinted_candidates_reference_idx on public.vinted_import_candidates(order_reference) where order_reference is not null;
create index if not exists vinted_candidates_fingerprint_idx on public.vinted_import_candidates(fingerprint);
create index if not exists vinted_candidates_owner_date_idx on public.vinted_import_candidates(owner_id, email_date desc);
alter table public.vinted_import_candidates add column if not exists purchased_from text;
alter table public.vinted_import_candidates add column if not exists candidate_type text not null default 'vinted' check (candidate_type in ('vinted','general'));
alter table public.vinted_import_candidates add column if not exists uncertainty_reasons text[] not null default '{}';
alter table public.purchases alter column sku drop not null;

alter table public.purchases add column if not exists vinted_candidate_id uuid;
alter table public.purchases add column if not exists vinted_order_reference text;
alter table public.purchases add column if not exists vinted_fingerprint text;
create unique index if not exists purchases_vinted_candidate_unique on public.purchases(vinted_candidate_id) where vinted_candidate_id is not null;
create unique index if not exists purchases_vinted_reference_unique on public.purchases(vinted_order_reference) where vinted_order_reference is not null;
create unique index if not exists purchases_vinted_fingerprint_unique on public.purchases(vinted_fingerprint) where vinted_fingerprint is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vinted_candidate_purchase_fk') then
    alter table public.vinted_import_candidates add constraint vinted_candidate_purchase_fk foreign key (imported_purchase_id) references public.purchases(id) on delete set null;
  end if;
end $$;

create table if not exists public.assistant_action_audit (
  id bigint generated always as identity primary key, owner_id uuid not null, action text not null,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists assistant_audit_owner_date_idx on public.assistant_action_audit(owner_id, created_at desc);
create table if not exists public.assistant_rate_limits (
  id bigint generated always as identity primary key, owner_id uuid not null, action text not null, created_at timestamptz not null default now()
);
create index if not exists assistant_rate_owner_action_idx on public.assistant_rate_limits(owner_id, action, created_at desc);

alter table public.yahoo_sync_history enable row level security;
alter table public.vinted_import_candidates enable row level security;
alter table public.assistant_action_audit enable row level security;
alter table public.assistant_rate_limits enable row level security;

-- The application accesses these tables only from owner-authorized server routes using the service role.
revoke all on public.yahoo_sync_history, public.vinted_import_candidates, public.assistant_action_audit, public.assistant_rate_limits from anon, authenticated;

-- Privacy-first mailbox index. This deliberately stores no message body, HTML,
-- attachment content, app password, or Anthropic response.
create table if not exists public.email_metadata_index (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  message_fingerprint text not null,
  folder text not null,
  yahoo_uid bigint not null,
  uid_validity text not null,
  sender_name text,
  sender_address text,
  subject text not null,
  email_date timestamptz not null,
  email_type text not null default 'other' check (email_type in ('confirmation','sold','shipping','delivery','cancellation','refund','other')),
  entity_name text,
  order_reference text,
  amount numeric(12,2),
  currency text,
  unread boolean not null default false,
  has_attachments boolean not null default false,
  indexed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, message_fingerprint)
);
create index if not exists email_metadata_owner_date_idx on public.email_metadata_index(owner_id, email_date desc);
create index if not exists email_metadata_owner_type_date_idx on public.email_metadata_index(owner_id, email_type, email_date desc);
create index if not exists email_metadata_owner_entity_idx on public.email_metadata_index(owner_id, lower(entity_name));

create table if not exists public.email_index_coverage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  range_start date not null,
  range_end date not null,
  status text not null check (status in ('running','completed','failed')),
  messages_indexed integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  safe_error text
);
create index if not exists email_coverage_owner_range_idx on public.email_index_coverage(owner_id, range_start, range_end);

alter table public.email_metadata_index enable row level security;
alter table public.email_index_coverage enable row level security;
revoke all on public.email_metadata_index, public.email_index_coverage from anon, authenticated;
