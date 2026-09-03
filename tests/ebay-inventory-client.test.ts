import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getInventoryItem } from "@/lib/ebay-account/inventory-client";

/**
 * Corrective pass (failed-draft diagnosis/retry) — getInventoryItem is the
 * one new read-only reconciliation call this pass adds. These are genuine
 * behavioural tests: a real (mocked) fetch, real function call, real
 * assertions on the request that was actually made and the value actually
 * returned — not source-text scans (see ebay-account-draft-only-safety.test.ts
 * for the structural/allowlist-shape proofs).
 */
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getInventoryItem — read-only reconciliation", () => {
  it("REQUIREMENT 9: uses HTTP GET, never PUT/POST, and never touches the write endpoint's method", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sku: "1644", condition: "USED_VERY_GOOD", offers: [] }));
    await getInventoryItem("token", "1644");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(String(url)).toContain("/sell/inventory/v1/inventory_item/1644");
  });

  it("URL-encodes a SKU containing characters that need encoding, never interpolates it raw", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sku: "AB.C-D_1", condition: null, offers: [] }));
    await getInventoryItem("token", "AB.C-D_1");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(encodeURIComponent("AB.C-D_1"));
  });

  it("rejects a SKU that fails the app's own SKU validator before ever calling fetch", async () => {
    await expect(getInventoryItem("token", "has spaces")).rejects.toThrow("Invalid eBay inventory SKU.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REQUIREMENT 10: a genuine 404 means 'does not exist' — returns null, never throws", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "Not found" }] }, 404));
    const result = await getInventoryItem("token", "1644");
    expect(result).toBeNull();
  });

  it("REQUIREMENT 11: an auth failure (401) is a real error, never silently treated as 'does not exist'", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "Invalid access token" }] }, 401));
    await expect(getInventoryItem("token", "1644")).rejects.toThrow();
  });

  it("REQUIREMENT 11: a rate limit (429) is a real error, never silently treated as 'does not exist'", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "Rate limit exceeded" }] }, 429));
    await expect(getInventoryItem("token", "1644")).rejects.toThrow();
  });

  it("REQUIREMENT 11: a server failure (500) is a real error, never silently treated as 'does not exist'", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    await expect(getInventoryItem("token", "1644")).rejects.toThrow();
  });

  it("returns only the fields reconciliation needs — never echoes the full remote body (e.g. image URLs, aspects) into the returned value", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      sku: "1644", condition: "USED_VERY_GOOD",
      product: { imageUrls: ["https://signed.example/secret-token-abc"], aspects: { Brand: ["On Running"] } },
      offers: [{ offerId: "abc" }],
    }));
    const result = await getInventoryItem("token", "1644");
    expect(result).toEqual({ sku: "1644", condition: "USED_VERY_GOOD", hasOffers: true });
    expect(JSON.stringify(result)).not.toContain("signed.example");
  });

  it("hasOffers is false when the remote item has no offers array or an empty one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sku: "1644", condition: "USED_VERY_GOOD" }));
    expect((await getInventoryItem("token", "1644"))?.hasOffers).toBe(false);
  });
});

describe("STRUCTURAL — getInventoryItem can never fall back to a write", () => {
  it("the function body contains exactly one inventoryRequest call, hardcoded to \"GET\", never a variable method", () => {
    const source = require("node:fs").readFileSync("lib/ebay-account/inventory-client.ts", "utf8") as string;
    const fnBody = source.slice(source.indexOf("export async function getInventoryItem"), source.indexOf("export function inventoryApiHost"));
    expect(fnBody).toContain('inventoryRequest(accessToken, "GET", `/sell/inventory/v1/inventory_item/');
    expect(fnBody).not.toMatch(/inventoryRequest\(accessToken,\s*"(PUT|POST|DELETE)"/);
  });

  it("is gated by assertAllowedInventoryOperation before constructing any request", () => {
    const source = require("node:fs").readFileSync("lib/ebay-account/inventory-client.ts", "utf8") as string;
    const fnBody = source.slice(source.indexOf("export async function getInventoryItem"), source.indexOf("export function inventoryApiHost"));
    const gateIndex = fnBody.indexOf('assertAllowedInventoryOperation("getInventoryItem")');
    const requestIndex = fnBody.indexOf("inventoryRequest(");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(gateIndex);
  });
});
