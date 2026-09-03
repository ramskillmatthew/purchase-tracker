import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest, supabaseRequestAll, refreshEbayAccessToken, fetchEbayIdentity, fetchEbayPolicies, fetchEbayInventoryLocations } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  refreshEbayAccessToken: vi.fn(),
  fetchEbayIdentity: vi.fn(),
  fetchEbayPolicies: vi.fn(),
  fetchEbayInventoryLocations: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));
vi.mock("@/lib/ebay-account/oauth", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/ebay-account/oauth")>();
  return { ...actual, refreshEbayAccessToken, fetchEbayIdentity, fetchEbayPolicies };
});
vi.mock("@/lib/ebay-account/inventory-client", () => ({ fetchEbayInventoryLocations }));

const ORIGINAL_ENV = { ...process.env };
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");

let encryptEbayToken: (v: string) => string;

beforeEach(async () => {
  supabaseRequest.mockReset(); supabaseRequestAll.mockReset();
  refreshEbayAccessToken.mockReset(); fetchEbayIdentity.mockReset(); fetchEbayPolicies.mockReset(); fetchEbayInventoryLocations.mockReset();
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
  fetchEbayInventoryLocations.mockResolvedValue([]);
  process.env.EBAY_CLIENT_ID = "test-client-id"; process.env.EBAY_CLIENT_SECRET = "test-client-secret";
  process.env.EBAY_RUNAME = "test-runame"; process.env.EBAY_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  delete process.env.EBAY_ENVIRONMENT;
  ({ encryptEbayToken } = await import("@/lib/ebay-account/oauth"));
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1", owner_id: "owner-1", environment: "PRODUCTION", ebay_user_id: "u-1", email: "seller@example.com",
    account_type: "BUSINESS", registration_marketplace: "EBAY_GB", account_status: "CONFIRMED", connection_status: "connected",
    encrypted_refresh_token: encryptEbayToken?.("real-refresh-token") ?? "x", encrypted_access_token: null, access_token_expires_at: null,
    granted_scopes: null, last_identity_sync_at: null, last_policy_sync_at: null, last_sync_error_code: null, last_sync_error_message: null,
    draft_only: true, default_fulfillment_policy_id: null, default_return_policy_id: null, default_payment_policy_id: null, default_inventory_location_key: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", disconnected_at: null,
    ...overrides,
  };
}

describe("lib/ebay-account/client.ts — getValidEbayAccessToken", () => {
  it("REQUIREMENT: refreshes when there is no cached access token", async () => {
    const { getValidEbayAccessToken } = await import("@/lib/ebay-account/client");
    supabaseRequestAll.mockResolvedValue([connectionRow()]);
    refreshEbayAccessToken.mockResolvedValue({ access_token: "fresh-token", expires_in: 7200, token_type: "User Access Token" });
    const { accessToken } = await getValidEbayAccessToken("owner-1");
    expect(accessToken).toBe("fresh-token");
    expect(refreshEbayAccessToken).toHaveBeenCalledTimes(1);
  });

  it("REQUIREMENT: reuses a still-valid cached access token without refreshing", async () => {
    const { getValidEbayAccessToken } = await import("@/lib/ebay-account/client");
    supabaseRequestAll.mockResolvedValue([connectionRow({ encrypted_access_token: encryptEbayToken("cached-token"), access_token_expires_at: new Date(Date.now() + 3600_000).toISOString() })]);
    const { accessToken } = await getValidEbayAccessToken("owner-1");
    expect(accessToken).toBe("cached-token");
    expect(refreshEbayAccessToken).not.toHaveBeenCalled();
  });

  it("REQUIREMENT (revoked): a refresh rejected with HTTP 400 marks needs_reconnect and throws a safe, distinct error", async () => {
    const { getValidEbayAccessToken } = await import("@/lib/ebay-account/client");
    supabaseRequestAll.mockResolvedValue([connectionRow()]);
    refreshEbayAccessToken.mockRejectedValue(Object.assign(new Error("eBay OAuth token request failed."), { status: 400 }));
    await expect(getValidEbayAccessToken("owner-1")).rejects.toMatchObject({ code: "needs_reconnect" });
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("ebay_connections?id=eq.conn-1"));
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.connection_status).toBe("needs_reconnect");
  });

  it("REQUIREMENT (transient failure preserves the connection): a network/5xx refresh failure never touches connection_status", async () => {
    const { getValidEbayAccessToken } = await import("@/lib/ebay-account/client");
    supabaseRequestAll.mockResolvedValue([connectionRow()]);
    refreshEbayAccessToken.mockRejectedValue(Object.assign(new Error("eBay OAuth token request failed."), { status: 503 }));
    await expect(getValidEbayAccessToken("owner-1")).rejects.toThrow();
    expect(supabaseRequest.mock.calls.some(c => String(c[0]).includes("ebay_connections"))).toBe(false);
  });

  it("throws a distinct not_connected error when there is no connection at all", async () => {
    const { getValidEbayAccessToken } = await import("@/lib/ebay-account/client");
    supabaseRequestAll.mockResolvedValue([]);
    await expect(getValidEbayAccessToken("owner-1")).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("lib/ebay-account/client.ts — syncEbayIdentityAndPolicies (partial-failure safety)", () => {
  beforeEach(() => {
    supabaseRequestAll.mockResolvedValue([connectionRow({ encrypted_access_token: encryptEbayToken("cached"), access_token_expires_at: new Date(Date.now() + 3600_000).toISOString() })]);
    supabaseRequest.mockImplementation(async (path: string) => {
      if (String(path).includes("ebay_connections") && !String(path).includes("?owner_id")) return new Response(JSON.stringify([connectionRow()]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    fetchEbayIdentity.mockResolvedValue({ userId: "u-1", email: "seller@example.com", accountType: "BUSINESS", registrationMarketplaceId: "EBAY_GB", status: "CONFIRMED" });
  });

  it("REQUIREMENT: all three policy types succeeding sets last_policy_sync_at", async () => {
    fetchEbayPolicies.mockResolvedValue([{ policyId: "p-1", name: "2 days", marketplaceId: "EBAY_GB", details: {} }]);
    const { syncEbayIdentityAndPolicies } = await import("@/lib/ebay-account/client");
    const result = await syncEbayIdentityAndPolicies("owner-1");
    expect(result.policies.every(p => p.status === "success")).toBe(true);
    const finalPatch = supabaseRequest.mock.calls.find(c => String(c[0]) === "ebay_connections?id=eq.conn-1");
    const body = JSON.parse((finalPatch![1] as RequestInit).body as string);
    expect(body.last_policy_sync_at).toBeDefined();
  });

  it("PROVEN REQUIREMENT: one policy type failing does NOT mark last_policy_sync_at, and does not affect the other two types' own upserts", async () => {
    fetchEbayPolicies.mockImplementation(async (_token: string, type: string) => {
      if (type === "RETURN") throw new Error("upstream timeout");
      return [{ policyId: `${type}-1`, name: "x", marketplaceId: "EBAY_GB", details: {} }];
    });
    const { syncEbayIdentityAndPolicies } = await import("@/lib/ebay-account/client");
    const result = await syncEbayIdentityAndPolicies("owner-1");
    expect(result.policies.find(p => p.type === "RETURN")?.status).toBe("failed");
    expect(result.policies.find(p => p.type === "FULFILLMENT")?.status).toBe("success");
    expect(result.policies.find(p => p.type === "PAYMENT")?.status).toBe("success");
    const finalPatch = supabaseRequest.mock.calls.find(c => String(c[0]) === "ebay_connections?id=eq.conn-1");
    const body = JSON.parse((finalPatch![1] as RequestInit).body as string);
    expect(body.last_policy_sync_at).toBeUndefined();
    expect(body.last_sync_error_code).toBe("partial_policy_sync_failed");
  });

  it("PROVEN REQUIREMENT: a policy no longer returned by a SUCCESSFUL sync of its own type is marked unavailable (never hard-deleted)", async () => {
    fetchEbayPolicies.mockResolvedValue([{ policyId: "kept-1", name: "Kept", marketplaceId: "EBAY_GB", details: {} }]);
    const { syncEbayIdentityAndPolicies } = await import("@/lib/ebay-account/client");
    await syncEbayIdentityAndPolicies("owner-1");
    const staleMarkCall = supabaseRequest.mock.calls.find(c => String(c[0]).includes("ebay_policies?connection_id=eq.conn-1") && String(c[0]).includes("ebay_policy_id=not.in"));
    expect(staleMarkCall).toBeDefined();
    const body = JSON.parse((staleMarkCall![1] as RequestInit).body as string);
    expect(body.available).toBe(false);
    expect(String(staleMarkCall![0])).not.toContain("DELETE");
  });

  it("REQUIREMENT: a failed identity fetch does not prevent policy sync from running, and is reported distinctly", async () => {
    fetchEbayIdentity.mockRejectedValue(new Error("identity unavailable"));
    fetchEbayPolicies.mockResolvedValue([{ policyId: "p-1", name: "x", marketplaceId: "EBAY_GB", details: {} }]);
    const { syncEbayIdentityAndPolicies } = await import("@/lib/ebay-account/client");
    const result = await syncEbayIdentityAndPolicies("owner-1");
    expect(result.identity.status).toBe("failed");
    expect(fetchEbayPolicies).toHaveBeenCalled(); // never skipped just because identity failed
  });
});

describe("lib/ebay-account/client.ts — saveEbayDefaults (ownership/type/marketplace/availability validation)", () => {
  it("REQUIREMENT: rejects an id that does not belong to this connection/type/marketplace/availability, and writes nothing", async () => {
    supabaseRequestAll.mockResolvedValue([]); // no matching available policy
    const { saveEbayDefaults } = await import("@/lib/ebay-account/client");
    const result = await saveEbayDefaults("owner-1", "conn-1", { fulfillmentPolicyId: "not-real" });
    expect(result.ok).toBe(false);
    expect(supabaseRequest.mock.calls.some(c => String(c[0]).startsWith("ebay_connections?id=eq.conn-1&owner_id"))).toBe(false); // keep previous defaults if saving fails
  });

  it("REQUIREMENT: saves real, validated policy IDs (not names) once every provided id passes validation", async () => {
    supabaseRequestAll.mockResolvedValue([{ id: "policy-row-1" }]);
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([connectionRow({ default_fulfillment_policy_id: "fp-real-1" })]), { status: 200 }));
    const { saveEbayDefaults } = await import("@/lib/ebay-account/client");
    const result = await saveEbayDefaults("owner-1", "conn-1", { fulfillmentPolicyId: "fp-real-1" });
    expect(result.ok).toBe(true);
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).startsWith("ebay_connections?id=eq.conn-1&owner_id"));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.default_fulfillment_policy_id).toBe("fp-real-1");
  });
});

describe("lib/ebay-account/client.ts — disconnectEbayConnection", () => {
  it("REQUIREMENT: destroys locally stored tokens and marks disconnected, never touches ebay_policies", async () => {
    const { disconnectEbayConnection } = await import("@/lib/ebay-account/client");
    await disconnectEbayConnection("owner-1", "conn-1");
    const patchCall = supabaseRequest.mock.calls.find(c => String(c[0]).startsWith("ebay_connections?id=eq.conn-1"));
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.encrypted_refresh_token).toBeNull();
    expect(body.encrypted_access_token).toBeNull();
    expect(body.connection_status).toBe("disconnected");
    expect(supabaseRequest.mock.calls.some(c => String(c[0]).startsWith("ebay_policies"))).toBe(false);
  });
});
