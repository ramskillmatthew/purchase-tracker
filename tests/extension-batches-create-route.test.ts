import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { POST as createBatchRoute, GET as listVisibleBatchesRoute } from "@/app/api/listing-studio/extension-batches/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const RPC_PATH = "rpc/listing_studio_create_extension_batch";

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    brand: "Nike", model: "Pegasus", product_type: "Trainers", colours: ["Black"], material: "Mesh",
    uk_size: "9", sku: "AA1711", condition: "Very Good Condition",
    generated_title: "Nike Pegasus Trainers", generated_description: "A great pair of trainers.",
    vinted_audience: "mens",
    vinted_category_id: 1906, vinted_category_status: "category_assigned",
    confirmed_price_pence: 4500,
    ...overrides,
  };
}
function categoryRow(overrides: Record<string, unknown> = {}) {
  return { id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null, ...overrides };
}
function imageRow(overrides: Record<string, unknown> = {}) {
  return { id: "img-1", draft_id: DRAFT_ID, upload_state: "uploaded", ...overrides };
}
function rpcCreatedResponse(batchId = "batch-1", displayNumber = 1) {
  return new Response(JSON.stringify([{ batch_id: batchId, display_number: displayNumber }]), { status: 200 });
}
function rpcConflictError(code: string) {
  const error = new Error(`${code}: draft already in another active batch`) as Error & { status: number };
  error.status = 409;
  return error;
}

function requestWith(draftIds: string[]) {
  return new Request("http://test/api/listing-studio/extension-batches", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds }),
  });
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "d".repeat(32);
  requireOwner.mockClear();
  supabaseRequestAll.mockReset();
  supabaseRequest.mockReset();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("listing_drafts?")) return [draftRow()];
    if (path.startsWith("listing_draft_images?")) return [imageRow()];
    if (path.startsWith("vinted_categories?")) return [categoryRow()];
    return [];
  });
  supabaseRequest.mockImplementation(async (path: string) => {
    if (path === RPC_PATH) return rpcCreatedResponse();
    // enforceRateLimit's own count-check query — see lib/security/activity.ts.
    if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(null, { status: 204 });
  });
});

describe("POST /api/listing-studio/extension-batches", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(401);
  });

  it("rejects an empty selection", async () => {
    const response = await createBatchRoute(requestWith([]));
    expect(response.status).toBe(400);
  });

  it("rejects a batch larger than 5", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `${i}1111111-1111-4111-8111-111111111111`);
    const response = await createBatchRoute(requestWith(ids));
    expect(response.status).toBe(400);
  });

  it("accepts a fully Ready listing and returns a pairing code, batch id, display number, and expiry — never the code hash", async () => {
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchId).toBe("batch-1");
    expect(body.displayNumber).toBe(1);
    expect(body.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(body.expiresAt).toBeTruthy();
    expect(body.listingCount).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/hash/i);
  });

  it("rejects a non-Ready listing (missing selling price) with a clear reason, and never calls the create-batch RPC", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ confirmed_price_pence: null })];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.rejected[0].reasons).toContain("Missing selling price");
    expect(supabaseRequest.mock.calls.some(c => c[0] === RPC_PATH)).toBe(false);
  });

  it("cross-owner draft: a draft not returned by the owner-scoped query is rejected as not found", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("listing_drafts?") ? [] : []));
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.rejected).toEqual([{ draftId: DRAFT_ID, sku: null, reasons: ["Listing not found."] }]);
  });

  it("scopes the listing_drafts query to owner_id=eq.<user>", async () => {
    await createBatchRoute(requestWith([DRAFT_ID]));
    const call = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("listing_drafts?"));
    expect(call![0]).toContain("owner_id=eq.owner-1");
  });

  it("passes only the HASH of the pairing code to the RPC, never the plaintext", async () => {
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    const body = await response.json();
    const rpcCall = supabaseRequest.mock.calls.find(c => c[0] === RPC_PATH);
    const rpcBody = JSON.parse((rpcCall![1] as RequestInit).body as string);
    expect(rpcBody.p_pairing_code_hash).toBeTruthy();
    expect(rpcBody.p_pairing_code_hash).not.toBe(body.pairingCode);
    expect(JSON.stringify(rpcBody)).not.toContain(body.pairingCode);
  });

  it("calls the create-batch RPC with every accepted draft id, in order, and the authenticated owner id", async () => {
    await createBatchRoute(requestWith([DRAFT_ID]));
    const rpcCall = supabaseRequest.mock.calls.find(c => c[0] === RPC_PATH);
    const rpcBody = JSON.parse((rpcCall![1] as RequestInit).body as string);
    expect(rpcBody.p_owner_id).toBe("owner-1");
    expect(rpcBody.p_draft_ids).toEqual([DRAFT_ID]);
  });

  // Multi-batch support — creating a batch must NEVER check for, block on,
  // or cancel any other batch the owner already has in flight; the only
  // thing that can reject creation is the create RPC's own atomic
  // "draft already in another live batch" check (tested below).
  it("multi-batch: creates a second, independent batch without any single-active-batch check or cancellation of the first", async () => {
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === RPC_PATH) {
        const parsed = JSON.parse((init!.body as string));
        return rpcCreatedResponse(parsed.p_draft_ids[0] === DRAFT_ID ? "batch-1" : "batch-2", parsed.p_draft_ids[0] === DRAFT_ID ? 1 : 2);
      }
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const firstResponse = await createBatchRoute(requestWith([DRAFT_ID]));
    const OTHER_DRAFT_ID = "22222222-2222-4222-8222-222222222222";
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ id: OTHER_DRAFT_ID })];
      if (path.startsWith("listing_draft_images?")) return [imageRow({ draft_id: OTHER_DRAFT_ID })];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const secondResponse = await createBatchRoute(requestWith([OTHER_DRAFT_ID]));
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    expect(firstBody.batchId).not.toBe(secondBody.batchId);
    expect(firstBody.displayNumber).not.toBe(secondBody.displayNumber);
    // No query anywhere in this route ever filters/checks "the owner's
    // current/active batch" the way the old single-batch implementation did.
    expect(supabaseRequestAll.mock.calls.some(c => /status=in\.\(pending_claim,claimed,in_progress\)/.test(c[0] as string))).toBe(false);
  });

  it("translates the RPC's DRAFT_ALREADY_IN_ACTIVE_BATCH conflict into a clear 409, not a generic 500", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === RPC_PATH) throw rpcConflictError("DRAFT_ALREADY_IN_ACTIVE_BATCH");
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/already part of another active batch/i);
  });

  it("enforces a rate limit on repeated batch creation via the shared assistant_rate_limits mechanism", async () => {
    await createBatchRoute(requestWith([DRAFT_ID]));
    expect(supabaseRequest.mock.calls.some(c => (c[0] as string).startsWith("assistant_rate_limits?"))).toBe(true);
  });

  it("rejects when the rate limit has already been reached, before touching any listing data", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path.startsWith("assistant_rate_limits?")) return new Response(JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` }))), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(429);
  });

  it("catches everything through safeApiError", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});

describe("GET /api/listing-studio/extension-batches — multi-batch resume: every visible batch, not just one", () => {
  const BATCH_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    requireOwner.mockClear();
    supabaseRequestAll.mockReset();
  });

  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await listVisibleBatchesRoute();
    expect(response.status).toBe(401);
  });

  it("returns every non-box-dismissed batch id and display number, not just one", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      expect(path).toContain("owner_id=eq.owner-1");
      expect(path).toContain("box_dismissed_at=is.null");
      return [
        { id: BATCH_ID, status: "claimed", expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), display_number: 1 },
        { id: "batch-2", status: "in_progress", expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), display_number: 2 },
      ];
    });
    const response = await listVisibleBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([{ batchId: BATCH_ID, displayNumber: 1 }, { batchId: "batch-2", displayNumber: 2 }]);
  });

  it("includes a terminal (e.g. completed) batch that hasn't been box-dismissed, even if its expiry is long past", async () => {
    supabaseRequestAll.mockImplementation(async () => [
      { id: BATCH_ID, status: "completed", expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), display_number: 1 },
    ]);
    const response = await listVisibleBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([{ batchId: BATCH_ID, displayNumber: 1 }]);
  });

  it("returns an empty list when the owner has no visible batch", async () => {
    supabaseRequestAll.mockImplementation(async () => []);
    const response = await listVisibleBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([]);
  });

  it("REGRESSION: never resurrects a still-non-terminal batch whose real expires_at has already passed, even if its status column hasn't been flipped to 'expired' yet", async () => {
    supabaseRequestAll.mockImplementation(async () => [
      { id: BATCH_ID, status: "pending_claim", expires_at: new Date(Date.now() - 60 * 1000).toISOString(), display_number: 1 },
    ]);
    const response = await listVisibleBatchesRoute();
    const body = await response.json();
    expect(body.batchIds).toEqual([]);
  });

  it("catches everything through safeApiError", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await listVisibleBatchesRoute();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});
