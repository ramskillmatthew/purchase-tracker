import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, buildFeedDraftPreviewForProduct } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  buildFeedDraftPreviewForProduct: vi.fn(async (_ownerId: string, _productDraftId: string) => ({ error: "No eBay preparation for this listing." }) as unknown),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/listing-studio/ebay-feed/feed-batches", () => ({ buildFeedDraftPreviewForProduct }));

const { POST: previewRoute } = await import("@/app/api/listing-studio/ebay-feed-batches/preview/route");

const PRODUCT_A = "22222222-2222-4222-8222-222222222222";
const PRODUCT_B = "33333333-3333-4333-8333-333333333333";
function jsonRequest(body: unknown) { return new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

beforeEach(() => {
  requireOwner.mockClear();
  buildFeedDraftPreviewForProduct.mockReset();
});

describe("POST /api/listing-studio/ebay-feed-batches/preview", () => {
  it("requires the authenticated owner", async () => {
    await previewRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(requireOwner).toHaveBeenCalledTimes(1);
  });

  it("returns one preview per requested listing, real fields and the completeInSellerHub list", async () => {
    buildFeedDraftPreviewForProduct.mockResolvedValue({
      fields: { Title: "On Running Cloud 5", "Custom label (SKU)": "1644", "Category ID": "95672", Price: "35.00", Quantity: "1", "Condition ID": "USED_VERY_GOOD" },
      completeInSellerHub: ["Shipping, returns, and payment policies (not part of this template)"],
    });
    const response = await previewRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.previews).toHaveLength(1);
    expect(body.previews[0].fields.Title).toBe("On Running Cloud 5");
    expect(body.previews[0].completeInSellerHub.length).toBeGreaterThan(0);
  });

  it("a listing that can't be previewed (missing SKU etc) reports its own error, never blocking the others", async () => {
    buildFeedDraftPreviewForProduct.mockImplementation(async (_ownerId: string, draftId: string) =>
      draftId === PRODUCT_A ? { error: "Missing SKU." } : { fields: { Title: "OK" }, completeInSellerHub: [] });
    const response = await previewRoute(jsonRequest({ draftIds: [PRODUCT_A, PRODUCT_B] }));
    const body = await response.json();
    expect(body.previews.find((p: { draftId: string }) => p.draftId === PRODUCT_A).error).toBe("Missing SKU.");
    expect(body.previews.find((p: { draftId: string }) => p.draftId === PRODUCT_B).fields.Title).toBe("OK");
  });

  it("rejects an empty draftIds array", async () => {
    const response = await previewRoute(jsonRequest({ draftIds: [] }));
    expect(response.status).not.toBe(200);
    expect(buildFeedDraftPreviewForProduct).not.toHaveBeenCalled();
  });

  it("deduplicates repeated draft ids", async () => {
    buildFeedDraftPreviewForProduct.mockResolvedValue({ fields: { Title: "OK" }, completeInSellerHub: [] });
    await previewRoute(jsonRequest({ draftIds: [PRODUCT_A, PRODUCT_A] }));
    expect(buildFeedDraftPreviewForProduct).toHaveBeenCalledTimes(1);
  });
});
