// eBay Seller Hub extension drafter — pairing-failure review (Phase 3).
// Exercises the REAL service-worker.js's claimEbayBatch (via the same
// chrome.runtime.onMessage router every other real message goes through —
// service-worker.js exports nothing directly, by design), proving the
// CLIENT-side error classification fixed this pass: a genuine
// connection/server failure must never be displayed as "invalid or
// expired" (that message is reserved for the route's own deliberate,
// undifferentiated 400 — see service-worker.js's own
// classifyEbayClaimFailure comment for the full reasoning).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EBAY_PANEL_TO_WORKER } from "../vinted-draft-queue-extension/shared/ebay-messages.js";

const APP_BASE_URL = "http://test-app.local";

async function loadWorker() {
  const messageListeners: Array<(message: any, sender: any, sendResponse: (r: any) => void) => boolean> = [];
  const storageData: Record<string, unknown> = { settings: { appBaseUrl: APP_BASE_URL } };
  const chromeMock: any = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      getManifest: () => ({ version: "1.0.0-test" }),
      onMessage: { addListener: (fn: any) => messageListeners.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(storageData, obj); }),
      },
      onChanged: { addListener: () => {} },
    },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(), onUpdated: { addListener: vi.fn() } },
    alarms: { create: vi.fn(), onAlarm: { addListener: () => {} }, clear: vi.fn() },
    permissions: { contains: vi.fn(async () => true) },
  };
  vi.stubGlobal("chrome", chromeMock);
  vi.resetModules();
  await import("../vinted-draft-queue-extension/service-worker.js");
  function dispatch(message: any) {
    return new Promise(resolve => { messageListeners[0](message, {}, resolve); });
  }
  return { dispatch, storageData };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("service worker — claimEbayBatch error classification (pairing failure review)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  });

  it("REQUIREMENT: a genuine 400 (the deliberate, undifferentiated 'invalid/expired/already-claimed' bucket) is classified as code_rejected, showing the route's own message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This code is invalid or has expired." }), { status: 400 })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.error).toBe("This code is invalid or has expired.");
    expect(result.errorKind).toBe("code_rejected");
  });

  it("REQUIREMENT: a 500 internal-server response is classified as server_failure — NEVER shown as 'invalid or expired', even though the route's fallback text differs from that exact phrase", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Could not claim this eBay batch (pairing_lookup)." }), { status: 500 })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("server_failure");
    expect(result.error).not.toMatch(/invalid or has expired/i);
  });

  it("REQUIREMENT: a 500 response whose body fails to parse as JSON is STILL classified as server_failure with an honest status-based message — never silently falls back to 'invalid or expired'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Internal Server Error</html>", { status: 500, headers: { "Content-Type": "text/html" } })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("server_failure");
    expect(result.error).not.toMatch(/invalid or has expired/i);
    expect(result.error).toContain("500");
  });

  it("REQUIREMENT: a 429 rate-limit response is classified as server_failure (retry, don't retype), never code_rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Too many attempts." }), { status: 429 })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("server_failure");
  });

  it("REQUIREMENT: a network-level failure (fetch itself rejects — DNS/offline/etc) is classified as connection_failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("connection_failure");
    expect(result.error).not.toMatch(/invalid or has expired/i);
  });

  it("REQUIREMENT: retrying after a transport failure does not corrupt any local state — a failed claim attempt never writes a pairing/batch to storage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const { dispatch, storageData } = await loadWorker();
    await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(storageData.ebayDrafterState).toBeUndefined();
  });

  // The successful-claim path also fetches the batch payload immediately
  // after (fetchEbayBatchPayload) — a real, minimal payload shape here so
  // that follow-up call succeeds too, keeping these two tests focused on
  // claimEbayBatch's own classification/storage behaviour rather than the
  // separate payload-fetch path.
  function successFetchMock() {
    return vi.fn(async (url: string) => {
      if (String(url).includes("/claim")) {
        return new Response(JSON.stringify({ batchToken: "tok.en.value", batchId: "b1", expiresAt: "2026-08-05T10:30:00.000Z" }), { status: 200 });
      }
      return new Response(JSON.stringify({ schemaVersion: "ebay-extension-batch-v1", batchId: "b1", expiresAt: "2026-08-05T10:30:00.000Z", items: [] }), { status: 200 });
    });
  }

  it("a genuine success is classified as no error at all, and the real batch token/id from the response is stored", async () => {
    vi.stubGlobal("fetch", successFetchMock());
    const { dispatch, storageData } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.error).toBeUndefined();
    expect((storageData.ebayDrafterState as any).pairing.batchId).toBe("b1");
  });

  it("REQUIREMENT: no plaintext pairing code is ever written to chrome.storage.local", async () => {
    vi.stubGlobal("fetch", successFetchMock());
    const { dispatch, storageData } = await loadWorker();
    await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(JSON.stringify(storageData)).not.toContain("ABCD2345");
  });
});
