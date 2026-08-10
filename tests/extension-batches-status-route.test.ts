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

import { GET as getBatchRoute, DELETE as cancelBatchRoute } from "@/app/api/listing-studio/extension-batches/[batchId]/route";
import { AuthError } from "@/lib/auth/server";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
function params() { return { params: Promise.resolve({ batchId: BATCH_ID }) }; }

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID, status: "in_progress", listing_count: 2,
    created_at: "2026-08-05T10:00:00.000Z", claimed_at: "2026-08-05T10:01:00.000Z", expires_at: "2026-08-05T10:10:00.000Z", completed_at: null,
    extension_id: "abc", extension_version: "1.0.0",
    ...overrides,
  };
}
function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1", draft_id: "draft-1", queue_position: 0, status: "completed", attempt_count: 1,
    error_code: null, error_message: null, vinted_draft_id: "999", started_at: "2026-08-05T10:01:00.000Z", completed_at: "2026-08-05T10:02:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  requireOwner.mockClear();
  supabaseRequestAll.mockReset();
  supabaseRequest.mockClear();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
    if (path.startsWith("vinted_extension_batch_items?")) return [itemRow()];
    if (path.startsWith("listing_drafts?")) return [{ id: "draft-1", generated_title: "Nike Pegasus", sku: "AA1711" }];
    return [];
  });
});

describe("GET /api/listing-studio/extension-batches/[batchId]", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await getBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(401);
  });

  it("404s for a batch that doesn't belong to this owner", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [] : []));
    const response = await getBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });

  it("returns batch status and items with generated title/sku joined in", async () => {
    const response = await getBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchId).toBe(BATCH_ID);
    expect(body.status).toBe("in_progress");
    expect(body.items[0]).toMatchObject({ itemId: "item-1", status: "completed", vintedDraftId: "999", generatedTitle: "Nike Pegasus", sku: "AA1711" });
  });

  it("scopes both the batch and drafts queries to owner_id=eq.<user>", async () => {
    await getBatchRoute(new Request("http://test"), params());
    const batchCall = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("vinted_extension_batches?"));
    expect(batchCall![0]).toContain("owner_id=eq.owner-1");
    const draftsCall = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("listing_drafts?"));
    expect(draftsCall![0]).toContain("owner_id=eq.owner-1");
  });

  it("catches everything through safeApiError", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await getBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});

describe("DELETE /api/listing-studio/extension-batches/[batchId] — cooperative cancel", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await cancelBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(401);
  });

  it("cancels an active batch and marks only QUEUED items cancelled", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [batchRow({ status: "in_progress" })] : []));
    const response = await cancelBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("cancelled");
    const itemsPatch = supabaseRequest.mock.calls.find(c => (c[0] as string).includes("vinted_extension_batch_items") && (c[0] as string).includes("status=eq.queued"));
    expect(itemsPatch).toBeDefined();
  });

  it("is a no-op for an already-terminal batch", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [batchRow({ status: "completed" })] : []));
    const response = await cancelBatchRoute(new Request("http://test"), params());
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(supabaseRequest.mock.calls.some(c => (c[1] as RequestInit)?.method === "PATCH")).toBe(false);
  });

  it("404s for a batch that doesn't belong to this owner", async () => {
    supabaseRequestAll.mockImplementation(async () => []);
    const response = await cancelBatchRoute(new Request("http://test"), params());
    expect(response.status).toBe(404);
  });
});
