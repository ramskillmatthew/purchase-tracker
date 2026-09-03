import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";

/**
 * eBay UK account connection — OAuth (authorization-code / User token
 * grant), token encryption, and one-time callback-state handling.
 * Deliberately separate from lib/listing-studio/ebay-taxonomy-client.ts,
 * which uses the CLIENT-CREDENTIALS (application) token grant for
 * Taxonomy — a completely different token type, never user-owned and
 * never able to read seller-owned business policies. This module reuses
 * the SAME EBAY_CLIENT_ID/EBAY_CLIENT_SECRET/EBAY_ENVIRONMENT keyset
 * (a real eBay Developer keyset supports both grant types), but every
 * token/state concept here is its own.
 *
 * Architecturally mirrors lib/gmail/oauth.ts (AES-256-GCM token
 * encryption, a `required()` env helper, a `tokenRequest` POST helper) —
 * the one deliberate difference is OAuth STATE: Gmail uses a stateless
 * signed JWT (fine for Gmail's own risk profile), but this integration's
 * product spec requires genuine one-time-use and replay rejection, which
 * a bare-expiry JWT cannot express. State here is DB-backed
 * (ebay_oauth_states) and atomically consumed via a single conditional
 * UPDATE ... WHERE consumed_at IS NULL ... RETURNING, so two concurrent
 * callback requests can never both succeed.
 */

export type EbayEnvironment = "PRODUCTION" | "SANDBOX";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function ebayEnvironment(): EbayEnvironment {
  return process.env.EBAY_ENVIRONMENT === "SANDBOX" ? "SANDBOX" : "PRODUCTION";
}
// Exported (Stage 6) — lib/ebay-account/inventory-client.ts needs the exact
// same host-selection rule for the Inventory API, which lives on the same
// "api"/"api.sandbox" host as the account/policy endpoints this file
// already calls.
export function ebayApiBase(env: EbayEnvironment = ebayEnvironment()) { return apiBase(env); }
function apiBase(env: EbayEnvironment) { return env === "SANDBOX" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"; }
function authBase(env: EbayEnvironment) { return env === "SANDBOX" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com"; }
// The Identity API is served from a distinct host ("apiz", not "api") —
// a real, documented eBay platform quirk, not a typo; verified against
// eBay's own published Identity API reference. Getting this exactly right
// is the whole point of "do not repeat the previous taxonomy URL mistake."
function identityBase(env: EbayEnvironment) { return env === "SANDBOX" ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com"; }

/**
 * PROVEN ROOT CAUSE FIX — the callback route used to build its post-OAuth
 * redirect from `new URL(request.url).origin`, i.e. whatever origin
 * Next.js itself observed for the incoming request. Through a reverse
 * proxy/tunnel (verified live: a Cloudflare quick tunnel) this resolved
 * to the app's OWN bind address, `https://localhost:3000` — never
 * reachable in a real browser, breaking the round trip right after a
 * genuine eBay authorisation.
 *
 * The trusted origin is now read from ONE place: the server-configured
 * `NEXT_PUBLIC_APP_URL` environment variable — never from anything a
 * request/proxy could influence (the `Host` header, `X-Forwarded-Host`,
 * or `request.url` itself are all deliberately never consulted here,
 * which is also what prevents this from ever becoming an open redirect:
 * the redirect target can only ever be this one server-controlled
 * value, never anything derived from the incoming request). Outside
 * development, `NEXT_PUBLIC_APP_URL` MUST be an absolute HTTPS URL — a
 * missing or insecure value fails the request outright rather than
 * silently falling back to something unintended. In development, an
 * unset value falls back to `http://localhost:3000` (the documented
 * .env.example default) and `http://` is accepted, since local dev has
 * no real TLS termination of its own — but once set (e.g. to a tunnel's
 * https:// URL for a live OAuth test), that value is used exactly as
 * configured, matching this same rule.
 */
export function trustedAppOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const isProduction = process.env.NODE_ENV === "production";
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new Error("NEXT_PUBLIC_APP_URL is not a valid absolute URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("NEXT_PUBLIC_APP_URL must be an http(s) URL.");
    }
    if (isProduction && parsed.protocol !== "https:") {
      throw new Error("NEXT_PUBLIC_APP_URL must be an absolute HTTPS URL outside development.");
    }
    return parsed.origin;
  }
  if (isProduction) throw new Error("NEXT_PUBLIC_APP_URL must be configured outside development.");
  return "http://localhost:3000";
}

/**
 * Scopes requested, and why each is here (documented per the product
 * spec's own "document the exact scopes finally used" requirement).
 *
 * PROVEN CORRECTION — the eBay Production keyset's complete OAuth scope
 * list has been manually verified in the Developer Portal:
 * `commerce.identity.email.readonly` and `commerce.identity.status.readonly`
 * are NOT available on this keyset. Requesting an unavailable scope risks
 * eBay rejecting the ENTIRE authorisation with `invalid_scope` — so only
 * the three scopes actually available and selected in the Developer
 * Portal are requested. This means email/status are no longer reliably
 * retrievable for every account; see fetchEbayIdentity below for how that
 * is now handled honestly (read defensively, never required, never
 * fabricated when absent).
 *
 *  - commerce.identity.readonly: the base identity scope — immutable user
 *    id, account type, registration marketplace, and (per eBay's own
 *    behaviour) a business seller's `businessAccount.email` is typically
 *    included under this scope alone. Does NOT reliably include
 *    `individualAccount.email` or a dependable `status` field — this app
 *    no longer assumes either is present just because this scope was
 *    granted.
 *  - sell.account.readonly: read (never write) the seller's own
 *    fulfilment/return/payment business policies — this stage only ever
 *    calls the GET policy endpoints, never update/delete.
 *  - sell.inventory: a genuinely WRITE-CAPABLE scope (create/replace
 *    inventory items and offers, and — if the application chose to call
 *    it — publish them). It is NOT a read-only or inherently non-
 *    publishing scope, and must never be described as such. It is
 *    requested now, per the product spec's own explicit allowance, ONLY
 *    because the next implementation stage needs to create UNPUBLISHED
 *    inventory items/offers without forcing every already-connected
 *    owner through a second authorisation. Draft-only safety is enforced
 *    entirely in application code, never by scope: this stage's own code
 *    contains no call to any Inventory API endpoint at all yet (see
 *    lib/ebay-account/inventory-allowlist.ts's own header comment for the
 *    explicit allowlist a future stage must add write operations to, and
 *    tests/ebay-account-draft-only-safety.test.ts for the proof no
 *    publish-capable call/route/URL exists anywhere in this codebase).
 */
export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
].join(" ");

// --- Token encryption (mirrors lib/gmail/oauth.ts's AES-256-GCM shape
// exactly, with an explicit cipher version prefix so a future key/format
// rotation can distinguish old vs. new payloads without guessing). ---
const TOKEN_CIPHER_VERSION = "v1";
function encryptionKey() {
  const key = Buffer.from(required("EBAY_TOKEN_ENCRYPTION_KEY"), "base64url");
  if (key.length !== 32) throw new Error("EBAY_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value.");
  return key;
}
export function encryptEbayToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${TOKEN_CIPHER_VERSION}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
export function decryptEbayToken(value: string): string {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== TOKEN_CIPHER_VERSION) throw new Error("Unsupported eBay token cipher version.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

// --- OAuth state: DB-backed, hashed, one-time, owner+environment-bound ---
const STATE_TTL_MS = 10 * 60 * 1000;
function hashState(raw: string): string { return createHash("sha256").update(raw).digest("base64url"); }

export type EbayOAuthIntent = "connect" | "change_account";

/** Creates a fresh, unpredictable (32 random bytes) one-time state value.
 * Only its SHA-256 hash is ever persisted — the raw value exists only in
 * the redirect URL / eBay's own round trip, so a stolen DB row alone
 * cannot be replayed. */
export async function createEbayOAuthState(ownerId: string, intent: EbayOAuthIntent = "connect", returnPath = "/settings"): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await supabaseRequest("ebay_oauth_states", {
    method: "POST",
    body: JSON.stringify({
      state_hash: hashState(raw), owner_id: ownerId, environment: ebayEnvironment(), intent,
      return_path: returnPath, expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
    }),
  });
  return raw;
}

/** Atomically consumes a state value: a single conditional UPDATE with
 * `consumed_at IS NULL AND expires_at > now()` in the WHERE clause,
 * returning the updated row only when it actually matched — this is what
 * makes "one-time use" and "replayed callback rejected" genuine database-
 * level guarantees, not just an application-level check that a concurrent
 * request could race past. Also verifies owner and environment binding.
 * Throws one deliberately generic message either way (invalid, expired,
 * already used, or owner/environment mismatch) — never distinguishing
 * these to a caller, since none of that detail is safe or useful to leak
 * about an OAuth state value. */
export async function consumeEbayOAuthState(rawState: string, ownerId: string): Promise<{ intent: EbayOAuthIntent; returnPath: string }> {
  const hash = hashState(rawState);
  const response = await supabaseRequest(
    `ebay_oauth_states?state_hash=eq.${hash}&owner_id=eq.${ownerId}&environment=eq.${ebayEnvironment()}&consumed_at=is.null&expires_at=gt.${new Date().toISOString()}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ consumed_at: new Date().toISOString() }) },
  );
  const rows = await response.json() as Array<{ intent: EbayOAuthIntent; return_path: string }>;
  const row = rows[0];
  if (!row) throw new Error("This eBay connection link is invalid, has expired, or has already been used. Start again from Settings.");
  return { intent: row.intent, returnPath: row.return_path };
}

/**
 * PROVEN ROOT CAUSE FIX — the live authorization request was rejected by
 * eBay with `invalid_request` before the login/consent screen ever
 * appeared: a purely STATIC, structural rejection, proven (via a
 * read-only diagnostic that never printed the URL/secrets — only safe
 * structural facts) to be `URLSearchParams`'s own encoding of the
 * space-separated `scope` value. `URLSearchParams`/`application/x-www-
 * form-urlencoded` serialises a space as `+` — correct for a POST body,
 * but eBay's `/oauth2/authorize` GET endpoint does not reliably accept
 * `+` as a space in `scope` and rejects the whole request outright. Every
 * other parameter (endpoint, client_id, redirect_uri/RuName,
 * response_type, state — exactly five params, no duplicates, no blanks,
 * no unsupported extras) was independently confirmed structurally
 * correct by that same diagnostic; this was the one genuine defect.
 *
 * The fix: build the query string with strict percent-encoding
 * (`encodeURIComponent`, which always emits `%20` for a space) for every
 * parameter, never `URLSearchParams`'s form-encoding — unambiguous,
 * standard for an OAuth authorization GET redirect, and accepted by
 * eBay's endpoint.
 */
export async function ebayAuthorizationUrl(ownerId: string, intent: EbayOAuthIntent = "connect"): Promise<string> {
  const state = await createEbayOAuthState(ownerId, intent);
  const params: Record<string, string> = {
    client_id: required("EBAY_CLIENT_ID"),
    redirect_uri: required("EBAY_RUNAME"), // eBay's OAuth redirect_uri parameter is the registered RuName, not a raw URL
    response_type: "code",
    scope: EBAY_OAUTH_SCOPES,
    state,
  };
  const query = Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  return `${authBase(ebayEnvironment())}/oauth2/authorize?${query}`;
}

export type EbayTokenResponse = { access_token: string; refresh_token?: string; expires_in: number; refresh_token_expires_in?: number; token_type: string };

async function tokenRequest(params: Record<string, string>): Promise<EbayTokenResponse> {
  const basic = Buffer.from(`${required("EBAY_CLIENT_ID")}:${required("EBAY_CLIENT_SECRET")}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(`${apiBase(ebayEnvironment())}/identity/v1/oauth2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams(params).toString(), cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    const error = new Error("Could not reach eBay to complete this connection.") as Error & { cause?: unknown };
    error.cause = cause; throw error;
  }
  if (!response.ok) {
    // Deliberately never surfaces the raw response body upward (it can
    // contain the exact request parameters eBay rejected) — only a safe
    // HTTP status, matching this app's existing safeApiError convention.
    const error = new Error("eBay OAuth token request failed.") as Error & { status: number };
    error.status = response.status; throw error;
  }
  return response.json();
}

export async function exchangeEbayCode(code: string): Promise<EbayTokenResponse> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: required("EBAY_RUNAME") });
}

/** Refreshes a short-lived access token. A caller distinguishes "revoked/
 * invalid" (HTTP 400 `invalid_grant` — mark needs_reconnect) from a
 * transient failure (network/5xx — never destroy the connection) by
 * inspecting the thrown error's `.status`. */
export async function refreshEbayAccessToken(refreshToken: string): Promise<EbayTokenResponse> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, scope: EBAY_OAUTH_SCOPES });
}

export type EbayIdentity = {
  userId: string; email: string | null; accountType: string | null;
  registrationMarketplaceId: string | null; status: string | null;
};

export async function fetchEbayIdentity(accessToken: string): Promise<EbayIdentity> {
  let response: Response;
  try {
    response = await fetch(`${identityBase(ebayEnvironment())}/commerce/identity/v1/user/`, {
      headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    const error = new Error("Could not reach eBay to read account identity.") as Error & { cause?: unknown };
    error.cause = cause; throw error;
  }
  if (!response.ok) {
    const error = new Error("eBay account identity could not be read.") as Error & { status: number };
    error.status = response.status; throw error;
  }
  const body = await response.json();
  // PROVEN ROOT CAUSE FIX — the Identity API never returns email at the
  // top level (`body.email` was always undefined). The real response
  // nests it under the account-type-specific object: a business seller's
  // email is `businessAccount.email`, an individual seller's is
  // `individualAccount.email` — read the one matching `accountType` first
  // (the account genuinely IS that type), falling back to whichever
  // object eBay actually populated if `accountType` itself is missing.
  //
  // SCOPE CORRECTION — `commerce.identity.email.readonly` and
  // `commerce.identity.status.readonly` are NOT available on this eBay
  // keyset (manually verified in the Developer Portal) and are therefore
  // never requested (see EBAY_OAUTH_SCOPES above). This means email is
  // read PURELY DEFENSIVELY here, never required: `businessAccount.email`
  // is commonly present under the base `commerce.identity.readonly` scope
  // alone, but `individualAccount.email` may simply not be included
  // without the extra scope this app cannot request. A missing email is
  // therefore NORMAL and EXPECTED for many accounts (especially
  // individual sellers) — never treated as an error, never fabricated,
  // never inferred from the username or this app's own login email. The
  // UI shows exactly "Email not supplied by eBay" in that case (see
  // app/settings/page.tsx). `status` is read the same way — optional,
  // never assumed retrieved, never displayed as if a genuine value had
  // been confirmed when eBay simply omitted it.
  const businessEmail = typeof body.businessAccount?.email === "string" && body.businessAccount.email ? body.businessAccount.email : null;
  const individualEmail = typeof body.individualAccount?.email === "string" && body.individualAccount.email ? body.individualAccount.email : null;
  const email = body.accountType === "INDIVIDUAL" ? (individualEmail ?? businessEmail) : body.accountType === "BUSINESS" ? (businessEmail ?? individualEmail) : (businessEmail ?? individualEmail);
  return {
    userId: body.userId,
    email,
    accountType: body.accountType ?? null,
    registrationMarketplaceId: body.registrationMarketplaceId ?? null,
    // Optional — eBay may omit this without commerce.identity.status.readonly.
    status: typeof body.status === "string" && body.status ? body.status : null,
  };
}

export type EbayPolicyType = "FULFILLMENT" | "RETURN" | "PAYMENT";
export type RawEbayPolicy = { policyId: string; name: string; marketplaceId: string; details: unknown };

const POLICY_ENDPOINTS: Record<EbayPolicyType, { path: string; responseKey: string; idField: string }> = {
  FULFILLMENT: { path: "fulfillment_policy", responseKey: "fulfillmentPolicies", idField: "fulfillmentPolicyId" },
  RETURN: { path: "return_policy", responseKey: "returnPolicies", idField: "returnPolicyId" },
  PAYMENT: { path: "payment_policy", responseKey: "paymentPolicies", idField: "paymentPolicyId" },
};

/**
 * Retrieves every EBAY_GB policy of the given type. eBay's documented
 * getFulfillmentPolicies/getReturnPolicies/getPaymentPolicies calls do not
 * currently paginate (no limit/offset in their published schema — sellers
 * have few business policies, unlike inventory) — this still follows a
 * `next` link defensively if eBay's response ever includes one, so it
 * stays correct without fabricating pagination that doesn't exist today.
 * Never assumes a single response is complete without checking for that.
 */
export async function fetchEbayPolicies(accessToken: string, type: EbayPolicyType): Promise<RawEbayPolicy[]> {
  const endpoint = POLICY_ENDPOINTS[type];
  const results: RawEbayPolicy[] = [];
  let url: string | null = `${apiBase(ebayEnvironment())}/sell/account/v1/${endpoint.path}?marketplace_id=EBAY_GB`;
  let pages = 0;
  while (url && pages < 20) {
    pages += 1;
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    } catch (cause) {
      const error = new Error(`Could not reach eBay to read ${type.toLowerCase()} policies.`) as Error & { cause?: unknown };
      error.cause = cause; throw error;
    }
    if (!response.ok) {
      const error = new Error(`eBay ${type.toLowerCase()} policies could not be read.`) as Error & { status: number };
      error.status = response.status; throw error;
    }
    const body = await response.json();
    for (const item of (body[endpoint.responseKey] ?? []) as Array<Record<string, unknown>>) {
      results.push({ policyId: String(item[endpoint.idField]), name: String(item.name ?? ""), marketplaceId: String(item.marketplaceId ?? "EBAY_GB"), details: item });
    }
    url = typeof body.next === "string" ? body.next : null;
  }
  return results;
}
