import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequest, supabaseRequestAll, getDefaultCategoryTreeId, getItemAspectsForCategory } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async () => new Response(null, { status: 204 })),
  supabaseRequestAll: vi.fn(async () => [] as unknown[]),
  getDefaultCategoryTreeId: vi.fn(),
  getItemAspectsForCategory: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));
vi.mock("@/lib/listing-studio/ebay-taxonomy-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/ebay-taxonomy-client")>();
  return { ...actual, getDefaultCategoryTreeId, getItemAspectsForCategory };
});

import { getCachedCategoryTreeId, getCachedItemAspects } from "@/lib/listing-studio/ebay-taxonomy-cache";

beforeEach(() => {
  supabaseRequest.mockClear(); supabaseRequestAll.mockReset();
  getDefaultCategoryTreeId.mockReset(); getItemAspectsForCategory.mockReset();
});

describe("getCachedCategoryTreeId", () => {
  it("returns a fresh cached row without calling the live API at all", async () => {
    supabaseRequestAll.mockResolvedValue([{ category_tree_id: "3", category_tree_version: "119", fetched_at: new Date().toISOString() }]);
    const result = await getCachedCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: false } });
    expect(getDefaultCategoryTreeId).not.toHaveBeenCalled();
  });

  it("fetches live and stores the result when nothing is cached yet", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    getDefaultCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119" } });
    const result = await getCachedCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: false } });
    expect(supabaseRequest).toHaveBeenCalledWith(expect.stringContaining("on_conflict=ebay_marketplace_id"), expect.anything());
  });

  it("REGRESSION: an expired cached row triggers a live refetch, not a silent stale return", async () => {
    supabaseRequestAll.mockResolvedValue([{ category_tree_id: "3", category_tree_version: "119", fetched_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }]);
    getDefaultCategoryTreeId.mockResolvedValue({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "120" } });
    const result = await getCachedCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "120", stale: false } });
  });

  it("REQUIREMENT: falls back to a stale cached value (honestly flagged) when the live refetch fails, rather than failing outright", async () => {
    supabaseRequestAll.mockResolvedValue([{ category_tree_id: "3", category_tree_version: "119", fetched_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }]);
    getDefaultCategoryTreeId.mockResolvedValue({ ok: false, error: "timeout" });
    const result = await getCachedCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", stale: true } });
  });

  it("returns the honest failure when there is nothing cached AND the live fetch fails", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    getDefaultCategoryTreeId.mockResolvedValue({ ok: false, error: "not_configured" });
    const result = await getCachedCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: false, error: "not_configured" });
  });
});

describe("getCachedItemAspects", () => {
  it("returns a fresh cached row without calling the live API", async () => {
    supabaseRequestAll.mockResolvedValue([{ aspects_json: [{ localizedAspectName: "Game" }], fetched_at: new Date().toISOString() }]);
    const result = await getCachedItemAspects("3", "119", "183454");
    expect(result).toEqual({ ok: true, data: { aspects: [{ localizedAspectName: "Game" }], stale: false } });
    expect(getItemAspectsForCategory).not.toHaveBeenCalled();
  });

  it("fetches live and caches when nothing matches this exact category_tree_version", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    getItemAspectsForCategory.mockResolvedValue({ ok: true, data: [{ localizedAspectName: "Set" }] });
    const result = await getCachedItemAspects("3", "119", "183454");
    expect(result).toEqual({ ok: true, data: { aspects: [{ localizedAspectName: "Set" }], stale: false } });
    expect(supabaseRequest).toHaveBeenCalledWith(expect.stringContaining("on_conflict=category_tree_id,category_id,category_tree_version"), expect.anything());
  });

  it("falls back to a stale cached row when the live refetch fails", async () => {
    supabaseRequestAll.mockResolvedValue([{ aspects_json: [{ localizedAspectName: "Game" }], fetched_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }]);
    getItemAspectsForCategory.mockResolvedValue({ ok: false, error: "request_failed" });
    const result = await getCachedItemAspects("3", "119", "183454");
    expect(result).toEqual({ ok: true, data: { aspects: [{ localizedAspectName: "Game" }], stale: true } });
  });
});
