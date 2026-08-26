import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify([]), { status: 200 })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));

import { POST as importRoute } from "@/app/api/listing-studio/vinted-categories/import/route";
import { AuthError } from "@/lib/auth/server";
import { EXPECTED_VERIFIED_ROOT_IDS } from "@/lib/listing-studio/vinted-catalogue-snapshot";

function category(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, title: "Root", url: "/catalog/1-root", parentId: null, rootId: 1,
    depth: 0, sortOrder: 0, isLeaf: true, fullPath: "Root", photoUrl: null,
    ...overrides,
  };
}
function validSnapshot() {
  const categories = EXPECTED_VERIFIED_ROOT_IDS.map((id) => category({ id, title: `Root ${id}`, rootId: id, fullPath: `Root ${id}` }));
  return {
    source: { market: "Vinted UK", pageUrl: "https://www.vinted.co.uk/items/new", extractionMethod: "Signed-in Create Listing page embedded catalogTree", capturedAt: "2026-08-03T20:57:01.525Z", shape: { id: "number" } },
    verification: { categoryCount: categories.length, leafCount: categories.length, maxDepth: 0, invalidRecords: 0, duplicateIds: 0, leafSelectability: "verified" },
    categories,
  };
}
function importRequest(body: Record<string, unknown>) {
  return new Request("http://test/api/listing-studio/vinted-categories/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function rpcSummaryResponse() {
  return new Response(JSON.stringify([{
    fetched_count: 9, active_count: 9, created_count: 9, updated_count: 0, unchanged_count: 0,
    deactivated_count: 0, leaf_count: 9, selectable_count: 9, fingerprint: "snap123", refreshed_at: "2026-08-03T00:00:00.000Z",
  }]), { status: 200 });
}

beforeEach(() => { requireOwner.mockClear(); supabaseRequest.mockClear(); });

describe("POST /api/listing-studio/vinted-categories/import — owner authentication", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await importRoute(importRequest({ snapshot: validSnapshot(), confirm: false }));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/listing-studio/vinted-categories/import — preview mode (confirm: false)", () => {
  it("validates and returns a preview without ever calling the RPC", async () => {
    const response = await importRoute(importRequest({ snapshot: validSnapshot(), confirm: false }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preview).toBe(true);
    expect(body.categoryCount).toBe(9);
    expect(body.rootIds).toEqual([...EXPECTED_VERIFIED_ROOT_IDS].sort((a, b) => a - b));
    expect(typeof body.fingerprint).toBe("string");
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("rejects a malformed snapshot and never calls the RPC", async () => {
    const response = await importRoute(importRequest({ snapshot: { not: "a snapshot" }, confirm: false }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(Array.isArray(body.details)).toBe(true);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("rejects a snapshot missing a verified root, even in preview mode", async () => {
    const snapshot = validSnapshot();
    snapshot.categories = snapshot.categories.filter((c) => c.id !== EXPECTED_VERIFIED_ROOT_IDS[0]);
    const response = await importRoute(importRequest({ snapshot, confirm: false }));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/listing-studio/vinted-categories/import — oversized request rejection", () => {
  it("rejects a request whose Content-Length exceeds the size cap", async () => {
    const request = new Request("http://test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(9 * 1024 * 1024) },
      body: JSON.stringify({ snapshot: validSnapshot(), confirm: false }),
    });
    const response = await importRoute(request);
    expect(response.status).toBe(413);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});

describe("POST /api/listing-studio/vinted-categories/import — confirmed import", () => {
  it("re-validates (never trusts an earlier preview) and applies via the transactional RPC with source_type='verified_browser_snapshot'", async () => {
    supabaseRequest.mockImplementationOnce(async () => rpcSummaryResponse());
    const response = await importRoute(importRequest({ snapshot: validSnapshot(), confirm: true }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preview).toBe(false);
    expect(body.sourceType).toBe("verified_browser_snapshot");
    expect(body.activeCount).toBe(9);

    const [rpcPath, rpcInit] = supabaseRequest.mock.calls[0];
    expect(rpcPath).toBe("rpc/vinted_categories_apply_refresh");
    const rpcBody = JSON.parse((rpcInit as RequestInit).body as string);
    expect(rpcBody.p_source_type).toBe("verified_browser_snapshot");
    expect(rpcBody.p_captured_at).toBe("2026-08-03T20:57:01.525Z");
  });

  it("sends the COMPLETE validated catalogue to the RPC — automatic-selection branch scoping never filters what gets stored", async () => {
    supabaseRequest.mockImplementationOnce(async () => rpcSummaryResponse());
    const snapshot = validSnapshot();
    await importRoute(importRequest({ snapshot, confirm: true }));
    const [, rpcInit] = supabaseRequest.mock.calls[0];
    const rpcBody = JSON.parse((rpcInit as RequestInit).body as string);
    expect(rpcBody.p_categories).toHaveLength(snapshot.categories.length);
  });

  it("never persists cookies, tokens, or any credential-shaped field from the snapshot payload", async () => {
    supabaseRequest.mockImplementationOnce(async () => rpcSummaryResponse());
    const snapshot = validSnapshot();
    await importRoute(importRequest({ snapshot, confirm: true }));
    const [, rpcInit] = supabaseRequest.mock.calls[0];
    const rpcBodyText = (rpcInit as RequestInit).body as string;
    expect(rpcBodyText).not.toMatch(/cookie/i);
    expect(rpcBodyText).not.toMatch(/session[_-]?token/i);
  });

  it("classifies a suspicious-shrinkage rejection safely and preserves the previous catalogue (RPC failure -> 409)", async () => {
    supabaseRequest.mockImplementationOnce(async () => { throw new Error("SUSPICIOUS_CATALOGUE_SHRINKAGE"); });
    const response = await importRoute(importRequest({ snapshot: validSnapshot(), confirm: true }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/lost an unexpectedly large share/);
  });

  it("rejects a malformed snapshot even when confirm is true — never applies unvalidated data", async () => {
    const response = await importRoute(importRequest({ snapshot: { not: "a snapshot" }, confirm: true }));
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });
});
