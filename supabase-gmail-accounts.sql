create table if not exists public.email_accounts (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  provider text not null check (provider in ('gmail')), email_address text not null,
  encrypted_refresh_token text not null, status text not null default 'connected' check (status in ('connected','revoked','error')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id, provider, email_address)
);
create index if not exists email_accounts_owner_provider_idx on public.email_accounts(owner_id, provider);
alter table public.email_accounts enable row level security;
revoke all on public.email_accounts from anon, authenticated;
