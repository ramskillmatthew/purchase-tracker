import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
  supabaseRequest: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 204 })),
  supabaseRequestAll: vi.fn<(path: string) => Promise<unknown[]>>(),
  extractEbayListing: vi.fn(),
  uploadStorageObject: vi.fn(async () => {}),
  deleteStorageObjects: vi.fn(async () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/server", () => ({ requireOwner: mocks.requireOwner, AuthError: class AuthError extends Error { status = 401; } }));
vi.mock("@/lib/supabase", () => ({ supabaseRequest: mocks.supabaseRequest, supabaseRequestAll: mocks.supabaseRequestAll }));
vi.mock("@/lib/listing-studio/ebay-extractor", () => ({ extractEbayListing: mocks.extractEbayListing, decodeHtml: (value: string) => value }));
vi.mock("@/lib/listing-studio/storage-rest", () => ({ uploadStorageObject: mocks.uploadStorageObject, deleteStorageObjects: mocks.deleteStorageObjects }));

import { POST } from "@/app/api/listing-studio/ebay-imports/[batchId]/items/[itemId]/process/route";

const batchId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
  mocks.supabaseRequestAll.mockImplementation(async (path: string) => path.startsWith("ebay_import_items?id=") ? [{ id: itemId, batch_id: batchId, source_url: "https://www.ebay.co.uk/itm/123456789012", status: "waiting", draft_id: null, attempt_count: 0 }] : [{ status: "imported" }]);
  mocks.extractEbayListing.mockResolvedValue({ itemId: "123456789012", url: "https://www.ebay.co.uk/itm/123456789012", title: "Nike trainers", description: "Original description", imageUrls: ["https://i.ebayimg.com/images/g/x/s-l1600.jpg"], pricePence: 5500, currency: "GBP", condition: "https://schema.org/UsedCondition", category: "Trainers", brand: "Nike", size: "9", colours: ["Black"], material: "Mesh", quantity: 1, itemSpecifics: { Brand: "Nike" } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg", "content-length": "3" } })));
});

describe("POST eBay import item process route", () => {
  it("copies photos, creates a normal editable draft and marks the import complete", async () => {
    const response = await POST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ batchId, itemId }) });
    expect(response.status).toBe(200);
    expect(mocks.uploadStorageObject).toHaveBeenCalledTimes(1);
    const draftInsert = mocks.supabaseRequest.mock.calls.find(call => call[0] === "listing_drafts");
    expect(JSON.parse((draftInsert?.[1] as RequestInit).body as string)).toMatchObject({ title: "Nike trainers", generated_title: "Nike trainers", generated_description: "Original description", brand: "Nike", uk_size: "9", status: "needs_review" });
    const imageInsert = mocks.supabaseRequest.mock.calls.find(call => call[0] === "listing_draft_images");
    expect(JSON.parse((imageInsert?.[1] as RequestInit).body as string)).toHaveLength(1);
    expect(mocks.supabaseRequest.mock.calls.some(call => String(call[0]).startsWith("ebay_import_items?") && JSON.parse((call[1] as RequestInit).body as string).status === "imported")).toBe(true);
  });

  it("stores only the label from eBay's verbose condition definition", async () => {
    mocks.extractEbayListing.mockResolvedValueOnce({ ...(await mocks.extractEbayListing.getMockImplementation()!()), condition: "New: A brand-new, unused, unopened and undamaged item in original retail packaging" });
    const response = await POST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ batchId, itemId }) });
    expect(response.status).toBe(200);
    const draftInsert = mocks.supabaseRequest.mock.calls.find(call => call[0] === "listing_drafts");
    expect(JSON.parse((draftInsert?.[1] as RequestInit).body as string).condition).toBe("New");
  });

  it("rejects malformed route ids before any extraction or storage work", async () => {
    const response = await POST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ batchId: "bad", itemId: "bad" }) });
    expect(response.status).toBe(400);
    expect(mocks.extractEbayListing).not.toHaveBeenCalled();
    expect(mocks.uploadStorageObject).not.toHaveBeenCalled();
  });
});
