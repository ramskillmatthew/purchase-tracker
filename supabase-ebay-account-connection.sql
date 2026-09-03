-- eBay UK account connection, identity and business-policy sync.
-- Run manually in the Supabase SQL editor; nothing in this app runs it
-- automatically. Safe to re-run: every statement is idempotent
-- (`if not exists`), matching every other supabase-*.sql file's own
-- convention. NOT applied to Production by this change — read-only local
-- work only.
--
-- ARCHITECTURE DECISION (read before touching this file): this is
-- deliberately SEPARATE from listing_marketplace_settings_defaults'
-- existing postage_profile_label/return_profile_label/payment_profile_label
-- columns (see supabase-listing-studio-marketplace.sql) — those are
-- honestly-unconnected, owner-typed LOCAL labels (that file's own header
-- comment: "Never a real eBay policy id... eBay OAuth/account-policy
-- retrieval is out of scope"). This migration is exactly that follow-up
-- scope: it never touches or reinterprets those existing columns, and a
-- future stage decides how/whether draft generation should read the new
-- default policy IDs here instead. Nothing about existing Listing Studio
-- generation changes as a result of this file.

-- One row per (owner, environment) — "one active connection per owner and
-- environment" from the product spec. Reconnecting (or completing a
-- "Change account" flow) upserts this same row rather than creating a
-- second one; disconnecting flips connection_status and clears the token
-- rather than deleting the row, so history/audit and any drafts that
-- reference this connection are never orphaned.
create table if not exists public.ebay_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,

  environment text not null
    check (environment in ('PRODUCTION', 'SANDBOX')),

  -- eBay's own IMMUTABLE user identifier (commerce/identity's `userId`) —
  -- the authoritative way to recognise "is this the same eBay account",
  -- since a username or email can change. Never shown in ordinary Settings
  -- UI (product spec: "Do not expose the immutable eBay user ID").
  ebay_user_id text not null,

  -- The account email eBay's Identity API actually returned, or null when
  -- eBay genuinely didn't supply one for this account/scope — the UI shows
  -- "Email not supplied by eBay" in that case, never inferring one, never
  -- falling back to the app-login email or the eBay username.
  email text,
  account_type text,
  registration_marketplace text,
  account_status text,

  -- 'connected' = usable. 'needs_reconnect' = refresh token invalid/
  -- revoked by eBay — the owner must reconnect; a merely TRANSIENT refresh
  -- failure never sets this (see lib/ebay-account/oauth.ts's own retry
  -- logic). 'disconnected' = the owner explicitly disconnected.
  connection_status text not null default 'connected'
    check (connection_status in ('connected', 'needs_reconnect', 'disconnected')),

  -- AES-256-GCM, versioned (see lib/ebay-account/oauth.ts's encryptToken) —
  -- null once disconnected (cryptographic destruction, not just a status
  -- flag). Never selected by any client-facing API response.
  encrypted_refresh_token text,
  -- Short-lived access token is cached here ONLY when genuinely useful
  -- (avoids a refresh round-trip on every single API call within its own
  -- validity window) — also encrypted, also cleared on disconnect.
  encrypted_access_token text,
  access_token_expires_at timestamptz,

  -- Space-separated, exactly as eBay granted them — lets the app detect a
  -- missing required scope without guessing.
  granted_scopes text,

  last_identity_sync_at timestamptz,
  last_policy_sync_at timestamptz,
  last_sync_error_code text,
  last_sync_error_message text,

  -- Drafts-only safety — server-side enforcement point for a later publish
  -- route. This stage locks it enabled; see this table's own application-
  -- layer read path (lib/ebay-account/oauth.ts) for why it's never trusted
  -- from client input alone.
  draft_only boolean not null default true,

  -- The OWNER's chosen default policy for each type, by eBay's own policy
  -- id — never a name (see ebay_policies.ebay_policy_id below, which is
  -- the join target). A default can point at a policy that has since
  -- become unavailable (ebay_policies.available = false); the application
  -- layer surfaces that as "Default policy needs attention" rather than
  -- silently picking a replacement.
  default_fulfillment_policy_id text,
  default_return_policy_id text,
  default_payment_policy_id text,
  default_inventory_location_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz,

  unique (owner_id, environment)
);

create index if not exists ebay_connections_owner_idx
  on public.ebay_connections (owner_id, environment);

alter table public.ebay_connections enable row level security;
revoke all on public.ebay_connections from anon, authenticated;

-- Every imported fulfilment/return/payment policy for the connection,
-- normalised — never collapsed into a single column. Policy ID (eBay's
-- own, not the name) plus connection is the authoritative identity: names
-- may be duplicated or renamed on eBay without losing identity here.
create table if not exists public.ebay_policies (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.ebay_connections (id)
    on delete cascade,
  owner_id uuid not null,

  policy_type text not null
    check (policy_type in ('FULFILLMENT', 'RETURN', 'PAYMENT')),

  ebay_policy_id text not null,
  name text not null,
  marketplace_id text not null default 'EBAY_GB',

  -- Type-specific structured detail (handling time + shipping services for
  -- FULFILLMENT; acceptance/period/refund method/return-shipping-payer for
  -- RETURN; payment methods for PAYMENT) — kept as the real API response
  -- shape rather than a narrowed set of columns, since eBay's own policy
  -- schema is richer than any one marketplace feature currently needs.
  details_json jsonb not null default '{}'::jsonb,

  -- false once a sync completes and this policy id was NOT returned again
  -- — never hard-deleted, so a historical draft's saved policy id/name
  -- snapshot and any default that pointed at it both stay resolvable.
  available boolean not null default true,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (connection_id, policy_type, ebay_policy_id)
);

create index if not exists ebay_policies_connection_idx
  on public.ebay_policies (connection_id, policy_type, available);

alter table public.ebay_policies enable row level security;
revoke all on public.ebay_policies from anon, authenticated;

-- Database-backed one-time OAuth state — deliberately NOT the stateless
-- signed-JWT pattern lib/gmail/oauth.ts uses for its own state, because
-- the eBay integration's product spec requires genuine one-time-use and
-- replay rejection (a bare signed JWT with only an expiry cannot express
-- "already consumed"). Only a SHA-256 hash of the actual state value is
-- stored — the raw value only ever exists in the redirect URL/eBay's own
-- round trip, never persisted, so a stolen DB row alone can't be replayed.
create table if not exists public.ebay_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  owner_id uuid not null,
  environment text not null
    check (environment in ('PRODUCTION', 'SANDBOX')),
  -- Allowlisted, server-chosen — never taken from client input at
  -- callback time, so this can never become an open redirect.
  return_path text not null default '/settings',
  -- Distinguishes a genuine new connection from a "Change account" replace
  -- — read back at callback time so the two flows can't be confused.
  intent text not null default 'connect'
    check (intent in ('connect', 'change_account')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ebay_oauth_states_owner_idx
  on public.ebay_oauth_states (owner_id, expires_at);

alter table public.ebay_oauth_states enable row level security;
revoke all on public.ebay_oauth_states from anon, authenticated;

-- Audit trail for every state-changing connection event — never used to
-- reconstruct current state (ebay_connections/ebay_policies remain
-- authoritative), purely a append-only history for support/debugging.
create table if not exists public.ebay_connection_audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connection_id uuid
    references public.ebay_connections (id)
    on delete set null,
  event_type text not null
    check (event_type in (
      'connection_initiated', 'connection_completed', 'connection_failed',
      'policies_synced', 'defaults_changed', 'account_changed',
      'account_disconnected', 'token_invalid'
    )),
  -- Safe, structured detail only — never a raw eBay error body, never a
  -- token, never a secret (see lib/ebay-account/oauth.ts's own audit
  -- writer for the exact allowlist of fields this ever contains).
  detail_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ebay_connection_audit_events_owner_idx
  on public.ebay_connection_audit_events (owner_id, created_at desc);

alter table public.ebay_connection_audit_events enable row level security;
revoke all on public.ebay_connection_audit_events from anon, authenticated;
