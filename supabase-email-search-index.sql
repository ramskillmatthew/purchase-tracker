-- Idempotent migration adding typo-tolerant metadata search to the existing
-- privacy-first email index (supabase-yahoo-email-agent.sql). No message
-- body, HTML, or excerpt is added by this migration — search remains
-- limited to sender, subject, and entity metadata already stored in
-- email_metadata_index. Run after supabase-yahoo-email-agent.sql.
create extension if not exists pg_trgm;

alter table public.email_metadata_index
  add column if not exists search_text text
  generated always as (
    coalesce(sender_name, '') || ' ' || coalesce(sender_address, '') || ' ' ||
    subject || ' ' || coalesce(entity_name, '')
  ) stored;

create index if not exists email_metadata_search_trgm_idx
  on public.email_metadata_index using gin (search_text gin_trgm_ops);

-- PostgREST filter query strings cannot express a similarity-ranked ORDER BY,
-- so ranked fuzzy search is exposed as two RPC functions. Both read only the
-- existing metadata-only table; neither touches message bodies.
create or replace function public.search_email_index(
  p_owner_id uuid,
  p_query text default null,
  p_type text default null,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null,
  p_limit int default 25
) returns setof public.email_metadata_index
language sql stable as $$
  select *
  from public.email_metadata_index
  where owner_id = p_owner_id
    and (p_type is null or email_type = p_type)
    and (p_start_at is null or email_date >= p_start_at)
    and (p_end_at is null or email_date < p_end_at)
    and (p_query is null or p_query = '' or search_text % p_query)
  order by
    case when p_query is null or p_query = '' then 0 else similarity(search_text, p_query) end desc,
    email_date desc
  limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.count_email_index(
  p_owner_id uuid,
  p_query text default null,
  p_type text default null,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null
) returns bigint
language sql stable as $$
  select count(*)
  from public.email_metadata_index
  where owner_id = p_owner_id
    and (p_type is null or email_type = p_type)
    and (p_start_at is null or email_date >= p_start_at)
    and (p_end_at is null or email_date < p_end_at)
    and (p_query is null or p_query = '' or search_text % p_query);
$$;

-- Matches the existing table-level revocations: these functions are called
-- only from owner-authorized server routes using the service role.
revoke all on function public.search_email_index from anon, authenticated;
revoke all on function public.count_email_index from anon, authenticated;
