import "server-only";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import {
  ebayEnvironment, encryptEbayToken, decryptEbayToken, refreshEbayAccessToken, fetchEbayIdentity, fetchEbayPolicies,
  type EbayTokenResponse, type EbayIdentity, type EbayPolicyType, type RawEbayPolicy,
} from "@/lib/ebay-account/oauth";
import { fetchEbayInventoryLocations } from "@/lib/ebay-account/inventory-client";

/**
 * Persistence + application-layer orchestration for the eBay account
 * connection: reading/saving the one connection row per (owner,
 * environment), refreshing access tokens on demand, syncing policies with
 * safe partial-failure handling, validating/saving defaults, disconnect,
 * and audit-event logging. Nothing here ever returns a token to a caller
 * outside this module except the short-lived access token a specific
 * eBay API call needs for that one request.
 */

export type EbayConnectionStatus = "connected" | "needs_reconnect" | "disconnected";

export type EbayConnection = {
  id: string; ownerId: string; environment: "PRODUCTION" | "SANDBOX";
  ebayUserId: string; email: string | null; accountType: string | null; registrationMarketplace: string | null; accountStatus: string | null;
  connectionStatus: EbayConnectionStatus;
  hasRefreshToken: boolean;
  grantedScopes: string | null;
  lastIdentitySyncAt: string | null; lastPolicySyncAt: string | null;
  lastSyncErrorCode: string | null; lastSyncErrorMessage: string | null;
  draftOnly: boolean;
  defaultFulfillmentPolicyId: string | null; defaultReturnPolicyId: string | null; defaultPaymentPolicyId: string | null; defaultInventoryLocationKey: string | null;
  createdAt: string; updatedAt: string; disconnectedAt: string | null;
};

type ConnectionRow = {
  id: string; owner_id: string; environment: "PRODUCTION" | "SANDBOX";
  ebay_user_id: string; email: string | null; account_type: string | null; registration_marketplace: string | null; account_status: string | null;
  connection_status: EbayConnectionStatus;
  encrypted_refresh_token: string | null; encrypted_access_token: string | null; access_token_expires_at: string | null;
  granted_scopes: string | null;
  last_identity_sync_at: string | null; last_policy_sync_at: string | null;
  last_sync_error_code: string | null; last_sync_error_message: string | null;
  draft_only: boolean;
  default_fulfillment_policy_id: string | null; default_return_policy_id: string | null; default_payment_policy_id: string | null; default_inventory_location_key: string | null;
  created_at: string; updated_at: string; disconnected_at: string | null;
};

const CONNECTION_SELECT = "id,owner_id,environment,ebay_user_id,email,account_type,registration_marketplace,account_status,connection_status,encrypted_refresh_token,encrypted_access_token,access_token_expires_at,granted_scopes,last_identity_sync_at,last_policy_sync_at,last_sync_error_code,last_sync_error_message,draft_only,default_fulfillment_policy_id,default_return_policy_id,default_payment_policy_id,default_inventory_location_key,created_at,updated_at,disconnected_at";

function mapConnection(row: ConnectionRow): EbayConnection {
  return {
    id: row.id, ownerId: row.owner_id, environment: row.environment,
    ebayUserId: row.ebay_user_id, email: row.email, accountType: row.account_type, registrationMarketplace: row.registration_marketplace, accountStatus: row.account_status,
    connectionStatus: row.connection_status,
    hasRefreshToken: Boolean(row.encrypted_refresh_token),
    grantedScopes: row.granted_scopes,
    lastIdentitySyncAt: row.last_identity_sync_at, lastPolicySyncAt: row.last_policy_sync_at,
    lastSyncErrorCode: row.last_sync_error_code, lastSyncErrorMessage: row.last_sync_error_message,
    draftOnly: row.draft_only,
    defaultFulfillmentPolicyId: row.default_fulfillment_policy_id, defaultReturnPolicyId: row.default_return_policy_id,
    defaultPaymentPolicyId: row.default_payment_policy_id, defaultInventoryLocationKey: row.default_inventory_location_key,
    createdAt: row.created_at, updatedAt: row.updated_at, disconnectedAt: row.disconnected_at,
  };
}

/** The active connection row for this owner+environment, regardless of
 * connection_status — the Settings UI itself decides what "Not connected"
 * vs. "Needs reconnect" vs. "Connected" means from connectionStatus, never
 * from row presence alone (a disconnected row is intentionally kept for
 * history/audit, not deleted — see the migration's own header comment). */
export async function getEbayConnection(ownerId: string): Promise<EbayConnection | null> {
  const rows = await supabaseRequestAll<ConnectionRow>(`ebay_connections?owner_id=eq.${ownerId}&environment=eq.${ebayEnvironment()}&select=${CONNECTION_SELECT}`);
  return rows[0] ? mapConnection(rows[0]) : null;
}

async function recordAudit(ownerId: string, connectionId: string | null, eventType: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await supabaseRequest("ebay_connection_audit_events", { method: "POST", body: JSON.stringify({ owner_id: ownerId, connection_id: connectionId, event_type: eventType, detail_json: detail }) });
  } catch { /* audit logging is never allowed to fail the primary action it's recording */ }
}

/** Persists a freshly completed OAuth connection (upsert on owner+
 * environment — "one active connection per owner and environment").
 * `intent: "change_account"` clears the previous defaults explicitly
 * (never lets an old account's policy IDs silently carry over to a new
 * one), even though the upsert's own new-row values would already leave
 * them null for a genuinely new connection_id — this is what makes
 * "Invalidate old account policy defaults" true even when eBay happens to
 * return the exact same ebay_user_id (reconnecting the same account). */
export async function saveEbayConnectionAfterOAuth(ownerId: string, tokens: EbayTokenResponse, identity: EbayIdentity, intent: "connect" | "change_account"): Promise<EbayConnection> {
  const now = new Date().toISOString();
  const body: Record<string, unknown> = {
    owner_id: ownerId, environment: ebayEnvironment(),
    ebay_user_id: identity.userId, email: identity.email, account_type: identity.accountType,
    registration_marketplace: identity.registrationMarketplaceId, account_status: identity.status,
    connection_status: "connected",
    encrypted_access_token: encryptEbayToken(tokens.access_token),
    access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    granted_scopes: null, // not returned by eBay's token response body; kept null rather than fabricated
    last_identity_sync_at: now,
    last_sync_error_code: null, last_sync_error_message: null,
    draft_only: true,
    updated_at: now,
  };
  if (tokens.refresh_token) body.encrypted_refresh_token = encryptEbayToken(tokens.refresh_token);
  if (intent === "change_account") {
    body.default_fulfillment_policy_id = null; body.default_return_policy_id = null; body.default_payment_policy_id = null;
  }
  const response = await supabaseRequest(`ebay_connections?on_conflict=owner_id,environment`, {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body),
  });
  const rows = await response.json() as ConnectionRow[];
  const connection = mapConnection(rows[0]);
  await recordAudit(ownerId, connection.id, intent === "change_account" ? "account_changed" : "connection_completed", { ebayUserId: identity.userId, accountType: identity.accountType });
  return connection;
}

/** Returns a currently-valid access token for this owner, refreshing it
 * first if it's expired or close to expiry. A revoked/invalid refresh
 * token (eBay's `invalid_grant`, HTTP 400) marks the connection
 * `needs_reconnect` and re-throws a typed error the caller can present
 * safely; any OTHER failure (network, 5xx, timeout) is left as a
 * transient error and never touches connection_status — "a transient
 * refresh failure must not immediately destroy the connection." */
export async function getValidEbayAccessToken(ownerId: string): Promise<{ accessToken: string; connection: EbayConnection }> {
  const rows = await supabaseRequestAll<ConnectionRow>(`ebay_connections?owner_id=eq.${ownerId}&environment=eq.${ebayEnvironment()}&select=${CONNECTION_SELECT}`);
  const row = rows[0];
  if (!row || row.connection_status !== "connected" || !row.encrypted_refresh_token) {
    throw Object.assign(new Error("No connected eBay account."), { code: "not_connected" });
  }
  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  if (row.encrypted_access_token && expiresAt - Date.now() > 60_000) {
    return { accessToken: decryptEbayToken(row.encrypted_access_token), connection: mapConnection(row) };
  }
  let refreshed: EbayTokenResponse;
  try {
    refreshed = await refreshEbayAccessToken(decryptEbayToken(row.encrypted_refresh_token));
  } catch (error) {
    const status = error instanceof Error && "status" in error ? (error as Error & { status?: number }).status : undefined;
    if (status === 400 || status === 401) {
      await supabaseRequest(`ebay_connections?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ connection_status: "needs_reconnect", last_sync_error_code: "invalid_grant", last_sync_error_message: "eBay rejected the stored connection. Reconnect the account.", updated_at: new Date().toISOString() }) });
      await recordAudit(ownerId, row.id, "token_invalid", { httpStatus: status });
      throw Object.assign(new Error("Your eBay permission has expired. Reconnect the account to continue."), { code: "needs_reconnect" });
    }
    throw error; // transient — connection left untouched
  }
  const nextBody: Record<string, unknown> = {
    encrypted_access_token: encryptEbayToken(refreshed.access_token),
    access_token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // eBay may rotate the refresh token on refresh — store the new one
  // whenever supplied, never assume the old one still works.
  if (refreshed.refresh_token) nextBody.encrypted_refresh_token = encryptEbayToken(refreshed.refresh_token);
  await supabaseRequest(`ebay_connections?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify(nextBody) });
  return { accessToken: refreshed.access_token, connection: mapConnection({ ...row, ...nextBody } as ConnectionRow) };
}

export type EbayPolicyRecord = {
  id: string; policyType: EbayPolicyType; ebayPolicyId: string; name: string; marketplaceId: string;
  available: boolean; firstSeenAt: string; lastSeenAt: string; lastSyncedAt: string;
};
type PolicyRow = { id: string; policy_type: EbayPolicyType; ebay_policy_id: string; name: string; marketplace_id: string; available: boolean; first_seen_at: string; last_seen_at: string; last_synced_at: string };
function mapPolicy(row: PolicyRow): EbayPolicyRecord {
  return { id: row.id, policyType: row.policy_type, ebayPolicyId: row.ebay_policy_id, name: row.name, marketplaceId: row.marketplace_id, available: row.available, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, lastSyncedAt: row.last_synced_at };
}

export async function listEbayPolicies(connectionId: string): Promise<EbayPolicyRecord[]> {
  const rows = await supabaseRequestAll<PolicyRow>(`ebay_policies?connection_id=eq.${connectionId}&select=id,policy_type,ebay_policy_id,name,marketplace_id,available,first_seen_at,last_seen_at,last_synced_at&order=policy_type.asc,name.asc`);
  return rows.map(mapPolicy);
}

type PolicySyncOutcome = { type: EbayPolicyType; status: "success" | "failed"; count: number; errorMessage?: string };

/** Upserts one policy type's freshly fetched snapshot and marks any
 * previously-known policy of this type that was NOT returned as
 * unavailable — never hard-deleted (a historical draft or a saved default
 * may still reference it). Each policy type is synced independently: a
 * failure fetching one type never touches the other two types' existing
 * data, and never marks anything unavailable based on an incomplete
 * snapshot ("partial sync failure does not incorrectly deactivate
 * policies"). */
async function syncOnePolicyType(ownerId: string, connectionId: string, accessToken: string, type: EbayPolicyType): Promise<PolicySyncOutcome> {
  let fetched: RawEbayPolicy[];
  try {
    fetched = await fetchEbayPolicies(accessToken, type);
  } catch (error) {
    return { type, status: "failed", count: 0, errorMessage: error instanceof Error ? error.message : "Unknown error." };
  }
  const now = new Date().toISOString();
  for (const policy of fetched) {
    await supabaseRequest(`ebay_policies?on_conflict=connection_id,policy_type,ebay_policy_id`, {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        connection_id: connectionId, owner_id: ownerId, policy_type: type, ebay_policy_id: policy.policyId,
        name: policy.name, marketplace_id: policy.marketplaceId || "EBAY_GB", details_json: policy.details,
        available: true, last_seen_at: now, last_synced_at: now, updated_at: now,
      }),
    });
  }
  // Mark stale (no longer returned) policies of this type unavailable —
  // scoped to policies whose ebay_policy_id was NOT in this successful
  // snapshot, so a policy still present is never touched.
  const returnedIds = fetched.map(p => p.policyId);
  const notInFilter = returnedIds.length ? `&ebay_policy_id=not.in.(${returnedIds.map(id => `"${id}"`).join(",")})` : "";
  await supabaseRequest(`ebay_policies?connection_id=eq.${connectionId}&policy_type=eq.${type}&available=eq.true${notInFilter}`, {
    method: "PATCH", body: JSON.stringify({ available: false, updated_at: now }),
  });
  return { type, status: "success", count: fetched.length };
}

export type EbayInventoryLocationRecord = {
  id: string; merchantLocationKey: string; name: string | null; status: string | null; addressSummary: string | null; available: boolean;
};
type LocationRow = { id: string; merchant_location_key: string; name: string | null; status: string | null; address_summary: string | null; available: boolean };
function mapLocation(row: LocationRow): EbayInventoryLocationRecord {
  return { id: row.id, merchantLocationKey: row.merchant_location_key, name: row.name, status: row.status, addressSummary: row.address_summary, available: row.available };
}

/** Read-only — mirrors listEbayPolicies exactly. This app never creates,
 * edits, enables, disables, or deletes a location; it only ever reads and
 * displays whatever the connected account already has on eBay's side (see
 * lib/ebay-account/inventory-allowlist.ts's own comment: only
 * "getInventoryLocations" is permitted for this resource). */
export async function listEbayInventoryLocations(connectionId: string): Promise<EbayInventoryLocationRecord[]> {
  const rows = await supabaseRequestAll<LocationRow>(`ebay_inventory_locations?connection_id=eq.${connectionId}&select=id,merchant_location_key,name,status,address_summary,available&order=name.asc`);
  return rows.map(mapLocation);
}

type LocationSyncOutcome = { status: "success" | "failed"; count: number; errorMessage?: string };

/** Same idempotent upsert-and-mark-stale-unavailable shape as
 * syncOnePolicyType above, for eBay inventory locations. Stage 6. */
async function syncInventoryLocations(ownerId: string, connectionId: string, accessToken: string): Promise<LocationSyncOutcome> {
  let fetched: Awaited<ReturnType<typeof fetchEbayInventoryLocations>>;
  try {
    fetched = await fetchEbayInventoryLocations(accessToken);
  } catch (error) {
    return { status: "failed", count: 0, errorMessage: error instanceof Error ? error.message : "Unknown error." };
  }
  // CORRECTIVE PASS — the writes below target ebay_inventory_locations, a
  // table that only exists once supabase-ebay-draft-batches.sql has been
  // applied. Wrapped in its own try/catch (separate from the fetch above)
  // so "the eBay call itself succeeded but the local table doesn't exist
  // yet" is reported as this ONE sync step failing, never an unhandled
  // throw that would abort syncEbayIdentityAndPolicies entirely and take
  // down the already-working identity/policy sync alongside it.
  try {
    const now = new Date().toISOString();
    for (const location of fetched) {
      await supabaseRequest(`ebay_inventory_locations?on_conflict=connection_id,merchant_location_key`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          connection_id: connectionId, owner_id: ownerId, merchant_location_key: location.merchantLocationKey,
          name: location.name, status: location.status, address_summary: location.addressSummary,
          available: true, last_seen_at: now, last_synced_at: now, updated_at: now,
        }),
      });
    }
    const returnedKeys = fetched.map(l => l.merchantLocationKey);
    const notInFilter = returnedKeys.length ? `&merchant_location_key=not.in.(${returnedKeys.map(k => `"${k}"`).join(",")})` : "";
    await supabaseRequest(`ebay_inventory_locations?connection_id=eq.${connectionId}&available=eq.true${notInFilter}`, {
      method: "PATCH", body: JSON.stringify({ available: false, updated_at: now }),
    });
    return { status: "success", count: fetched.length };
  } catch (error) {
    return { status: "failed", count: 0, errorMessage: error instanceof Error ? error.message : "Could not store synced inventory locations." };
  }
}

export type EbaySyncResult = {
  identity: { status: "success" | "failed"; errorMessage?: string };
  policies: PolicySyncOutcome[];
  locations: LocationSyncOutcome;
  connection: EbayConnection;
};

/** The one "Sync account" implementation, shared by the initial post-OAuth
 * import and the manual "Sync account" action — re-fetches identity and
 * all three policy types, applies safe partial-failure handling, and only
 * updates last_policy_sync_at once every policy type succeeded (a
 * genuinely COMPLETE snapshot) — never marking one type updated while
 * silently leaving another stale without reporting it. */
export async function syncEbayIdentityAndPolicies(ownerId: string): Promise<EbaySyncResult> {
  const { accessToken, connection } = await getValidEbayAccessToken(ownerId);
  const now = new Date().toISOString();

  let identityOutcome: EbaySyncResult["identity"] = { status: "success" };
  const identityPatch: Record<string, unknown> = { last_identity_sync_at: now, updated_at: now };
  try {
    const identity = await fetchEbayIdentity(accessToken);
    identityPatch.email = identity.email; identityPatch.account_type = identity.accountType;
    identityPatch.registration_marketplace = identity.registrationMarketplaceId; identityPatch.account_status = identity.status;
  } catch (error) {
    identityOutcome = { status: "failed", errorMessage: error instanceof Error ? error.message : "Unknown error." };
  }

  const policyOutcomes: PolicySyncOutcome[] = [];
  for (const type of ["FULFILLMENT", "RETURN", "PAYMENT"] as const) {
    policyOutcomes.push(await syncOnePolicyType(ownerId, connection.id, accessToken, type));
  }
  const allPoliciesSucceeded = policyOutcomes.every(outcome => outcome.status === "success");

  // Stage 6 — inventory locations sync alongside policies (read-only, same
  // partial-failure discipline: a location-sync failure never marks
  // last_policy_sync_at, since that field means "every business setting
  // needed for a draft is up to date", and never touches the already-
  // synced policy rows either).
  const locationOutcome = await syncInventoryLocations(ownerId, connection.id, accessToken);

  const finalPatch: Record<string, unknown> = { ...identityPatch };
  if (allPoliciesSucceeded && locationOutcome.status === "success") finalPatch.last_policy_sync_at = now;
  const failedTypes = policyOutcomes.filter(o => o.status === "failed");
  const failedParts = [...failedTypes.map(o => `${o.type.toLowerCase()} polic${failedTypes.length === 1 ? "y" : "ies"}`), ...(locationOutcome.status === "failed" ? ["inventory locations"] : [])];
  finalPatch.last_sync_error_code = identityOutcome.status === "failed" ? "identity_sync_failed" : failedParts.length ? "partial_policy_sync_failed" : null;
  finalPatch.last_sync_error_message = identityOutcome.status === "failed"
    ? identityOutcome.errorMessage
    : failedParts.length ? `Could not sync: ${failedParts.join(", ")}.` : null;

  const response = await supabaseRequest(`ebay_connections?id=eq.${connection.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(finalPatch) });
  const rows = await response.json() as ConnectionRow[];
  const updatedConnection = mapConnection(rows[0]);
  await recordAudit(ownerId, connection.id, "policies_synced", { identity: identityOutcome.status, policies: policyOutcomes, locations: locationOutcome.status });
  return { identity: identityOutcome, policies: policyOutcomes, locations: locationOutcome, connection: updatedConnection };
}

export type EbayDefaultsInput = {
  fulfillmentPolicyId?: string | null; returnPolicyId?: string | null; paymentPolicyId?: string | null;
  inventoryLocationKey?: string | null;
};
export type EbayDefaultsResult = { ok: true; connection: EbayConnection } | { ok: false; error: string };

/** Validates that every selected policy id genuinely belongs to the
 * OWNER's active connection, the correct type, and remains available,
 * before saving anything — "never call eBay policy-update endpoints"
 * (this only ever writes to ebay_connections' own default_*_policy_id
 * columns) and "keep previous defaults if saving fails" (nothing is
 * written until every provided id has passed validation). Stage 6 extends
 * the same validate-before-write discipline to the default inventory
 * location. */
export async function saveEbayDefaults(ownerId: string, connectionId: string, input: EbayDefaultsInput): Promise<EbayDefaultsResult> {
  const checks: Array<[EbayPolicyType, string | null | undefined]> = [["FULFILLMENT", input.fulfillmentPolicyId], ["RETURN", input.returnPolicyId], ["PAYMENT", input.paymentPolicyId]];
  for (const [type, id] of checks) {
    if (id == null) continue;
    const rows = await supabaseRequestAll<{ id: string }>(`ebay_policies?connection_id=eq.${connectionId}&policy_type=eq.${type}&ebay_policy_id=eq.${id}&marketplace_id=eq.EBAY_GB&available=eq.true&select=id`);
    if (!rows.length) return { ok: false, error: `The selected ${type.toLowerCase()} policy is not available on this connection.` };
  }
  if (input.inventoryLocationKey != null) {
    const rows = await supabaseRequestAll<{ id: string }>(`ebay_inventory_locations?connection_id=eq.${connectionId}&merchant_location_key=eq.${encodeURIComponent(input.inventoryLocationKey)}&available=eq.true&select=id`);
    if (!rows.length) return { ok: false, error: "The selected inventory location is not available on this connection." };
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.fulfillmentPolicyId !== undefined) patch.default_fulfillment_policy_id = input.fulfillmentPolicyId;
  if (input.returnPolicyId !== undefined) patch.default_return_policy_id = input.returnPolicyId;
  if (input.paymentPolicyId !== undefined) patch.default_payment_policy_id = input.paymentPolicyId;
  if (input.inventoryLocationKey !== undefined) patch.default_inventory_location_key = input.inventoryLocationKey;
  const response = await supabaseRequest(`ebay_connections?id=eq.${connectionId}&owner_id=eq.${ownerId}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  const rows = await response.json() as ConnectionRow[];
  if (!rows[0]) return { ok: false, error: "Connection not found." };
  const connection = mapConnection(rows[0]);
  await recordAudit(ownerId, connectionId, "defaults_changed", input);
  return { ok: true, connection };
}

/**
 * Disconnects the current connection: cryptographically destroys the
 * locally stored tokens (nulled, not merely flagged) and marks the
 * connection disconnected. eBay does not currently publish a general
 * third-party token-revocation REST endpoint for this OAuth flow (unlike,
 * say, Google's `/revoke`) — a seller's own "Third-party access" page in
 * their eBay Account settings is the only place a grant can be revoked on
 * eBay's own side. This is stated here rather than silently pretending a
 * revoke call was made; disconnect is genuinely LOCAL — this app simply
 * stops being able to use the (now-deleted) tokens.
 */
export async function disconnectEbayConnection(ownerId: string, connectionId: string): Promise<void> {
  await supabaseRequest(`ebay_connections?id=eq.${connectionId}&owner_id=eq.${ownerId}`, {
    method: "PATCH",
    body: JSON.stringify({
      connection_status: "disconnected", encrypted_refresh_token: null, encrypted_access_token: null,
      access_token_expires_at: null, disconnected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }),
  });
  await recordAudit(ownerId, connectionId, "account_disconnected");
}
