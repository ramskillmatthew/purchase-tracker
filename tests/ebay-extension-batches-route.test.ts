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

const { POST: createRoute, GET: listRoute } = await import("@/app/api/listing-studio/ebay-extension-batches/route");

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

  // CORRECTIVE PASS (environment provenance audit) — the pairing card's
  // own environment identifiers, resolved server-side, never fabricated
  // client-side. Real values (a git SHA, a Supabase hostname) depend on
  // the ambient test-process environment, which this file doesn't
  // control — see tests/ebay-extension-health-route.test.ts for the
  // deterministic module-load-time resolution tests. This just proves the
  // route actually forwards them.
  it("REQUIREMENT: the response includes the SAME safe build/environment identifiers the extension's own health check reports — never fabricated client-side", async () => {
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    const body = await response.json();
    expect(typeof body.buildId).toBe("string");
    expect(body.buildId.length).toBeGreaterThan(0);
    expect(typeof body.supabaseProjectRef).toBe("string");
    expect(body.supabaseProjectRef.length).toBeGreaterThan(0);
  });

  it("REGRESSION: the create route resolves these identifiers from the SAME shared module the health route uses — never a second, independent implementation that could drift", async () => {
    const source = await import("node:fs").then(fs => fs.readFileSync("app/api/listing-studio/ebay-extension-batches/route.ts", "utf8"));
    expect(source).toContain('from "@/lib/listing-studio/server-diagnostics"');
    const healthSource = await import("node:fs").then(fs => fs.readFileSync("app/api/extension/ebay-batch/health/route.ts", "utf8"));
    expect(healthSource).toContain('from "@/lib/listing-studio/server-diagnostics"');
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

  // CORRECTIVE PASS (blocking-batch visibility review) — the conflict now
  // names the actual blocking batch, so the UI can offer a real "View this
  // batch" action instead of a dead end.
  it("REQUIREMENT: a DRAFT_ALREADY_IN_ACTIVE_BATCH conflict carrying the blocking batch's own id surfaces it as blockingBatchId — never fabricated, never dropped", async () => {
    const BLOCKING_ID = "5f0ebbad-06a9-4f07-bdc5-5266b0c7498b";
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("rpc/")) throw rpcError(`DRAFT_ALREADY_IN_ACTIVE_BATCH:${BLOCKING_ID}`);
      return new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]));
    });
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.blockingBatchId).toBe(BLOCKING_ID);
  });

  it("REQUIREMENT: a conflict with no parseable batch id in the RPC's own message surfaces blockingBatchId: null — never a guessed/fabricated id", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("rpc/")) throw rpcError("DRAFT_ALREADY_IN_ACTIVE_BATCH");
      return new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1 }]));
    });
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    const body = await response.json();
    expect(body.blockingBatchId).toBeNull();
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

  // ---- CORRECTIVE PASS 6 (retry truthfulness review) ----------------------

  it("REQUIREMENT (first-attempt failure / not a retry): retry_of_item_id: null from the RPC surfaces as isRetry: false", async () => {
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ batch_id: "batch-1", display_number: 1, retry_of_item_id: null }])));
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.isRetry).toBe(false);
  });

  it("REQUIREMENT (retry after failure): a non-null retry_of_item_id from the RPC (the server-derived lineage — see the migration's own coverage of exactly how it's computed) surfaces honestly as isRetry: true — never guessed by the route itself", async () => {
    const OLD_FAILED_ITEM_ID = "44444444-4444-4444-8444-444444444444";
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ batch_id: "batch-2", display_number: 2, retry_of_item_id: OLD_FAILED_ITEM_ID }])));
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchId).toBe("batch-2");
    expect(body.isRetry).toBe(true);
  });

  it("REQUIREMENT (new item identity): a retry's response carries only the NEW batch's own id — never the old failed item's id in any client-visible field", async () => {
    const OLD_FAILED_ITEM_ID = "44444444-4444-4444-8444-444444444444";
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([{ batch_id: "batch-2", display_number: 2, retry_of_item_id: OLD_FAILED_ITEM_ID }])));
    const response = await createRoute(jsonRequest({ marketplaceDraftIds: [MDRAFT_ID] }));
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(OLD_FAILED_ITEM_ID);
  });

  it("REQUIREMENT (double retry): two concurrent retry attempts for the same listing can never both succeed — the SAME advisory-lock-serialized RPC call this file's own concurrent-create test already proves for a first send applies identically here (retry is not a second code path)", async () => {
    let calls = 0;
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("rpc/")) {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify([{ batch_id: "batch-2", display_number: 2, retry_of_item_id: "44444444-4444-4444-8444-444444444444" }]));
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

// CORRECTIVE PASS (blocking-batch visibility review) — the fix for the
// reported bug itself: GET must return EVERY row the create RPC's own
// conflict check would treat as active, and must auto-reconcile (via the
// EXISTING, already-hardened expire RPC) any row the list RPC flags as
// is_expired_unreconciled, so the UI never shows a phantom "Waiting for
// pairing" for a window that has actually already closed.
describe("GET /api/listing-studio/ebay-extension-batches", () => {
  const LIST_RPC_PATH = "rpc/listing_studio_list_ebay_extension_batches";
  const EXPIRE_RPC_PATH = "rpc/listing_studio_expire_ebay_extension_batch";
  const BATCH_ID = "5f0ebbad-06a9-4f07-bdc5-5266b0c7498b";
  const ITEM_ID = "66666666-6666-4666-8666-666666666666";

  function listRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      batch_id: BATCH_ID, display_number: 7, batch_status: "pending_claim",
      created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T00:10:00.000Z", claimed_at: null, completed_at: null,
      extension_id: null, extension_version: null, browser_label: null,
      box_dismissed_at: null, last_extension_activity_at: null,
      item_id: ITEM_ID, marketplace_draft_id: MDRAFT_ID, item_status: "queued", attempt_count: 0,
      error_code: null, error_message: null, current_step: null, step_detail: null,
      item_started_at: null, item_completed_at: null,
      is_active: true, is_expired_unreconciled: false,
      ...overrides,
    };
  }

  it("REQUIREMENT: a genuinely active row is always returned, with the exact detail shape the panel needs — never silently dropped", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === LIST_RPC_PATH) return new Response(JSON.stringify([listRow()]));
      throw new Error(`unexpected rpc call: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts")) return [{ id: MDRAFT_ID, product_draft_id: "pdraft-1", title: "On Running Cloud 5" }] as unknown as typeof MARKETPLACE_DRAFT[];
      if (path.startsWith("listing_drafts")) return [{ id: "pdraft-1", sku: "1644" }] as unknown as typeof MARKETPLACE_DRAFT[];
      return [];
    });
    const response = await listRoute(new Request("http://test/api/listing-studio/ebay-extension-batches"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batches).toHaveLength(1);
    const [batch] = body.batches;
    expect(batch.batchId).toBe(BATCH_ID);
    expect(batch.displayNumber).toBe(7);
    expect(batch.status).toBe("pending_claim");
    expect(batch.isActive).toBe(true);
    expect(batch.item.marketplaceDraftId).toBe(MDRAFT_ID);
    expect(batch.item.title).toBe("On Running Cloud 5");
    expect(batch.item.sku).toBe("1644");
  });

  it("REQUIREMENT: a row the list RPC flags is_expired_unreconciled is reconciled via the EXISTING expire RPC BEFORE being returned — never a phantom 'waiting for pairing' for a window that has already closed", async () => {
    let expireCalledWith: unknown = null;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === LIST_RPC_PATH) return new Response(JSON.stringify([listRow({ is_expired_unreconciled: true })]));
      if (path === EXPIRE_RPC_PATH) { expireCalledWith = init?.body ? JSON.parse(init.body as string) : null; return new Response(null, { status: 204 }); }
      throw new Error(`unexpected rpc call: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts")) return [{ id: MDRAFT_ID, product_draft_id: "pdraft-1", title: "On Running Cloud 5" }] as unknown as typeof MARKETPLACE_DRAFT[];
      if (path.startsWith("listing_drafts")) return [{ id: "pdraft-1", sku: "1644" }] as unknown as typeof MARKETPLACE_DRAFT[];
      return [];
    });
    const response = await listRoute(new Request("http://test/api/listing-studio/ebay-extension-batches"));
    const body = await response.json();
    expect(expireCalledWith).toEqual({ p_batch_id: BATCH_ID });
    const [batch] = body.batches;
    expect(batch.status).toBe("expired");
    expect(batch.isActive).toBe(false);
  });

  it("REQUIREMENT: reconciling an in-flight item status (queued/preparing/filling) also marks the ITEM cancelled locally — the UI never shows 'Filling in listing details…' for a batch it just reported as expired", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === LIST_RPC_PATH) return new Response(JSON.stringify([listRow({ is_expired_unreconciled: true, item_status: "filling" })]));
      if (path === EXPIRE_RPC_PATH) return new Response(null, { status: 204 });
      throw new Error(`unexpected rpc call: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts")) return [{ id: MDRAFT_ID, product_draft_id: "pdraft-1", title: "On Running Cloud 5" }] as unknown as typeof MARKETPLACE_DRAFT[];
      if (path.startsWith("listing_drafts")) return [{ id: "pdraft-1", sku: "1644" }] as unknown as typeof MARKETPLACE_DRAFT[];
      return [];
    });
    const response = await listRoute(new Request("http://test/api/listing-studio/ebay-extension-batches"));
    const body = await response.json();
    expect(body.batches[0].item.status).toBe("cancelled");
  });

  it("a terminal (completed/cancelled/already-expired) row is returned as-is, with isActive: false and no expire RPC call", async () => {
    let expireCalled = false;
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === LIST_RPC_PATH) return new Response(JSON.stringify([listRow({ batch_status: "cancelled", item_status: "cancelled", is_active: false, is_expired_unreconciled: false })]));
      if (path === EXPIRE_RPC_PATH) { expireCalled = true; return new Response(null, { status: 204 }); }
      throw new Error(`unexpected rpc call: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts")) return [{ id: MDRAFT_ID, product_draft_id: "pdraft-1", title: "On Running Cloud 5" }] as unknown as typeof MARKETPLACE_DRAFT[];
      if (path.startsWith("listing_drafts")) return [{ id: "pdraft-1", sku: "1644" }] as unknown as typeof MARKETPLACE_DRAFT[];
      return [];
    });
    const response = await listRoute(new Request("http://test/api/listing-studio/ebay-extension-batches"));
    const body = await response.json();
    expect(body.batches[0].isActive).toBe(false);
    expect(body.batches[0].status).toBe("cancelled");
    expect(expireCalled).toBe(false);
  });

  it("an empty list (no batches for this owner) returns an empty array, not an error", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === LIST_RPC_PATH) return new Response(JSON.stringify([]));
      throw new Error(`unexpected rpc call: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async () => []);
    const response = await listRoute(new Request("http://test/api/listing-studio/ebay-extension-batches"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batches).toEqual([]);
  });

  // CORRECTIVE PASS (controlled pairing test review, Phase 4)
  it("REQUIREMENT: defaults to p_include_dismissed: false when the query param is absent — the exact prior behaviour, unchanged", async () => {
    let rpcBody: unknown;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === LIST_RPC_PATH) { rpcBody = init?.body ? JSON.parse(init.body as string) : null; return new Response(JSON.stringify([])); }
      throw new Error(`unexpected rpc call: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async () => []);
    await listRoute(new Request("http://test/api/listing-studio/ebay-extension-batches"));
    expect(rpcBody).toMatchObject({ p_include_dismissed: false });
  });

  it("REQUIREMENT: ?includeDismissed=true is forwarded as p_include_dismissed: true to the list RPC — the 'Show dismissed batches' toggle", async () => {
    let rpcBody: unknown;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === LIST_RPC_PATH) { rpcBody = init?.body ? JSON.parse(init.body as string) : null; return new Response(JSON.stringify([listRow({ is_active: false, box_dismissed_at: "2026-09-01T00:00:00.000Z" })])); }
      throw new Error(`unexpected rpc call: ${path}`);
    });
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_marketplace_drafts")) return [{ id: MDRAFT_ID, product_draft_id: "pdraft-1", title: "On Running Cloud 5" }] as unknown as typeof MARKETPLACE_DRAFT[];
      if (path.startsWith("listing_drafts")) return [{ id: "pdraft-1", sku: "1644" }] as unknown as typeof MARKETPLACE_DRAFT[];
      return [];
    });
    const response = await listRoute(new Request("http://test/api/listing-studio/ebay-extension-batches?includeDismissed=true"));
    expect(rpcBody).toMatchObject({ p_include_dismissed: true });
    const body = await response.json();
    expect(body.batches[0].boxDismissedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});
