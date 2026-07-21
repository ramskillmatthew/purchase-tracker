-- Idempotent migration replacing the date-span heuristic with deterministic,
-- resumable UID-cursor pagination for email index sync. A historical range
-- is marked 'completed' only once every folder's matching UID list — as of
-- a FROZEN per-run snapshot high-water UID captured when the run first
-- began — has been proven exhausted. 'partial' means real progress was
-- made and a cursor (including each folder's frozen high-water UID) is
-- saved for the next run to continue from; there is no message-count cap
-- that stands in for proof of completeness. A range covering "today" is
-- never marked completed at all — its high-water UID is re-captured fresh
-- on every pass, so mail arriving later the same day is picked up
-- incrementally rather than being permanently missed once an earlier pass
-- that day looked "done".
--
-- Safe to run more than once. The original design (before this migration)
-- inserted a new email_index_coverage row on every sync attempt instead of
-- reusing one, so duplicate (owner_id, range_start, range_end) rows may
-- already exist in this database — this migration consolidates them before
-- adding a uniqueness guarantee, rather than assuming a clean slate.

alter table public.email_index_coverage
  add column if not exists continuation_cursor jsonb;

alter table public.email_index_coverage
  drop constraint if exists email_index_coverage_status_check;
alter table public.email_index_coverage
  add constraint email_index_coverage_status_check
  check (status in ('running', 'completed', 'failed', 'partial'));

-- Any row still 'running' at migration time is presumed abandoned, not a
-- live process — this migration is run manually while nothing should be
-- concurrently syncing. Resetting it first means a stale 'running' leftover
-- can never outrank a genuinely useful 'completed' or 'partial' row below,
-- and never survives to violate the "one running row per owner" mutex
-- index from supabase-email-index-sync-lock.sql.
update public.email_index_coverage
  set status = 'failed', completed_at = coalesce(completed_at, now()), safe_error = 'Reset during schema migration.'
  where status = 'running';

-- Consolidate duplicate rows left behind by the earlier one-row-per-attempt
-- design, before the uniqueness guarantee below can be added. Exactly one
-- row survives per (owner_id, range_start, range_end):
--   1. 'completed' outranks everything — it is proven authoritative.
--   2. 'partial' outranks 'failed' — it carries real, resumable progress
--      (including continuation_cursor), which a bare failure record does not.
--   3. Within the same tier, the most recently active row wins (by
--      completed_at, falling back to created_at), so an older partial row's
--      cursor is never chosen over a newer, more-advanced one.
-- This only deletes rows that already lost to a clear winner under this
-- ordering; it never discards the row this migration would itself pick.
with ranked as (
  select id,
    row_number() over (
      partition by owner_id, range_start, range_end
      order by
        case status when 'completed' then 3 when 'partial' then 2 else 1 end desc,
        coalesce(completed_at, created_at) desc
    ) as rank
  from public.email_index_coverage
)
delete from public.email_index_coverage
where id in (select id from ranked where rank > 1);

-- Ensures repeated attempts at the exact same [range_start, range_end]
-- window update the one authoritative row for that window (transitioning
-- partial/failed -> running -> partial/completed) instead of accumulating a
-- new row per pass, so there is never more than one checkpoint to resume
-- from and never an ambiguous choice between several stale ones. Safe to
-- add now that duplicates have been consolidated above; safe to re-run
-- since it only adds the constraint if not already present.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'email_index_coverage_owner_range_unique') then
    alter table public.email_index_coverage
      add constraint email_index_coverage_owner_range_unique unique (owner_id, range_start, range_end);
  end if;
end $$;
