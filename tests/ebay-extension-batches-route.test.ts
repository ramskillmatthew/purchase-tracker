import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest, supabaseRequestAll, enforceRateLimit } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(async () => new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]))),
  supabaseRequestAll: vi.fn(async (path: string) => {
    if (path.startsWith("listing_marketplace_drafts")) return [MARKETPLACE_DRAFT];
    if (path.startsWith("listing_draft_images")) return [{ id: "img-1", draft_id: "pdraft-1" }];
    if (path.startsWith("ebay_extension_batches")) return [];
    return [];
  }),
  enforceRateLimit: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));
vi.mock("@/lib/security/activity", () => ({ enforceRateLimit }));

const MDRAFT_ID = "22222222-2222-4222-8222-222222222222";
// REQUIREMENT (legacy-offer/blocker audit): a legacy ebay_offer_id is
// present on this fixture row (matching SKU 1644's own real, live-read
// state this session: ebay_offer_id "254825272011", ebay_feed_draft_created_at
// null) — and the route below must succeed anyway, never referencing this
// field at all.
const MARKETPLACE_DRAFT = {
  id: MDRAFT_ID, product_draft_id: "pdraft-1", marketplace: "EBAY_UK",
  title: "On Running Cloud 5", description: "desc", category_id: "95672", condition_value: "Used – Very Good",
  price_pence: 3500, quantity: 1,
};

const { POST: createRoute } = await import("@/app/api/listing-studio/ebay-extension-batches/route");

function jsonRequest(body: unknown) { return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "d".repeat(32);
  requireOwner.mockClear();
  supabaseRequest.mockClear();
  supabaseRequestAll.mockClear();
  enforceRateLimit.mockClear();
});

describe("POST /api/listing-studio/ebay-extension-batches", () => {
  it("REQUIREMENT: creates a batch for a ready EBAY_UK marketplace draft — never blocked by a legacy Inventory API offer (this route never reads ebay_offer_id at all)", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/ebay-extension-batches/route.ts", "utf8"));
    expect(source).not.toMatch(/\.ebay_offer_id|\.ebayOfferId|draft\.offer_id/);

    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchId).toBe("batch-1");
    expect(body.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
  });

  it("rejects a marketplace draft missing required eBay fields, with a specific reason per field", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts")) return [{ ...MARKETPLACE_DRAFT, price_pence: null } as unknown as typeof MARKETPLACE_DRAFT];
      if (path.startsWith("listing_draft_images")) return [];
      return [];
    });
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.rejected[0].reasons).toContain("Missing eBay selling price.");
    expect(body.rejected[0].reasons).toContain("No uploaded photos.");
  });

  it("caps at MAX_EBAY_EXTENSION_BATCH_LISTINGS (1) — a second id is rejected by the request schema itself", async () => {
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID, "33333333-3333-4333-8333-333333333333"] }));
    expect(response.status).not.toBe(200);
  });

  it("owner id is always derived from the authenticated session, never trusted from the request body", async () => {
    const response = await createRoute(new Request("http://test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplaceDraftIds: [MDRAFT_ID], ownerId: "attacker-owner" }),
    }));
    // The extra field is rejected by the .strict() schema, not silently accepted
    expect(response.status).not.toBe(200);
  });

  it("is rate-limited", async () => {
    await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(enforceRateLimit).toHaveBeenCalledWith("owner-1", "ebay_extension_batch_create", expect.any(Number), expect.any(Number));
  });
});
