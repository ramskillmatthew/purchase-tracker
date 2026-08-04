import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest, fetchVintedCatalogue } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify([]), { status: 200 })),
  fetchVintedCatalogue: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest }));
vi.mock("@/lib/listing-studio/vinted-catalogue-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-catalogue-client")>();
  return { ...actual, fetchVintedCatalogue };
});

import { POST as refreshRoute } from "@/app/api/listing-studio/vinted-categories/refresh/route";
import { AuthError } from "@/lib/auth/server";
import type { FlattenedVintedCategory } from "@/lib/listing-studio/vinted-catalogue";

function category(overrides: Partial<FlattenedVintedCategory> = {}): FlattenedVintedCategory {
  return {
    id: 1906, code: null, label: "Trainers", fullPath: "Women > Shoes > Trainers",
    parentId: 1905, rootId: 1904, depth: 2, sortOrder: 0, isLeaf: true, isSelectable: true,
    audience: "womens", itemFamily: null, vintedUrl: null,
    colorFieldVisibility: null, sizeFieldVisibility: null, measurementsFieldVisibility: null, brandFieldVisibility: null,
    rawJson: {},
    ...overrides,
  };
}

function rpcSummaryResponse() {
  return new Response(JSON.stringify([{
    fetched_count: 1, active_count: 1, created_count: 1, updated_count: 0, unchanged_count: 0,
    deactivated_count: 0, leaf_count: 1, selectable_count: 1, fingerprint: "abc123", refreshed_at: "2026-08-03T00:00:00.000Z",
  }]), { status: 200 });
}

beforeEach(() => { requireOwner.mockClear(); supabaseRequest.mockClear(); fetchVintedCatalogue.mockReset(); });

describe("POST /api/listing-studio/vinted-categories/refresh — owner authentication", () => {
  it("requires authentication before ever fetching Vinted", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await refreshRoute();
    expect(response.status).toBe(401);
    expect(fetchVintedCatalogue).not.toHaveBeenCalled();
  });
});

describe("POST /api/listing-studio/vinted-categories/refresh — fetch failure handling", () => {
  it("never calls the RPC when the fetch itself failed, and records a failed sync-status row", async () => {
    fetchVintedCatalogue.mockResolvedValueOnce({ status: "blocked", httpStatus: 403 });
    const response = await refreshRoute();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
    expect(supabaseRequest).toHaveBeenCalledWith(
      expect.stringContaining("vinted_category_sync_status"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(supabaseRequest).not.toHaveBeenCalledWith(expect.stringContaining("rpc/vinted_categories_apply_refresh"), expect.anything());
  });

  it("maps a non-JSON/challenge-page response to a safe message without leaking raw detail", async () => {
    fetchVintedCatalogue.mockResolvedValueOnce({ status: "unexpected_content_type", contentType: "text/html; charset=UTF-8" });
    const response = await refreshRoute();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).not.toMatch(/text\/html/);
  });
});

describe("POST /api/listing-studio/vinted-categories/refresh — successful refresh", () => {
  it("computes a fingerprint, calls the RPC, and returns the documented summary shape", async () => {
    fetchVintedCatalogue.mockResolvedValueOnce({ status: "success", categories: [category()] });
    supabaseRequest.mockImplementationOnce(async () => rpcSummaryResponse());

    const response = await refreshRoute();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      sourceType: "live_endpoint",
      fetchedCount: 1, activeCount: 1, createdCount: 1, updatedCount: 0, unchangedCount: 0,
      deactivatedCount: 0, leafCount: 1, selectableCount: 1, fingerprint: "abc123", refreshedAt: "2026-08-03T00:00:00.000Z",
    });

    const [rpcPath, rpcInit] = supabaseRequest.mock.calls[0];
    expect(rpcPath).toBe("rpc/vinted_categories_apply_refresh");
    const rpcBody = JSON.parse((rpcInit as RequestInit).body as string);
    expect(rpcBody.p_categories).toEqual([expect.objectContaining({ id: 1906, full_path: "Women > Shoes > Trainers" })]);
    expect(typeof rpcBody.p_fingerprint).toBe("string");
  });

  it("fingerprint stability: the same categories produce the same fingerprint across two calls", async () => {
    fetchVintedCatalogue.mockResolvedValue({ status: "success", categories: [category()] });
    supabaseRequest.mockImplementation(async (path: string) => (path.startsWith("rpc/") ? rpcSummaryResponse() : new Response(JSON.stringify([]), { status: 200 })));

    await refreshRoute();
    const firstFingerprint = JSON.parse((supabaseRequest.mock.calls.find(c => c[0] === "rpc/vinted_categories_apply_refresh")![1] as RequestInit).body as string).p_fingerprint;
    supabaseRequest.mockClear();
    await refreshRoute();
    const secondFingerprint = JSON.parse((supabaseRequest.mock.calls.find(c => c[0] === "rpc/vinted_categories_apply_refresh")![1] as RequestInit).body as string).p_fingerprint;
    expect(firstFingerprint).toBe(secondFingerprint);
  });
});

describe("POST /api/listing-studio/vinted-categories/refresh — RPC rejection handling (safe error mapping)", () => {
  it("classifies a suspicious-shrinkage rejection into a safe message and returns 409", async () => {
    fetchVintedCatalogue.mockResolvedValueOnce({ status: "success", categories: [category()] });
    supabaseRequest.mockImplementationOnce(async () => { throw new Error("SUSPICIOUS_CATALOGUE_SHRINKAGE: detail here"); });
    const response = await refreshRoute();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/lost an unexpectedly large share/);
  });

  it("classifies a concurrent-refresh rejection into a safe message and does not overwrite the other refresh's sync-status row", async () => {
    fetchVintedCatalogue.mockResolvedValueOnce({ status: "success", categories: [category()] });
    supabaseRequest.mockImplementationOnce(async () => { throw new Error("REFRESH_ALREADY_IN_PROGRESS"); });
    const response = await refreshRoute();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/already running/);
    expect(supabaseRequest).toHaveBeenCalledTimes(1); // only the failed RPC call — no sync-status write for this one
  });

  it("never leaks a raw/unrecognized database error to the client", async () => {
    fetchVintedCatalogue.mockResolvedValueOnce({ status: "success", categories: [category()] });
    supabaseRequest.mockImplementationOnce(async () => { throw new Error("connection reset by peer, socket 0x7f, internal detail"); });
    const response = await refreshRoute();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).not.toMatch(/socket|0x7f/);
  });
});
