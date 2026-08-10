import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequestAll, prepareSinglePhoto } = vi.hoisted(() => ({
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  prepareSinglePhoto: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll }));
vi.mock("@/lib/listing-studio/vinted-export-photos", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/listing-studio/vinted-export-photos")>();
  return { ...actual, prepareSinglePhoto };
});

import { GET as photoRoute, OPTIONS as photoOptions } from "@/app/api/extension/batch/photos/[itemId]/[position]/route";
import { signBatchToken } from "@/lib/listing-studio/extension-batch-tokens";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ITEM_ID = "44444444-4444-4444-8444-444444444444";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "owner-1";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function params(itemId = ITEM_ID, position = "0") { return { params: Promise.resolve({ itemId, position }) }; }
function batchRow(overrides: Record<string, unknown> = {}) {
  return { id: BATCH_ID, status: "in_progress", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), owner_id: OWNER_ID, ...overrides };
}
function itemRow(overrides: Record<string, unknown> = {}) {
  return { id: ITEM_ID, batch_id: BATCH_ID, draft_id: DRAFT_ID, ...overrides };
}
function imageRow(overrides: Record<string, unknown> = {}) {
  return { id: "img-1", storage_path: `${OWNER_ID}/${DRAFT_ID}/img-1-photo.jpg`, mime_type: "image/jpeg", sort_order: 0, ...overrides };
}

async function requestWithToken(token: string | null, origin = EXTENSION_ORIGIN) {
  return new Request("http://test/api/extension/batch/photos/x/0", { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) } });
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "g".repeat(32);
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  supabaseRequestAll.mockReset();
  prepareSinglePhoto.mockReset();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
    if (path.startsWith("vinted_extension_batch_items?")) return [itemRow()];
    if (path.startsWith("listing_draft_images?")) return [imageRow()];
    return [];
  });
  prepareSinglePhoto.mockImplementation(async () => ({ imageId: "img-1", fileName: "01.jpg", bytes: Buffer.from("fake-jpeg-bytes"), contentType: "image/jpeg" }));
});

describe("GET /api/extension/batch/photos/[itemId]/[position]", () => {
  it("requires a bearer token", async () => {
    const response = await photoRoute(await requestWithToken(null), params());
    expect(response.status).toBe(401);
  });

  it("returns the converted photo bytes with the correct Content-Type", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await photoRoute(await requestWithToken(token), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.toString()).toBe("fake-jpeg-bytes");
  });

  it("REGRESSION: batch-restricted per fetch — an item that doesn't belong to THIS token's own batch_id is rejected, even if the item id is real", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
      if (path.startsWith("vinted_extension_batch_items?")) return []; // scoped query (id=eq.X&batch_id=eq.Y) finds nothing for a mismatched batch
      return [];
    });
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await photoRoute(await requestWithToken(token), params(OTHER_ITEM_ID));
    expect(response.status).toBe(404);
  });

  it("rejects (410) once the batch has expired", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [batchRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] : []));
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await photoRoute(await requestWithToken(token), params());
    expect(response.status).toBe(410);
  });

  it("404s for an out-of-range photo position", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await photoRoute(await requestWithToken(token), params(ITEM_ID, "5"));
    expect(response.status).toBe(404);
  });

  it("aborts an individual item cleanly (502) when the photo cannot be prepared — never a partial/corrupt response", async () => {
    const { ExportPhotoError } = await import("@/lib/listing-studio/vinted-export-photos");
    prepareSinglePhoto.mockRejectedValueOnce(new ExportPhotoError("img-1", "Could not download this photo."));
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await photoRoute(await requestWithToken(token), params());
    expect(response.status).toBe(502);
  });

  it("HEIC conversion is delegated to the app's existing conversion function (prepareSinglePhoto), never a second implementation", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await photoRoute(await requestWithToken(token), params());
    expect(prepareSinglePhoto).toHaveBeenCalledTimes(1);
  });

  it("the underlying image query is scoped to this batch's own owner_id — never a client-controllable value", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await photoRoute(await requestWithToken(token), params());
    const call = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("listing_draft_images?"));
    expect(call![0]).toContain(`owner_id=eq.${OWNER_ID}`);
  });

  it("responds with CORS headers only for the configured EXTENSION_ORIGIN, and OPTIONS preflight succeeds", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await photoRoute(await requestWithToken(token), params());
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION_ORIGIN);
    const preflight = await photoOptions(await requestWithToken(null));
    expect(preflight.status).toBe(204);
  });

  it("catches everything through safeApiError", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await photoRoute(await requestWithToken(token), params());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});
