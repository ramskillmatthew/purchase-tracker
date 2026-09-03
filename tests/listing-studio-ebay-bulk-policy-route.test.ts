import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, getEbayConnection, listEbayPolicies, listMarketplaceDraftsForProducts, patchMarketplaceDraft } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  getEbayConnection: vi.fn(),
  listEbayPolicies: vi.fn(async () => [] as unknown[]),
  listMarketplaceDraftsForProducts: vi.fn(async () => new Map()),
  patchMarketplaceDraft: vi.fn(async (_ownerId: string, _id: string, _patch: Record<string, unknown>) => {}),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/ebay-account/client", () => ({ getEbayConnection, listEbayPolicies }));
vi.mock("@/lib/listing-studio/marketplace-drafts", () => ({ listMarketplaceDraftsForProducts, patchMarketplaceDraft }));

const { POST: bulkPolicyRoute } = await import("@/app/api/listing-studio/listings-review/ebay-bulk-policy/route");

const A = "22222222-2222-4222-8222-222222222222"; // has eBay prep, no offer yet -> eligible
const B = "33333333-3333-4333-8333-333333333333"; // Vinted only -> skipped
const C = "44444444-4444-4444-8444-444444444444"; // already has an offer -> skipped

function jsonRequest(body: unknown) { return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function connection(overrides: Record<string, unknown> = {}) { return { id: "conn-1", connectionStatus: "connected", ...overrides }; }
function ebayDraft(id: string, overrides: Record<string, unknown> = {}) { return { id, marketplace: "EBAY_UK" as const, ebayOfferId: null, ...overrides }; }

beforeEach(() => {
  requireOwner.mockClear();
  getEbayConnection.mockReset(); listEbayPolicies.mockReset(); listMarketplaceDraftsForProducts.mockReset(); patchMarketplaceDraft.mockReset();
  getEbayConnection.mockResolvedValue(connection());
  listEbayPolicies.mockResolvedValue([{ id: "p1", policyType: "FULFILLMENT", ebayPolicyId: "FUL-1", name: "Royal Mail Tracked 48", marketplaceId: "EBAY_GB", available: true, firstSeenAt: "x", lastSeenAt: "x", lastSyncedAt: "x" }]);
  listMarketplaceDraftsForProducts.mockResolvedValue(new Map([
    [A, [ebayDraft("mdraft-a")]],
    [C, [ebayDraft("mdraft-c", { ebayOfferId: "existing-offer" })]],
  ]));
});

describe("POST /api/listing-studio/listings-review/ebay-bulk-policy", () => {
  it("REQUIREMENT: applies only to eligible eBay preparations, skips Vinted-only and already-drafted listings, and reports exact counts", async () => {
    const response = await bulkPolicyRoute(jsonRequest({ draftIds: [A, B, C], policyType: "FULFILLMENT", ebayPolicyId: "FUL-1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.appliedCount).toBe(1);
    expect(body.skippedCount).toBe(2);
    expect(body.skipped).toEqual(expect.arrayContaining([
      { draftId: B, reason: "No eBay preparation for this listing" },
      { draftId: C, reason: "An eBay draft already exists for this listing" },
    ]));
    expect(patchMarketplaceDraft).toHaveBeenCalledTimes(1);
    expect(patchMarketplaceDraft).toHaveBeenCalledWith("owner-1", "mdraft-a", { ebay_fulfillment_policy_id: "FUL-1" });
  });

  it("never touches listing_drafts (Vinted data) — only patchMarketplaceDraft is ever called", async () => {
    await bulkPolicyRoute(jsonRequest({ draftIds: [A], policyType: "FULFILLMENT", ebayPolicyId: "FUL-1" }));
    for (const call of patchMarketplaceDraft.mock.calls) {
      expect(Object.keys(call[2] as Record<string, unknown>).every(key => key.startsWith("ebay_"))).toBe(true);
    }
  });

  it("rejects a policy id that isn't currently available on this connection — nothing is applied", async () => {
    const response = await bulkPolicyRoute(jsonRequest({ draftIds: [A], policyType: "FULFILLMENT", ebayPolicyId: "STALE-999" }));
    expect(response.status).toBe(400);
    expect(patchMarketplaceDraft).not.toHaveBeenCalled();
  });

  it("409s when no eBay account is connected", async () => {
    getEbayConnection.mockResolvedValue(null);
    const response = await bulkPolicyRoute(jsonRequest({ draftIds: [A], policyType: "FULFILLMENT", ebayPolicyId: "FUL-1" }));
    expect(response.status).toBe(409);
  });
});
