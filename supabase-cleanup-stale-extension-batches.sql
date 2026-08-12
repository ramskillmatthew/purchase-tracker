-- ============================================================================
-- ONE-TIME CLEANUP — stale historical vinted_extension_batches rows
-- ============================================================================
-- This is NOT part of the reusable schema setup (supabase-listing-studio.sql)
-- and is deliberately kept in its own file: it targets 17 EXACT, confirmed
-- immutable batch IDs, not a general rule, and user-specific/incident-
-- specific UUIDs have no place living permanently in the schema file every
-- fresh install/deploy runs.
--
-- Background: before the multi-batch display-number allocation fix, these
-- 17 rows were left in 'pending_claim' or 'in_progress' with
-- box_dismissed_at still null — they were never genuinely finished by a
-- real extension session, and nothing in the app ever flips a batch's
-- status on its own (see this file's own "why these accumulated" note at
-- the bottom). Because box_dismissed_at was null, they were still counted
-- as "occupied" by the old allocation logic, which is what made new
-- batches jump straight to Batch 2 / Batch 4 instead of continuing
-- sequentially. The allocation bug itself is already fixed in
-- supabase-listing-studio.sql; THIS file only cleans up the specific
-- leftover rows so they stop occupying display numbers and stop showing
-- stale Live Activity filter buttons.
--
-- Semantics mirror the app's own existing cancellation route EXACTLY
-- (app/api/listing-studio/extension-batches/[batchId]/route.ts's DELETE
-- handler):
--   - batch: status -> 'cancelled', completed_at = now()
--   - items: ONLY status = 'queued' items -> 'cancelled'. An item already
--     preparing/filling/saving/completed/failed is left EXACTLY as
--     recorded — no real result (a saved Vinted draft id, an error
--     message, a completion timestamp) is ever altered. This matches the
--     cancellation route's own documented reasoning: an item already in
--     flight is the extension's own responsibility to finish or fail,
--     never interrupted by a server-side status flip. Since every one of
--     these 17 batches is already confirmed not genuinely running, no
--     extension will ever act on a "queued" item that gets cancelled here
--     — it is not going anywhere either way.
--
-- Additionally (new, multi-batch-specific — beyond what a plain cancel
-- does today, but required so these rows behave exactly like a normal
-- terminal-box dismissal): both box_dismissed_at and activity_dismissed_at
-- are set in the SAME statement that makes the batch terminal, mirroring
-- the app's own combined terminal-box-dismissal UPDATE (see that route's
-- own comment). This is what actually frees their display numbers and
-- removes any stale "Batch N" Live Activity button.
--
-- Never hard-deletes anything: no batch row, no batch-item row, and no
-- listing_drafts row is ever deleted by this file. Only status/timestamp
-- columns on the 17 named batches (and, only for their still-QUEUED
-- items) are updated.
--
-- Idempotent / safe to run more than once: every UPDATE's WHERE clause
-- re-verifies the row is STILL in its exact pre-cleanup state
-- (status in ('pending_claim','in_progress') and box_dismissed_at is
-- null) before touching it — once cleaned up, a second run of this same
-- file matches zero rows and changes nothing.
--
-- Scope is exact-ID only: every statement below filters by `id in (...)`
-- against the 17 literal UUIDs confirmed stale. This is what guarantees
-- any OTHER batch — including newer ones you were actively testing with
-- (e.g. "Batch 2"/"Batch 4"/"Batch 5") — can never be touched, regardless
-- of what display_number they happen to show; display numbers are never
-- used to select rows anywhere in this file, only immutable ids are.
-- ============================================================================

begin;

-- Step 1 — make each stale batch terminal AND fully dismissed, in one
-- atomic UPDATE per the combined-dismissal semantics above. Gated on the
-- exact state you confirmed (status still pending_claim/in_progress,
-- box_dismissed_at still null) — this single WHERE clause is also what
-- makes the whole file idempotent.
update public.vinted_extension_batches b
set status = 'cancelled',
    completed_at = now(),
    box_dismissed_at = now(),
    activity_dismissed_at = now()
where b.id in (
  'a9d0c220-8eea-4ec9-8981-eb6f551f9125',
  'dfb253e5-f1f2-42b6-939d-8b9b35c1efe4',
  '21ff8827-3fd1-441a-9896-cbae93c1537b',
  '1b0e5093-ab46-4685-8cc8-0632f518675a',
  '62437264-7889-403c-96ee-439f3448bb5c',
  '2145e088-f161-4980-bf94-6c7a5316a8d0',
  'c8647ddc-891f-4d0c-a56a-a73f6391db94',
  '69e57b59-77b7-489b-a6a5-6bb33625ed98',
  '26fe5c90-91a7-45bd-9e20-29dedeb15efd',
  '155045d7-6b2e-4298-8c23-dfb5ddbe6dfe',
  'f85b0138-129c-450e-84c5-f40c02a78de8',
  '5f9f3d12-f8b9-4fff-844a-4bd74d5dfdd8',
  '2d4b26bc-322f-4bde-a8c0-c8f6f8a793a5',
  '16f60d8e-9773-474d-898f-46bc2c883fec',
  '11a586f1-ae91-4313-b383-a1f81024f8b7',
  '540252ce-e11a-4eb4-b9ec-f13be2f1a51c',
  'ae3b3dab-fc79-4530-8c9b-7ed04055fde8'
)
and b.status in ('pending_claim', 'in_progress')
and b.box_dismissed_at is null;

-- Step 2 — mirror the cancellation route's own item-side behaviour
-- exactly: only QUEUED items belonging to these 17 batches are ever
-- touched. This is naturally idempotent on its own (a second run finds no
-- more 'queued' items among them, since they're already 'cancelled').
update public.vinted_extension_batch_items i
set status = 'cancelled'
where i.batch_id in (
  'a9d0c220-8eea-4ec9-8981-eb6f551f9125',
  'dfb253e5-f1f2-42b6-939d-8b9b35c1efe4',
  '21ff8827-3fd1-441a-9896-cbae93c1537b',
  '1b0e5093-ab46-4685-8cc8-0632f518675a',
  '62437264-7889-403c-96ee-439f3448bb5c',
  '2145e088-f161-4980-bf94-6c7a5316a8d0',
  'c8647ddc-891f-4d0c-a56a-a73f6391db94',
  '69e57b59-77b7-489b-a6a5-6bb33625ed98',
  '26fe5c90-91a7-45bd-9e20-29dedeb15efd',
  '155045d7-6b2e-4298-8c23-dfb5ddbe6dfe',
  'f85b0138-129c-450e-84c5-f40c02a78de8',
  '5f9f3d12-f8b9-4fff-844a-4bd74d5dfdd8',
  '2d4b26bc-322f-4bde-a8c0-c8f6f8a793a5',
  '16f60d8e-9773-474d-898f-46bc2c883fec',
  '11a586f1-ae91-4313-b383-a1f81024f8b7',
  '540252ce-e11a-4eb4-b9ec-f13be2f1a51c',
  'ae3b3dab-fc79-4530-8c9b-7ed04055fde8'
)
and i.status = 'queued';

-- Verification — run this (either as part of the same transaction, or
-- separately afterwards) to see the exact end-state of the 17 rows this
-- file targets. On the FIRST run, expect status='cancelled' and all three
-- timestamp columns populated for every row. On a SECOND run, the two
-- UPDATEs above will report 0 rows affected, and this SELECT will show
-- the identical already-cancelled state — proving nothing further
-- changed.
select
  id,
  display_number,
  status,
  box_dismissed_at,
  activity_dismissed_at
from public.vinted_extension_batches
where id in (
  'a9d0c220-8eea-4ec9-8981-eb6f551f9125',
  'dfb253e5-f1f2-42b6-939d-8b9b35c1efe4',
  '21ff8827-3fd1-441a-9896-cbae93c1537b',
  '1b0e5093-ab46-4685-8cc8-0632f518675a',
  '62437264-7889-403c-96ee-439f3448bb5c',
  '2145e088-f161-4980-bf94-6c7a5316a8d0',
  'c8647ddc-891f-4d0c-a56a-a73f6391db94',
  '69e57b59-77b7-489b-a6a5-6bb33625ed98',
  '26fe5c90-91a7-45bd-9e20-29dedeb15efd',
  '155045d7-6b2e-4298-8c23-dfb5ddbe6dfe',
  'f85b0138-129c-450e-84c5-f40c02a78de8',
  '5f9f3d12-f8b9-4fff-844a-4bd74d5dfdd8',
  '2d4b26bc-322f-4bde-a8c0-c8f6f8a793a5',
  '16f60d8e-9773-474d-898f-46bc2c883fec',
  '11a586f1-ae91-4313-b383-a1f81024f8b7',
  '540252ce-e11a-4eb4-b9ec-f13be2f1a51c',
  'ae3b3dab-fc79-4530-8c9b-7ed04055fde8'
)
order by display_number;

commit;

-- ============================================================================
-- Why these accumulated indefinitely (reported per request — no general
-- automatic stale-batch system is added; see the multi-batch feature's own
-- completion report for the explicit scope decision not to build one here)
-- ============================================================================
-- Nothing in this app ever flips a batch's status column on its own except:
--   1. The extension itself, when it genuinely claims/processes/reports on
--      a batch (app/api/extension/claim, .../batch/items/[itemId]/result).
--   2. The owner explicitly cancelling via DELETE
--      .../extension-batches/[batchId] (the "Cancel"/"Cancel batch" button).
--   3. A LAZY expiry check inside the claim route itself: if someone
--      attempts to claim an already-past-expires_at 'pending_claim' batch,
--      that ONE row gets flipped to 'expired' at that moment — but only as
--      a side effect of an actual claim attempt. A pairing code nobody ever
--      tries to reuse simply never triggers this check, so the row can sit
--      in 'pending_claim' forever.
-- There is no periodic sweep anywhere that revisits old rows on its own.
--
-- Can a safe reconciliation rule be derived from existing data? Yes, in
-- principle: every batch's own expires_at (10 minutes from creation,
-- EXTENSION_BATCH_EXPIRY_SECONDS in lib/listing-studio/extension-batch-schema.ts)
-- already hard-blocks the extension from reporting further progress once
-- passed (the item-result route itself returns 410 once
-- now() > expires_at, regardless of batch status) — so a 'pending_claim'
-- or 'in_progress' row whose expires_at is long in the past (say, more
-- than a day) can be trusted as genuinely abandoned without guessing,
-- since the app itself already refuses to let a real extension act on it
-- past that point. That said, per this task's explicit scope: no automatic
-- sweep is implemented here — this file is the one-time, exact-ID cleanup
-- only.
