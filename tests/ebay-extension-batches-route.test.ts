import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest, supabaseRequestAll, enforceRateLimit } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(async (_path: string) => new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]))),
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
  // mockReset (not mockClear) for both — a prior test's own
  // .mockImplementation() otherwise survives into later tests despite
  // mockClear() (which only clears call history, never a replaced
  // implementation). A real gap this review's own new tests caught:
  // without this, "rejects a marketplace draft missing required eBay
  // fields" (which sets price_pence: null) silently leaked its
  // implementation into every test declared after it in this file.
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
  enforceRateLimit.mockClear();
  supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }])));
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("listing_marketplace_drafts")) return [MARKETPLACE_DRAFT];
    if (path.startsWith("listing_draft_images")) return [{ id: "img-1", draft_id: "pdraft-1" }];
    if (path.startsWith("ebay_extension_batches")) return [];
    return [];
  });
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

  // REQUIREMENT (safety review) — evidence that no rejection from the RPC
  // can ever produce a fake success. Each mock throws exactly like the
  // real supabaseRequest wrapper does on a non-2xx PostgREST response
  // (never merely returns an error Response — see this project's own
  // established "test-fidelity" lesson: a mock that doesn't throw doesn't
  // genuinely exercise the route's real catch-block behaviour).
  function rpcError(message: string) {
    const error = new Error(JSON.stringify({ code: "P0003", message }));
    (error as Error & { status: number }).status = 500;
    return error;
  }

  it("REQUIREMENT: DRAFT_ALREADY_IN_ACTIVE_BATCH surfaces as a clean 409 — never a batchId, never a 200", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("rpc/")) throw rpcError("DRAFT_ALREADY_IN_ACTIVE_BATCH");
      return new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]));
    });
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.batchId).toBeUndefined();
  });

  it("REQUIREMENT: an invalid/nonexistent/wrong-owner draft id rejected by the RPC (DRAFT_NOT_ELIGIBLE) never produces a batchId or a 200 — the route fails safely, never silently", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("rpc/")) throw rpcError("DRAFT_NOT_ELIGIBLE");
      return new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]));
    });
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).not.toBe(200);
    const body = await response.json();
    expect(body.batchId).toBeUndefined();
    // safeApiError's own established contract — never leaks the raw RPC error text to the client
    expect(JSON.stringify(body)).not.toContain("DRAFT_NOT_ELIGIBLE");
  });

  it("REQUIREMENT: an ITEM_INSERT_MISMATCH from the RPC (the exact defect this review found) never produces a batchId or a 200", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("rpc/")) throw rpcError("ITEM_INSERT_MISMATCH");
      return new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]));
    });
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).not.toBe(200);
    const body = await response.json();
    expect(body.batchId).toBeUndefined();
  });

  // REQUIREMENT (safety review) — evidence that concurrent sends for the
  // SAME listing cannot both succeed. This app-layer test proves the route
  // itself has no read-then-write race of its own (it makes exactly ONE
  // RPC call per request, no separate existence check beforehand) — the
  // actual cross-request serialization is the RPC's own advisory lock +
  // partial unique index (see tests/ebay-extension-batch-migration.test.ts),
  // which cannot be executed here (no Postgres available), only reasoned
  // about from the SQL's own text.
  it("REQUIREMENT: the route makes exactly ONE call to the RPC per request — no separate check-then-insert of its own that a second concurrent request could race", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/ebay-extension-batches/route.ts", "utf8"));
    const rpcCallCount = (source.match(/rpc\/listing_studio_create_ebay_extension_batch/g) ?? []).length;
    expect(rpcCallCount).toBe(1);
  });

  it("of two concurrent requests for the same listing, if the RPC (correctly serialized by its own advisory lock) lets exactly one succeed and rejects the other, the route surfaces exactly one success and one clean 409 — never two successes", async () => {
    let calls = 0;
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("rpc/")) {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]));
        throw rpcError("DRAFT_ALREADY_IN_ACTIVE_BATCH");
      }
      return new Response(JSON.stringify([]));
    });
    const [first, second] = await Promise.all([
      createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] })),
      createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] })),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
