import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, buildFeedDraftPreviewForProduct } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  buildFeedDraftPreviewForProduct: vi.fn(async (_ownerId: string, _productDraftId: string) => ({ ok: false, reason: "No eBay preparation for this listing." }) as unknown),
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

  it("REQUIREMENT (Phase 3): returns a server-authoritative structured result — requestedCount, eligibleCount, ineligibleCount, rows, blockers, template version, marketplace, action", async () => {
    buildFeedDraftPreviewForProduct.mockResolvedValue({
      ok: true,
      row: {
        draftId: PRODUCT_A,
        fields: { Title: "On Running Cloud 5", "Custom label (SKU)": "1644", "Category ID": "95672", Price: "35.00", Quantity: "1", "Condition ID": "USED_VERY_GOOD" },
        completeInSellerHub: ["Shipping, returns, and payment policies (not part of this template)"],
      },
    });
    const response = await previewRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requestedCount).toBe(1);
    expect(body.eligibleCount).toBe(1);
    expect(body.ineligibleCount).toBe(0);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].fields.Title).toBe("On Running Cloud 5");
    expect(body.blockers).toEqual([]);
    expect(body.marketplace).toBe("EBAY_UK");
    expect(body.action).toBe("Draft");
    expect(typeof body.templateVersion).toBe("string");
    expect(body.templateVersion.length).toBeGreaterThan(0);
  });

  it("a listing that can't be previewed (missing SKU etc) reports a precise blocker, never blocking the others", async () => {
    buildFeedDraftPreviewForProduct.mockImplementation(async (_ownerId: string, draftId: string) =>
      draftId === PRODUCT_A
        ? { ok: false, reason: "This listing is missing a SKU." }
        : { ok: true, row: { draftId, fields: { Title: "OK" }, completeInSellerHub: [] } });
    const response = await previewRoute(jsonRequest({ draftIds: [PRODUCT_A, PRODUCT_B] }));
    const body = await response.json();
    expect(body.requestedCount).toBe(2);
    expect(body.eligibleCount).toBe(1);
    expect(body.ineligibleCount).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].draftId).toBe(PRODUCT_B);
    expect(body.blockers).toEqual([{ draftId: PRODUCT_A, reason: "This listing is missing a SKU." }]);
  });

  it("REQUIREMENT: never silently omits a requested listing — every id gets a row or a blocker", async () => {
    buildFeedDraftPreviewForProduct.mockImplementation(async (_ownerId: string, draftId: string) => ({ ok: false, reason: `blocked ${draftId}` }));
    const response = await previewRoute(jsonRequest({ draftIds: [PRODUCT_A, PRODUCT_B] }));
    const body = await response.json();
    expect(body.rows.length + body.blockers.length).toBe(body.requestedCount);
    expect(body.blockers.map((b: { draftId: string }) => b.draftId).sort()).toEqual([PRODUCT_A, PRODUCT_B].sort());
  });

  it("PHASE 5: rejects an empty draftIds array server-side, with eligibleCount/rows/blockers all correctly zero/empty — never calls the preview builder", async () => {
    const response = await previewRoute(jsonRequest({ draftIds: [] }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.eligibleCount).toBe(0);
    expect(body.rows).toEqual([]);
    expect(buildFeedDraftPreviewForProduct).not.toHaveBeenCalled();
  });

  it("deduplicates repeated draft ids", async () => {
    buildFeedDraftPreviewForProduct.mockResolvedValue({ ok: true, row: { draftId: PRODUCT_A, fields: { Title: "OK" }, completeInSellerHub: [] } });
    const response = await previewRoute(jsonRequest({ draftIds: [PRODUCT_A, PRODUCT_A] }));
    const body = await response.json();
    expect(buildFeedDraftPreviewForProduct).toHaveBeenCalledTimes(1);
    expect(body.requestedCount).toBe(1);
  });

  it("PHASE 5: a client cannot bypass zero-row protection by sending a malformed body — rejected before any preview work", async () => {
    const response = await previewRoute(new Request("http://test", { method: "POST", body: "not json" }));
    expect(response.status).not.toBe(200);
    expect(buildFeedDraftPreviewForProduct).not.toHaveBeenCalled();
  });

  it("PHASE 6: never exposes a raw internal error to the browser when the whole route unexpectedly throws (e.g. requireOwner itself fails)", async () => {
    requireOwner.mockRejectedValueOnce(new Error("raw internal database connection string leaked accidentally"));
    const response = await previewRoute(jsonRequest({ draftIds: [PRODUCT_A] }));
    expect(response.status).not.toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("connection string");
  });
});
