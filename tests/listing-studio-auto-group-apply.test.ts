import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// applyAutoGroupProposal is "server-only" — mocked the same way as every
// other server-only module exercised directly in this test suite (see
// tests/purchase-import-ai-extract-runtime.test.ts).
vi.mock("server-only", () => ({}));

const { applyAutoGroupProposal } = await import("@/lib/listing-studio/auto-group-apply");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const owner = { id: "11111111-0000-4000-8000-000000000001" };
const unsortedId = "22222222-0000-4000-8000-000000000002";
const imageIds = ["33333333-0000-4000-8000-000000000003", "33333333-0000-4000-8000-000000000004"];

describe("applyAutoGroupProposal — transactional group creation and movement", () => {
  it("REGRESSION: reuses rpc/listing_studio_split_group — a proposal apply IS a split of Unsorted into a new group, not a separate two-step create+move that could leave an orphaned empty group", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("new-draft-id"));
    const result = await applyAutoGroupProposal(owner, unsortedId, imageIds, "Product 4");
    expect(result).toEqual({ ok: true, draftId: "new-draft-id" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/rest/v1/rpc/listing_studio_split_group");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ p_owner_id: owner.id, p_source_draft_id: unsortedId, p_image_ids: imageIds, p_new_title: "Product 4" });
  });

  it("REGRESSION: partial failure produces no group at all — a rejected RPC call never leaves a half-created group behind, since there was only ever one atomic call", async () => {
    fetchMock.mockResolvedValueOnce(new Response("IMAGE_NOT_IN_SOURCE_DRAFT", { status: 409 }));
    const result = await applyAutoGroupProposal(owner, unsortedId, imageIds, "Product 4");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("One or more of these photos are not in the group you're splitting.");
    // Only the one RPC call was ever made — no follow-up "create group" or
    // "move images" call exists for this function to have half-completed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies an unrecognized RPC failure with a safe, generic message — never the raw database error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("some obscure postgres internal detail", { status: 500 }));
    const result = await applyAutoGroupProposal(owner, unsortedId, imageIds, "Product 4");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Could not create this group.");
      expect(result.error).not.toContain("postgres");
    }
  });

  it("never throws — a network-level failure is also returned as a safe result", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network unreachable"));
    const result = await applyAutoGroupProposal(owner, unsortedId, imageIds, "Product 4");
    expect(result.ok).toBe(false);
  });
});
