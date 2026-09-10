import { describe, expect, it } from "vitest";
import {
  validateEbayExtensionBatchPayload, validateEbayExtensionBatchItem, buildEbayExtensionPhotoPath,
  EBAY_EXTENSION_BATCH_SCHEMA_VERSION, MAX_EBAY_EXTENSION_BATCH_LISTINGS,
} from "@/lib/listing-studio/ebay-extension-batch-schema";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const MDRAFT_ID = "22222222-2222-4222-8222-222222222222";
const PDRAFT_ID = "33333333-3333-4333-8333-333333333333";

// A realistic payload built from this session's own live-read SKU 1644
// data (see the conversation's own read-only Supabase queries): 8 photos
// in sort_order 0-7, eBay title/description/category/condition/price as
// stored on the EBAY_UK marketplace draft, legacy ebay_offer_id present
// but never referenced anywhere in this schema.
function sku1644Item(overrides: Record<string, unknown> = {}) {
  return {
    itemId: ITEM_ID, marketplaceDraftId: MDRAFT_ID, productDraftId: PDRAFT_ID, queuePosition: 0,
    sku: "1644", marketplace: "EBAY_UK" as const,
    title: "On Running Cloud 5 Womens UK 4 Light blue Grey Mesh Running Trainers Lightweight",
    description: "On Running Cloud 5 Women's Running Trainers – UK 4",
    categoryId: "95672", categoryName: "Trainers",
    conditionValue: "Used – Very Good", conditionDescription: null,
    brand: "On Running", size: "4", colour: "Light blue, Grey",
    itemSpecifics: [
      { name: "Brand", value: "On Running" }, { name: "Model", value: "Cloud 5" },
      { name: "Colour", value: "Light blue, Grey" }, { name: "UK Shoe Size", value: "4" },
      { name: "Department", value: "Women" }, { name: "Upper Material", value: "Mesh" },
      { name: "Performance/Activity", value: "Running & Jogging" },
    ],
    pricePence: 3500, priceDisplay: "£35.00", quantity: 1,
    photos: Array.from({ length: 8 }, (_, position) => ({ position, path: buildEbayExtensionPhotoPath(ITEM_ID, position), fileName: `${String(position + 1).padStart(2, "0")}.jpg` })),
    fulfillmentPolicy: { ebayPolicyId: "248160141024", name: "1 week" },
    returnPolicy: { ebayPolicyId: "260426783024", name: "returns" },
    paymentPolicy: { ebayPolicyId: "248160067024", name: "buy it now" },
    ...overrides,
  };
}

describe("eBay extension batch schema — REQUIREMENT: the exact SKU 1644 payload shape validates", () => {
  it("a realistic SKU 1644 item validates", () => {
    expect(() => validateEbayExtensionBatchItem(sku1644Item())).not.toThrow();
  });

  it("a full batch payload (schemaVersion, batchId, expiresAt, items) validates", () => {
    const payload = {
      schemaVersion: EBAY_EXTENSION_BATCH_SCHEMA_VERSION, batchId: MDRAFT_ID, expiresAt: "2026-09-10T12:10:00.000Z",
      items: [sku1644Item()],
    };
    expect(() => validateEbayExtensionBatchPayload(payload)).not.toThrow();
  });

  it("preserves photo ORDER exactly — position 0 through 7, never re-sorted", () => {
    const item = validateEbayExtensionBatchItem(sku1644Item());
    expect(item.photos.map(p => p.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("REQUIREMENT: the payload type has NO field for the legacy Inventory API offer id anywhere — it structurally cannot block or influence this payload", () => {
    const item = sku1644Item() as Record<string, unknown>;
    expect(Object.keys(item)).not.toContain("ebayOfferId");
    expect(Object.keys(item)).not.toContain("legacyOfferId");
    // .strict() schema — an extra unexpected field is REJECTED, not silently dropped
    expect(() => validateEbayExtensionBatchItem({ ...sku1644Item(), ebayOfferId: "254825272011" })).toThrow();
  });

  it("policies are OPTIONAL (nullable) — a listing with no policy assigned yet is still a valid payload", () => {
    expect(() => validateEbayExtensionBatchItem(sku1644Item({ fulfillmentPolicy: null, returnPolicy: null, paymentPolicy: null }))).not.toThrow();
  });

  it("this milestone caps a batch at exactly 1 listing", () => {
    expect(MAX_EBAY_EXTENSION_BATCH_LISTINGS).toBe(1);
    const payload = {
      schemaVersion: EBAY_EXTENSION_BATCH_SCHEMA_VERSION, batchId: MDRAFT_ID, expiresAt: "2026-09-10T12:10:00.000Z",
      items: [sku1644Item(), sku1644Item({ itemId: "44444444-4444-4444-8444-444444444444" })],
    };
    expect(() => validateEbayExtensionBatchPayload(payload)).toThrow();
  });

  it("rejects a photo path that doesn't match the eBay batch route shape (never a Vinted path, never an absolute URL)", () => {
    expect(() => validateEbayExtensionBatchItem(sku1644Item({ photos: [{ position: 0, path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0", fileName: "01.jpg" }] }))).toThrow();
    expect(() => validateEbayExtensionBatchItem(sku1644Item({ photos: [{ position: 0, path: "https://evil.example/x.jpg", fileName: "01.jpg" }] }))).toThrow();
  });

  it("rejects a title longer than eBay's own 80-character limit", () => {
    expect(() => validateEbayExtensionBatchItem(sku1644Item({ title: "x".repeat(81) }))).toThrow();
  });

  it("requires at least one photo", () => {
    expect(() => validateEbayExtensionBatchItem(sku1644Item({ photos: [] }))).toThrow();
  });

  it("requires a non-empty SKU", () => {
    expect(() => validateEbayExtensionBatchItem(sku1644Item({ sku: "" }))).toThrow();
  });
});
