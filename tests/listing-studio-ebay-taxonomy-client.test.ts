import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getDefaultCategoryTreeId, getCategorySuggestions, getItemAspectsForCategory, __resetEbayTokenCacheForTests,
} from "@/lib/listing-studio/ebay-taxonomy-client";

const ORIGINAL_ENV = { ...process.env };

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: "test-token", expires_in: 7200 }), { status: 200 });
}

beforeEach(() => {
  __resetEbayTokenCacheForTests();
  process.env.EBAY_CLIENT_ID = "test-client-id";
  process.env.EBAY_CLIENT_SECRET = "test-client-secret";
  delete process.env.EBAY_ENVIRONMENT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("credential gating", () => {
  it("REQUIREMENT: returns not_configured, never attempting a request, when EBAY_CLIENT_ID/SECRET are absent", async () => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also gates when only one of the two credentials is set", async () => {
    delete process.env.EBAY_CLIENT_SECRET;
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: false, error: "not_configured" });
  });
});

describe("OAuth token handling", () => {
  it("fetches a token via client-credentials Basic auth, then reuses it for the actual API call", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/identity/v1/oauth2/token")) return tokenResponse();
      return new Response(JSON.stringify({ categoryTreeId: "3", categoryTreeVersion: "119" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119" } });
    const tokenCall = fetchMock.mock.calls.find(call => String(call[0]).includes("oauth2/token"));
    const tokenInit = tokenCall![1] as { headers: Record<string, string>; body: string };
    expect(tokenInit.headers.Authorization).toMatch(/^Basic /);
    expect(tokenInit.body).toContain("grant_type=client_credentials");
  });

  it("REGRESSION: a cached, unexpired token is reused — the token endpoint is not called twice", async () => {
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("oauth2/token")) { tokenCalls += 1; return tokenResponse(); }
      return new Response(JSON.stringify({ categoryTreeId: "3", categoryTreeVersion: "119" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await getDefaultCategoryTreeId("EBAY_GB");
    await getDefaultCategoryTreeId("EBAY_GB");
    expect(tokenCalls).toBe(1);
  });

  it("uses the sandbox host when EBAY_ENVIRONMENT=SANDBOX", async () => {
    process.env.EBAY_ENVIRONMENT = "SANDBOX";
    const fetchMock = vi.fn(async (_url: string) => tokenResponse());
    vi.stubGlobal("fetch", fetchMock);
    await getDefaultCategoryTreeId("EBAY_GB").catch(() => {});
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.sandbox.ebay.com");
  });
});

describe("getDefaultCategoryTreeId", () => {
  it("parses a valid response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : new Response(JSON.stringify({ categoryTreeId: "3", categoryTreeVersion: "119", categoryTreeMarketplaceId: "EBAY_GB" }), { status: 200 })));
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: true, data: { categoryTreeId: "3", categoryTreeVersion: "119", categoryTreeMarketplaceId: "EBAY_GB" } });
  });

  it("REGRESSION: rejects a malformed response rather than trusting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : new Response(JSON.stringify({ somethingElse: true }), { status: 200 })));
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: false, error: "invalid_response" });
  });

  it("surfaces a 429 as rate_limited, never a generic failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : new Response(null, { status: 429 })));
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: false, error: "rate_limited" });
  });

  it("surfaces a network throw as request_failed, never an unhandled rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (String(url).includes("oauth2/token")) return tokenResponse(); throw new Error("network down"); }));
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(result).toEqual({ ok: false, error: "request_failed" });
  });

  it("REGRESSION: never leaks a raw provider error message in its result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (String(url).includes("oauth2/token")) return tokenResponse(); throw new Error("secret upstream detail: sk-abc123"); }));
    const result = await getDefaultCategoryTreeId("EBAY_GB");
    expect(JSON.stringify(result)).not.toContain("sk-abc123");
  });
});

describe("getCategorySuggestions", () => {
  function suggestionsResponse() {
    return new Response(JSON.stringify({
      categorySuggestions: [
        { category: { categoryId: "183454", categoryName: "CCG Sealed Boxes" }, categoryTreeNodeAncestors: [{ categoryId: "1", categoryName: "Collectables" }], relevancy: "300.0" },
      ],
    }), { status: 200 });
  }

  it("returns parsed suggestions for a query", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : suggestionsResponse()));
    const result = await getCategorySuggestions("3", "Pokemon TCG Elite Trainer Box");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0].category.categoryName).toBe("CCG Sealed Boxes");
  });

  it("URL-encodes the query string", async () => {
    const fetchMock = vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : suggestionsResponse());
    vi.stubGlobal("fetch", fetchMock);
    await getCategorySuggestions("3", "Pokémon & Friends");
    const apiCall = fetchMock.mock.calls.find(call => !String(call[0]).includes("oauth2/token"));
    expect(String(apiCall![0])).toContain(encodeURIComponent("Pokémon & Friends"));
  });

  it("an empty categorySuggestions array is valid — 'no results' is not an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : new Response(JSON.stringify({ categorySuggestions: [] }), { status: 200 })));
    const result = await getCategorySuggestions("3", "nonexistent product xyz");
    expect(result).toEqual({ ok: true, data: [] });
  });
});

describe("getItemAspectsForCategory", () => {
  it("returns parsed aspect definitions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : new Response(JSON.stringify({
      aspects: [{ localizedAspectName: "Game", aspectConstraint: { aspectRequired: true, aspectUsage: "REQUIRED", aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Pokémon TCG" }] }],
    }), { status: 200 })));
    const result = await getItemAspectsForCategory("3", "183454");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0].localizedAspectName).toBe("Game");
  });
});

describe("response size guard", () => {
  it("rejects a response advertising an oversized content-length before reading the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("oauth2/token") ? tokenResponse() : new Response(JSON.stringify({ categorySuggestions: [] }), { status: 200, headers: { "content-length": "999999999" } })));
    const result = await getCategorySuggestions("3", "test");
    expect(result).toEqual({ ok: false, error: "invalid_response" });
  });
});
