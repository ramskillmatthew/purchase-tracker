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

import { POST as createBatchRoute } from "@/app/api/listing-studio/extension-batches/route";
import { AuthError } from "@/lib/auth/server";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

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
    if (path === "vinted_extension_batches") return new Response(JSON.stringify([{ id: "batch-1" }]), { status: 201 });
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

  it("accepts a fully Ready listing and returns a pairing code, batch id, and expiry — never the code hash", async () => {
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchId).toBe("batch-1");
    expect(body.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(body.expiresAt).toBeTruthy();
    expect(body.listingCount).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/hash/i);
  });

  it("rejects a non-Ready listing (missing selling price) with a clear reason, and creates no batch", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ confirmed_price_pence: null })];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.rejected[0].reasons).toContain("Missing selling price");
    expect(supabaseRequest.mock.calls.some(c => c[0] === "vinted_extension_batches")).toBe(false);
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

  it("stores only the HASH of the pairing code, never the plaintext, in the batch insert body", async () => {
    const response = await createBatchRoute(requestWith([DRAFT_ID]));
    const body = await response.json();
    const insertCall = supabaseRequest.mock.calls.find(c => c[0] === "vinted_extension_batches");
    const insertBody = JSON.parse((insertCall![1] as RequestInit).body as string);
    expect(insertBody.pairing_code_hash).toBeTruthy();
    expect(insertBody.pairing_code_hash).not.toBe(body.pairingCode);
    expect(JSON.stringify(insertBody)).not.toContain(body.pairingCode);
  });

  it("inserts exactly one batch_items row per accepted listing, in order", async () => {
    await createBatchRoute(requestWith([DRAFT_ID]));
    const itemsCall = supabaseRequest.mock.calls.find(c => c[0] === "vinted_extension_batch_items");
    const items = JSON.parse((itemsCall![1] as RequestInit).body as string);
    expect(items).toEqual([{ batch_id: "batch-1", draft_id: DRAFT_ID, queue_position: 0, status: "queued" }]);
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
