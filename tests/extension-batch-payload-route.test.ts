import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { GET as batchPayloadRoute, OPTIONS as batchOptions } from "@/app/api/extension/batch/route";
import { signBatchToken } from "@/lib/listing-studio/extension-batch-tokens";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "owner-1";
const EXTENSION_ORIGIN = "chrome-extension://ocohhcppeflfggaicbpgmjbmekgbkjcl";

function batchRow(overrides: Record<string, unknown> = {}) {
  return { id: BATCH_ID, status: "claimed", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), owner_id: OWNER_ID, ...overrides };
}
function itemRow(overrides: Record<string, unknown> = {}) {
  return { id: ITEM_ID, draft_id: DRAFT_ID, queue_position: 0, status: "queued", ...overrides };
}
function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID, brand: "Nike", model: "Pegasus", product_type: "Trainers", colours: ["Black"], material: "Mesh",
    uk_size: "9", sku: "AA1711", condition: "Very Good Condition",
    generated_title: "Nike Pegasus Trainers", generated_description: "desc",
    vinted_audience: "mens", vinted_category_id: 1906, vinted_category_path: "Men > Shoes > Trainers",
    confirmed_price_pence: 4500,
    ...overrides,
  };
}
function categoryRow(overrides: Record<string, unknown> = {}) {
  return { id: 1906, code: null, label: "Trainers", full_path: "Men > Shoes > Trainers", parent_id: 1905, root_id: 1904, depth: 2, is_leaf: true, is_selectable: true, is_active: true, audience: "mens", item_family: null, ...overrides };
}
function imageRow(overrides: Record<string, unknown> = {}) {
  return { id: "img-1", draft_id: DRAFT_ID, mime_type: "image/jpeg", sort_order: 0, ...overrides };
}

async function requestWithToken(token: string | null, origin = EXTENSION_ORIGIN) {
  return new Request("http://test/api/extension/batch", {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
  });
}

beforeEach(() => {
  process.env.EXTENSION_BATCH_SECRET = "f".repeat(32);
  process.env.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  supabaseRequestAll.mockReset();
  supabaseRequest.mockReset();
  supabaseRequestAll.mockImplementation(async (path: string) => {
    if (path.startsWith("vinted_extension_batches?")) return [batchRow()];
    if (path.startsWith("vinted_extension_batch_items?")) return [itemRow()];
    if (path.startsWith("listing_drafts?")) return [draftRow()];
    if (path.startsWith("listing_draft_images?")) return [imageRow()];
    if (path.startsWith("vinted_categories?")) return [categoryRow()];
    return [];
  });
});

describe("GET /api/extension/batch", () => {
  it("requires a bearer token", async () => {
    const response = await batchPayloadRoute(await requestWithToken(null));
    expect(response.status).toBe(401);
  });

  it("rejects an invalid/garbage token", async () => {
    const response = await batchPayloadRoute(await requestWithToken("garbage"));
    expect(response.status).toBe(401);
  });

  it("returns the full validated payload for a claimed batch, with each photo a RELATIVE path pointing at this app's own photo route (never a raw Supabase URL, never an absolute URL)", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await batchPayloadRoute(await requestWithToken(token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchId).toBe(BATCH_ID);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.title).toBe("Nike Pegasus Trainers");
    expect(item.vintedCategoryId).toBe(1906);
    expect(item.vintedCategoryPath).toBe("Men > Shoes > Trainers");
    expect(item.photos[0].path).toBe(`/api/extension/batch/photos/${ITEM_ID}/0`);
    expect(item.photos[0].url).toBeUndefined(); // the old absolute-url field no longer exists at all
    expect(item.photos[0].path).not.toContain("supabase");
    expect(item.photos[0].path).not.toMatch(/^https?:\/\//); // relative, never absolute
  });

  it("REGRESSION (photo origin-mismatch bug): the returned photo path never depends on NEXT_PUBLIC_APP_URL — the route works identically whether it's set, unset, or set to a completely different origin than the app is actually running on", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await batchPayloadRoute(await requestWithToken(token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0].photos[0].path).toBe(`/api/extension/batch/photos/${ITEM_ID}/0`);

    process.env.NEXT_PUBLIC_APP_URL = "http://this-is-a-completely-different-origin.example:9999";
    const response2 = await batchPayloadRoute(await requestWithToken(await signBatchToken(BATCH_ID, 600)));
    const body2 = await response2.json();
    expect(body2.items[0].photos[0].path).toBe(`/api/extension/batch/photos/${ITEM_ID}/0`); // identical — the env var never influenced it
  });

  it("REGRESSION: the route source no longer READS process.env.NEXT_PUBLIC_APP_URL anywhere (a code comment may still mention the old bug/helper by name for history; this checks actual env var usage, not prose)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("app/api/extension/batch/route.ts", "utf8");
    expect(source).not.toMatch(/process\.env\.NEXT_PUBLIC_APP_URL/);
  });

  it("uses the current EXTENSION_BATCH_SCHEMA_VERSION (v2 — relative photo paths)", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await batchPayloadRoute(await requestWithToken(token));
    const body = await response.json();
    expect(body.schemaVersion).toBe("vinted-extension-batch-v2");
  });

  it("REGRESSION: never includes purchasePricePence/purchasePriceDisplay — deliberately out of scope for the extension payload", () => {
    // Structural: the route source never references those field names for
    // the extension payload at all (they exist only in the ZIP export schema).
    return import("node:fs").then(async fs => {
      const source = fs.readFileSync("app/api/extension/batch/route.ts", "utf8");
      expect(source).not.toMatch(/purchasePricePence|purchase_match/i);
    });
  });

  it("rejects (410) once the batch has expired", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [batchRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] : []));
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await batchPayloadRoute(await requestWithToken(token));
    expect(response.status).toBe(410);
  });

  it("rejects (409) once the batch is no longer claimed/in_progress (e.g. already completed or cancelled)", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [batchRow({ status: "cancelled" })] : []));
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await batchPayloadRoute(await requestWithToken(token));
    expect(response.status).toBe(409);
  });

  it("REGRESSION: a token minted for a DIFFERENT batch id can never fetch this one", async () => {
    const otherBatchToken = await signBatchToken("22222222-2222-4222-8222-222222222222", 600);
    supabaseRequestAll.mockImplementation(async (path: string) => (path.startsWith("vinted_extension_batches?") ? [] : []));
    const response = await batchPayloadRoute(await requestWithToken(otherBatchToken));
    expect(response.status).toBe(404);
  });

  it("first fetch flips status from claimed to in_progress", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    await batchPayloadRoute(await requestWithToken(token));
    const patchCall = supabaseRequest.mock.calls.find(c => (c[0] as string).includes("status=eq.claimed"));
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string).status).toBe("in_progress");
  });

  it("never exposes the Supabase service-role key or a signed URL directly in the response", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await batchPayloadRoute(await requestWithToken(token));
    const text = await response.text();
    expect(text).not.toMatch(/service_role|SUPABASE_SECRET_KEY/i);
    expect(text).not.toMatch(/supabase\.co/i);
  });

  it("responds with CORS headers only for the configured EXTENSION_ORIGIN", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    const response = await batchPayloadRoute(await requestWithToken(token));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION_ORIGIN);
    const mismatched = await batchPayloadRoute(await requestWithToken(token, "https://evil.example"));
    expect(mismatched.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await batchOptions(await requestWithToken(null));
    expect(preflight.status).toBe(204);
  });

  it("catches everything through safeApiError", async () => {
    const token = await signBatchToken(BATCH_ID, 600);
    supabaseRequestAll.mockRejectedValueOnce(new Error("db exploded"));
    const response = await batchPayloadRoute(await requestWithToken(token));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("db exploded");
  });
});
