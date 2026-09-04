-- Listings Review — corrective pass (fourth real Seller Hub Feed
-- submission audit: making Retry a single, genuinely atomic transaction).
-- ADDITIVE ONLY — nothing here drops, renames, or narrows any existing
-- column, index, table, or function; every statement is idempotent
-- (`create or replace` / `if not exists`), matching every other
-- supabase-*.sql file's own convention. NOT applied as part of the
-- corrective pass that wrote this file.
--
-- BACKGROUND: the confirmed root cause of the real "Retry returns to
-- Queued forever" symptom was a CLIENT-side bug (the browser's own poll
-- loop never re-included a previously-dismissed batch — see
-- ListingsReviewWorkspace.tsx's own corrective-pass fix), not a database
-- atomicity failure — the existing two-step "PATCH the batch, then PATCH
-- its items" sequence in lib/listing-studio/ebay-feed/feed-batches.ts's
-- own retryEbayFeedBatch DID correctly transition both rows in this
-- specific real case. It is, however, genuinely NOT atomic across the two
-- separate REST calls: a network fault between the two PATCHes could in
-- principle leave the parent reset but its items still 'failed' (or vice
-- versa) — a real, if rare, gap this migration closes properly, exactly
-- as Phase 3's own invariant demands: "Every transition must either
-- complete fully or fail without leaving a half-updated state."
--
-- This RPC does NOT itself decide which remote-reconciliation branch to
-- resume into (the "does eBay already have a record of this task"
-- decision) — that still requires a real, read-only getFeedTask network
-- call, which cannot happen inside a Postgres function. The application
-- layer performs that reconciliation FIRST (exactly as
-- retryEbayFeedBatch already does today), then calls this RPC with the
-- already-decided target status. This RPC's own contract is purely "make
-- the parent+child state transition atomic, correct, and safe to call
-- twice" — never "decide whether it's safe to retry a live remote task".
create or replace function public.listing_studio_retry_ebay_feed_batch(
  p_owner_id uuid,
  p_batch_id uuid,
  p_resume_status text
)
returns table (
  batch_id uuid, status text, attempt_count integer, ebay_task_id text, listing_count integer
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_batch record;
begin
  -- Only ever a status this application's own pipeline can legitimately
  -- resume into after a real Retry — never an arbitrary caller-supplied
  -- value. 'queued' = nothing ever reached eBay, full fresh restart;
  -- 'processing' = a real remote task exists and is still in progress
  -- (never re-upload); 'downloading_result' = eBay already finished
  -- processing the task remotely (never re-create, never re-upload).
  if p_resume_status not in ('queued', 'processing', 'downloading_result') then
    raise exception 'INVALID_RESUME_STATUS' using errcode = 'P0001';
  end if;

  -- Row-locked for the duration of this transaction — the same
  -- concurrency guarantee a claim's own `for update skip locked` gives
  -- the background worker, applied here to a user-triggered Retry
  -- instead. A concurrent SECOND Retry call for the same batch simply
  -- waits for this transaction to commit, then finds status no longer
  -- 'failed'/'completed_with_errors' and raises NOT_RETRYABLE — a clean,
  -- catchable rejection, never a torn or duplicated state (REQUIREMENT:
  -- idempotent against duplicate Retry clicks; protected from
  -- concurrency).
  select * into v_batch
  from public.ebay_feed_batches
  where id = p_batch_id and owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Only a batch that actually reached a real terminal failure is
  -- retryable — never a batch still genuinely in flight (that would
  -- silently steal/corrupt work a live worker might still be doing).
  if v_batch.status not in ('failed', 'completed_with_errors') then
    raise exception 'NOT_RETRYABLE' using errcode = 'P0003';
  end if;

  -- REQUIREMENT: preserve succeeded children — never touched (this
  -- UPDATE's own WHERE clause only ever matches status = 'failed').
  -- Items resume to 'queued' only when nothing ever reached eBay
  -- (p_resume_status = 'queued'); otherwise to 'uploaded' — they DID
  -- already reach eBay before the batch failed, so they must never be
  -- reported as if the upload itself still needs to happen.
  update public.ebay_feed_batch_items
  set status = case when p_resume_status = 'queued' then 'queued' else 'uploaded' end,
      error_code = null,
      error_message = null,
      completed_at = null
  where batch_id = p_batch_id
    and status = 'failed';

  -- REQUIREMENT: parent cannot retain terminal timestamps while being
  -- queued (completed_at cleared); claim/lease fields cleared so the
  -- very next claim (whether the caller's own immediate process-tick
  -- drive, or the background worker) can pick this batch straight back
  -- up; attempt_count is left untouched here on purpose — the claim RPC
  -- itself increments it exactly once per real claim, so retrying does
  -- not double-count an attempt that hasn't happened yet.
  update public.ebay_feed_batches
  set status = p_resume_status,
      error_code = null,
      error_message = null,
      completed_at = null,
      claimed_at = null,
      lease_expires_at = null,
      claimed_by = null
  where id = p_batch_id;

  return query
  select b.id, b.status, b.attempt_count, b.ebay_task_id, b.listing_count
  from public.ebay_feed_batches b
  where b.id = p_batch_id;
end;
$$;

revoke all on function public.listing_studio_retry_ebay_feed_batch(uuid, uuid, text) from public;

-- ============================================================================
-- FUNCTION EXECUTION LOCKDOWN — identical pattern to every other function
-- in supabase-ebay-feed-drafts.sql's own "FUNCTION EXECUTION LOCKDOWN"
-- section: explicit revoke from anon/authenticated, explicit grant to
-- service_role only. This application's server-side code (the only
-- caller) always authenticates to Supabase with the service-role key —
-- anon/authenticated must never be able to call this directly, since it
-- takes only an owner_id and never independently verifies the caller IS
-- that owner (that check belongs to this application's own auth layer,
-- exactly like every other RPC here).
-- ============================================================================
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.listing_studio_retry_ebay_feed_batch(uuid, uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.listing_studio_retry_ebay_feed_batch(uuid, uuid, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.listing_studio_retry_ebay_feed_batch(uuid, uuid, text) to service_role;
  end if;
end $$;

-- ============================================================================
-- READ-ONLY PERMISSION VERIFIER — run this manually in the Supabase SQL
-- editor AFTER applying the migration above (never as part of it) to
-- confirm the exact grant state before this function is ever called from
-- application code. Expected result: exactly one row, with
-- service_role = true and anon = false and authenticated = false.
-- ============================================================================
-- select
--   has_function_privilege('anon', 'public.listing_studio_retry_ebay_feed_batch(uuid, uuid, text)', 'EXECUTE') as anon,
--   has_function_privilege('authenticated', 'public.listing_studio_retry_ebay_feed_batch(uuid, uuid, text)', 'EXECUTE') as authenticated,
--   has_function_privilege('service_role', 'public.listing_studio_retry_ebay_feed_batch(uuid, uuid, text)', 'EXECUTE') as service_role;
