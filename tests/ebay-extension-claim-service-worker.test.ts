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
import { readFileSync } from "node:fs";
import { EBAY_PANEL_TO_WORKER } from "../vinted-draft-queue-extension/shared/ebay-messages.js";

const APP_BASE_URL = "http://test-app.local";

// CORRECTIVE PASS (claim state-machine review) — `seedStorageData` and
// `setOverride` let a test simulate a service-worker restart (a FRESH
// module load — vi.resetModules() below — reading whatever a PREVIOUS
// loadWorker() instance already persisted) and a failed local-persistence
// write, without changing this helper's existing default behaviour for
// every other test in this file (both params optional, defaulting to the
// exact prior shape).
async function loadWorker(seedStorageData: Record<string, unknown> = {}, setOverride?: (obj: Record<string, unknown>) => Promise<void>) {
  const messageListeners: Array<(message: any, sender: any, sendResponse: (r: any) => void) => boolean> = [];
  const storageData: Record<string, unknown> = { settings: { appBaseUrl: APP_BASE_URL }, ...seedStorageData };
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
        set: vi.fn(setOverride ?? (async (obj: Record<string, unknown>) => { Object.assign(storageData, obj); })),
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

// CORRECTIVE PASS (claim state-machine review) — a REAL claim (pairing
// code MCSFAAJG, reviewed live): the server-side row proved the claim
// RPC committed (claimed_at set, extension_id/version recorded, batch
// status advanced to in_progress) while the side panel kept showing the
// old, ambiguous "Waiting for connection" — the bug was never that the
// claim failed; it was that claimEbayBatch returned a STALE state
// snapshot (captured before its own internal fetchEbayBatchPayload()
// call) to the panel's click handler, which then re-rendered from it,
// clobbering the correct render chrome.storage.onChanged had already
// produced from the real, up-to-date write. These tests cover every
// scenario the review specifically asked for.
function realItemPayload(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "item-1", marketplaceDraftId: "md-1", productDraftId: "pd-1", queuePosition: 0,
    sku: "1644", marketplace: "EBAY_UK", title: "On Running Cloud 5", description: "desc",
    categoryId: "95672", categoryName: "Trainers", conditionValue: "Used – Very Good", conditionDescription: null,
    brand: "On Running", size: "UK 4", colour: "Blue", itemSpecifics: [],
    pricePence: 3500, priceDisplay: "£35.00", quantity: 1,
    photos: [{ position: 0, fileName: "01.jpg", path: "/api/extension/ebay-batch/photos/item-1/0" }],
    fulfillmentPolicy: null, returnPolicy: null, paymentPolicy: null,
    ...overrides,
  };
}
function successFetchMockWithItem() {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/claim")) {
      return new Response(JSON.stringify({ batchToken: "tok.en.value", batchId: "b1", expiresAt: "2026-08-05T10:30:00.000Z" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      schemaVersion: "ebay-extension-batch-v1", batchId: "b1", expiresAt: "2026-08-05T10:30:00.000Z", items: [realItemPayload()],
    }), { status: 200 });
  });
}

describe("claim state-machine review — the real regression, reproduced and fixed", () => {
  it("REQUIREMENT (successful response, lost UI messaging): claimEbayBatch returns the FRESH, post-payload state (with the real item) — never the stale pre-payload snapshot the panel used to render from", async () => {
    vi.stubGlobal("fetch", successFetchMockWithItem());
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    // The exact regression: this used to be null (paired, batch not yet
    // loaded) even though the payload fetch that followed succeeded.
    expect(result.state.batch?.items?.[0]?.itemId).toBe("item-1");
    expect(result.state.batch.items[0].sku).toBe("1644");
  });

  it("REQUIREMENT (successful response, lost UI messaging): even if the panel's own click handler never receives/processes this response at all, storage itself already holds the fully correct claimed+loaded state — a later EBAY_GET_STATE (e.g. from the panel simply reopening) reconstructs it independently of that lost response", async () => {
    vi.stubGlobal("fetch", successFetchMockWithItem());
    const { dispatch } = await loadWorker();
    await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" }); // response deliberately never inspected here
    const reopened: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_GET_STATE });
    expect(reopened.state.pairing.batchId).toBe("b1");
    expect(reopened.state.batch.items[0].itemId).toBe("item-1");
  });

  it("REQUIREMENT (service worker restarted): a fresh worker module load (a new loadWorker(), simulating the service worker restarting) reads the SAME persisted storage a previous instance wrote and reconstructs the identical claimed+loaded state — getEbayState() never caches in memory", async () => {
    vi.stubGlobal("fetch", successFetchMockWithItem());
    const before = await loadWorker();
    await before.dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    // A genuinely NEW module instance (vi.resetModules() inside
    // loadWorker), seeded with exactly what the "before" instance
    // persisted — mirrors a real service-worker restart, which loses all
    // JS module state but never touches chrome.storage.local.
    const after = await loadWorker({ ebayDrafterState: before.storageData.ebayDrafterState });
    const result: any = await after.dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_GET_STATE });
    expect(result.state.pairing.batchId).toBe("b1");
    expect(result.state.batch.items[0].itemId).toBe("item-1");
  });

  it("REQUIREMENT (malformed/missing stored state): a corrupted ebayDrafterState (batch present but items is not an array) never throws out of EBAY_GET_STATE itself — the state machine's own try/catch boundary is in the PANEL's render, not the worker's read, so the worker must still return whatever is actually stored, verbatim, for the panel to handle", async () => {
    const { dispatch } = await loadWorker({ ebayDrafterState: { pairing: { batchId: "b1", batchToken: "t", expiresAt: "x", claimedAt: "x" }, batch: { batchId: "b1", items: "not-an-array" }, payloadError: null } });
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_GET_STATE });
    expect(result.state.batch.items).toBe("not-an-array"); // returned as-is — never silently "fixed" or hidden
  });

  it("REQUIREMENT (failed persistence): if the local chrome.storage.local.set write itself fails after a genuinely successful server claim, the response is a real, visible error — never a fake success (result.state must not be returned) and never silently swallowed", async () => {
    vi.stubGlobal("fetch", successFetchMockWithItem());
    const failingSet = vi.fn(async () => { throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded"); });
    const { dispatch } = await loadWorker({}, failingSet);
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.error).toBeTruthy();
    expect(result.state).toBeUndefined();
  });

  it("REQUIREMENT (do not automatically submit the same single-use code twice): claimEbayBatch is called with a fresh code exactly once per dispatch — nothing in this function itself retries or resubmits on any path", () => {
    const source = readFileSync("vinted-draft-queue-extension/service-worker.js", "utf8");
    const fnStart = source.indexOf("async function claimEbayBatch(pairingCode)");
    const fnEnd = source.indexOf("\n}\n", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    // Only ONE fetch call to the claim route inside this whole function.
    expect((fn.match(/\/api\/extension\/ebay-batch\/claim/g) ?? []).length).toBe(1);
  });

  it("REQUIREMENT (manual Refresh, never re-claims): EBAY_REFRESH_BATCH re-loads an ALREADY-claimed batch's payload without ever calling the claim route again", async () => {
    let claimCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/claim")) { claimCalls += 1; return new Response(JSON.stringify({ batchToken: "tok.en.value", batchId: "b1", expiresAt: "2026-08-05T10:30:00.000Z" }), { status: 200 }); }
      return new Response(JSON.stringify({ schemaVersion: "ebay-extension-batch-v1", batchId: "b1", expiresAt: "2026-08-05T10:30:00.000Z", items: [realItemPayload()] }), { status: 200 });
    }));
    const { dispatch } = await loadWorker();
    await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(claimCalls).toBe(1);
    const refreshed: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_REFRESH_BATCH });
    expect(claimCalls).toBe(1); // still exactly one — refresh never re-claims
    expect(refreshed.state.batch.items[0].itemId).toBe("item-1");
  });

  it("REQUIREMENT (claimed but payload load failed — a genuinely distinct, honest state): a claim that succeeds followed by a payload fetch that fails returns claimed:true with a persisted payloadError, never the ambiguous ok-with-null-batch shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/claim")) return new Response(JSON.stringify({ batchToken: "tok.en.value", batchId: "b1", expiresAt: "2026-08-05T10:30:00.000Z" }), { status: 200 });
      return new Response(JSON.stringify({ error: "Could not load this batch." }), { status: 500 });
    }));
    const { dispatch } = await loadWorker();
    const result: any = await dispatch({ type: EBAY_PANEL_TO_WORKER.EBAY_CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect(result.claimed).toBe(true);
    expect(result.payloadError).toBeTruthy();
    expect(result.state.payloadError).toBe(result.payloadError);
    expect(result.state.pairing.batchId).toBe("b1"); // the claim itself is still genuinely persisted
  });
});
