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

  // CORRECTIVE PASS (controlled pairing test review) — a real, reproduced
  // 404 was previously falling through to this SAME generic
  // "server_failure" bucket as a 500, showing a misleading "try again in
  // a moment" for a failure retrying can never fix (the route genuinely
  // doesn't exist at the configured origin). 500/503/etc now get their
  // own, more specific "internal_failure" kind — see the 404 test below
  // for the route_not_found kind this same review added.
  it("REQUIREMENT: a 500 internal-server response is classified as internal_failure — NEVER shown as 'invalid or expired', and never the generic server_failure bucket a 404 used to share", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Could not claim this eBay batch (pairing_lookup)." }), { status: 500 })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("internal_failure");
    expect(result.error).not.toMatch(/invalid or has expired/i);
  });

  it("REQUIREMENT: a 500 response whose body fails to parse as JSON is STILL classified as internal_failure with an honest status-based message — never silently falls back to 'invalid or expired'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Internal Server Error</html>", { status: 500, headers: { "Content-Type": "text/html" } })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("internal_failure");
    expect(result.error).not.toMatch(/invalid or has expired/i);
    expect(result.error).toContain("500");
  });

  it("REQUIREMENT: a 429 rate-limit response is classified as its own rate_limited kind (retry, don't retype), never code_rejected and never lumped in with a genuine server failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Too many attempts." }), { status: 429 })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("rate_limited");
  });

  // CORRECTIVE PASS (controlled pairing test review) — the exact defect a
  // real, reproduced pairing failure traced to: a genuine 404 (the claim
  // route does not exist at the configured App URL — wrong origin, wrong
  // path, or a server build predating this route) was reported as "The
  // app reported a problem (status 404). Try again in a moment." —
  // indistinguishable from a transient server hiccup, even though retrying
  // can never fix a route that doesn't exist. The message must also name
  // the actual destination origin the request was built against, so the
  // fix is "check Settings → App URL", not a guess.
  it("REQUIREMENT: a 404 (the route does not exist at the configured App URL) is classified as its own route_not_found kind, naming the actual destination origin — never the generic server_failure/'try again' message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 404 })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("route_not_found");
    expect(result.error).toContain(APP_BASE_URL);
    expect(result.error).not.toMatch(/try again in a moment/i);
  });

  it("REQUIREMENT: a 401/403 response is classified as its own auth_failure kind, distinct from code_rejected and route_not_found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized." }), { status: 401 })));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("auth_failure");
  });

  it("REQUIREMENT: a network-level failure (fetch itself rejects — DNS/offline/etc) is classified as connection_failure and names the actual destination origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.errorKind).toBe("connection_failure");
    expect(result.error).not.toMatch(/invalid or has expired/i);
    expect(result.error).toContain(APP_BASE_URL);
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
