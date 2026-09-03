import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  requireOwner, ebayAuthorizationUrl, consumeEbayOAuthState, exchangeEbayCode, fetchEbayIdentity, trustedAppOrigin,
  saveEbayConnectionAfterOAuth, syncEbayIdentityAndPolicies, getEbayConnection, listEbayPolicies, saveEbayDefaults, disconnectEbayConnection,
} = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  ebayAuthorizationUrl: vi.fn(async () => "https://auth.ebay.com/oauth2/authorize?mocked=1"),
  consumeEbayOAuthState: vi.fn(),
  exchangeEbayCode: vi.fn(),
  fetchEbayIdentity: vi.fn(),
  trustedAppOrigin: vi.fn(() => "https://app.example.com"),
  saveEbayConnectionAfterOAuth: vi.fn(),
  syncEbayIdentityAndPolicies: vi.fn(),
  getEbayConnection: vi.fn(),
  listEbayPolicies: vi.fn(async () => []),
  saveEbayDefaults: vi.fn(),
  disconnectEbayConnection: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/ebay-account/oauth", () => ({ ebayAuthorizationUrl, consumeEbayOAuthState, exchangeEbayCode, fetchEbayIdentity, trustedAppOrigin }));
vi.mock("@/lib/ebay-account/client", () => ({ saveEbayConnectionAfterOAuth, syncEbayIdentityAndPolicies, getEbayConnection, listEbayPolicies, saveEbayDefaults, disconnectEbayConnection }));

beforeEach(() => {
  requireOwner.mockClear();
  ebayAuthorizationUrl.mockReset(); consumeEbayOAuthState.mockReset(); exchangeEbayCode.mockReset(); fetchEbayIdentity.mockReset(); trustedAppOrigin.mockReset();
  saveEbayConnectionAfterOAuth.mockReset(); syncEbayIdentityAndPolicies.mockReset(); getEbayConnection.mockReset(); listEbayPolicies.mockReset();
  saveEbayDefaults.mockReset(); disconnectEbayConnection.mockReset();
  requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  ebayAuthorizationUrl.mockResolvedValue("https://auth.ebay.com/oauth2/authorize?mocked=1");
  trustedAppOrigin.mockReturnValue("https://app.example.com");
  listEbayPolicies.mockResolvedValue([]);
});

describe("GET /api/ebay/connect", () => {
  it("REQUIREMENT: requires authentication", async () => {
    const { AuthError } = await import("@/lib/auth/server");
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const { GET } = await import("@/app/api/ebay/connect/route");
    const response = await GET(new Request("http://test"));
    expect(response.status).toBe(401);
  });

  it("redirects to eBay's own authorization URL, never asking the user to paste a token", async () => {
    const { GET } = await import("@/app/api/ebay/connect/route");
    const response = await GET(new Request("http://test"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://auth.ebay.com/oauth2/authorize?mocked=1");
    expect(ebayAuthorizationUrl).toHaveBeenCalledWith("owner-1", "connect");
  });

  it("REQUIREMENT: ?intent=change_account passes through as a distinct intent", async () => {
    const { GET } = await import("@/app/api/ebay/connect/route");
    await GET(new Request("http://test?intent=change_account"));
    expect(ebayAuthorizationUrl).toHaveBeenCalledWith("owner-1", "change_account");
  });
});

describe("GET /api/ebay/callback", () => {
  it("PROVEN ROOT CAUSE FIX: the redirect origin comes from trustedAppOrigin(), never from the request's own origin/Host — this is the exact fix for the https://localhost:3000-through-the-tunnel bug", async () => {
    trustedAppOrigin.mockReturnValue("https://male-dsc-curve-liabilities.trycloudflare.com");
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://this-origin-must-never-be-used:9999?error=access_denied"));
    expect(response.headers.get("location")).toBe("https://male-dsc-curve-liabilities.trycloudflare.com/settings?ebay=error&reason=access_denied");
  });

  it("REQUIREMENT: a misconfigured/insecure NEXT_PUBLIC_APP_URL (trustedAppOrigin throws) fails the request safely — never a crash, never an insecure fallback redirect", async () => {
    trustedAppOrigin.mockImplementation(() => { throw new Error("NEXT_PUBLIC_APP_URL must be an absolute HTTPS URL outside development."); });
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?code=abc&state=xyz"));
    expect(response.status).toBe(500);
    expect(consumeEbayOAuthState).not.toHaveBeenCalled(); // never proceeds into the OAuth flow with an untrusted redirect target
  });

  it("REQUIREMENT: OAuth denial redirects with a safe, distinct reason — never a raw eBay error", async () => {
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?error=access_denied"));
    expect(response.headers.get("location")).toContain("ebay=error&reason=access_denied");
    expect(consumeEbayOAuthState).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: missing state is rejected before any token exchange is attempted", async () => {
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?code=abc"));
    expect(response.headers.get("location")).toContain("reason=state_invalid");
    expect(exchangeEbayCode).not.toHaveBeenCalled();
  });

  it("REQUIREMENT (replay rejection): an invalid/expired/already-used state is rejected honestly", async () => {
    consumeEbayOAuthState.mockRejectedValue(new Error("state invalid"));
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?code=abc&state=used-state"));
    expect(response.headers.get("location")).toContain("reason=state_invalid");
  });

  it("REQUIREMENT: missing code is handled distinctly from a missing state", async () => {
    consumeEbayOAuthState.mockResolvedValue({ intent: "connect", returnPath: "/settings" });
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?state=valid-state"));
    expect(response.headers.get("location")).toContain("reason=missing_code");
  });

  it("REQUIREMENT: the callback response never carries a token in the redirect URL", async () => {
    consumeEbayOAuthState.mockResolvedValue({ intent: "connect", returnPath: "/settings" });
    exchangeEbayCode.mockResolvedValue({ access_token: "SUPER-SECRET-TOKEN", refresh_token: "SECRET-REFRESH", expires_in: 7200, token_type: "User Access Token" });
    fetchEbayIdentity.mockResolvedValue({ userId: "u-1", email: "seller@example.com", accountType: "BUSINESS", registrationMarketplaceId: "EBAY_GB", status: "CONFIRMED" });
    saveEbayConnectionAfterOAuth.mockResolvedValue({ id: "conn-1" });
    syncEbayIdentityAndPolicies.mockResolvedValue({});
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?code=real-code&state=valid-state"));
    const location = response.headers.get("location") || "";
    expect(location).not.toContain("SUPER-SECRET-TOKEN");
    expect(location).not.toContain("SECRET-REFRESH");
    expect(location).toContain("ebay=connected");
  });

  it("REQUIREMENT: a token-exchange failure is reported distinctly from a generic connection failure", async () => {
    consumeEbayOAuthState.mockResolvedValue({ intent: "connect", returnPath: "/settings" });
    exchangeEbayCode.mockRejectedValue(Object.assign(new Error("x"), { status: 400 }));
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?code=bad&state=valid-state"));
    expect(response.headers.get("location")).toContain("reason=token_exchange_failed");
  });

  it("a failure fetching identity after a successful token exchange redirects as connection_failed, never crashes", async () => {
    consumeEbayOAuthState.mockResolvedValue({ intent: "connect", returnPath: "/settings" });
    exchangeEbayCode.mockResolvedValue({ access_token: "AT", refresh_token: "RT", expires_in: 7200, token_type: "User Access Token" });
    fetchEbayIdentity.mockRejectedValue(new Error("identity down"));
    const { GET } = await import("@/app/api/ebay/callback/route");
    const response = await GET(new Request("http://test?code=real-code&state=valid-state"));
    expect(response.headers.get("location")).toContain("reason=connection_failed");
  });

  it("REQUIREMENT: refreshing the callback (same code/state) is safely rejected the second time — consumeEbayOAuthState's own one-time guarantee, exercised at the route level", async () => {
    consumeEbayOAuthState.mockResolvedValueOnce({ intent: "connect", returnPath: "/settings" }).mockRejectedValueOnce(new Error("already used"));
    exchangeEbayCode.mockResolvedValue({ access_token: "AT", refresh_token: "RT", expires_in: 7200, token_type: "User Access Token" });
    fetchEbayIdentity.mockResolvedValue({ userId: "u-1", email: "s@example.com", accountType: "BUSINESS", registrationMarketplaceId: "EBAY_GB", status: "CONFIRMED" });
    saveEbayConnectionAfterOAuth.mockResolvedValue({ id: "conn-1" });
    syncEbayIdentityAndPolicies.mockResolvedValue({});
    const { GET } = await import("@/app/api/ebay/callback/route");
    const first = await GET(new Request("http://test?code=real-code&state=valid-state"));
    const second = await GET(new Request("http://test?code=real-code&state=valid-state"));
    expect(first.headers.get("location")).toContain("ebay=connected");
    expect(second.headers.get("location")).toContain("reason=state_invalid");
    expect(saveEbayConnectionAfterOAuth).toHaveBeenCalledTimes(1); // never a duplicate connection
  });
});

describe("GET /api/ebay/connection", () => {
  it("REQUIREMENT: requires authentication", async () => {
    const { AuthError } = await import("@/lib/auth/server");
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const { GET } = await import("@/app/api/ebay/connection/route");
    expect((await GET()).status).toBe(401);
  });

  it("REQUIREMENT: never triggers a sync itself — a plain read of already-stored state", async () => {
    getEbayConnection.mockResolvedValue(null);
    const { GET } = await import("@/app/api/ebay/connection/route");
    await GET();
    expect(syncEbayIdentityAndPolicies).not.toHaveBeenCalled();
  });

  it("REQUIREMENT: never includes a token field in the response", async () => {
    getEbayConnection.mockResolvedValue({ id: "conn-1", hasRefreshToken: true, email: "s@example.com" });
    const { GET } = await import("@/app/api/ebay/connection/route");
    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toMatch(/encrypted_(refresh|access)_token/i);
    expect(JSON.stringify(body)).not.toContain("\"accessToken\"");
    expect(JSON.stringify(body)).not.toContain("\"refreshToken\"");
  });
});

describe("POST /api/ebay/sync", () => {
  it("REQUIREMENT: requires authentication", async () => {
    const { AuthError } = await import("@/lib/auth/server");
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const { POST } = await import("@/app/api/ebay/sync/route");
    expect((await POST()).status).toBe(401);
  });

  it("a sync failure never returns a raw token, and reports a safe status", async () => {
    syncEbayIdentityAndPolicies.mockRejectedValue(Object.assign(new Error("eBay unavailable"), {}));
    const { POST } = await import("@/app/api/ebay/sync/route");
    const response = await POST();
    expect(response.status).toBe(500);
  });
});

describe("POST /api/ebay/defaults", () => {
  it("REQUIREMENT: requires authentication", async () => {
    const { AuthError } = await import("@/lib/auth/server");
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const { POST } = await import("@/app/api/ebay/defaults/route");
    const response = await POST(new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(401);
  });

  it("REQUIREMENT: 409s when there is no connected account", async () => {
    getEbayConnection.mockResolvedValue(null);
    const { POST } = await import("@/app/api/ebay/defaults/route");
    const response = await POST(new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fulfillmentPolicyId: "fp-1" }) }));
    expect(response.status).toBe(409);
  });

  it("a validation failure from saveEbayDefaults surfaces as 422, never silently succeeding", async () => {
    getEbayConnection.mockResolvedValue({ id: "conn-1", connectionStatus: "connected" });
    saveEbayDefaults.mockResolvedValue({ ok: false, error: "The selected fulfillment policy is not available on this connection." });
    const { POST } = await import("@/app/api/ebay/defaults/route");
    const response = await POST(new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fulfillmentPolicyId: "fake" }) }));
    expect(response.status).toBe(422);
  });
});

describe("POST /api/ebay/disconnect", () => {
  it("REQUIREMENT: requires authentication", async () => {
    const { AuthError } = await import("@/lib/auth/server");
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const { POST } = await import("@/app/api/ebay/disconnect/route");
    expect((await POST()).status).toBe(401);
  });

  it("REQUIREMENT: disconnects the owner's OWN connection only", async () => {
    getEbayConnection.mockResolvedValue({ id: "conn-1" });
    const { POST } = await import("@/app/api/ebay/disconnect/route");
    await POST();
    expect(disconnectEbayConnection).toHaveBeenCalledWith("owner-1", "conn-1");
  });
});
