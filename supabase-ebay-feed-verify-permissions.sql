-- Read-only verification for the eBay Feed draft-batches RPC permission
-- lockdown in supabase-ebay-feed-drafts.sql. Never alters schema, data, or
-- grants — safe to run any number of times, before or after applying that
-- migration. Run manually in the Supabase SQL editor; nothing in this app
-- runs it automatically.
--
-- Before the migration is applied, every row below will simply fail to
-- resolve (the functions don't exist yet) — that is expected, not an error
-- in this file. Run it AFTER applying supabase-ebay-feed-drafts.sql to
-- confirm the final grant state before this application ever calls one of
-- these RPCs for real.
--
-- Required final state for every row:
--   service_role_allowed = true
--   anon_allowed          = false
--   authenticated_allowed = false
--
-- Uses has_function_privilege(...), PostgreSQL's own privilege-inspection
-- function — never inspects or returns table data, secrets, tokens, or any
-- business data.
select
  'listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[])' as function_signature,
  has_function_privilege('service_role', 'public.listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[])', 'execute') as service_role_allowed,
  has_function_privilege('anon', 'public.listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[])', 'execute') as anon_allowed,
  has_function_privilege('authenticated', 'public.listing_studio_create_ebay_feed_batch(uuid, uuid[], uuid[], text[])', 'execute') as authenticated_allowed
union all
select
  'listing_studio_latest_ebay_feed_status(uuid)',
  has_function_privilege('service_role', 'public.listing_studio_latest_ebay_feed_status(uuid)', 'execute'),
  has_function_privilege('anon', 'public.listing_studio_latest_ebay_feed_status(uuid)', 'execute'),
  has_function_privilege('authenticated', 'public.listing_studio_latest_ebay_feed_status(uuid)', 'execute')
union all
select
  'listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer)',
  has_function_privilege('service_role', 'public.listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer)', 'execute'),
  has_function_privilege('anon', 'public.listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer)', 'execute'),
  has_function_privilege('authenticated', 'public.listing_studio_claim_ebay_feed_batches(uuid, uuid, integer, text, integer)', 'execute')
union all
select
  'listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer)',
  has_function_privilege('service_role', 'public.listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer)', 'execute'),
  has_function_privilege('anon', 'public.listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer)', 'execute'),
  has_function_privilege('authenticated', 'public.listing_studio_advance_ebay_feed_batch(uuid, text, text, text, integer, text, text, integer)', 'execute')
union all
select
  'listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb)',
  has_function_privilege('service_role', 'public.listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb)', 'execute'),
  has_function_privilege('anon', 'public.listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb)', 'execute'),
  has_function_privilege('authenticated', 'public.listing_studio_finish_ebay_feed_batch_items(uuid, text, jsonb)', 'execute')
union all
select
  'listing_studio_owners_with_claimable_ebay_feed_work(integer)',
  has_function_privilege('service_role', 'public.listing_studio_owners_with_claimable_ebay_feed_work(integer)', 'execute'),
  has_function_privilege('anon', 'public.listing_studio_owners_with_claimable_ebay_feed_work(integer)', 'execute'),
  has_function_privilege('authenticated', 'public.listing_studio_owners_with_claimable_ebay_feed_work(integer)', 'execute');
