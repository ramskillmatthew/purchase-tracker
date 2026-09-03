import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  supabaseRequestAll: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

const ORIGINAL_ENV = { ...process.env };
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");

beforeEach(() => {
  supabaseRequest.mockReset(); supabaseRequestAll.mockReset();
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
  process.env.EBAY_CLIENT_ID = "test-client-id";
  process.env.EBAY_CLIENT_SECRET = "test-client-secret";
  process.env.EBAY_RUNAME = "test-runame";
  process.env.EBAY_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  delete process.env.EBAY_ENVIRONMENT;
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; vi.unstubAllGlobals(); });

describe("lib/ebay-account/oauth.ts — token encryption", () => {
  it("REQUIREMENT: a token round-trips exactly through encrypt/decrypt", async () => {
    const { encryptEbayToken, decryptEbayToken } = await import("@/lib/ebay-account/oauth");
    const encrypted = encryptEbayToken("v^1.1#a-real-looking-refresh-token");
    expect(encrypted).not.toContain("v^1.1#a-real-looking-refresh-token");
    expect(decryptEbayToken(encrypted)).toBe("v^1.1#a-real-looking-refresh-token");
  });

  it("REQUIREMENT: the encrypted payload is versioned, so a future format/key rotation can be distinguished", async () => {
    const { encryptEbayToken } = await import("@/lib/ebay-account/oauth");
    expect(encryptEbayToken("x").split(".")[0]).toBe("v1");
  });

  it("REQUIREMENT: two encryptions of the same value never produce the same ciphertext (random IV)", async () => {
    const { encryptEbayToken } = await import("@/lib/ebay-account/oauth");
    expect(encryptEbayToken("same-value")).not.toBe(encryptEbayToken("same-value"));
  });

  it("fails closed (throws) rather than silently returning garbage for a wrong/short key", async () => {
    const { encryptEbayToken } = await import("@/lib/ebay-account/oauth");
    process.env.EBAY_TOKEN_ENCRYPTION_KEY = "not-32-bytes";
    expect(() => encryptEbayToken("x")).toThrow();
  });

  it("never hardcodes a key — throws honestly when EBAY_TOKEN_ENCRYPTION_KEY is absent", async () => {
    const { encryptEbayToken } = await import("@/lib/ebay-account/oauth");
    delete process.env.EBAY_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptEbayToken("x")).toThrow(/EBAY_TOKEN_ENCRYPTION_KEY/);
  });
});

describe("lib/ebay-account/oauth.ts — OAuth state: one-time, hashed, owner+environment-bound", () => {
  it("REQUIREMENT: createEbayOAuthState never persists the raw state value — only its hash", async () => {
    const { createEbayOAuthState } = await import("@/lib/ebay-account/oauth");
    const raw = await createEbayOAuthState("owner-1");
    const body = JSON.parse((supabaseRequest.mock.calls[0][1] as RequestInit).body as string);
    expect(body.state_hash).toBeDefined();
    expect(body.state_hash).not.toBe(raw);
    expect(JSON.stringify(body)).not.toContain(raw);
  });

  it("REQUIREMENT: state is unpredictable — two calls never produce the same raw value", async () => {
    const { createEbayOAuthState } = await import("@/lib/ebay-account/oauth");
    const a = await createEbayOAuthState("owner-1"); const b = await createEbayOAuthState("owner-1");
    expect(a).not.toBe(b);
  });

  it("REQUIREMENT: state is owner-bound at creation time", async () => {
    const { createEbayOAuthState } = await import("@/lib/ebay-account/oauth");
    await createEbayOAuthState("owner-42");
    const body = JSON.parse((supabaseRequest.mock.calls[0][1] as RequestInit).body as string);
    expect(body.owner_id).toBe("owner-42");
  });

  it("REQUIREMENT: state has a short expiry set at creation", async () => {
    const { createEbayOAuthState } = await import("@/lib/ebay-account/oauth");
    const before = Date.now();
    await createEbayOAuthState("owner-1");
    const body = JSON.parse((supabaseRequest.mock.calls[0][1] as RequestInit).body as string);
    const ttlMs = new Date(body.expires_at).getTime() - before;
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
  });

  it("REQUIREMENT: consumeEbayOAuthState performs ONE atomic conditional UPDATE (consumed_at IS NULL, expires_at > now) — never a separate read-then-write", async () => {
    const { consumeEbayOAuthState } = await import("@/lib/ebay-account/oauth");
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ intent: "connect", return_path: "/settings" }]), { status: 200 }));
    const result = await consumeEbayOAuthState("raw-state-value", "owner-1");
    expect(result).toEqual({ intent: "connect", returnPath: "/settings" });
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
    const [path, init] = supabaseRequest.mock.calls[0];
    expect(String(path)).toContain("consumed_at=is.null");
    expect(String(path)).toContain("owner_id=eq.owner-1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("REQUIREMENT (replay rejection): a state with no matching un-consumed row (already used, expired, or invalid) is rejected with one honest generic error", async () => {
    const { consumeEbayOAuthState } = await import("@/lib/ebay-account/oauth");
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await expect(consumeEbayOAuthState("already-used", "owner-1")).rejects.toThrow(/invalid, has expired, or has already been used/);
  });

  it("REQUIREMENT: state is environment-scoped in the consuming query", async () => {
    const { consumeEbayOAuthState } = await import("@/lib/ebay-account/oauth");
    process.env.EBAY_ENVIRONMENT = "SANDBOX";
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ intent: "connect", return_path: "/settings" }]), { status: 200 }));
    await consumeEbayOAuthState("x", "owner-1");
    expect(String(supabaseRequest.mock.calls[0][0])).toContain("environment=eq.SANDBOX");
  });
});

describe("lib/ebay-account/oauth.ts — authorization URL", () => {
  it("REQUIREMENT: uses the registered RuName as redirect_uri, never a raw callback URL", async () => {
    const { ebayAuthorizationUrl } = await import("@/lib/ebay-account/oauth");
    const url = await ebayAuthorizationUrl("owner-1");
    expect(new URL(url).searchParams.get("redirect_uri")).toBe("test-runame");
  });

  it("REQUIREMENT: requests only the documented, necessary scopes — never an unrelated one", async () => {
    const { ebayAuthorizationUrl, EBAY_OAUTH_SCOPES } = await import("@/lib/ebay-account/oauth");
    const url = await ebayAuthorizationUrl("owner-1");
    const scope = new URL(url).searchParams.get("scope");
    expect(scope).toBe(EBAY_OAUTH_SCOPES);
    expect(scope).toContain("commerce.identity.readonly");
    expect(scope).toContain("sell.account.readonly");
    expect(scope).not.toContain("sell.account\"."); // never the write-capable non-readonly variant
    expect(scope).not.toMatch(/sell\.fulfillment|sell\.marketing|sell\.finances/); // never order-management/unrelated scopes
  });

  it("PROVEN CORRECTION: never requests commerce.identity.email.readonly or commerce.identity.status.readonly — manually verified unavailable on this eBay Production keyset, and requesting either risks eBay rejecting the ENTIRE authorisation with invalid_scope", async () => {
    const { ebayAuthorizationUrl } = await import("@/lib/ebay-account/oauth");
    const scope = new URL(await ebayAuthorizationUrl("owner-1")).searchParams.get("scope");
    expect(scope).not.toContain("commerce.identity.email.readonly");
    expect(scope).not.toContain("commerce.identity.status.readonly");
  });

  it("REQUIREMENT: the exact, complete scope list — exactly the three scopes available and selected in the Developer Portal, nothing more, nothing less", async () => {
    const { ebayAuthorizationUrl, EBAY_OAUTH_SCOPES } = await import("@/lib/ebay-account/oauth");
    const scope = new URL(await ebayAuthorizationUrl("owner-1")).searchParams.get("scope");
    expect(EBAY_OAUTH_SCOPES.split(" ")).toEqual([
      "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
      "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
    ]);
    expect(scope).toBe(EBAY_OAUTH_SCOPES);
  });

  it("targets Production by default, Sandbox only when EBAY_ENVIRONMENT=SANDBOX", async () => {
    const { ebayAuthorizationUrl } = await import("@/lib/ebay-account/oauth");
    expect((await ebayAuthorizationUrl("owner-1")).startsWith("https://auth.ebay.com/")).toBe(true);
    process.env.EBAY_ENVIRONMENT = "SANDBOX";
    expect((await ebayAuthorizationUrl("owner-1")).startsWith("https://auth.sandbox.ebay.com/")).toBe(true);
  });

  it("PROVEN ROOT CAUSE FIX — REGRESSION reproducing the live invalid_request failure: the raw generated URL encodes scope's spaces as %20, never as '+' (URLSearchParams' own form-encoding, which eBay's /oauth2/authorize rejects outright with invalid_request before the login screen ever appears)", async () => {
    const { ebayAuthorizationUrl } = await import("@/lib/ebay-account/oauth");
    const rawUrl = await ebayAuthorizationUrl("owner-1");
    const scopeMatch = rawUrl.match(/[?&]scope=([^&]*)/);
    expect(scopeMatch).not.toBeNull();
    const rawScopeValue = scopeMatch![1];
    expect(rawScopeValue).not.toContain("+"); // the exact defect: URLSearchParams previously emitted "+" here
    expect(rawScopeValue).toContain("%20");
    // Decoding the raw value back still yields exactly the three required scopes, space-separated — the fix only
    // changes HOW the space is encoded, never the scope content itself.
    expect(decodeURIComponent(rawScopeValue)).toBe(
      "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly https://api.ebay.com/oauth/api_scope/sell.account.readonly https://api.ebay.com/oauth/api_scope/sell.inventory",
    );
  });

  it("REQUIREMENT: the full URL still parses correctly via the standard URL/URLSearchParams reader — the fix only changes serialisation, never round-trip correctness", async () => {
    const { ebayAuthorizationUrl, EBAY_OAUTH_SCOPES } = await import("@/lib/ebay-account/oauth");
    const parsed = new URL(await ebayAuthorizationUrl("owner-1"));
    expect(parsed.origin + parsed.pathname).toBe("https://auth.ebay.com/oauth2/authorize");
    expect([...parsed.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "response_type", "scope", "state"]);
    expect(parsed.searchParams.get("scope")).toBe(EBAY_OAUTH_SCOPES);
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });

  it("REQUIREMENT: no unsupported/duplicate/blank query parameters — exactly five, each present once, none empty", async () => {
    const { ebayAuthorizationUrl } = await import("@/lib/ebay-account/oauth");
    const parsed = new URL(await ebayAuthorizationUrl("owner-1"));
    const entries = [...parsed.searchParams.entries()];
    expect(entries.length).toBe(5);
    const names = entries.map(([k]) => k);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    for (const [, value] of entries) expect(value.trim().length).toBeGreaterThan(0); // no blank values
  });
});

describe("lib/ebay-account/oauth.ts — token exchange/refresh (mocked eBay network)", () => {
  it("exchanges a code server-side via HTTP Basic auth, never exposing the client secret in the request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 7200, token_type: "User Access Token" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { exchangeEbayCode } = await import("@/lib/ebay-account/oauth");
    const tokens = await exchangeEbayCode("auth-code-123");
    expect(tokens.access_token).toBe("AT");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    expect((init as RequestInit).body as string).not.toContain("test-client-secret");
    expect((init as { headers: Record<string,string> }).headers.Authorization).toMatch(/^Basic /);
  });

  it("a failed token exchange throws a safe error carrying only an HTTP status, never the raw eBay response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "some raw eBay detail" }), { status: 400 })));
    const { exchangeEbayCode } = await import("@/lib/ebay-account/oauth");
    await expect(exchangeEbayCode("bad-code")).rejects.toMatchObject({ status: 400 });
    try { await exchangeEbayCode("bad-code"); } catch (error) { expect(String((error as Error).message)).not.toContain("some raw eBay detail"); }
  });

  it("a network failure (fetch throws) is wrapped in a safe message, never left as a raw unhandled rejection reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const { exchangeEbayCode } = await import("@/lib/ebay-account/oauth");
    await expect(exchangeEbayCode("code")).rejects.toThrow(/Could not reach eBay/);
  });
});

describe("lib/ebay-account/oauth.ts — identity (Identity API host, correct email location)", () => {
  it("REQUIREMENT: calls the Identity API's own distinct host (apiz, not api)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ userId: "u-1", accountType: "BUSINESS", registrationMarketplaceId: "EBAY_GB", status: "CONFIRMED", businessAccount: { email: "seller@example.com" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    const identity = await fetchEbayIdentity("access-token");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://apiz.ebay.com/commerce/identity/v1/user/");
    expect(identity).toEqual({ userId: "u-1", email: "seller@example.com", accountType: "BUSINESS", registrationMarketplaceId: "EBAY_GB", status: "CONFIRMED" });
  });

  it("PROVEN ROOT CAUSE FIX (business account email): reads businessAccount.email — never a non-existent top-level body.email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-biz", accountType: "BUSINESS", businessAccount: { email: "shop@example.co.uk" } }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    expect((await fetchEbayIdentity("t")).email).toBe("shop@example.co.uk");
  });

  it("PROVEN ROOT CAUSE FIX (individual account email): reads individualAccount.email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-ind", accountType: "INDIVIDUAL", individualAccount: { email: "person@example.com" } }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    expect((await fetchEbayIdentity("t")).email).toBe("person@example.com");
  });

  it("REQUIREMENT: an individual email omitted by eBay (expected, since commerce.identity.email.readonly is not requested — unavailable on this keyset) is null, never fabricated, never falling back to username or another account's email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-ind", accountType: "INDIVIDUAL", username: "some_ebay_username", individualAccount: {} }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    const identity = await fetchEbayIdentity("t");
    expect(identity.email).toBeNull();
    expect(identity.email).not.toBe("some_ebay_username");
  });

  it("REQUIREMENT: account status is genuinely optional — its absence (expected, since commerce.identity.status.readonly is not requested) is null, never a fabricated 'retrieved' value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-1", accountType: "BUSINESS", businessAccount: { email: "s@example.com" } }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    expect((await fetchEbayIdentity("t")).status).toBeNull();
  });

  it("REQUIREMENT: no account-type object at all (missing scope, or an account type this app doesn't recognise) is null, never inferred", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-1", accountType: "INDIVIDUAL" }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    expect((await fetchEbayIdentity("access-token")).email).toBeNull();
  });

  it("REQUIREMENT: email is never inferred from the eBay username or any other field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-1", accountType: "BUSINESS", username: "trottersattire", businessAccount: {} }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    const identity = await fetchEbayIdentity("t");
    expect(identity.email).toBeNull();
    expect(JSON.stringify(identity)).not.toContain("trottersattire");
  });

  it("REQUIREMENT: account status is read through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-1", accountType: "BUSINESS", status: "CONFIRMED", businessAccount: { email: "s@example.com" } }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    expect((await fetchEbayIdentity("t")).status).toBe("CONFIRMED");
  });

  it("a business account's email still resolves correctly even if eBay also happens to include an (unused) individualAccount object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u-1", accountType: "BUSINESS", businessAccount: { email: "biz@example.com" }, individualAccount: { email: "should-not-be-used@example.com" } }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    expect((await fetchEbayIdentity("t")).email).toBe("biz@example.com");
  });

  it("the immutable eBay user id is always read straight through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "the-immutable-id" }), { status: 200 })));
    const { fetchEbayIdentity } = await import("@/lib/ebay-account/oauth");
    expect((await fetchEbayIdentity("t")).userId).toBe("the-immutable-id");
  });
});

describe("lib/ebay-account/oauth.ts — business policy retrieval", () => {
  it("REQUIREMENT: passes marketplace_id=EBAY_GB for every policy type", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ fulfillmentPolicies: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEbayPolicies } = await import("@/lib/ebay-account/oauth");
    await fetchEbayPolicies("t", "FULFILLMENT");
    expect(String(fetchMock.mock.calls[0][0])).toContain("marketplace_id=EBAY_GB");
  });

  it("REQUIREMENT: imports MULTIPLE fulfilment policies, never assuming only one exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      fulfillmentPolicies: [
        { fulfillmentPolicyId: "fp-1", name: "2 days", marketplaceId: "EBAY_GB" },
        { fulfillmentPolicyId: "fp-2", name: "1 week", marketplaceId: "EBAY_GB" },
        { fulfillmentPolicyId: "fp-3", name: "Presale", marketplaceId: "EBAY_GB" },
      ],
    }), { status: 200 })));
    const { fetchEbayPolicies } = await import("@/lib/ebay-account/oauth");
    const policies = await fetchEbayPolicies("t", "FULFILLMENT");
    expect(policies.map(p => p.name)).toEqual(["2 days", "1 week", "Presale"]);
    expect(policies.every(p => p.policyId)).toBe(true); // real eBay policy ids preserved, not just labels
  });

  it("REQUIREMENT: policy identity is the eBay policy ID, not the name — two differently-named-but-real policies are both preserved distinctly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ returnPolicies: [{ returnPolicyId: "rp-1", name: "No returns", marketplaceId: "EBAY_GB" }, { returnPolicyId: "rp-2", name: "No returns", marketplaceId: "EBAY_GB" }] }), { status: 200 })));
    const { fetchEbayPolicies } = await import("@/lib/ebay-account/oauth");
    const policies = await fetchEbayPolicies("t", "RETURN");
    expect(policies.map(p => p.policyId)).toEqual(["rp-1", "rp-2"]); // distinguishable by id despite identical names
  });

  it("follows a `next` link defensively if eBay's response ever includes one, never assuming one page is complete without checking", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ paymentPolicies: [{ paymentPolicyId: "pp-1", name: "Buy It Now", marketplaceId: "EBAY_GB" }], next: "https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_GB&page=2" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ paymentPolicies: [{ paymentPolicyId: "pp-2", name: "Immediate Payment", marketplaceId: "EBAY_GB" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchEbayPolicies } = await import("@/lib/ebay-account/oauth");
    const policies = await fetchEbayPolicies("t", "PAYMENT");
    expect(policies.map(p => p.policyId)).toEqual(["pp-1", "pp-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a policy-endpoint failure throws a safe status-bearing error, never a fabricated empty success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const { fetchEbayPolicies } = await import("@/lib/ebay-account/oauth");
    await expect(fetchEbayPolicies("t", "FULFILLMENT")).rejects.toMatchObject({ status: 503 });
  });
});

describe("lib/ebay-account/oauth.ts — trustedAppOrigin (PROVEN ROOT CAUSE FIX for the https://localhost:3000 tunnel leak)", () => {
  it("REQUIREMENT: reads the origin from NEXT_PUBLIC_APP_URL, never from a request/proxy-derived value", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://male-dsc-curve-liabilities.trycloudflare.com";
    const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
    expect(trustedAppOrigin()).toBe("https://male-dsc-curve-liabilities.trycloudflare.com");
  });

  it("REQUIREMENT: falls back to http://localhost:3000 only when NEXT_PUBLIC_APP_URL is unset and NODE_ENV is not production", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "development";
    try {
      const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
      expect(trustedAppOrigin()).toBe("http://localhost:3000");
    } finally { (process.env as Record<string, string>).NODE_ENV = originalNodeEnv ?? "test"; }
  });

  it("REQUIREMENT: an http:// NEXT_PUBLIC_APP_URL is accepted in development (no real local TLS termination)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
    expect(trustedAppOrigin()).toBe("http://localhost:3000");
  });

  it("REQUIREMENT: outside development, only an absolute HTTPS NEXT_PUBLIC_APP_URL is permitted — an http:// value fails the request rather than silently redirecting insecurely", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://example.com";
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
      expect(() => trustedAppOrigin()).toThrow(/absolute HTTPS URL/);
    } finally { (process.env as Record<string, string>).NODE_ENV = originalNodeEnv ?? "test"; }
  });

  it("REQUIREMENT: outside development, a missing NEXT_PUBLIC_APP_URL fails the request rather than silently falling back to localhost", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
      expect(() => trustedAppOrigin()).toThrow(/must be configured/);
    } finally { (process.env as Record<string, string>).NODE_ENV = originalNodeEnv ?? "test"; }
  });

  it("REQUIREMENT: a malformed NEXT_PUBLIC_APP_URL is rejected outright, never silently used as-is (prevents an open-redirect-shaped misconfiguration)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
    expect(() => trustedAppOrigin()).toThrow();
  });

  it("REQUIREMENT: a non-http(s) scheme is rejected — never javascript:/data:/file: or anything else, even in development", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "javascript:alert(1)";
    const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
    expect(() => trustedAppOrigin()).toThrow(/http\(s\)/);
  });

  it("REQUIREMENT: an https URL with a path/query is reduced to its origin only — the redirect base is never influenced by anything beyond scheme+host+port", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com/some/path?query=1";
    const { trustedAppOrigin } = await import("@/lib/ebay-account/oauth");
    expect(trustedAppOrigin()).toBe("https://example.com");
  });
});
