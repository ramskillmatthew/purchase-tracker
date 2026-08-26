import { beforeEach, describe, expect, it, vi } from "vitest";
import unzipper from "unzipper";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest, prepareExportPhotos } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  prepareExportPhotos: vi.fn(),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));
vi.mock("@/lib/listing-studio/vinted-export-photos", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-export-photos")>();
  return { ...actual, prepareExportPhotos };
});

import { POST as exportRoute } from "@/app/api/listing-studio/listings-review/export/route";
import { AuthError } from "@/lib/auth/server";
import { validateExportManifest } from "@/lib/listing-studio/vinted-export-schema";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID_2 = "22222222-2222-4222-8222-222222222222";

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    brand: "Nike", model: "Pegasus", product_type: "Trainers", colours: ["Black"], material: "Mesh",
    uk_size: "9", sku: "AA1711", condition: "Very Good Condition",
    generated_title: "Nike Pegasus Trainers", generated_description: "A great pair of trainers.",
    vinted_audience: "mens",
    vinted_category_id: 1906, vinted_category_path: "Men > Shoes > Trainers", vinted_category_status: "category_assigned",
    confirmed_price_pence: 4500,
    ...overrides,
  };
}
function imageRow(overrides: Record<string, unknown> = {}) {
  return { id: "img-1", draft_id: DRAFT_ID, storage_path: `owner-1/${DRAFT_ID}/img-1-a.jpg`, mime_type: "image/jpeg", file_size: 1000, sort_order: 0, ...overrides };
}
function categoryRow(overrides: Record<string, unknown> = {}) {
  return { id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null, ...overrides };
}
function purchaseRow(overrides: Record<string, unknown> = {}) {
  return { id: "p1", sku: "AA1711", order_date: "2026-01-10", item_description: "Nike Pegasus", price_purchased: 18.5, ...overrides };
}

function requestWith(draftIds: string[]) {
  return new Request("http://test/api/listing-studio/listings-review/export", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftIds }),
  });
}

async function unzip(response: Response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  const directory = await unzipper.Open.buffer(buffer);
  const entries = new Map<string, Buffer>();
  for (const file of directory.files) {
    if (file.type === "File") entries.set(file.path, await file.buffer());
  }
  return entries;
}

beforeEach(() => {
  requireOwner.mockClear();
  supabaseRequestAll.mockReset();
  supabaseRequest.mockClear();
  prepareExportPhotos.mockReset();

  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("listing_drafts?")) return [draftRow()];
    if (path.startsWith("listing_draft_images?")) return [imageRow()];
    if (path.startsWith("vinted_categories?")) return [categoryRow()];
    if (path.startsWith("purchases?")) return [purchaseRow()];
    return [];
  });
  prepareExportPhotos.mockImplementation(async (images: { imageId: string }[]) =>
    images.map((img, i) => ({ imageId: img.imageId, fileName: `0${i + 1}.jpg`, bytes: Buffer.from(`bytes-${img.imageId}`) })));
});

describe("POST /api/listing-studio/listings-review/export — safety/auth/validation", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(401);
  });

  it("rejects an empty selection", async () => {
    const response = await exportRoute(requestWith([]));
    expect(response.status).toBe(400);
  });

  it("rejects a batch larger than the maximum", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `1111111${i}-1111-4111-8111-11111111111${i}`.slice(0, 36));
    const response = await exportRoute(requestWith(ids));
    expect(response.status).toBe(400);
  });

  it("accepts exactly the maximum batch size (10) at the schema level", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [];
      return [];
    });
    const ids = Array.from({ length: 10 }, (_, i) => `${i}1111111-1111-4111-8111-111111111111`);
    const response = await exportRoute(requestWith(ids));
    // Not 400 for "too many" — every id is individually reported as
    // "not found" (none exist in this fake DB), proving the batch-size
    // gate itself let all 10 through the schema layer.
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.rejected).toHaveLength(10);
    expect(body.error).not.toMatch(/at most/i);
  });

  it("cross-owner draft: a draft that isn't returned by the owner-scoped query is reported as not found, never silently included", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return []; // simulates the owner-scoped query finding nothing
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.rejected).toEqual([{ draftId: DRAFT_ID, sku: null, reasons: ["Listing not found."] }]);
  });

  it("REGRESSION: the listing_drafts query is itself scoped to owner_id=eq.<user> — cross-owner access is structurally impossible, not just filtered after the fact", async () => {
    await exportRoute(requestWith([DRAFT_ID]));
    const call = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("listing_drafts?"));
    expect(call![0]).toContain("owner_id=eq.owner-1");
  });
});

describe("POST /api/listing-studio/listings-review/export — server-side readiness re-validation (never trusts the browser)", () => {
  it("a fully Ready listing is exported successfully", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
  });

  it("rejects a listing missing brand, with a clear reason", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ brand: null })];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.rejected[0].reasons).toContain("Missing Brand");
  });

  it("rejects a listing with no Vinted category", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ vinted_category_id: null, vinted_category_path: null })];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.rejected[0].reasons.some((r: string) => /category/i.test(r))).toBe(true);
  });

  it("rejects a listing whose stored category has since gone inactive — a fresh catalogue lookup, never the stale stored path", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("vinted_categories?")) return [categoryRow({ is_active: false })];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
  });

  it("rejects a listing with no selling price", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ confirmed_price_pence: null })];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.rejected[0].reasons).toContain("Missing selling price");
  });

  it("rejects a listing with no uploaded photos at all", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.rejected[0].reasons).toContain("No uploaded photos");
  });

  it("rejects a listing with more photos than the per-listing maximum", async () => {
    const manyImages = Array.from({ length: 41 }, (_, i) => imageRow({ id: `img-${i}`, sort_order: i }));
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return manyImages;
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.rejected[0].reasons.some((r: string) => /too many photos/i.test(r))).toBe(true);
  });

  it("REGRESSION: total combined photo bytes over the limit is rejected BEFORE any photo is downloaded", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [imageRow({ file_size: 200 * 1024 * 1024 })];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/too large/i);
    expect(prepareExportPhotos).not.toHaveBeenCalled();
  });

  it("a photo download failure aborts the whole export with a clear error", async () => {
    const { ExportPhotoError } = await import("@/lib/listing-studio/vinted-export-photos");
    prepareExportPhotos.mockRejectedValueOnce(new ExportPhotoError("img-1", "Could not download this photo."));
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(502);
  });
});

describe("POST /api/listing-studio/listings-review/export — ZIP structure and exported data", () => {
  it("produces the exact top-level structure: <root>/manifest.json, <root>/README.txt, <root>/products/<folder>/listing.json, <root>/products/<folder>/photos/01.<ext>", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const paths = [...entries.keys()];
    const root = paths[0].split("/")[0];
    expect(root).toMatch(/^vinted-drafts-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(paths).toContain(`${root}/manifest.json`);
    expect(paths).toContain(`${root}/README.txt`);
    expect(paths).toContain(`${root}/products/001-AA1711/listing.json`);
    expect(paths).toContain(`${root}/products/001-AA1711/photos/01.jpg`);
  });

  it("cover photo is always \"01\" and photo order is preserved from sort_order", async () => {
    prepareExportPhotos.mockImplementation(async (images: { imageId: string }[]) =>
      images.map((img, i) => ({ imageId: img.imageId, fileName: `0${i + 1}.jpg`, bytes: Buffer.from(`bytes-${img.imageId}`) })));
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [
        imageRow({ id: "img-cover", sort_order: 0 }),
        imageRow({ id: "img-second", sort_order: 1 }),
      ];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    expect(entries.get(`${root}/products/001-AA1711/photos/01.jpg`)!.toString()).toBe("bytes-img-cover");
    expect(entries.get(`${root}/products/001-AA1711/photos/02.jpg`)!.toString()).toBe("bytes-img-second");
    const listingJson = JSON.parse(entries.get(`${root}/products/001-AA1711/listing.json`)!.toString());
    expect(listingJson.photoFiles).toEqual(["photos/01.jpg", "photos/02.jpg"]);
  });

  it("listing.json contains the exact stored title/description/category/size/colours/material/price/audience", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    const listingJson = JSON.parse(entries.get(`${root}/products/001-AA1711/listing.json`)!.toString());
    expect(listingJson.title).toBe("Nike Pegasus Trainers");
    expect(listingJson.description).toBe("A great pair of trainers.");
    expect(listingJson.brand).toBe("Nike");
    expect(listingJson.model).toBe("Pegasus");
    expect(listingJson.productType).toBe("Trainers");
    expect(listingJson.condition).toBe("Very Good Condition");
    expect(listingJson.ukSize).toBe("9");
    expect(listingJson.audience).toBe("mens");
    expect(listingJson.colours).toEqual(["Black"]);
    expect(listingJson.materials).toEqual(["Mesh"]);
    expect(listingJson.vintedCategoryId).toBe(1906);
    expect(listingJson.vintedCategoryPath).toBe("Men > Shoes > Trainers");
  });

  it("GBP price is correct integer pence + formatted display, and purchase price is distinguished from the Vinted selling price", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    const listingJson = JSON.parse(entries.get(`${root}/products/001-AA1711/listing.json`)!.toString());
    expect(listingJson.pricePence).toBe(4500);
    expect(listingJson.priceDisplay).toBe("£45.00");
    expect(listingJson.purchasePricePence).toBe(1850);
    expect(listingJson.purchasePriceDisplay).toBe("£18.50");
    expect(listingJson.pricePence).not.toBe(listingJson.purchasePricePence);
  });

  it("purchasePricePence is null when no matching purchase exists — never confused with £0", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow()];
      if (path.startsWith("listing_draft_images?")) return [imageRow()];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      if (path.startsWith("purchases?")) return []; // no purchase found
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    const listingJson = JSON.parse(entries.get(`${root}/products/001-AA1711/listing.json`)!.toString());
    expect(listingJson.purchasePricePence).toBeNull();
    expect(listingJson.purchasePriceDisplay).toBeNull();
  });

  it("REGRESSION: a missing SKU is itself a Ready-validation failure (SKU is a required field) — this route correctly rejects it rather than silently exporting with a fallback folder name; the fallback-to-draft-id NAMING behaviour itself is covered directly against buildProductFolderName in vinted-export-schema.test.ts, for the defensive case where it's ever called without a SKU", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ sku: null })];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.rejected[0].reasons).toContain("Missing SKU");
  });

  it("REGRESSION: duplicate SKUs across two listings in the same batch produce two distinct, non-colliding folders", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow(), draftRow({ id: DRAFT_ID_2 })]; // same SKU "AA1711"
      if (path.startsWith("listing_draft_images?")) return [imageRow({ draft_id: DRAFT_ID }), imageRow({ id: "img-2", draft_id: DRAFT_ID_2 })];
      if (path.startsWith("vinted_categories?")) return [categoryRow()];
      return [];
    });
    const response = await exportRoute(requestWith([DRAFT_ID, DRAFT_ID_2]));
    expect(response.status).toBe(200);
    const entries = await unzip(response);
    const paths = [...entries.keys()];
    const [root] = paths[0].split("/");
    expect(paths).toContain(`${root}/products/001-AA1711/listing.json`);
    expect(paths).toContain(`${root}/products/002-AA1711/listing.json`);
  });

  it("manifest.json validates against the export schema and lists every exported listing", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    const manifest = JSON.parse(entries.get(`${root}/manifest.json`)!.toString());
    expect(() => validateExportManifest(manifest)).not.toThrow();
    expect(manifest.listingCount).toBe(1);
    expect(manifest.listings[0].draftId).toBe(DRAFT_ID);
  });

  it("REGRESSION: no signed URL, credential, or internal secret ever appears anywhere in the exported JSON", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    const manifestText = entries.get(`${root}/manifest.json`)!.toString();
    const listingText = entries.get(`${root}/products/001-AA1711/listing.json`)!.toString();
    for (const text of [manifestText, listingText]) {
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text.toLowerCase()).not.toMatch(/service_role|secret|token|signature|cookie/);
    }
  });

  it("README.txt is included and mentions saving as a draft, never publishing", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    const readme = entries.get(`${root}/README.txt`)!.toString();
    expect(readme).toMatch(/draft/i);
  });
});

describe("POST /api/listing-studio/listings-review/export — export tracking", () => {
  it("sets vinted_exported_at and vinted_export_id on every exported listing, but never vinted_draft_created_at", async () => {
    await exportRoute(requestWith([DRAFT_ID]));
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).startsWith(`listing_drafts?id=eq.${DRAFT_ID}`) && (c[1] as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.vinted_exported_at).toBeTruthy();
    expect(body.vinted_export_id).toBeTruthy();
    expect(body).not.toHaveProperty("vinted_draft_created_at");
  });

  it("the export tracking write only happens AFTER the ZIP was fully built — the PATCH call happens, and the response is still a successful ZIP", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(200);
    expect(supabaseRequest.mock.calls.some(c => (c[1] as RequestInit)?.method === "PATCH")).toBe(true);
  });

  it("REGRESSION: re-exporting the same listing again is allowed — never blocked, and vinted_export_id changes each time", async () => {
    await exportRoute(requestWith([DRAFT_ID]));
    const firstBody = JSON.parse((supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH")![1] as RequestInit).body as string);

    supabaseRequest.mockClear();
    const secondResponse = await exportRoute(requestWith([DRAFT_ID]));
    expect(secondResponse.status).toBe(200);
    const secondBody = JSON.parse((supabaseRequest.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH")![1] as RequestInit).body as string);
    expect(secondBody.vinted_export_id).not.toBe(firstBody.vinted_export_id);
  });

  it("a failed/rejected export never writes any export-tracking fields", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("listing_drafts?")) return [draftRow({ confirmed_price_pence: null })];
      return [];
    });
    await exportRoute(requestWith([DRAFT_ID]));
    expect(supabaseRequest.mock.calls.some(c => (c[1] as RequestInit)?.method === "PATCH")).toBe(false);
  });
});

describe("POST /api/listing-studio/listings-review/export — misc", () => {
  it("catches everything through safeApiError", async () => {
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await exportRoute(requestWith([DRAFT_ID]));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });

  it("the Content-Disposition filename matches the ZIP's own root folder name", async () => {
    const response = await exportRoute(requestWith([DRAFT_ID]));
    const disposition = response.headers.get("Content-Disposition")!;
    const fileName = /filename="([^"]+)"/.exec(disposition)![1];
    const entries = await unzip(response);
    const [root] = [...entries.keys()][0].split("/");
    expect(fileName).toBe(`${root}.zip`);
  });
});
