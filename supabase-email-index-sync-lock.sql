-- Idempotent migration for Phase 3 (automatic incremental indexing).
-- Ensures at most one sync run per owner can be "running" at a time, so a
-- cron tick and a manual "Sync now" click (or two overlapping cron ticks)
-- cannot race and corrupt coverage bookkeeping. Enforced by Postgres, not
-- just application logic, so it holds even under concurrent requests.
create unique index if not exists email_index_coverage_one_running_idx
  on public.email_index_coverage(owner_id) where status = 'running';
