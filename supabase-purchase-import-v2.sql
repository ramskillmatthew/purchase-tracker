-- Purchase Import v2: multi-item/multi-unit orders, persisted review edits,
-- and transactional order-group import.
--
-- Idempotent — every statement uses `if not exists`/`if exists`/`create or
-- replace`, so it is safe to run more than once. Does NOT run automatically;
-- review and run manually against Supabase when ready. NOT executed by this
-- change.
--
-- Wrapped in one explicit transaction (begin;/commit; below) — every schema
-- change, index change, and function definition in this file either all
-- take effect together or, on any failure, all roll back together. Nothing
-- here is left half-applied.
--

begin;

-- ============================================================================
-- 1. New candidate columns
-- ============================================================================
-- item_index/unit_index: which distinct line item, and which physical unit
--   of that item's quantity, a candidate row represents within one source
--   email. Existing rows default to 0/0 (each pre-existing row already was
--   "the" one item/unit for its email).
alter table public.vinted_import_candidates add column if not exists item_index integer not null default 0;
alter table public.vinted_import_candidates add column if not exists unit_index integer not null default 0;

-- order_total_paid: the complete charged amount for the whole order,
--   duplicated on every row belonging to that order, so the review UI can
--   reconcile "sum of rows" vs "order total" without a second lookup.
alter table public.vinted_import_candidates add column if not exists order_total_paid numeric(10,2);

-- source_provider/source_account: which connected mailbox this candidate
--   came from, for traceability — never exported, never treated as a
--   credential (an email address, not a token).
alter table public.vinted_import_candidates add column if not exists source_provider text check (source_provider in ('yahoo','gmail'));
alter table public.vinted_import_candidates add column if not exists source_account text;

-- item_condition_hint: the parser/AI-extracted condition for this specific
--   row (rows are now per-item, so different items in the same order can
--   have different, or unreliably-known, conditions). Null leaves it blank
--   for manual review, same as every other extracted-but-uncertain field.
alter table public.vinted_import_candidates add column if not exists item_condition_hint text;

-- draft: the reviewer's own in-progress edit, persisted server-side so it
--   survives a page reload or another sync. Null means "no user edit yet -
--   show the parser's own fields." Non-null means "the user has edited this
--   row - the review UI must show these values, and nothing (including a
--   re-sync) may overwrite them without the user re-editing." The sync
--   route never writes to this column, by construction (see the app code),
--   so a re-scan refreshing the parser-owned fields below can never clobber
--   it — this is the "override flag" half of the two options requested;
--   the presence/absence of a value in this column *is* the override flag.
alter table public.vinted_import_candidates add column if not exists draft jsonb;

-- source_item_key: a stable, deterministic identity for one physical item
--   within one source email (see lib/purchase-import/identity.ts) — DISTINCT
--   from order_reference, which stays exactly as extracted with no
--   artificial suffix, since several physical items in one order
--   legitimately share the same order reference. Backfilled below for
--   existing rows using their already-correct item_index/unit_index
--   defaults (0/0), so every pre-existing row gets a valid, unique key with
--   no data loss.
alter table public.vinted_import_candidates add column if not exists source_item_key text;
update public.vinted_import_candidates
  set source_item_key = yahoo_message_id || '::' || item_index || '::' || unit_index
  where source_item_key is null;
alter table public.vinted_import_candidates alter column source_item_key set not null;

-- ============================================================================
-- 2. Candidate uniqueness: replace the one-row-per-email constraint
-- ============================================================================
-- The old constraint assumed one email = one candidate row, which multi-item
-- orders break. source_item_key already encodes email + item + unit, so it
-- alone is both simpler and correct as the uniqueness/upsert-conflict target.
drop index if exists vinted_candidates_message_unique;
create unique index if not exists vinted_candidates_source_item_key_unique on public.vinted_import_candidates(source_item_key);

-- ============================================================================
-- 3. Purchases: replace the order-level uniqueness with item-level uniqueness
-- ============================================================================
-- vinted_order_reference and vinted_fingerprint are computed per ORDER, so
-- every physical-item row from the same multi-item order shares the same
-- value — a UNIQUE constraint on either therefore rejects the second item of
-- any multi-item order. source_item_key is unique per ITEM, which is what
-- duplicate-prevention on this table actually needs to be keyed on.
-- vinted_order_reference/vinted_fingerprint remain as plain (non-unique)
-- columns for traceability/inspection; they are simply no longer the
-- enforcement mechanism.
drop index if exists purchases_vinted_reference_unique;
drop index if exists purchases_vinted_fingerprint_unique;
alter table public.purchases add column if not exists source_item_key text;
update public.purchases p
  set source_item_key = c.source_item_key
  from public.vinted_import_candidates c
  where p.vinted_candidate_id = c.id and p.source_item_key is null;
create unique index if not exists purchases_source_item_key_unique on public.purchases(source_item_key) where source_item_key is not null;
-- purchases_vinted_candidate_unique (on vinted_candidate_id) is unaffected
-- and stays exactly as it was — each candidate row can still only ever
-- produce one purchase row, which remains true and correct.

-- ============================================================================
-- 4. Reconciling duplicate order-confirmation/receipt emails for the same
--    order (a DIFFERENT email, same real-world order — e.g. a duplicate or
--    forwarded copy of the same receipt)
-- ============================================================================
-- source_item_key can't catch this by itself, since two different emails
-- produce two different keys even for the same real order. This is handled
-- in application logic instead (see import_purchase_order below): before
-- inserting, the RPC checks whether a purchase already exists with the same
-- content fingerprint but whose *source candidate* (joined via
-- vinted_candidate_id, not by parsing source_item_key) came from a
-- different email. If so, the whole order group is rejected (not partially
-- imported, not silently imported) so the reviewer can check it by hand.
-- This is a best-effort heuristic, not a proof of non-duplication —
-- documented here rather than silently assumed correct.

-- ============================================================================
-- 5. Transactional, owner-scoped order-group import
-- ============================================================================
-- Called once per order group (all rows sharing one source email), never
-- once per row. A PL/pgSQL function body is one implicit transaction: any
-- exception raised anywhere inside it rolls back every effect of that same
-- call automatically, including earlier iterations of the loops below — so
-- "roll back everything if any row fails" requires no explicit
-- BEGIN/COMMIT/ROLLBACK, just letting an exception propagate. `for update`
-- row locks below prevent two concurrent import attempts on the same
-- candidate from both succeeding.
create or replace function public.import_purchase_order(p_owner_id uuid, p_records jsonb)
returns table(purchase_id uuid, source_item_key text)
language plpgsql
as $$
declare
  v_item jsonb;
  v_candidate public.vinted_import_candidates%rowtype;
  v_new_purchase_id uuid;
  v_message_id text;
  v_submitted_ids uuid[];
  v_total_ids uuid[];
  v_order_total numeric(10,2);
  v_submitted_total_pence numeric;
  v_distinct_totals bigint;
  v_price numeric;
begin
  if p_records is null or jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) = 0 then
    raise exception 'NO_RECORDS' using errcode = 'P0001';
  end if;

  -- Pass 1: validate and lock every candidate in this order group before
  -- inserting anything. Any failure here aborts the whole call with nothing
  -- written — never a partial validation.
  for v_item in select * from jsonb_array_elements(p_records)
  loop
    select * into v_candidate
      from public.vinted_import_candidates
      where id = (v_item->>'candidate_id')::uuid and owner_id = p_owner_id
      for update;

    if not found then
      raise exception 'CANDIDATE_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_candidate.import_status <> 'pending' then
      raise exception 'CANDIDATE_NOT_PENDING' using errcode = 'P0003';
    end if;
    if v_candidate.source_item_key is null then
      raise exception 'CANDIDATE_MISSING_KEY' using errcode = 'P0004';
    end if;

    -- REGRESSION: the app rounds each submitted row individually while this
    -- function's own order-total check rounds only the COMBINED total — a
    -- fractional-penny value (e.g. three decimal places) could therefore
    -- pass one layer's check while disagreeing with the other's. Every
    -- submitted price must be non-negative and an exact whole-penny amount
    -- BEFORE it's used in any total comparison or insert. `numeric` is
    -- exact decimal arithmetic (never floating point), so this comparison
    -- needs no tolerance — a genuine third decimal digit always fails it.
    v_price := (v_item->>'price_purchased')::numeric;
    if v_price is null or v_price < 0 or v_price * 100 <> round(v_price * 100) then
      raise exception 'INVALID_PRICE_PRECISION' using errcode = 'P0009';
    end if;

    -- Duplicate-order safeguard (see section 4 above): a purchase already
    -- exists with this order's fingerprint, inserted from a candidate that
    -- came from a genuinely different source email — found via the
    -- relational join through vinted_candidate_id, never by parsing
    -- source_item_key's own text.
    if v_candidate.fingerprint is not null and exists (
      select 1 from public.purchases p
      join public.vinted_import_candidates c2 on c2.id = p.vinted_candidate_id
      where p.vinted_fingerprint = v_candidate.fingerprint
        and c2.yahoo_message_id is distinct from v_candidate.yahoo_message_id
    ) then
      raise exception 'POSSIBLE_DUPLICATE_ORDER' using errcode = 'P0005';
    end if;
  end loop;

  -- Pass 1.5: every pending, importable (not cancelled/refunded) candidate
  -- sharing a source order (yahoo_message_id) must be submitted together —
  -- never a subset. Importing only some physical items from a multi-item
  -- or multi-unit order would leave siblings permanently stuck pending
  -- while their counterparts are already in `purchases`. `for update` locks
  -- the *entire* sibling set (not just the submitted rows) so a concurrent
  -- request can't change the answer between this check and Pass 2's
  -- inserts. This mirrors (and is authoritative over) the equivalent
  -- client-side and route-level checks — never rely on those alone.
  --
  -- REGRESSION: PostgreSQL forbids `FOR UPDATE` directly on a query with
  -- aggregation (array_agg) — locking clauses require every returned row to
  -- map to one identifiable table row, which an aggregate result does not.
  -- The fix locks the plain, non-aggregated sibling rows first inside the
  -- `locked_siblings` CTE (a normal FOR UPDATE select, one row per table
  -- row), then aggregates those already-locked ids in the separate outer
  -- SELECT below — aggregating over an already-materialized CTE result is
  -- always valid, since no locking clause applies to that outer query.
  for v_message_id in
    select distinct c.yahoo_message_id
    from jsonb_array_elements(p_records) elem
    join public.vinted_import_candidates c on c.id = (elem->>'candidate_id')::uuid
    where c.owner_id = p_owner_id
  loop
    select array_agg((elem->>'candidate_id')::uuid order by (elem->>'candidate_id')::uuid) into v_submitted_ids
      from jsonb_array_elements(p_records) elem
      join public.vinted_import_candidates c on c.id = (elem->>'candidate_id')::uuid
      where c.owner_id = p_owner_id and c.yahoo_message_id = v_message_id;

    with locked_siblings as (
      select id, order_total_paid
      from public.vinted_import_candidates
      where owner_id = p_owner_id and yahoo_message_id = v_message_id
        and import_status = 'pending' and cancellation_refund_status is null
      for update
    )
    select array_agg(id order by id), max(order_total_paid), count(distinct order_total_paid)
      into v_total_ids, v_order_total, v_distinct_totals
      from locked_siblings;

    -- REGRESSION: order_total_paid is meant to be duplicated identically
    -- across every sibling row of one order — max() would silently pick
    -- one value if the siblings ever disagreed (a parser/backfill bug, a
    -- partially-applied edit, etc.), which could then compare cleanly
    -- against a mismatched allocation by coincidence. count(distinct ...)
    -- already ignores nulls, so an all-null sibling set still yields 0
    -- here and falls through to the existing null-total behaviour below.
    if v_distinct_totals > 1 then
      raise exception 'INCONSISTENT_ORDER_TOTAL' using errcode = 'P0008';
    end if;

    if v_submitted_ids is distinct from v_total_ids then
      raise exception 'INCOMPLETE_ORDER_SELECTION' using errcode = 'P0006';
    end if;

    -- Order-total invariant: the reviewer-confirmed prices of every row
    -- being imported for this order must sum to EXACTLY the candidate's own
    -- stored order_total_paid, compared in integer pence (never floating
    -- point) so no fractional-penny rounding artefact can pass. A null
    -- order_total_paid (the order total was never confidently extracted)
    -- is not enforced here — that case stays governed by the existing
    -- review-time rules instead. Prices are never silently altered or
    -- rebalanced to make this pass; a mismatch rejects the whole group.
    if v_order_total is not null then
      select round(sum((elem->>'price_purchased')::numeric) * 100) into v_submitted_total_pence
        from jsonb_array_elements(p_records) elem
        join public.vinted_import_candidates c on c.id = (elem->>'candidate_id')::uuid
        where c.owner_id = p_owner_id and c.yahoo_message_id = v_message_id;

      if v_submitted_total_pence is distinct from round(v_order_total * 100) then
        raise exception 'ORDER_TOTAL_MISMATCH' using errcode = 'P0007';
      end if;
    end if;
  end loop;

  -- Pass 2: every candidate in this call is confirmed pending, owned, a
  -- complete order-group selection, and not a likely duplicate order —
  -- insert and mark imported together.
  for v_item in select * from jsonb_array_elements(p_records)
  loop
    select * into v_candidate
      from public.vinted_import_candidates
      where id = (v_item->>'candidate_id')::uuid and owner_id = p_owner_id
      for update;

    insert into public.purchases (
      order_date, purchased_from, seller_name, sku, item_description, item_size, quantity, item_condition,
      price_purchased, arrived, vinted_candidate_id, vinted_order_reference, vinted_fingerprint, source_item_key
    ) values (
      (v_item->>'order_date')::date,
      v_item->>'purchased_from',
      nullif(v_item->>'seller_name', ''),
      coalesce(v_item->>'sku', ''),
      v_item->>'item_description',
      v_item->>'item_size',
      1,
      v_item->>'item_condition',
      (v_item->>'price_purchased')::numeric,
      case when (v_item ? 'arrived') and v_item->>'arrived' is not null then (v_item->>'arrived')::boolean else null end,
      v_candidate.id, v_candidate.order_reference, v_candidate.fingerprint, v_candidate.source_item_key
    )
    returning id into v_new_purchase_id;

    update public.vinted_import_candidates
      set import_status = 'imported', imported_purchase_id = v_new_purchase_id, imported_at = now(), updated_at = now()
      where id = v_candidate.id;

    purchase_id := v_new_purchase_id;
    source_item_key := v_candidate.source_item_key;
    return next;
  end loop;
end;
$$;

-- Matches the existing table-level access pattern: the application only
-- ever calls this via the service-role key, which is unaffected by these
-- revokes. anon/authenticated are explicitly denied direct execution.
revoke all on function public.import_purchase_order(uuid, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.import_purchase_order(uuid, jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.import_purchase_order(uuid, jsonb) from authenticated; end if;
end $$;

commit;

-- ============================================================================
-- ROLLBACK (not executed automatically — apply manually if ever needed, and
-- deliberately OUTSIDE the committed migration transaction above)
-- ============================================================================
-- Safe at any time:
--   drop function if exists public.import_purchase_order(uuid, jsonb);
--   alter table public.vinted_import_candidates drop column if exists draft;
--   alter table public.vinted_import_candidates drop column if exists item_condition_hint;
--   alter table public.vinted_import_candidates drop column if exists source_provider;
--   alter table public.vinted_import_candidates drop column if exists source_account;
--   alter table public.vinted_import_candidates drop column if exists order_total_paid;
--
-- Only safe BEFORE any multi-item order has been imported post-migration
-- (restoring these will fail — or silently under-protect — once sibling
-- rows from one multi-item order share a reference/fingerprint):
--   drop index if exists purchases_source_item_key_unique;
--   alter table public.purchases drop column if exists source_item_key;
--   create unique index purchases_vinted_reference_unique on public.purchases(vinted_order_reference) where vinted_order_reference is not null;
--   create unique index purchases_vinted_fingerprint_unique on public.purchases(vinted_fingerprint) where vinted_fingerprint is not null;
--   drop index if exists vinted_candidates_source_item_key_unique;
--   alter table public.vinted_import_candidates drop column if exists source_item_key;
--   alter table public.vinted_import_candidates drop column if exists item_index;
--   alter table public.vinted_import_candidates drop column if exists unit_index;
--   create unique index vinted_candidates_message_unique on public.vinted_import_candidates(yahoo_message_id);
--     (this last one will itself fail once any email has more than one
--     candidate row, i.e. as soon as any multi-item order has been scanned —
--     rolling back after that point requires deleting the extra rows first,
--     which is a data-loss decision only you should make.)
