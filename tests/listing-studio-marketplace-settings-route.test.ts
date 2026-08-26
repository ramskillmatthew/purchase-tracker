import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequestAll, supabaseRequest } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequestAll, supabaseRequest }));

import { GET, PATCH } from "@/app/api/listing-studio/marketplace-settings/route";
import { AuthError } from "@/lib/auth/server";
import { FALLBACK_MARKETPLACE_DRAFT_SETTINGS } from "@/lib/listing-studio/marketplace-settings";

beforeEach(() => {
  requireOwner.mockClear(); supabaseRequestAll.mockReset(); supabaseRequest.mockReset();
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("GET /api/listing-studio/marketplace-settings", () => {
  it("requires authentication", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await GET(new Request("http://test?marketplace=EBAY_UK"));
    expect(response.status).toBe(401);
  });

  it("returns fixed application defaults when no account-level row exists yet", async () => {
    supabaseRequestAll.mockResolvedValue([]);
    const response = await GET(new Request("http://test?marketplace=EBAY_UK"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings).toEqual(FALLBACK_MARKETPLACE_DRAFT_SETTINGS);
  });

  it("returns the saved account-level defaults when a row exists", async () => {
    supabaseRequestAll.mockResolvedValue([{
      content_mode: null, listing_format: "buy_it_now", default_quantity: 3, allow_offers: true,
      postage_profile_label: "Royal Mail Tracked 48", return_profile_label: null, payment_profile_label: null,
      package_size: "small_parcel", automation_mode: "strict",
    }]);
    const response = await GET(new Request("http://test?marketplace=EBAY_UK"));
    const body = await response.json();
    expect(body.settings.quantity).toBe(3);
    expect(body.settings.allowOffers).toBe(true);
    expect(body.settings.automationMode).toBe("strict");
    expect(body.settings.postageProfileLabel).toBe("Royal Mail Tracked 48");
  });

  it("rejects a missing/invalid marketplace query param", async () => {
    const response = await GET(new Request("http://test?marketplace=MARS"));
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/listing-studio/marketplace-settings", () => {
  function patchRequest(body: unknown) {
    return new Request("http://test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  it("REQUIREMENT: never persists a fabricated eBay policy id — only an honest local label", async () => {
    const response = await PATCH(patchRequest({ marketplace: "EBAY_UK", settings: { postageProfileLabel: "My Royal Mail profile" } }));
    expect(response.status).toBe(200);
    const [path, init] = supabaseRequest.mock.calls[0];
    expect(path).toContain("on_conflict=owner_id,marketplace");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.postage_profile_label).toBe("My Royal Mail profile");
    expect(body).not.toHaveProperty("postage_policy_id");
  });

  it("rejects an unrecognised settings key", async () => {
    const response = await PATCH(patchRequest({ marketplace: "EBAY_UK", settings: { madeUpSetting: true } }));
    expect(response.status).toBe(400);
    expect(supabaseRequest).not.toHaveBeenCalled();
  });

  it("only ever writes the fields explicitly supplied — a partial update never resets the rest", async () => {
    await PATCH(patchRequest({ marketplace: "EBAY_UK", settings: { automationMode: "fast" } }));
    const body = JSON.parse((supabaseRequest.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ owner_id: "owner-1", marketplace: "EBAY_UK", updated_at: expect.any(String), automation_mode: "fast" });
  });
});
