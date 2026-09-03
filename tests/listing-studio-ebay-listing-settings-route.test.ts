import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, getMarketplaceDraft, patchMarketplaceDraft, getEbayConnection, listEbayPolicies } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  getMarketplaceDraft: vi.fn(),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
  getEbayConnection: vi.fn(),
  listEbayPolicies: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ getMarketplaceDraft, patchMarketplaceDraft }));
vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection, listEbayPolicies }));

const { PATCH: route } = await import("@/app/api/listing-studio/groups/[draftId]/ebay-listing-settings/route");

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ draftId: DRAFT_ID }) }; }
function jsonRequest(body: unknown) { return new Request("http://test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdraft-1", pricePence: null, ebayFulfillmentPolicyId: null, ebayReturnPolicyId: null, ebayPaymentPolicyId: null, ebayMerchantLocationKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear();
  getMarketplaceDraft.mockReset(); patchMarketplaceDraft.mockReset(); getEbayConnection.mockReset(); listEbayPolicies.mockReset();
  getMarketplaceDraft.mockResolvedValue(draft());
  getEbayConnection.mockResolvedValue({ id: "conn-1", connectionStatus: "connected" });
  listEbayPolicies.mockResolvedValue([{ id: "p1", policyType: "FULFILLMENT", ebayPolicyId: "FUL-1", name: "x", marketplaceId: "EBAY_GB", available: true, firstSeenAt: "x", lastSeenAt: "x", lastSyncedAt: "x" }]);
});

describe("PATCH /api/listing-studio/groups/[draftId]/ebay-listing-settings", () => {
  it("404s when no eBay preparation exists for this listing", async () => {
    getMarketplaceDraft.mockResolvedValue(null);
    const response = await route(jsonRequest({ sellingPrice: "25.00" }), params());
    expect(response.status).toBe(404);
  });

  it("saves the eBay price WITHOUT touching Vinted's own price column — patchMarketplaceDraft only ever writes to listing_marketplace_drafts", async () => {
    const response = await route(jsonRequest({ sellingPrice: "25.00" }), params());
    expect(response.status).toBe(200);
    expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-1", { price_pence: 2500 });
  });

  it("rejects an invalid price and saves nothing", async () => {
    const response = await route(jsonRequest({ sellingPrice: "not-a-number" }), params());
    expect(response.status).toBe(400);
    expect(patchMarketplaceDraft).not.toHaveBeenCalled();
  });

  it("validates a shipping policy id against the connection's currently-available policies before saving", async () => {
    const ok = await route(jsonRequest({ fulfillmentPolicyId: "FUL-1" }), params());
    expect(ok.status).toBe(200);
    expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-1", { ebay_fulfillment_policy_id: "FUL-1" });

    patchMarketplaceDraft.mockClear();
    const stale = await route(jsonRequest({ fulfillmentPolicyId: "STALE-999" }), params());
    expect(stale.status).toBe(400);
    expect(patchMarketplaceDraft).not.toHaveBeenCalled();
  });

  it("clearing a policy (explicit null) is allowed without re-validating against available policies", async () => {
    const response = await route(jsonRequest({ returnPolicyId: null }), params());
    expect(response.status).toBe(200);
    expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-1", { ebay_return_policy_id: null });
  });

  it("price and policy fields can be saved together or independently — saving one never requires the other", async () => {
    const response = await route(jsonRequest({ sellingPrice: "40.00", paymentPolicyId: null }), params());
    expect(response.status).toBe(200);
    expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-1", { price_pence: 4000, ebay_payment_policy_id: null });
  });

  it("400s an entirely empty patch", async () => {
    const response = await route(jsonRequest({}), params());
    expect(response.status).toBe(400);
  });
});
