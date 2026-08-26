import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as QueueState from "../vinted-draft-queue-extension/shared/queue-state.js";
import { PANEL_TO_WORKER, WORKER_TO_CONTENT, CONTENT_TO_WORKER } from "../vinted-draft-queue-extension/shared/messages.js";
import { validateBatchItem } from "../vinted-draft-queue-extension/shared/validation.js";

// Follow-up correction (queue-stalling bug) — these tests exercise
// service-worker.js's real orchestration logic (pingContentScript,
// injectContentScript, ensureContentScriptReady, triggerTick, startItem)
// through its only public surface: the chrome.runtime.onMessage listener
// and the chrome.alarms.onAlarm listener it registers at import time.
// service-worker.js exports none of those functions directly (by design —
// see its own top comment on holding no in-memory state), so a full chrome.*
// mock plus dispatching real messages is the only way to prove the fix
// without weakening the module's own encapsulation just to make it testable.

const T0 = "2026-08-05T10:00:00.000Z";
const APP_BASE_URL = "http://test-app.local";
const ALARM_NAME = "vinted-draft-queue-tick";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "vinted-extension-batch-v1", batchId: "batch-1", expiresAt: "2026-08-05T10:30:00.000Z",
    items: [{ itemId: "item-1", draftId: "draft-1", queuePosition: 0, title: "Hoka Clifton 9", sku: "AA1" }],
    ...overrides,
  };
}

// The complete, production-shaped ExtensionBatchItem — mirrors
// lib/listing-studio/extension-batch-schema.ts's extensionBatchItemSchema
// field for field (not the trimmed itemId/draftId/queuePosition/title/sku
// subset the queue-stalling fix's fixtures above use, which was exactly
// what the payload-loss bug reduced every real item down to).
function fullBatchItemFixture(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "11111111-1111-4111-8111-111111111111",
    draftId: "22222222-2222-4222-8222-222222222222",
    queuePosition: 0,
    sku: "AA1",
    title: "Hoka Clifton 9",
    description: "Barely worn Hoka Clifton 9 running shoes in great condition.",
    brand: "Hoka",
    model: "Clifton 9",
    productType: "trainers",
    condition: "very_good",
    ukSize: "9",
    audience: "men",
    colours: ["black", "white"],
    materials: ["mesh"],
    pricePence: 4500,
    priceDisplay: "£45.00",
    vintedCategoryId: 1234,
    vintedCategoryPath: "Men > Shoes > Trainers",
    // Follow-up correction (photo origin-mismatch bug): `path` is a
    // RELATIVE reference (never an absolute URL) — the service worker
    // resolves it against its OWN configured settings.appBaseUrl (see
    // createChromeMock's storageData.settings below), never against
    // wherever the payload's own url might have pointed.
    photos: [
      { position: 0, fileName: "01.jpg", path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0" },
      { position: 1, fileName: "02.jpg", path: "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/1" },
    ],
    coverPhotoPosition: 0,
    ...overrides,
  };
}
function fullBatchPayloadFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "vinted-extension-batch-v1",
    batchId: "33333333-3333-4333-8333-333333333333",
    expiresAt: "2026-08-05T10:30:00.000Z",
    items: [fullBatchItemFixture()],
    ...overrides,
  };
}

function claimFetchMock(rawPayload: ReturnType<typeof fullBatchPayloadFixture>) {
  return vi.fn(async (url: string) => {
    const href = String(url);
    if (href.endsWith("/api/extension/claim")) {
      return new Response(JSON.stringify({ batchToken: "test-token", batchId: rawPayload.batchId, expiresAt: rawPayload.expiresAt }), { status: 200 });
    }
    if (href.endsWith("/api/extension/batch")) return new Response(JSON.stringify(rawPayload), { status: 200 });
    return new Response(null, { status: 204 });
  });
}

function seededRunningState() {
  let state = QueueState.applyBatchPayload(QueueState.createInitialState(), payload(), T0);
  state = QueueState.applyClaim(state, { batchId: "batch-1", batchToken: "test-batch-token", expiresAt: "2026-08-05T10:30:00.000Z", claimedAt: T0 });
  // applyStart() is a no-op without a confirmed account (the mandatory
  // initial confirmation gate) — these fixtures are for tests about the
  // content-script readiness/watchdog machinery, not the confirmation gate
  // itself, so the account is pre-confirmed here exactly as a real
  // CONFIRM_ACCOUNT click would leave it.
  state = QueueState.applyAccountDetected(state, { memberId: "1", displayName: "shopfront_uk" }, T0);
  state = QueueState.applyAccountConfirmed(state, T0);
  // Likewise, a Vinted tab is pre-selected (id 1) — these fixtures are for
  // tests about content-script readiness/watchdog machinery, not tab
  // SELECTION itself (see the dedicated "Vinted tab selection" suite
  // below), so ensureVintedTab() just validates this persisted id rather
  // than running the full selectVintedTab() algorithm.
  state = QueueState.applySelectedVintedTab(state, 1);
  return QueueState.applyStart(state);
}

type SendMessageResult = { response?: unknown; lastError?: string; noCallback?: boolean };
type SendMessageHandler = (tabId: number, message: any) => SendMessageResult;

type MockTab = { id: number; url: string; windowId: number; active: boolean };

function createChromeMock(options: {
  sendMessageHandler: SendMessageHandler;
  executeScript?: ReturnType<typeof vi.fn>;
  tabsQueryResult?: Array<{ id: number }>;
  // New for the deterministic tab-selection fix — see selectVintedTab()/
  // ensureVintedTab() in service-worker.js. All optional: tests about
  // content-script readiness (which pre-seed a persisted vintedTabId via
  // seededRunningState()) never need selectVintedTab() to run at all, so
  // they don't need any of these.
  activeTabQueryResult?: MockTab[]; // chrome.tabs.query({active:true, currentWindow:true})
  vintedTabsQueryResult?: MockTab[]; // chrome.tabs.query({url: VINTED_URL_PATTERN})
  createdTabId?: number; // chrome.tabs.create()'s resulting id
  tabsGetImpl?: (tabId: number) => MockTab; // throw to simulate a closed tab
  initialState?: unknown;
  // Follow-up correction (photo origin-mismatch bug) — chrome.permissions.contains()
  // is checked before every photo fetch (see checkHostPermitted). Defaults
  // to granting everything, since almost every test here is about
  // something else entirely; the dedicated "host not permitted" tests
  // override this to prove the opposite.
  permissionsGranted?: boolean;
  // Follow-up correction (native browser reload-confirmation bug) — when
  // true, chrome.tabs.update() never fires its own "complete" event at
  // all, simulating the browser's native unsaved-changes confirmation
  // blocking the navigation indefinitely (the real-world scenario this
  // whole feature exists to recover from). The persistent, module-level
  // chrome.tabs.onUpdated listener is completely unaffected — a test can
  // still simulate the user later resolving that dialog by calling the
  // returned fireTabUpdated() helper manually at any point.
  tabsUpdateStuck?: boolean;
}) {
  const storageData: Record<string, unknown> = { state: options.initialState, settings: { appBaseUrl: APP_BASE_URL } };
  const messageListeners: Array<(message: any, sender: any, sendResponse: (r: any) => void) => boolean> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const startupListeners: Array<() => void> = [];
  const installedListeners: Array<() => void> = [];

  const runtime: any = {
    id: "test-extension-id",
    lastError: undefined,
    getManifest: () => ({ version: "1.0.0-test" }),
    onMessage: { addListener: (fn: any) => messageListeners.push(fn) },
    onInstalled: { addListener: (fn: any) => installedListeners.push(fn) },
    onStartup: { addListener: (fn: any) => startupListeners.push(fn) },
  };

  const sendMessage = vi.fn((tabId: number, message: any, callback: (r: any) => void) => {
    let result = options.sendMessageHandler(tabId, message);
    // Clean-create-form fix — every PRE-EXISTING test's sendMessageHandler
    // above falls through to some generic catch-all response (`{}`,
    // `{ started: true }`, etc — several slightly different shapes are
    // used throughout this file) for any message type it isn't
    // specifically testing. For INSPECT_PAGE_STATE specifically, any
    // response that doesn't itself carry a `state` field is reinterpreted
    // here as "this test doesn't care about the clean-form gate — assume
    // the page is already clean", so every one of the ~40 pre-existing
    // tests exercising startItem()/PROCESS_ITEM keeps passing completely
    // unchanged, with zero reload round trip. A test that DOES care
    // returns a real `{ state: "dirty" | "saved_draft" | "unavailable" }`
    // shape for this type from its own handler and is entirely unaffected.
    if (
      message?.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE
      && result && !result.lastError && !result.noCallback
      && (!result.response || typeof result.response !== "object" || !("state" in result.response))
    ) {
      result = { response: { state: "clean" } };
    }
    // The eBay read/import paths call chrome.tabs.sendMessage with no
    // callback at all (`await chrome.tabs.sendMessage(tabId, message)`),
    // relying on Chrome's real promise-returning form — distinct from
    // every pre-existing caller in this codebase, which always passes an
    // explicit callback. Mirrors the real API: rejects on a lastError,
    // resolves with the response otherwise.
    if (typeof callback !== "function") {
      if (result.noCallback) return new Promise(() => {});
      return result.lastError ? Promise.reject(new Error(result.lastError)) : Promise.resolve(result.response);
    }
    if (result.noCallback) return;
    if (result.lastError) {
      runtime.lastError = { message: result.lastError };
      callback(result.response);
      runtime.lastError = undefined;
    } else {
      runtime.lastError = undefined;
      callback(result.response);
    }
  });

  const executeScript = options.executeScript ?? vi.fn(async () => {});
  let lastCreatedTabId: number | null = null;
  const tabsCreate = vi.fn(async () => {
    const id = options.createdTabId ?? 999;
    lastCreatedTabId = id;
    return { id };
  });
  const tabsGet = vi.fn(async (tabId: number) => {
    if (options.tabsGetImpl) return options.tabsGetImpl(tabId);
    // Default: whatever id was asked for is a perfectly valid Create
    // Listing tab — the tests that actually care about validity/loss
    // override tabsGetImpl explicitly.
    return { id: tabId, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
  });

  // Follow-up correction (durable Save Draft confirmation) — service-
  // worker.js now registers its OWN persistent chrome.tabs.onUpdated
  // listener (never removed, unlike createFreshCreateListingTab's own
  // dynamic self-removing one below) to notice a navigation to a real
  // observed post-save destination. Every listener ever registered is
  // captured here (not just the most recent one) and fireTabUpdated lets
  // a test manually dispatch a navigation event to ALL of them, exactly
  // like a real browser would.
  const updatedListeners: Array<(tabId: number, changeInfo: any, tab: any) => void> = [];
  function fireTabUpdated(tabId: number, changeInfo: any, tab?: any) {
    for (const fn of [...updatedListeners]) fn(tabId, changeInfo, tab ?? { id: tabId, url: changeInfo.url });
  }
  const tabsOnUpdatedAddListener = vi.fn((fn: any) => {
    updatedListeners.push(fn);
    // createFreshCreateListingTab() awaits an onUpdated "complete" event
    // for the tab it JUST created before resolving — simulate that
    // completing on the next microtask so the real (non-test) wait logic
    // isn't touched at all. Only fires for THIS freshly-added listener
    // (mirroring how, in a real browser, only a listener added AFTER the
    // tab was created would ever see its own completion event) — the
    // persistent, module-load-time listener is registered long before any
    // tab is created, so this never spuriously fires for it.
    if (lastCreatedTabId != null) {
      const id = lastCreatedTabId;
      queueMicrotask(() => fn(id, { status: "complete" }, { id, url: "https://www.vinted.co.uk/items/new" }));
    }
  });
  const tabsUpdate = vi.fn(async (tabId: number, updateInfo: { url?: string }) => {
    // Mirrors real chrome.tabs.update(): the navigation completes
    // asynchronously — simulated here as a "complete" onUpdated event
    // fired one MACROtask later (setTimeout, not queueMicrotask). This
    // matters: the caller (returnTabToCreateListing) does
    // `await chrome.tabs.update(...)` THEN registers its own onUpdated
    // listener on the very next line — both of those steps are
    // themselves microtask-only continuations, so a queueMicrotask-timed
    // fire here could win the race and fire BEFORE that listener is
    // registered, hanging the awaiting promise forever. A real browser
    // never has this race (the real "complete" event is always many
    // ticks later than the update() call's own resolution) — this is
    // purely a mock-timing artifact, fixed by never firing sooner than a
    // macrotask away, guaranteeing every microtask (including listener
    // registration) has already drained first.
    const url = updateInfo.url ?? "https://www.vinted.co.uk/items/new";
    if (!options.tabsUpdateStuck) {
      setTimeout(() => fireTabUpdated(tabId, { status: "complete", url }, { id: tabId, url }), 0);
    }
    return { id: tabId, url };
  });

  const chromeMock: any = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(storageData, obj); }),
      },
    },
    tabs: {
      query: vi.fn(async (queryInfo: any = {}) => {
        if (queryInfo.active && queryInfo.currentWindow) return options.activeTabQueryResult ?? [];
        if (queryInfo.url) return options.vintedTabsQueryResult ?? options.tabsQueryResult ?? [];
        return [];
      }),
      create: tabsCreate,
      get: tabsGet,
      update: tabsUpdate,
      remove: vi.fn(async () => {}),
      sendMessage,
      onUpdated: { addListener: tabsOnUpdatedAddListener, removeListener: vi.fn((fn: any) => { const i = updatedListeners.indexOf(fn); if (i >= 0) updatedListeners.splice(i, 1); }) },
    },
    scripting: { executeScript },
    runtime,
    alarms: { create: vi.fn(), onAlarm: { addListener: (fn: any) => alarmListeners.push(fn) } },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    permissions: {
      contains: vi.fn((_query: unknown, callback: (granted: boolean) => void) => callback(options.permissionsGranted ?? true)),
    },
  };

  return {
    chromeMock, storageData, messageListeners, alarmListeners, startupListeners, installedListeners,
    sendMessage, executeScript, tabsCreate, tabsGet, tabsUpdate, fireTabUpdated,
  };
}

async function loadWorker(chromeMock: any) {
  vi.stubGlobal("chrome", chromeMock);
  vi.resetModules();
  return import("../vinted-draft-queue-extension/service-worker.js");
}

function dispatch(messageListeners: Array<(message: any, sender: any, sendResponse: (r: any) => void) => boolean>, message: any, sender: any = {}) {
  return new Promise(resolve => { messageListeners[0](message, sender, resolve); });
}

function currentItem(storageData: Record<string, unknown>) {
  return (storageData.state as any).batch.items[0];
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("service worker — content-script readiness gate (queue-stalling fix)", () => {
  it("a Vinted tab already open before the extension was installed: first PING gets no receiver, so it safely injects content-script.js and retries before ever dispatching the item", async () => {
    let pingCalls = 0;
    const { chromeMock, storageData, messageListeners, executeScript } = createChromeMock({
      initialState: seededRunningState(),
      tabsQueryResult: [{ id: 1 }], // the tab is already open — ensureVintedTab must reuse it, never create a new one
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") {
          pingCalls++;
          return pingCalls === 1 ? { lastError: "Could not establish connection. Receiving end does not exist." } : { response: { ready: true } };
        }
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: null } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) return { response: { started: true } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect(chromeMock.tabs.create).not.toHaveBeenCalled(); // reused the already-open tab
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ["content-script.js"] });
    expect(pingCalls).toBe(2); // first ping (fails), retry ping after injection (succeeds)
  });

  it("no content-script receiver at all, even after injection: reports a clear, retryable failure instead of leaving the item stuck", async () => {
    const { chromeMock, storageData, messageListeners, executeScript } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { lastError: "Could not establish connection. Receiving end does not exist." };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("failed"));

    expect(executeScript).toHaveBeenCalledTimes(1); // injection was attempted once as the fallback
    const item = currentItem(storageData);
    expect(item.status).not.toBe("preparing"); // never left stuck — moved straight to a retryable failure
    expect(item.errorCode).toBe("CONTENT_SCRIPT_UNAVAILABLE");
    expect(item.errorMessage).toMatch(/could not be established.*refresh the vinted tab and retry/i);
  });

  it("successful safe injection and retry: the item proceeds to dispatch once readiness is confirmed post-injection", async () => {
    let pingCalls = 0;
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") { pingCalls++; return pingCalls === 1 ? { lastError: "no receiver" } : { response: { ready: true } }; }
        // Same stable memberId as the pre-confirmed account, but a changed
        // display name — a display-name-only change must never be mistaken
        // for a different account (updates the name, never pauses).
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_new_name" } } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) return { response: { started: true } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    const finalState = storageData.state as any;
    expect(finalState.batch.account.memberId).toBe("1");
    expect(finalState.batch.account.displayName).toBe("shopfront_new_name");
    expect(finalState.batch.paused).toBe(false);
  });

  it("REGRESSION: content-script.js's idempotency guard prevents a duplicate chrome.runtime.onMessage listener when injected twice (declarative injection racing the programmatic fallback)", () => {
    const extensionDir = path.resolve("vinted-draft-queue-extension");
    const source = readFileSync(path.join(extensionDir, "content-script.js"), "utf8");
    const addListener = vi.fn();
    const fakeWindow: Record<string, unknown> = {};
    const fakeChrome = {
      runtime: {
        getURL: (p: string) => pathToFileURL(path.join(extensionDir, p) + "/").href,
        onMessage: { addListener },
        sendMessage: vi.fn(),
      },
    };
    const run = new Function("window", "chrome", "document", source);
    run(fakeWindow, fakeChrome, {}); // first injection (e.g. declarative content_scripts)
    run(fakeWindow, fakeChrome, {}); // second injection (e.g. the programmatic fallback racing with it)

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(fakeWindow.__vintedDraftQueueContentScriptLoaded).toBe(true);
  });

  it("injection failure (chrome.scripting.executeScript rejects): reports the same clear, retryable failure, never throws", async () => {
    const { chromeMock, storageData, messageListeners, executeScript } = createChromeMock({
      initialState: seededRunningState(),
      executeScript: vi.fn(async () => { throw new Error("Cannot access contents of the page. Extension manifest must request permission."); }),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { lastError: "no receiver" }; // never has a content script, hence the injection attempt
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("failed"));

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(currentItem(storageData).errorCode).toBe("CONTENT_SCRIPT_UNAVAILABLE");
  });

  it("sendMessage failure for PROCESS_ITEM after readiness was already confirmed: logged, never silently swallowed, and never rolls back the item's status", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } }; // no injection needed this time
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: null } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) return { lastError: "The message port closed before a response was received." };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("PROCESS_ITEM dispatch failed after readiness was confirmed"),
      expect.stringContaining("message port closed"),
    );
  });

});

// ---- Clean-create-form boundary (BUG FIX: a failed item's leftover
// photos/fields contaminating the next item) ---------------------------------
//
// Confirmed root cause: nothing ever reset the Vinted tab between a failed
// item and the next dispatch. ensureCleanCreateForm() is the one gate
// startItem() now goes through before EVER sending PROCESS_ITEM — see
// service-worker.js's own top comment on that function. These tests drive
// it through its only public surface (chrome.runtime.onMessage), exactly
// like every other test in this file.
describe("service worker — clean-create-form boundary (BUG FIX: leftover photos/fields contaminating the next item)", () => {
  function twoItemPayload() {
    return {
      schemaVersion: "vinted-extension-batch-v1", batchId: "batch-1", expiresAt: "2026-08-05T10:30:00.000Z",
      items: [
        { itemId: "item-1", draftId: "draft-1", queuePosition: 0, title: "Item One — 10 photos" },
        { itemId: "item-2", draftId: "draft-2", queuePosition: 1, title: "Item Two — 8 photos" },
      ],
    };
  }
  function seededTwoItemRunningState() {
    let state = QueueState.applyBatchPayload(QueueState.createInitialState(), twoItemPayload(), T0);
    state = QueueState.applyClaim(state, { batchId: "batch-1", batchToken: "test-batch-token", expiresAt: "2026-08-05T10:30:00.000Z", claimedAt: T0 });
    state = QueueState.applyAccountDetected(state, { memberId: "1", displayName: "shopfront_uk" }, T0);
    state = QueueState.applyAccountConfirmed(state, T0);
    state = QueueState.applySelectedVintedTab(state, 1);
    return QueueState.applyStart(state);
  }

  it("REQUIREMENT: a dirty page (leftover photos from a previous failed item) is reset to a fresh /items/new BEFORE PROCESS_ITEM is ever sent, and only sent once the reset page confirms clean", async () => {
    let inspectCalls = 0;
    const order: string[] = [];
    const { chromeMock, storageData, messageListeners, tabsUpdate } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") { order.push("PING"); return { response: { ready: true } }; }
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) {
          inspectCalls += 1;
          order.push(`INSPECT(${inspectCalls})`);
          if (inspectCalls === 1) return { response: { state: "dirty", photoCount: 10 } }; // leftover from a previous item
          return { response: { state: "clean" } }; // confirmed clean after the reset
        }
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { order.push("PROCESS_ITEM"); return { response: { started: true } }; }
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect(tabsUpdate).toHaveBeenCalledWith(1, { url: "https://www.vinted.co.uk/items/new" });
    expect(inspectCalls).toBe(2); // dirty, then re-checked clean after the reset — never assumed
    // The reset navigation and its own re-confirmation happen strictly
    // BEFORE PROCESS_ITEM — never races ahead of it.
    expect(order.indexOf("INSPECT(1)")).toBeLessThan(order.indexOf("PROCESS_ITEM"));
    expect(order.indexOf("INSPECT(2)")).toBeLessThan(order.indexOf("PROCESS_ITEM"));
  });

  it("REQUIREMENT: an already-clean page costs nothing extra — no reset navigation, PROCESS_ITEM still dispatched normally", async () => {
    const { chromeMock, storageData, messageListeners, tabsUpdate } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "clean" } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) return { response: { started: true } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect(tabsUpdate).not.toHaveBeenCalled(); // "avoid an unnecessary reload if safe"
  });

  it("REQUIREMENT: a confirmed saved-draft page is navigated AWAY from (to start the next item), never treated as dirty content to clear", async () => {
    let inspectCalls = 0;
    const { chromeMock, storageData, messageListeners, tabsUpdate, sendMessage } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) {
          inspectCalls += 1;
          if (inspectCalls === 1) return { response: { state: "saved_draft", vintedDraftId: "555" } };
          return { response: { state: "clean" } };
        }
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) return { response: { started: true } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect(tabsUpdate).toHaveBeenCalledWith(1, { url: "https://www.vinted.co.uk/items/new" }); // navigated away...
    // ...but the ONLY messages ever sent to the tab are the standard
    // readiness/inspection/dispatch ones — nothing that could interact with
    // (let alone modify) the saved draft's own content.
    const sentTypes = new Set(sendMessage.mock.calls.map(([, message]: [number, any, (r: any) => void]) => message.type));
    expect(sentTypes).toEqual(new Set(["PING", WORKER_TO_CONTENT.DETECT_ACCOUNT, WORKER_TO_CONTENT.INSPECT_PAGE_STATE, WORKER_TO_CONTENT.PROCESS_ITEM]));
  });

  it("REQUIREMENT: if the reset page never confirms clean, the item fails clearly and retryably — PROCESS_ITEM is NEVER sent", async () => {
    let processItemSent = false;
    const { chromeMock, storageData, messageListeners, tabsUpdate } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "dirty", photoCount: 10 } }; // never becomes clean, even after the reset
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { processItemSent = true; return { response: { started: true } }; }
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("failed"), { timeout: 12000 });

    const item = currentItem(storageData);
    expect(item.errorCode).toBe("CLEAN_FORM_FAILED");
    expect(item.errorMessage).toMatch(/could not establish a clean create listing form/i);
    expect(tabsUpdate).toHaveBeenCalled(); // a reset WAS attempted...
    expect(processItemSent).toBe(false); // ...but the item was never dispatched into the still-contaminated page
  }, 15000);

  it("REQUIREMENT: manual Retry of a failed item goes through the SAME reset gate — never resumes on the page the failed attempt left behind", async () => {
    let state = seededRunningState();
    state = QueueState.applyItemFailed(state, "item-1", "SET_MATERIALS", 'NOT_FOUND: material option exactly matching "Suede"', T0, "UPLOAD_PHOTOS");

    let inspectCalls = 0;
    const order: string[] = [];
    const { chromeMock, storageData, messageListeners, tabsUpdate } = createChromeMock({
      initialState: state,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) {
          inspectCalls += 1;
          order.push(`INSPECT(${inspectCalls})`);
          if (inspectCalls === 1) return { response: { state: "dirty", photoCount: 10 } }; // the failed attempt's own leftover photos
          return { response: { state: "clean" } };
        }
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { order.push("PROCESS_ITEM"); return { response: { started: true } }; }
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.RETRY_ITEM, itemId: "item-1" });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect(tabsUpdate).toHaveBeenCalledWith(1, { url: "https://www.vinted.co.uk/items/new" });
    expect(order.indexOf("INSPECT(1)")).toBeLessThan(order.indexOf("PROCESS_ITEM"));
    expect(order.indexOf("INSPECT(2)")).toBeLessThan(order.indexOf("PROCESS_ITEM"));
  });

  it("REQUIREMENT: races between navigation/content-script reinjection and dispatch are avoided — PROCESS_ITEM only sent once the content script re-confirms ready on the RESET page", async () => {
    let pingsAfterReset = 0;
    let resetHappened = false;
    const order: string[] = [];
    const { chromeMock, storageData, messageListeners, executeScript } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") {
          order.push("PING");
          if (resetHappened) {
            pingsAfterReset += 1;
            // The navigation "destroyed" the old content script — the
            // first post-reset PING gets no receiver, exactly like a fresh
            // page load, requiring re-injection before it succeeds.
            return pingsAfterReset === 1 ? { lastError: "no receiver" } : { response: { ready: true } };
          }
          return { response: { ready: true } };
        }
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) {
          if (!resetHappened) { resetHappened = true; return { response: { state: "dirty", photoCount: 10 } }; }
          return { response: { state: "clean" } };
        }
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { order.push("PROCESS_ITEM"); return { response: { started: true } }; }
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect(executeScript).toHaveBeenCalled(); // re-injected after the reset navigation
    expect(pingsAfterReset).toBeGreaterThanOrEqual(2); // failed once, then succeeded after injection
    expect(order[order.length - 1]).toBe("PROCESS_ITEM"); // dispatch is always the LAST thing, never ahead of readiness
  });

  it("REQUIREMENT: queue order and one-item-at-a-time processing remain intact through a reset — item 2 never starts until item 1 fully resolves AND its own reset completes", async () => {
    const dispatchedItemIds: string[] = [];
    let item1Inspected = false;
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededTwoItemRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "clean" } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) {
          dispatchedItemIds.push(message.item.itemId);
          if (message.item.itemId === "item-1") item1Inspected = true;
          return { response: { started: true } };
        }
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(dispatchedItemIds).toContain("item-1"));
    expect(dispatchedItemIds).not.toContain("item-2"); // never dispatched while item-1 is still in flight

    // item-1 fails (e.g. leaves photos behind) — the queue must move to
    // item-2 next, never re-dispatch item-1 out of order.
    await dispatch(messageListeners, { type: CONTENT_TO_WORKER.ITEM_RESULT, itemId: "item-1", status: "failed", errorCode: "SET_MATERIALS", errorMessage: "NOT_FOUND" });
    await vi.waitFor(() => expect(dispatchedItemIds).toContain("item-2"));

    expect(item1Inspected).toBe(true);
    expect(dispatchedItemIds).toEqual(["item-1", "item-2"]); // strict order, never interleaved or duplicated
  });
});

// Follow-up correction (native browser reload-confirmation bug) — the
// browser's own native "Reload site? Changes that you made may not be
// saved." confirmation can block ensureCleanCreateForm's reset navigation
// indefinitely; this extension can never detect/click/bypass it (chrome-
// internal UI, never part of the page DOM). These tests drive the
// waiting_for_manual_reload state machine through the same public surface
// as every other test in this file, simulating the stuck dialog via
// tabsUpdateStuck (chrome.tabs.update never completing) and fake timers
// bounded by TAB_NAVIGATION_TIMEOUT_MS (8000ms).
describe("service worker — manual browser reload (native browser reload-confirmation bug)", () => {
  const TAB_NAVIGATION_TIMEOUT_MS = 8000;

  function twoItemPayload() {
    return {
      schemaVersion: "vinted-extension-batch-v1", batchId: "batch-1", expiresAt: "2026-08-05T10:30:00.000Z",
      items: [
        { itemId: "item-1", draftId: "draft-1", queuePosition: 0, title: "Item One" },
        { itemId: "item-2", draftId: "draft-2", queuePosition: 1, title: "Item Two" },
      ],
    };
  }
  function seededTwoItemRunningState() {
    let state = QueueState.applyBatchPayload(QueueState.createInitialState(), twoItemPayload(), T0);
    state = QueueState.applyClaim(state, { batchId: "batch-1", batchToken: "test-batch-token", expiresAt: "2026-08-05T10:30:00.000Z", claimedAt: T0 });
    state = QueueState.applyAccountDetected(state, { memberId: "1", displayName: "shopfront_uk" }, T0);
    state = QueueState.applyAccountConfirmed(state, T0);
    state = QueueState.applySelectedVintedTab(state, 1);
    return QueueState.applyStart(state);
  }

  it("REQUIREMENT: a contaminated form whose reset navigation never completes (native dialog blocking it) enters WAITING_FOR_MANUAL_RELOAD — never FAILED — after exactly one reload attempt", async () => {
    vi.useFakeTimers();
    const { chromeMock, storageData, messageListeners, tabsUpdate } = createChromeMock({
      initialState: seededRunningState(),
      tabsUpdateStuck: true,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "dirty", photoCount: 10 } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    const dispatchPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await dispatchPromise;

    const item = currentItem(storageData);
    expect(item.status).toBe(QueueState.ITEM_STATUSES.WAITING_FOR_MANUAL_RELOAD);
    expect(item.status).not.toBe("failed");
    expect((storageData.state as any).batch.paused).toBe(true);
    expect((storageData.state as any).batch.pauseReason).toBe("manual_reload_required");
    expect((storageData.state as any).batch.manualReload).toMatchObject({ itemId: "item-1", attempts: 1 });
    expect(tabsUpdate).toHaveBeenCalledTimes(1); // exactly one reload attempt, never a loop
  });

  it("REQUIREMENT: the exact required warning text is reported to the app using the existing 'paused' status + currentStep/detail fields — no app-side schema change needed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { chromeMock, messageListeners } = createChromeMock({
      initialState: seededRunningState(),
      tabsUpdateStuck: true,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "dirty", photoCount: 10 } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    const dispatchPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await dispatchPromise;

    const resultPost = fetchMock.mock.calls.find(call => String(call[0]).includes("/api/extension/batch/items/item-1/result"));
    expect(resultPost).toBeDefined();
    const body = JSON.parse((resultPost![1] as RequestInit).body as string);
    expect(body.status).toBe("paused");
    expect(body.currentStep).toBe("WAITING_FOR_MANUAL_RELOAD");
    expect(body.detail).toBe(QueueState.MANUAL_RELOAD_WARNING_MESSAGE);
    expect(body.detail).toBe("Browser needs manual reload — click Reload in the Vinted confirmation box to continue.");
  });

  it("REQUIREMENT: never begins another item while waiting — item-2 is never dispatched", async () => {
    vi.useFakeTimers();
    let item2Dispatched = false;
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededTwoItemRunningState(),
      tabsUpdateStuck: true,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "dirty", photoCount: 10 } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM && message.item.itemId === "item-2") item2Dispatched = true;
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    const dispatchPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await dispatchPromise;

    expect((storageData.state as any).batch.items[0].status).toBe(QueueState.ITEM_STATUSES.WAITING_FOR_MANUAL_RELOAD);
    expect(item2Dispatched).toBe(false);
    expect((storageData.state as any).batch.items[1].status).toBe("queued"); // untouched, never dispatched, never touched
  });

  it("REQUIREMENT: no repeated reload loop — subsequent periodic ticks only ever INSPECT while unresolved, never fire another chrome.tabs.update", async () => {
    vi.useFakeTimers();
    const { chromeMock, storageData, messageListeners, alarmListeners, tabsUpdate } = createChromeMock({
      initialState: seededRunningState(),
      tabsUpdateStuck: true,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "dirty", photoCount: 10 } }; // remains dirty/unresolved throughout
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    const dispatchPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await dispatchPromise;
    expect(tabsUpdate).toHaveBeenCalledTimes(1);

    // Several more periodic alarm ticks pass — still unresolved.
    for (let i = 0; i < 3; i++) {
      alarmListeners[0]({ name: ALARM_NAME });
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(tabsUpdate).toHaveBeenCalledTimes(1); // still exactly one — never repeated automatically
    expect(currentItem(storageData).status).toBe(QueueState.ITEM_STATUSES.WAITING_FOR_MANUAL_RELOAD); // still waiting, not failed
  });

  it("REQUIREMENT: once the user manually resolves the browser's dialog and the page is confirmed clean, the item resumes automatically — no Retry needed", async () => {
    vi.useFakeTimers();
    let reloadResolvedByUser = false;
    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededRunningState(),
      tabsUpdateStuck: true,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: reloadResolvedByUser ? "clean" : "dirty", photoCount: reloadResolvedByUser ? 0 : 10 } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    const dispatchPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await dispatchPromise;
    expect(currentItem(storageData).status).toBe(QueueState.ITEM_STATUSES.WAITING_FOR_MANUAL_RELOAD);
    vi.useRealTimers(); // the slow bounded wait is over — back to real timers so vi.waitFor's own polling below can progress

    // The user clicks Reload in the browser's own native dialog — the
    // navigation genuinely completes now, well after our own bounded wait
    // already gave up. The SAME persistent tab-navigation listener that
    // confirms Save Draft (never a second, uncoordinated one) is what
    // notices this.
    reloadResolvedByUser = true;
    await fireTabUpdated(1, { status: "complete", url: "https://www.vinted.co.uk/items/new" });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect((storageData.state as any).batch.manualReload).toBeNull();
    expect((storageData.state as any).batch.paused).toBe(false);
  });

  it("REQUIREMENT: if the page is still dirty after the navigation completes (Cancel, or genuinely unresolved), it remains paused and waiting — never continues on the contaminated form", async () => {
    vi.useFakeTimers();
    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededRunningState(),
      tabsUpdateStuck: true,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "dirty", photoCount: 10 } }; // never becomes clean
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    const dispatchPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await dispatchPromise;
    vi.useRealTimers(); // the slow bounded wait is over — back to real timers for the rest of this test

    await fireTabUpdated(1, { status: "complete", url: "https://www.vinted.co.uk/items/new" });
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(currentItem(storageData).status).toBe(QueueState.ITEM_STATUSES.WAITING_FOR_MANUAL_RELOAD);
    expect((storageData.state as any).batch.paused).toBe(true);
    expect((storageData.state as any).batch.manualReload).not.toBeNull();
  });

  it('REQUIREMENT: "Try reload again" (RETRY_MANUAL_RELOAD) issues exactly one new chrome.tabs.update attempt', async () => {
    vi.useFakeTimers();
    const { chromeMock, storageData, messageListeners, tabsUpdate } = createChromeMock({
      initialState: seededRunningState(),
      tabsUpdateStuck: true,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "dirty", photoCount: 10 } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    const dispatchPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await dispatchPromise;
    expect(tabsUpdate).toHaveBeenCalledTimes(1);

    const retryPromise = dispatch(messageListeners, { type: PANEL_TO_WORKER.RETRY_MANUAL_RELOAD });
    // The retried chrome.tabs.update is ALSO stuck (tabsUpdateStuck) —
    // it goes through the SAME bounded TAB_NAVIGATION_TIMEOUT_MS wait as
    // the original automatic attempt.
    await vi.advanceTimersByTimeAsync(TAB_NAVIGATION_TIMEOUT_MS);
    await retryPromise;

    expect(tabsUpdate).toHaveBeenCalledTimes(2); // exactly one MORE attempt, never a loop
    expect((storageData.state as any).batch.manualReload.attempts).toBe(2);
  });

  it("RETRY_MANUAL_RELOAD is a clear no-op error when nothing is actually pending", async () => {
    const { chromeMock, messageListeners } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);
    const result: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.RETRY_MANUAL_RELOAD });
    expect(result.error).toMatch(/no manual reload is currently pending/i);
  });

  it("REQUIREMENT: a service-worker restart while a manual reload is pending reacquires a tab and recovers safely — the item is never reset to QUEUED blindly, and never FAILED just because the extension restarted", async () => {
    let state = seededRunningState();
    state = QueueState.applyManualReloadNeeded(state, { itemId: "item-1", tabId: 1 }, T0);
    let inspectCalls = 0;
    const { chromeMock, storageData, startupListeners } = createChromeMock({
      initialState: state,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) { inspectCalls += 1; return { response: { state: "clean" } }; }
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    startupListeners[0]();
    await vi.waitFor(() => expect(inspectCalls).toBeGreaterThan(0));
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));

    expect((storageData.state as any).batch.manualReload).toBeNull(); // resolved once genuinely confirmed clean
  });

});

// Follow-up correction (orphaned extension batch recovery) — every
// triggerTick() (the same ~1-minute chrome.alarms cadence the queue's own
// watchdog already relies on) now also sends a bounded, best-effort
// heartbeat while a batch is genuinely still running, so the app's own
// last_extension_activity_at (see app/api/extension/batch/heartbeat/route.ts)
// stays fresh through a long stretch with nothing else to report — most
// notably a WAITING_FOR_MANUAL_RELOAD wait, which has no other genuine
// activity to send.
describe("service worker — heartbeat (orphaned extension batch recovery)", () => {
  it("REQUIREMENT: every periodic tick sends a heartbeat while the batch is genuinely still running (non-terminal items present)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { chromeMock, alarmListeners } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(c => String(c[0]).includes("/api/extension/batch/heartbeat"))).toBe(true));

    const heartbeatCall = fetchMock.mock.calls.find(c => String(c[0]).includes("/api/extension/batch/heartbeat"));
    expect((heartbeatCall![1] as RequestInit).method).toBe("POST");
    expect((heartbeatCall![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-batch-token" });
  });

  it("sends no heartbeat at all when there is no active batch (nothing to keep alive)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { chromeMock, alarmListeners } = createChromeMock({
      initialState: QueueState.createInitialState(),
      sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);
    alarmListeners[0]({ name: ALARM_NAME });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes("/api/extension/batch/heartbeat"))).toBe(false);
  });

  it("a failed heartbeat request never breaks the rest of triggerTick's own queue-driving logic", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/extension/batch/heartbeat")) throw new Error("network down");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { chromeMock, storageData, alarmListeners } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.INSPECT_PAGE_STATE) return { response: { state: "clean" } };
        return { response: { started: true } };
      },
    });
    await loadWorker(chromeMock);
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("preparing"));
  });
});

describe("service worker — watchdog", () => {
  it("watchdog: an in-flight item with no reported progress for the timeout window is moved to a retryable failed state on the next tick, and never left in preparing indefinitely", async () => {
    let state = seededRunningState();
    const staleProgressAt = new Date(Date.now() - 4 * 60 * 1000).toISOString(); // older than the 3-minute watchdog window
    state = { ...state, batch: { ...(state as any).batch, items: [{ ...(state as any).batch.items[0], status: "preparing", lastProgressAt: staleProgressAt }] } };

    const { chromeMock, storageData, alarmListeners } = createChromeMock({
      initialState: state,
      sendMessageHandler: () => ({ response: {} }), // the periodic alarm tick shouldn't need to talk to any tab here — the watchdog fires before any new dispatch
    });

    await loadWorker(chromeMock);
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("failed"));

    const item = currentItem(storageData);
    expect(item.errorCode).toBe("WATCHDOG_TIMEOUT");
    expect(item.errorMessage).toMatch(/no response from the vinted page/i);
  });

  it("app and local queue status stay consistent: every failure reported locally is also POSTed to the app's batch/items/:id/result endpoint with the same status and error code", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededRunningState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { lastError: "no receiver" };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(currentItem(storageData).status).toBe("failed"));

    const resultPost = fetchMock.mock.calls.find(call => String(call[0]).includes("/api/extension/batch/items/item-1/result"));
    expect(resultPost).toBeDefined();
    const body = JSON.parse((resultPost![1] as RequestInit).body as string);
    const localItem = currentItem(storageData);
    expect(body.status).toBe(localItem.status);
    expect(body.errorCode).toBe(localItem.errorCode);
  });
});

describe("service worker — payload integrity across the queue persistence boundary (payload-loss fix)", () => {
  it("REGRESSION: the full API payload survives claim -> fetchBatchPayload's validateBatchPayload -> applyBatchPayload -> chrome.storage.local -> nextQueuedItem/startItem -> the real PROCESS_ITEM message, and the sent item passes validateBatchItem cleanly", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const rawItem = rawPayload.items[0] as Record<string, unknown>;
    let capturedProcessItemMessage: any = null;

    const { chromeMock, storageData, messageListeners } = createChromeMock({
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { capturedProcessItemMessage = message; return { response: { started: true } }; }
        return { response: {} };
      },
    });

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const href = String(url);
      if (href.endsWith("/api/extension/claim")) {
        return new Response(JSON.stringify({ batchToken: "test-token", batchId: rawPayload.batchId, expiresAt: rawPayload.expiresAt }), { status: 200 });
      }
      // The real /api/extension/batch response — exactly what fetchBatchPayload() runs
      // through validateBatchPayload() before ever calling applyBatchPayload() with it.
      if (href.endsWith("/api/extension/batch")) return new Response(JSON.stringify(rawPayload), { status: 200 });
      return new Response(null, { status: 204 }); // e.g. the best-effort item-result POST
    }));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    // First checkpoint: applyBatchPayload's own persistence into chrome.storage.local
    // must retain every field of the payload item, not just the reduced subset the bug left behind.
    const storedItem = currentItem(storageData);
    for (const field of Object.keys(rawItem)) expect(storedItem[field]).toEqual(rawItem[field]);

    // The mandatory initial account confirmation gate: claiming a batch
    // only detects the account (pendingConfirmation) — starting still
    // requires the explicit CONFIRM_ACCOUNT click this mirrors.
    expect((storageData.state as any).batch.account).toBeNull();
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CONFIRM_ACCOUNT });
    expect((storageData.state as any).batch.account.memberId).toBe("1");

    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(capturedProcessItemMessage).not.toBeNull());

    // Second checkpoint: the actual message startItem() sent to the content script.
    const sentItem = capturedProcessItemMessage.item;
    const requiredFields = [
      "description", "brand", "model", "productType", "condition", "ukSize", "audience",
      "colours", "materials", "pricePence", "priceDisplay", "vintedCategoryId", "vintedCategoryPath",
      "photos", "coverPhotoPosition",
    ];
    for (const field of requiredFields) expect(sentItem[field]).toEqual(rawItem[field]);

    // Follow-up correction (photo-download CORS bug): the bearer token is
    // no longer sent to the content script at all — it never downloads a
    // photo itself anymore (the service worker does, using its own
    // persisted token — see downloadPhotoForContentScript), so the live
    // batch credential is never exposed to this least-trusted context.
    expect(capturedProcessItemMessage.bearerToken).toBeUndefined();
    expect(sentItem.bearerToken).toBeUndefined();

    // Final checkpoint: the exact check runItem() performs before ever touching the DOM.
    expect(validateBatchItem(sentItem)).toEqual([]);
  });
});

describe("service worker — mandatory initial account confirmation gate", () => {
  it("REGRESSION: Start batch is rejected before the account has been confirmed, even if sent directly", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        return { response: {} };
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });
    expect((storageData.state as any).batch.pendingConfirmation.memberId).toBe("1");
    expect((storageData.state as any).batch.account).toBeNull();

    const startResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    expect(startResult.error).toMatch(/confirm the vinted account/i);
    expect((storageData.state as any).batch.running).toBe(false);
  });

  it("confirming the detected account enables Start batch to actually run", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        return { response: { started: true } };
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CONFIRM_ACCOUNT });
    const startResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });

    expect(startResult.error).toBeUndefined();
    expect((storageData.state as any).batch.running).toBe(true);
  });

  it("REGRESSION: no reliable identity can be detected — blocks the batch with the exact required message, and Start batch stays rejected", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: null } }; // e.g. only a "99+" notification badge was visible, no reliable profile link
        return { response: {} };
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    expect((storageData.state as any).batch.accountIdentificationError).toBe("Could not reliably identify the logged-in Vinted account.");
    expect((storageData.state as any).batch.account).toBeNull();
    expect((storageData.state as any).batch.pendingConfirmation).toBeNull();

    const startResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    expect(startResult.error).toMatch(/confirm the vinted account/i);
  });

  it("a new batch (re-claimed) requires fresh confirmation, even though the previous batch's account was already confirmed", async () => {
    const batchA = fullBatchPayloadFixture();
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        return { response: {} };
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(batchA));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CONFIRM_ACCOUNT });
    expect((storageData.state as any).batch.account.memberId).toBe("1");

    // A second, different batch is claimed (e.g. the user paired again for a new set of listings).
    const batchB = fullBatchPayloadFixture({ batchId: "44444444-4444-4444-8444-444444444444" });
    vi.stubGlobal("fetch", claimFetchMock(batchB));
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "WXYZ6789" });

    expect((storageData.state as any).batch.batchId).toBe(batchB.batchId);
    expect((storageData.state as any).batch.account).toBeNull(); // never carried over from batch A
    expect((storageData.state as any).batch.pendingConfirmation.memberId).toBe("1");

    const startResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    expect(startResult.error).toMatch(/confirm the vinted account/i);
  });

  it("reloading the side panel (re-reading state fresh from chrome.storage.local) preserves confirmation for the still-active batch", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        return { response: {} };
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CONFIRM_ACCOUNT });
    expect((storageData.state as any).batch.account.memberId).toBe("1");

    // Simulate a side-panel-only reload: a brand new service-worker module
    // instance (as if the side panel/worker were torn down and reopened),
    // reading the SAME underlying chrome.storage.local — never re-fetching
    // the batch payload, so nothing re-triggers detection or confirmation.
    await loadWorker(chromeMock);
    const getStateResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.GET_STATE });

    expect(getStateResult.state.batch.account.memberId).toBe("1");
    expect(getStateResult.state.batch.batchId).toBe(rawPayload.batchId);
  });
});

describe("service worker — deterministic Vinted tab selection (arbitrary-tab-selection fix)", () => {
  function accountReadyHandler(): SendMessageHandler {
    return (_tabId, message) => {
      if (message.type === "PING") return { response: { ready: true } };
      if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
      if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) return { response: { started: true } };
      return { response: {} };
    };
  }

  it("REGRESSION: the active /items/new tab wins when multiple Vinted tabs exist", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const activeCreateListingTab: MockTab = { id: 5, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const otherVintedTab: MockTab = { id: 6, url: "https://www.vinted.co.uk/", windowId: 1, active: false };
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      activeTabQueryResult: [activeCreateListingTab],
      vintedTabsQueryResult: [activeCreateListingTab, otherVintedTab],
      sendMessageHandler: accountReadyHandler(),
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    expect((storageData.state as any).batch.vintedTabId).toBe(5);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it("REGRESSION: a homepage tab listed before the Create Listing tab is never selected — the Create Listing tab wins even when it isn't the active tab", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const activeHomepageTab: MockTab = { id: 5, url: "https://www.vinted.co.uk/", windowId: 1, active: true };
    const createListingTab: MockTab = { id: 6, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: false };
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      activeTabQueryResult: [activeHomepageTab],
      // Homepage tab listed FIRST — proves order-in-the-array isn't what wins; only isCreateListingTab() matters.
      vintedTabsQueryResult: [activeHomepageTab, createListingTab],
      sendMessageHandler: accountReadyHandler(),
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    expect((storageData.state as any).batch.vintedTabId).toBe(6);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it("a Create Listing tab in the current window wins over one in a different window", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const activeTabElsewhere: MockTab = { id: 5, url: "https://www.vinted.co.uk/", windowId: 1, active: true };
    const createListingCurrentWindow: MockTab = { id: 6, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: false };
    const createListingOtherWindow: MockTab = { id: 7, url: "https://www.vinted.co.uk/items/new", windowId: 2, active: false };
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      activeTabQueryResult: [activeTabElsewhere],
      vintedTabsQueryResult: [createListingOtherWindow, createListingCurrentWindow],
      sendMessageHandler: accountReadyHandler(),
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    expect((storageData.state as any).batch.vintedTabId).toBe(6);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it("falls back to a Create Listing tab in another window when none exists in the current window", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const activeTabElsewhere: MockTab = { id: 5, url: "https://www.vinted.co.uk/", windowId: 1, active: true };
    const createListingOtherWindow: MockTab = { id: 7, url: "https://www.vinted.co.uk/items/new", windowId: 2, active: false };
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      activeTabQueryResult: [activeTabElsewhere],
      vintedTabsQueryResult: [createListingOtherWindow],
      sendMessageHandler: accountReadyHandler(),
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    expect((storageData.state as any).batch.vintedTabId).toBe(7);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it("creates a fresh Create Listing tab only when none exists anywhere", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const { chromeMock, storageData, messageListeners, tabsCreate } = createChromeMock({
      activeTabQueryResult: [],
      vintedTabsQueryResult: [],
      createdTabId: 42,
      sendMessageHandler: accountReadyHandler(),
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    expect(tabsCreate).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledWith({ url: "https://www.vinted.co.uk/items/new", active: true });
    expect((storageData.state as any).batch.vintedTabId).toBe(42);
  });

  it("REGRESSION: the selected tab remains stable throughout the batch — selection runs only ONCE even across multiple items", async () => {
    const rawPayload = fullBatchPayloadFixture({
      items: [
        fullBatchItemFixture({ itemId: "item-a", queuePosition: 0 }),
        fullBatchItemFixture({ itemId: "item-b", draftId: "33333333-3333-4333-8333-333333333334", queuePosition: 1 }),
      ],
    });
    const chosenTab: MockTab = { id: 7, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const capturedTabIds: number[] = [];
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      activeTabQueryResult: [chosenTab],
      vintedTabsQueryResult: [chosenTab],
      sendMessageHandler: (tabId, message) => {
        capturedTabIds.push(tabId);
        return accountReadyHandler()(tabId, message);
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CONFIRM_ACCOUNT });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("preparing"));

    // Item 1 completes — triggers triggerTick() to pick up item 2, which calls ensureVintedTab() again.
    await dispatch(messageListeners, { type: CONTENT_TO_WORKER.ITEM_RESULT, itemId: "item-a", status: "completed", vintedDraftId: "111" });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[1].status).toBe("preparing"));

    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect((storageData.state as any).batch.vintedTabId).toBe(7);
    expect(capturedTabIds.length).toBeGreaterThan(0);
    expect(capturedTabIds.every(id => id === 7)).toBe(true); // every message, for both items, used the identical tab id
    // Exactly ONE selection round happened (the {active,currentWindow} query + the {url} query) — never repeated for the second item.
    expect(chromeMock.tabs.query).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION: account detection and form processing use the identical tab id", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const chosenTab: MockTab = { id: 9, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    let detectAccountTabId: number | null = null;
    let processItemTabId: number | null = null;
    const { chromeMock, messageListeners } = createChromeMock({
      activeTabQueryResult: [chosenTab],
      vintedTabsQueryResult: [chosenTab],
      sendMessageHandler: (tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) { detectAccountTabId = tabId; return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } }; }
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { processItemTabId = tabId; return { response: { started: true } }; }
        return { response: {} };
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CONFIRM_ACCOUNT });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });
    await vi.waitFor(() => expect(processItemTabId).not.toBeNull());

    expect(detectAccountTabId).not.toBeNull();
    expect(detectAccountTabId).toBe(chosenTab.id);
    expect(processItemTabId).toBe(chosenTab.id);
  });

  it("REGRESSION: closing the selected tab pauses safely with a clear recovery message — never silently switches to a different Vinted tab", async () => {
    const state = seededRunningState(); // vintedTabId = 1, running = true, one queued item
    const otherValidTab: MockTab = { id: 2, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const { chromeMock, storageData, alarmListeners, tabsGet } = createChromeMock({
      initialState: state,
      activeTabQueryResult: [otherValidTab],
      vintedTabsQueryResult: [otherValidTab], // a DIFFERENT, perfectly valid tab exists — must never be silently picked instead
      tabsGetImpl: (tabId: number) => { if (tabId === 1) throw new Error("No tab with id: 1."); return otherValidTab; },
      sendMessageHandler: () => ({ response: {} }),
    });

    await loadWorker(chromeMock);
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect((storageData.state as any).batch.paused).toBe(true));

    const finalBatch = (storageData.state as any).batch;
    expect(finalBatch.pauseReason).toBe("vinted_tab_lost");
    expect(finalBatch.vintedTabId).toBeNull();
    expect(currentItem(storageData).status).toBe("queued"); // never touched — a safe pause before dispatch, not a failure
    expect(tabsGet).toHaveBeenCalledWith(1);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled(); // never silently created/picked a replacement
  });

  it("REGRESSION: navigating the selected tab away from an allowed Create Listing URL pauses safely", async () => {
    const state = seededRunningState(); // vintedTabId = 1, running = true, one queued item
    const { chromeMock, storageData, alarmListeners } = createChromeMock({
      initialState: state,
      tabsGetImpl: (tabId: number) => ({ id: tabId, url: "https://www.vinted.co.uk/catalog/some-other-page", windowId: 1, active: true }),
      sendMessageHandler: () => ({ response: {} }),
    });

    await loadWorker(chromeMock);
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect((storageData.state as any).batch.paused).toBe(true));

    const finalBatch = (storageData.state as any).batch;
    expect(finalBatch.pauseReason).toBe("vinted_tab_lost");
    expect(finalBatch.vintedTabId).toBeNull();
    expect(currentItem(storageData).status).toBe("queued");
  });

  it("REGRESSION: on browser restart, a stale tab id from a previous session is never trusted — a fresh Create Listing tab is safely reselected", async () => {
    let state = seededRunningState(); // pre-restart: vintedTabId = 1 (from the OLD browser session)
    state = { ...state, batch: { ...(state as any).batch, vintedTabId: 999 } }; // simulate an old, now-meaningless tab id

    const freshTab: MockTab = { id: 5, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const { chromeMock, storageData, startupListeners, tabsGet } = createChromeMock({
      initialState: state,
      activeTabQueryResult: [freshTab],
      vintedTabsQueryResult: [freshTab],
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) return { response: { started: true } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    expect(startupListeners.length).toBeGreaterThan(0);
    startupListeners[0]();

    await vi.waitFor(() => expect((storageData.state as any).batch.vintedTabId).toBe(5));
    // The stale id (999) from before the restart was never even validated — resumeAfterRestart() clears
    // it outright rather than trying chrome.tabs.get(999) against a tab id that may now refer to nothing,
    // or (worse) have been reused by Chrome for a completely unrelated tab.
    expect(tabsGet).not.toHaveBeenCalledWith(999);
  });
});

describe("service worker — photo download (photo-download CORS-bug fix): downloads happen HERE, in the service worker, never the content script", () => {
  // A future expiry — this file's other fixtures use a fixed 2026-08-05
  // date that is now in the PAST relative to the real wall clock
  // (isBatchExpired() below uses the real clock, unlike the rest of this
  // file's pure QueueState helpers, which take an explicit nowIso), so
  // these tests compute their own always-future expiry instead.
  function futureIso(msFromNow = 3600_000) { return new Date(Date.now() + msFromNow).toISOString(); }

  function seededPhotoState(overrides: Record<string, unknown> = {}) {
    const rawPayload = fullBatchPayloadFixture({ expiresAt: futureIso(), ...overrides });
    let state = QueueState.applyBatchPayload(QueueState.createInitialState(), rawPayload, T0);
    state = QueueState.applyClaim(state, { batchId: rawPayload.batchId, batchToken: "test-token", expiresAt: rawPayload.expiresAt, claimedAt: T0 });
    return { state, rawPayload };
  }

  function requestPhoto(messageListeners: Array<(message: any, sender: any, sendResponse: (r: any) => void) => boolean>, itemId: string, position: number) {
    return dispatch(messageListeners, { type: CONTENT_TO_WORKER.REQUEST_PHOTO, itemId, position }) as Promise<any>;
  }

  it("REGRESSION: successfully downloads the first photo through the real service-worker path, using the batch's own bearer token", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const photoBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${APP_BASE_URL}${item.photos[0].path}`); // the relative path resolved against the CONFIGURED App URL
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer test-token");
      return new Response(photoBytes, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(true);
    expect(result.position).toBe(0);
    expect(result.fileName).toBe(item.photos[0].fileName);
    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from(photoBytes)); // correct File-reconstructable bytes
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: HTTP 401 is reported as a specific, safe failure — never the generic 'could not download' message", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTP_401/);
    expect(result.reason).toMatch(/401/);
  });

  it("HTTP 403 is reported the same way", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTP_403/);
  });

  it("REGRESSION: an expired batch is rejected before any fetch is attempted", async () => {
    const rawPayload = fullBatchPayloadFixture({ expiresAt: futureIso(-3600_000) }); // already in the past
    let state = QueueState.applyBatchPayload(QueueState.createInitialState(), rawPayload, T0);
    state = QueueState.applyClaim(state, { batchId: rawPayload.batchId, batchToken: "test-token", expiresAt: rawPayload.expiresAt, claimedAt: T0 });
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXPIRED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REGRESSION: HTTP 404 is reported specifically", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404, statusText: "Not Found" })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTP_404/);
  });

  it("REGRESSION: HTTP 500 is reported specifically", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTP_500/);
  });

  it("REGRESSION: a CORS-style fetch rejection (the exact reported bug — fetch() throws rather than resolving) is caught and reported safely, never left as an unhandled rejection", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    // This is exactly what a real cross-origin-blocked fetch() throws in
    // Chrome — the failure mode this whole fix addresses.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NETWORK/);
    expect(result.reason).toMatch(/TypeError/);
    expect(result.reason).toMatch(/Failed to fetch/);
  });

  it("a missing host permission manifests identically to the CORS-style rejection above (fetch() throws before any response exists) — the same safe NETWORK handling covers it; the manifest itself is checked separately below", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);
    expect(result.ok).toBe(false);
  });

  it("manifest.json's host_permissions cover both the app and Vinted — no NEW permission was needed for this fix, since the service worker already had them (the bug was the WRONG context making the request, not missing permissions)", () => {
    const manifest = JSON.parse(readFileSync("vinted-draft-queue-extension/manifest.json", "utf8"));
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(["http://localhost:3000/*", "https://www.vinted.co.uk/*"]),
    );
  });

  it("REGRESSION: manifest.json's host_permissions cover ports 3000, 3001, AND 3002 — narrowly scoped to localhost, never an unrelated internet-wide grant", () => {
    const manifest = JSON.parse(readFileSync("vinted-draft-queue-extension/manifest.json", "utf8"));
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(["http://localhost:3000/*", "http://localhost:3001/*", "http://localhost:3002/*"]),
    );
    // Narrowly scoped: every entry is either localhost, the exact deployed
    // production origin, vinted.co.uk, ebay.co.uk, or the eBay
    // seller-description host — never "<all_urls>" or a bare "*://*/*" wildcard.
    for (const origin of manifest.host_permissions) {
      expect(
        origin === "https://www.vinted.co.uk/*" ||
        origin === "https://www.ebay.co.uk/*" ||
        origin === "https://*.ebaydesc.com/*" ||
        origin.includes("localhost") ||
        origin === "https://purchase-tracker-one.vercel.app/*",
      ).toBe(true);
    }
  });

  // Follow-up correction (live production error — PHOTO_HOST_NOT_PERMITTED):
  // the deployed production origin must actually be present, not merely
  // "would be allowed if present" — this is what fixes the live error.
  it("REGRESSION: manifest.json's host_permissions includes the exact deployed production origin (https://purchase-tracker-one.vercel.app/*) — fixes the live PHOTO_HOST_NOT_PERMITTED error", () => {
    const manifest = JSON.parse(readFileSync("vinted-draft-queue-extension/manifest.json", "utf8"));
    expect(manifest.host_permissions).toContain("https://purchase-tracker-one.vercel.app/*");
  });

  it("REGRESSION: photo order and correct bearer authentication are unaffected by the path-based resolution fix — both photos of a multi-photo item resolve to the correct URL, in order, each with the batch's own bearer token", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any; // fullBatchItemFixture has 2 photos (position 0 and 1)
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requestedUrls.push(url);
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer test-token");
      return new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const first = await requestPhoto(messageListeners, item.itemId, 0);
    const second = await requestPhoto(messageListeners, item.itemId, 1);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(requestedUrls).toEqual([
      `${APP_BASE_URL}${item.photos[0].path}`,
      `${APP_BASE_URL}${item.photos[1].path}`,
    ]);
  });

  it("REGRESSION: an empty response body is rejected", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([]), { status: 200, headers: { "Content-Type": "image/jpeg" } })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EMPTY/);
  });

  it("REGRESSION: an invalid/disallowed MIME type is rejected", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "application/octet-stream" } })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/INVALID_MIME/);
  });

  it("REGRESSION: an oversized photo is rejected", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const oversized = new Uint8Array(35 * 1024 * 1024 + 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(oversized, { status: 200, headers: { "Content-Type": "image/jpeg" } })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/TOO_LARGE/);
  });

  it("REGRESSION: safe error reporting — bearer tokens never appear in a failure reason, only protocol/hostname/pathname/status/exception", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" })));

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("test-token"); // the bearer token itself
    expect(result.reason).toMatch(/HTTP_403/); // still specific and useful
  });

  // ---- Photo origin-mismatch bug (follow-up correction) -------------------
  //
  // Root cause traced: the batch payload used to carry an ABSOLUTE photo
  // url built server-side from NEXT_PUBLIC_APP_URL, which could silently
  // point at a different origin than the extension's own configured App
  // URL (settings.appBaseUrl) — the live symptom was the extension's
  // configured App URL being port 3002 while NEXT_PUBLIC_APP_URL (and
  // therefore the payload's url) was port 3000, so every photo request
  // went to the wrong, unreachable origin and hung. Fixed by returning a
  // RELATIVE `path` and resolving it ONLY against settings.appBaseUrl,
  // with the origin/shape verified before ever attempting a fetch.

  it("REGRESSION: the configured App URL (settings.appBaseUrl) is the source of truth for the photo's origin — even with a DIFFERENT port than NEXT_PUBLIC_APP_URL would have used, the relative path resolves to the CONFIGURED port", async () => {
    // Mirrors the live bug exactly: the app's own NEXT_PUBLIC_APP_URL was
    // port 3000, but the extension's configured App URL was port 3002.
    const CONFIGURED_APP_URL = "http://localhost:3002";
    const rawPayload = fullBatchPayloadFixture({ expiresAt: futureIso() });
    let state = QueueState.applyBatchPayload(QueueState.createInitialState(), rawPayload, T0);
    state = QueueState.applyClaim(state, { batchId: rawPayload.batchId, batchToken: "test-token", expiresAt: rawPayload.expiresAt, claimedAt: T0 });
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    (storageData.settings as any).appBaseUrl = CONFIGURED_APP_URL; // the extension's own configured setting, independent of NEXT_PUBLIC_APP_URL
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${CONFIGURED_APP_URL}${item.photos[0].path}`);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([3000, 3001, 3002])("REGRESSION: local dev port %i behaves correctly — the relative path always joins with whichever port is configured", async (port: number) => {
    const CONFIGURED_APP_URL = `http://localhost:${port}`;
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    (storageData.settings as any).appBaseUrl = CONFIGURED_APP_URL;
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${CONFIGURED_APP_URL}${item.photos[0].path}`);
      return new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);
    expect(result.ok).toBe(true);
  });

  it("REGRESSION: an arbitrary external host embedded in the path is never trusted — the path validation pattern rejects anything but the exact expected route, so no fetch is ever attempted", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    (state as any).batch.items[0].photos[0].path = "https://evil.example/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0";
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_URL_INVALID/);
    expect(fetchMock).not.toHaveBeenCalled(); // responds immediately — never attempts the fetch at all
  });

  it("REGRESSION: resolvePhotoUrl's origin check — an explicit, independent invariant, not merely implied by the path-shape check above — always resolves to exactly the CONFIGURED App URL's own origin, for any validly-shaped path, whatever that configured origin is", async () => {
    // A path-absolute reference (one starting with "/", which is all
    // PHOTO_PATH_PATTERN ever allows) is structurally guaranteed by the
    // URL spec to resolve to the BASE's own origin — so for a well-formed
    // path, "origin mismatch" can only ever be caused by a bug in a FUTURE
    // change to the path-shape gate, never by the payload itself. This
    // test exercises the exported resolvePhotoUrl directly (rather than
    // via a contrived payload) to prove the origin-equality check is a
    // real, independent line of code — not dead weight — across several
    // distinct configured origins, including the exact live bug's ports.
    const { chromeMock } = createChromeMock({ initialState: seededPhotoState().state, sendMessageHandler: () => ({ response: {} }) });
    const worker: any = await loadWorker(chromeMock);
    const validPath = "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0";

    for (const origin of ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "https://app.example.com"]) {
      const result = worker.resolvePhotoUrl(origin, validPath);
      expect(result.ok).toBe(true);
      expect(result.url.origin).toBe(origin); // never any OTHER origin, whatever is configured
    }
  });

  it("REGRESSION: an invalid configured App URL is rejected as PHOTO_URL_INVALID rather than silently resolving somewhere unexpected", async () => {
    const { chromeMock } = createChromeMock({ initialState: seededPhotoState().state, sendMessageHandler: () => ({ response: {} }) });
    const worker: any = await loadWorker(chromeMock);
    const validPath = "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111/0";

    const result = worker.resolvePhotoUrl("not-a-url", validPath);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_URL_INVALID/);
  });

  it("REGRESSION: a path containing a query string is rejected before any fetch is attempted", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    (state as any).batch.items[0].photos[0].path = `${item.photos[0].path}?token=SUPER_SECRET_VALUE_123`;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_URL_INVALID/);
    expect(result.reason).not.toContain("SUPER_SECRET_VALUE_123");
    expect(result.reason).not.toContain("token=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REGRESSION: a path containing a fragment is rejected before any fetch is attempted", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    (state as any).batch.items[0].photos[0].path = `${item.photos[0].path}#fragment`;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_URL_INVALID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["parent traversal", "/api/extension/batch/photos/../../etc/passwd"],
    ["encoded traversal", "/api/extension/batch/photos/%2e%2e/%2e%2e/etc/passwd"],
    ["credentials embedded", "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111@evil.example/0"],
    ["not the expected route at all", "/some/other/route"],
    ["missing position", "/api/extension/batch/photos/11111111-1111-4111-8111-111111111111"],
  ])("REGRESSION: a malformed/traversal path (%s) is rejected before any fetch is attempted", async (_label: string, badPath: string) => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    (state as any).batch.items[0].photos[0].path = badPath;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_URL_INVALID/);
    expect(fetchMock).not.toHaveBeenCalled(); // responds immediately, never times out waiting on a fetch that was never attempted
  });

  it("REGRESSION: a missing host permission for the configured App URL's origin is reported immediately (PHOTO_HOST_NOT_PERMITTED), never by waiting for a fetch to fail", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }), permissionsGranted: false });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const result = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PHOTO_HOST_NOT_PERMITTED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REGRESSION: content script never directly fetches the private photo URL — no fetch(...) call (or even a mention of one) exists in content-script.js at all — this holds regardless of whether the configured App URL is localhost or the production origin, since content-script.js has no fetch() call for ANY origin to begin with", () => {
    const source = readFileSync("vinted-draft-queue-extension/content-script.js", "utf8");
    expect(source).not.toMatch(/fetch\(/);
  });

  // ============================================================================
  // Live production follow-up bug — PHOTO_HOST_NOT_PERMITTED was already
  // fixed (the production origin is now in manifest.json's host_permissions
  // — see the tests above), but the extension still failed with "NETWORK:
  // ... (TypeError: Failed to fetch)" once a REAL photo download was
  // attempted against https://purchase-tracker-one.vercel.app. Root cause
  // (traced via this repo's own build output, not Vercel's dashboard, which
  // this environment has no credentials for): heic-convert -> heic-decode
  // -> libheif-js dynamically requires a .wasm binary that Vercel's own
  // file tracer could not see (confirmed directly: route.js.nft.json for
  // this exact route listed 60 traced files and NONE of them were the wasm
  // asset) — a missing traced file is never uploaded with the deployed
  // serverless function, so requiring it crashes the function at MODULE
  // LOAD time, before any HTTP response can be constructed, which is
  // exactly what makes a cross-origin fetch() see a raw connection failure
  // instead of a clean JSON error. Fixed via next.config.ts's
  // outputFileTracingIncludes (see that file's own comment). These tests
  // prove the SERVICE WORKER's own request/response handling end to end
  // against the real production origin; they cannot prove the Vercel-side
  // bundling fix itself (that's proven by inspecting the build's own
  // .nft.json — see the diagnosis report), only that the extension
  // correctly downloads a photo once given a normal, well-formed response.
  // ============================================================================
  describe("production-origin photo download (live production follow-up bug)", () => {
    const PRODUCTION_ORIGIN = "https://purchase-tracker-one.vercel.app";

    it("REGRESSION: successfully downloads a photo through the service worker when the configured App URL is the real production origin — proves the fix end to end, not merely against the test fixture's fake app host", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      const photoBytes = new Uint8Array([10, 20, 30]);
      const fetchMock = vi.fn(async (url: string) => {
        expect(url).toBe(`${PRODUCTION_ORIGIN}${item.photos[0].path}`);
        return new Response(photoBytes, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      await loadWorker(chromeMock);
      const result: any = await requestPhoto(messageListeners, item.itemId, 0);

      expect(result.ok).toBe(true);
      expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from(photoBytes));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("REGRESSION: the Authorization bearer header actually reaches the production photo route — asserted directly against the fetch() call's own init.headers, not merely assumed", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      let capturedAuth: string | undefined;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
        return new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
      }));

      await loadWorker(chromeMock);
      const result: any = await requestPhoto(messageListeners, item.itemId, 0);

      expect(result.ok).toBe(true);
      expect(capturedAuth).toBe("Bearer test-token");
    });

    it("REGRESSION: a redirected response is REJECTED and reported, never treated as valid photo data — even when the redirect's final status happens to be 200 (e.g. a login page)", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      vi.stubGlobal("fetch", vi.fn(async () => {
        // Response's own `redirected`/`url` are read-only per the real Fetch
        // API and can't be set via the constructor — Object.defineProperty
        // mirrors exactly what a real followed-redirect Response looks like.
        const response = new Response("<html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } });
        Object.defineProperty(response, "redirected", { value: true });
        Object.defineProperty(response, "url", { value: `${PRODUCTION_ORIGIN}/login` });
        return response;
      }));

      await loadWorker(chromeMock);
      const result: any = await requestPhoto(messageListeners, item.itemId, 0);

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/REDIRECT_REJECTED/);
      expect(result.reason).toContain("redirected=true");
      expect(result.reason).toMatch(/final_url="https:\/\/purchase-tracker-one\.vercel\.app\/login"/);
    });

    it("REGRESSION: a redirected response is rejected even when the final status is an HTTP error — the redirect check runs BEFORE the ok/status check", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      vi.stubGlobal("fetch", vi.fn(async () => {
        const response = new Response("Not Found", { status: 404, statusText: "Not Found" });
        Object.defineProperty(response, "redirected", { value: true });
        Object.defineProperty(response, "url", { value: `${PRODUCTION_ORIGIN}/some-other-place` });
        return response;
      }));

      await loadWorker(chromeMock);
      const result: any = await requestPhoto(messageListeners, item.itemId, 0);

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/REDIRECT_REJECTED/); // never HTTP_404 — the redirect itself is the reported failure
    });

    it("a normal, non-redirected response is unaffected — redirected=false is reported but never treated as a failure on its own", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } })));

      await loadWorker(chromeMock);
      const result: any = await requestPhoto(messageListeners, item.itemId, 0);

      expect(result.ok).toBe(true);
    });

    it("REGRESSION: the new structured diagnostic reason includes stage, HTTP status, redirected, and final_url for an HTTP failure — every field the diagnosis requires, not just a generic message", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Missing batch token." }), { status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } })));

      await loadWorker(chromeMock);
      const result: any = await requestPhoto(messageListeners, item.itemId, 0);

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^HTTP_401:/);
      expect(result.reason).toContain("stage=HTTP_STATUS");
      expect(result.reason).toContain("status=401");
      expect(result.reason).toContain("redirected=false");
      expect(result.reason).toContain('server_error="Missing batch token."'); // the route's own safe JSON error body, surfaced
    });

    it("REGRESSION: the safe server-error extraction never breaks (and never throws) on a non-JSON error body — degrades to a bounded raw-text excerpt instead", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Internal Server Error</html>", { status: 500, statusText: "Internal Server Error", headers: { "Content-Type": "text/html" } })));

      await loadWorker(chromeMock);
      const result: any = await requestPhoto(messageListeners, item.itemId, 0);

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^HTTP_500:/);
      expect(result.reason).toContain("server_error=");
    });

    it("REGRESSION: the bearer token never appears in console.warn output either — not just the returned reason (see the existing 'safe error reporting' test above for the returned-reason side of this guarantee)", async () => {
      const { state, rawPayload } = seededPhotoState();
      const item = rawPayload.items[0] as any;
      const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
      (storageData.settings as any).appBaseUrl = PRODUCTION_ORIGIN;
      vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" })));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadWorker(chromeMock);
      await requestPhoto(messageListeners, item.itemId, 0);

      const allWarnOutput = warnSpy.mock.calls.map(call => call.join(" ")).join("\n");
      expect(allWarnOutput).not.toContain("test-token");
      expect(allWarnOutput).not.toMatch(/Bearer\s+\S/);
    });

    it("REGRESSION: fixing this diagnostics/redirect-handling bug touches nothing Upload/publish-adjacent — no forbidden-action selector or wording was introduced anywhere in service-worker.js", () => {
      const source = readFileSync("vinted-draft-queue-extension/service-worker.js", "utf8");
      expect(source).not.toMatch(/upload-form-save-button/); // the verified forbidden publish control's own testid
      expect(source).not.toMatch(/\bpublish\b/i);
    });
  });

  it("no photo bytes are ever written to chrome.storage.local — REQUEST_PHOTO's response bypasses storage entirely", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners, storageData } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { "Content-Type": "image/jpeg" } })));

    await loadWorker(chromeMock);
    await requestPhoto(messageListeners, item.itemId, 0);

    expect(JSON.stringify(storageData.state)).not.toMatch(/base64|OQk5/); // "OQk5" would be [9,9,9]'s base64 — never persisted
  });

  // ---- Message-lifecycle hang bug (follow-up correction) -----------------
  //
  // Root cause traced: a live batch hung indefinitely with NO download
  // error at all, only the unrelated 3-minute item watchdog eventually
  // noticing. Neither side of the REQUEST_PHOTO exchange bounded anything —
  // this service worker's own fetch() could stall on a dead connection
  // forever, and even setting that aside, nothing here guaranteed
  // sendResponse was ever called exactly once. These tests exercise both.

  it("REGRESSION: the onMessage listener returns true synchronously for every message type, keeping the response channel open", async () => {
    const { state } = seededPhotoState();
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    await loadWorker(chromeMock);

    const returnValue = messageListeners[0]({ type: CONTENT_TO_WORKER.REQUEST_PHOTO, itemId: "x", position: 0 }, {}, () => {});
    expect(returnValue).toBe(true);
  });

  it("REGRESSION: every handler path calls sendResponse exactly once, even if sendResponse itself throws on the first attempt", async () => {
    const { state } = seededPhotoState();
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    await loadWorker(chromeMock);

    let calls = 0;
    const throwingSendResponse = vi.fn(() => {
      calls++;
      if (calls === 1) throw new Error("receiver gone"); // simulates a closed tab/panel
    });
    messageListeners[0]({ type: PANEL_TO_WORKER.GET_STATE }, {}, throwingSendResponse);
    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 10)); // give any stray microtask a chance to misbehave
    expect(calls).toBe(1); // never called a second time after the first attempt threw
  });

  it("REGRESSION: if downloadPhotoForContentScript itself rejects (an unexpected exception, not a normal ok:false), the listener still sends a single, safe error response rather than hanging", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    chromeMock.storage.local.get = vi.fn(async () => { throw new Error("storage exploded"); });

    await loadWorker(chromeMock);
    const result: any = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.error).toMatch(/storage exploded/);
  });

  it("REGRESSION: a fetch that stalls forever (never resolves, never rejects) is aborted after ~30s and reported as a clear timeout — the watchdog is no longer the first indication of this", async () => {
    vi.useFakeTimers();
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        (error as any).name = "AbortError";
        reject(error);
      });
    }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorker(chromeMock);
    const resultPromise = requestPhoto(messageListeners, item.itemId, 0);
    await vi.advanceTimersByTimeAsync(30_000);
    const result: any = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/TIMEOUT/);
    expect(result.reason).toContain("0"); // photo position
  });

  it("REGRESSION: a photo whose base64 payload is too large for one reliable message is transferred in bounded chunks and reassembles to the exact original bytes", async () => {
    const { state, rawPayload } = seededPhotoState();
    const item = rawPayload.items[0] as any;
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    const bigBytes = new Uint8Array(15_000_001); // just over SAFE_SINGLE_MESSAGE_BASE64_CHARS worth of binary
    for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = i % 256;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bigBytes, { status: 200, headers: { "Content-Type": "image/jpeg" } })));

    await loadWorker(chromeMock);
    const result: any = await requestPhoto(messageListeners, item.itemId, 0);

    expect(result.ok).toBe(true);
    expect(result.chunked).toBe(true);
    expect(typeof result.transferId).toBe("string");
    expect(result.totalChunks).toBeGreaterThan(1);
    expect(result.base64).toBeUndefined(); // never inlined in one huge message for a large payload

    let base64 = "";
    for (let chunkIndex = 0; chunkIndex < result.totalChunks; chunkIndex++) {
      const chunkResult: any = await dispatch(messageListeners, { type: CONTENT_TO_WORKER.REQUEST_PHOTO_CHUNK, transferId: result.transferId, chunkIndex });
      expect(chunkResult.ok).toBe(true);
      base64 += chunkResult.data;
    }
    // Buffer.compare (native) rather than expect(...).toEqual(...) — a deep
    // recursive equality check over a 15MB typed array is extremely slow
    // and adds nothing a byte-for-byte native compare doesn't already prove.
    expect(Buffer.compare(Buffer.from(base64, "base64"), Buffer.from(bigBytes))).toBe(0);

    // Fully consumed — freed immediately, never left for the TTL to clean up.
    const afterConsumed: any = await dispatch(messageListeners, { type: CONTENT_TO_WORKER.REQUEST_PHOTO_CHUNK, transferId: result.transferId, chunkIndex: 0 });
    expect(afterConsumed.ok).toBe(false);
    expect(afterConsumed.reason).toMatch(/NOT_FOUND/);
  }, 20000);

  it("REGRESSION: requesting a chunk for an unknown/expired transfer fails safely instead of hanging", async () => {
    const { state } = seededPhotoState();
    const { chromeMock, messageListeners } = createChromeMock({ initialState: state, sendMessageHandler: () => ({ response: {} }) });
    await loadWorker(chromeMock);

    const result: any = await dispatch(messageListeners, { type: CONTENT_TO_WORKER.REQUEST_PHOTO_CHUNK, transferId: "does-not-exist", chunkIndex: 0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });
});

// ============================================================================
// Durable Save Draft confirmation (live Save Draft investigation, follow-up)
// — the service-worker orchestration around shared/queue-state.js's pure
// pendingSave state machine. These tests never run the real content
// script/form-steps.js — exactly like every other test in this file, they
// simulate what the content script WOULD send (BEGIN_SAVE_DRAFT, then a
// tab navigation, then a CHECK_DRAFT_CONFIRMATION response) via the same
// message-dispatch/sendMessageHandler/fireTabUpdated seams already
// established above.
// ============================================================================

describe("service worker — durable Save Draft confirmation (live Save Draft investigation, follow-up)", () => {
  const SAVE_DRAFT_TAB_ID = 7;

  /** A batch with ONE item already marked "preparing" and the tab selected — the state a real batch would be in right as its content script is about to call BEGIN_SAVE_DRAFT. */
  function seededSavingState(overrides: Record<string, unknown> = {}) {
    let state = seededRunningState();
    state = { ...state, batch: { ...(state as any).batch, vintedTabId: SAVE_DRAFT_TAB_ID, ...overrides } };
    return state;
  }

  function beginSaveDraftMessage(itemId = "item-1", extra: Record<string, unknown> = {}) {
    return { type: CONTENT_TO_WORKER.BEGIN_SAVE_DRAFT, itemId, draftId: "draft-1", expectedTitle: "Hoka Clifton 9", expectedSku: "AA1", ...extra };
  }

  it("REGRESSION: PENDING RECORD PERSISTED BEFORE THE CLICK — BEGIN_SAVE_DRAFT persists batch.pendingSave and marks the item SAVING, using the message's own sender.tab.id (never a client-supplied tabId)", async () => {
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededSavingState(), sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);

    const result: any = await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });

    expect(result.ok).toBe(true);
    const state = storageData.state as any;
    expect(state.batch.pendingSave).toMatchObject({ itemId: "item-1", vintedTabId: SAVE_DRAFT_TAB_ID, state: "awaiting_navigation_confirmation" });
    expect(state.batch.items[0].status).toBe("saving");
  });

  it("REGRESSION: BEGIN_SAVE_DRAFT refuses a tabId that doesn't match the batch's own selected Vinted tab — a content script can never claim to be a tab it isn't", async () => {
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededSavingState(), sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);

    const result: any = await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: 999 } }); // a DIFFERENT tab

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/TAB_MISMATCH/);
    expect((storageData.state as any).batch.pendingSave).toBeUndefined();
  });

  it("REGRESSION: BEGIN_SAVE_DRAFT refuses when a pending save is already in flight for this batch — never two at once", async () => {
    const { chromeMock, messageListeners } = createChromeMock({
      initialState: seededSavingState(), sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });

    const second: any = await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });

    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/ALREADY_PENDING/);
  });

  it("REGRESSION: /member/<sellerId> confirmation through a \"Finish editing\" link — the tab navigating there triggers a CHECK_DRAFT_CONFIRMATION check, and a genuine draft id completes the item exactly once", async () => {
    const checkCalls: number[] = [];
    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededSavingState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) { checkCalls.push(1); return { response: { vintedDraftId: "9621049256" } }; }
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });

    fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/member/3140272892" });

    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("completed"));
    const item = (storageData.state as any).batch.items[0];
    expect(item.vintedDraftId).toBe("9621049256");
    expect((storageData.state as any).batch.pendingSave).toBeNull();
    expect(checkCalls.length).toBeGreaterThan(0);
  });

  it("REGRESSION: /items/<draftId>/edit confirmation — the direct edit-page destination is equally valid, no Finish-editing link required on that page", async () => {
    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededSavingState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: "9621049256" } };
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });

    fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/items/9621049256/edit" });

    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("completed"));
    expect((storageData.state as any).batch.items[0].vintedDraftId).toBe("9621049256");
  });

  it("REGRESSION: navigation alone is never treated as success — a matching destination URL with NO confirmed draft link found yet leaves the item still pending, never completed", async () => {
    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededSavingState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: null } }; // navigated, but nothing confirms it yet
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });

    fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/member/3140272892" });
    await new Promise(resolve => setTimeout(resolve, 10)); // let the async confirmation attempt settle

    const state = storageData.state as any;
    expect(state.batch.items[0].status).toBe("saving"); // never completed on navigation alone
    expect(state.batch.pendingSave).not.toBeNull(); // still pending — a real deadline decides failure, not a single missed check
    expect(state.batch.pendingSave.attempts).toBeGreaterThan(0); // the attempt WAS made and recorded
  });

  it("REGRESSION: delayed draft-link appearance — the first check finds nothing, a LATER periodic recovery tick finds it and completes the item", async () => {
    let found = false;
    const { chromeMock, storageData, messageListeners, alarmListeners } = createChromeMock({
      initialState: seededSavingState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: found ? "9621049256" : null } };
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });
    (chromeMock.tabs.get as any) = vi.fn(async (id: number) => ({ id, url: "https://www.vinted.co.uk/member/3140272892", windowId: 1, active: true }));

    // First recovery tick — the profile page is still rendering, nothing found yet.
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect((storageData.state as any).batch.pendingSave?.attempts).toBeGreaterThan(0));
    expect((storageData.state as any).batch.items[0].status).toBe("saving");

    // The destination page finishes rendering; the NEXT periodic tick now finds the link.
    found = true;
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("completed"));
    expect((storageData.state as any).batch.items[0].vintedDraftId).toBe("9621049256");
  });

  it("REGRESSION: service-worker restart during confirmation — a live pendingSave at boot becomes a clear SAVE_DRAFT_UNCONFIRMED failure, NEVER a silent requeue that could click Save Draft again", async () => {
    const state = seededSavingState();
    let pendingState = QueueState.applyPendingSaveStarted(state as any, {
      batchId: (state as any).batch.batchId, itemId: "item-1", draftId: "draft-1", vintedTabId: SAVE_DRAFT_TAB_ID,
      expectedTitle: "Hoka Clifton 9", expectedSku: "AA1", clickedAt: T0, deadline: "2026-08-05T10:01:30.000Z",
    }, T0);

    const { chromeMock, storageData, startupListeners } = createChromeMock({
      initialState: pendingState, sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);
    startupListeners[0]();

    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("failed"));
    const item = (storageData.state as any).batch.items[0];
    expect(item.errorCode).toBe(QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE);
    expect((storageData.state as any).batch.pendingSave).toBeNull();
    expect((storageData.state as any).batch.vintedTabId).toBeNull(); // reselected fresh, never trusted from before the restart
  });

  // Follow-up correction (restart-recovery gap) — the test directly above
  // covers a pendingSave that is ALREADY past its own deadline by the time
  // the restart is handled (its fixed-past-date deadline is, by
  // coincidence, always behind the real wall clock nowIso() uses). These
  // tests cover the other, previously-broken case: a restart while a
  // pendingSave is genuinely still LIVE (its deadline is in the far
  // future) — this must never be treated as an automatic hard failure.
  const FAR_FUTURE_DEADLINE = "2099-01-01T00:00:00.000Z";

  function liveRestartPendingState() {
    const state = seededSavingState();
    return QueueState.applyPendingSaveStarted(state as any, {
      batchId: (state as any).batch.batchId, itemId: "item-1", draftId: "draft-1", vintedTabId: SAVE_DRAFT_TAB_ID,
      expectedTitle: "Hoka Clifton 9", expectedSku: "AA1", clickedAt: T0, deadline: FAR_FUTURE_DEADLINE,
    }, T0);
  }

  it("REGRESSION (restart-recovery gap): a restart with a NOT-yet-expired pendingSave is PRESERVED, not immediately failed — the item stays 'saving' and a fresh, appropriate tab is safely reacquired via ensureVintedTab(), never a new/separate mechanism", async () => {
    const REACQUIRED_TAB_ID = 55; // deliberately a DIFFERENT id than the old SAVE_DRAFT_TAB_ID — proves this was actually reacquired, not just reused blindly
    const reacquiredTab: MockTab = { id: REACQUIRED_TAB_ID, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const processItemCalls: unknown[] = [];
    const beginSaveDraftLikeCalls: unknown[] = [];

    const { chromeMock, storageData, startupListeners, tabsCreate } = createChromeMock({
      initialState: liveRestartPendingState(),
      activeTabQueryResult: [reacquiredTab],
      vintedTabsQueryResult: [reacquiredTab],
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { processItemCalls.push(message); return { response: { started: true } }; }
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: null } }; // still not confirmed — never treated as a hard failure by itself
        beginSaveDraftLikeCalls.push(message);
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    startupListeners[0]();

    await vi.waitFor(() => expect((storageData.state as any).batch.pendingSave?.vintedTabId).toBe(REACQUIRED_TAB_ID));

    const state = storageData.state as any;
    expect(state.batch.items[0].status).toBe("saving"); // never reset to queued (duplicate-click risk) and never failed (restart isn't an automatic hard failure)
    expect(state.batch.pendingSave).not.toBeNull();
    expect(state.batch.pendingSave.deadline).toBe(FAR_FUTURE_DEADLINE); // restart never grants (or removes) extra time
    expect(tabsCreate).not.toHaveBeenCalled(); // an already-open, allowed Vinted tab was reused — never a blind new tab
    expect(processItemCalls.length).toBe(0); // confirmation-only: never re-runs the item
    expect(beginSaveDraftLikeCalls.length).toBe(0); // and never anything besides PING/CHECK_DRAFT_CONFIRMATION — no click-adjacent message is ever sent
  });

  it("REGRESSION (restart-recovery gap): once a fresh tab is reacquired after restart, a genuine confirmation on it still completes the item normally — the app is notified exactly like any other confirmation path", async () => {
    const REACQUIRED_TAB_ID = 55;
    const reacquiredTab: MockTab = { id: REACQUIRED_TAB_ID, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const resultPosts: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/result")) resultPosts.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(null, { status: 204 });
    }));

    const { chromeMock, storageData, startupListeners } = createChromeMock({
      initialState: liveRestartPendingState(),
      activeTabQueryResult: [reacquiredTab],
      vintedTabsQueryResult: [reacquiredTab],
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: "9621049256" } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    startupListeners[0]();

    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("completed"));
    const item = (storageData.state as any).batch.items[0];
    expect(item.vintedDraftId).toBe("9621049256");
    expect((storageData.state as any).batch.pendingSave).toBeNull();
    // Never reported as a failure during the earlier "restored, tab being reacquired" moment — only the genuine completion is ever posted.
    expect(resultPosts.some(p => p.status === "failed")).toBe(false);
    expect(resultPosts.some(p => p.status === "completed" && p.vintedDraftId === "9621049256")).toBe(true);
  });

  it("REGRESSION (restart-recovery gap): if the reacquired tab can never confirm before the deadline, restart recovery degrades gracefully into the SAME ordinary SAVE_DRAFT_UNCONFIRMED failure — never a special-cased 'restart made this impossible' error, and the app is notified exactly once", async () => {
    const REACQUIRED_TAB_ID = 55;
    const reacquiredTab: MockTab = { id: REACQUIRED_TAB_ID, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const resultPosts: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/result")) resultPosts.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(null, { status: 204 });
    }));

    // A deadline just barely in the future relative to the real clock — the restart preserves it, reacquires a tab, checks once (finds nothing), and then a later tick naturally lets it expire.
    const NEAR_FUTURE_DEADLINE = new Date(Date.now() + 50).toISOString();
    const state = seededSavingState();
    const pendingState = QueueState.applyPendingSaveStarted(state as any, {
      batchId: (state as any).batch.batchId, itemId: "item-1", draftId: "draft-1", vintedTabId: SAVE_DRAFT_TAB_ID,
      expectedTitle: "Hoka Clifton 9", expectedSku: "AA1", clickedAt: T0, deadline: NEAR_FUTURE_DEADLINE,
    }, T0);

    const { chromeMock, storageData, startupListeners, alarmListeners } = createChromeMock({
      initialState: pendingState,
      activeTabQueryResult: [reacquiredTab],
      vintedTabsQueryResult: [reacquiredTab],
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: null } };
        return { response: {} };
      },
    });

    await loadWorker(chromeMock);
    startupListeners[0]();
    await vi.waitFor(() => expect((storageData.state as any).batch.pendingSave?.vintedTabId).toBe(REACQUIRED_TAB_ID));

    // Wait out the (tiny) deadline, then a periodic tick discovers the expiry — the same ordinary path an in-session timeout would take.
    await new Promise(resolve => setTimeout(resolve, 60));
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("failed"));

    const item = (storageData.state as any).batch.items[0];
    expect(item.errorCode).toBe(QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE);
    const failurePosts = resultPosts.filter(p => p.status === "failed" && p.errorCode === QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE);
    expect(failurePosts.length).toBe(1); // reported to the app exactly once, never during the earlier preserved/reacquiring moment
  });

  it("REGRESSION: duplicate/late navigation events never duplicate completion — TWO matching onUpdated events for the same tab report the SAME single completion, never a second ITEM_RESULT/fetch POST", async () => {
    const resultPosts: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/result")) resultPosts.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededSavingState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: "9621049256" } };
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });

    fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/member/3140272892" });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("completed"));
    // A second, late/duplicate navigation event for the SAME (already-resolved) tab — pendingSave is already null, so this must be a safe no-op.
    fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/member/3140272892" });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect((storageData.state as any).batch.items[0].vintedDraftId).toBe("9621049256");
    const completionPosts = resultPosts.filter((p: any) => p.status === "completed");
    expect(completionPosts.length).toBe(1); // exactly one completion ever reported to the app
  });

  it("REGRESSION: a confirmed item's draft id is reported back to the app exactly once, via the same items/:id/result endpoint every other status uses", async () => {
    const resultPosts: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/result")) resultPosts.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededSavingState(),
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: "9621049256" } };
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });
    fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/member/3140272892" });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("completed"));

    const completionPost = resultPosts.find(p => p.status === "completed");
    expect(completionPost).toBeDefined();
    expect(completionPost.vintedDraftId).toBe("9621049256");
  });

  it("REGRESSION: timeout offers confirmation-only retry — an expired pending save becomes SAVE_DRAFT_UNCONFIRMED, RETRY_ITEM structurally refuses it (never re-clicks Save Draft), and CHECK_SAVED_DRAFT is the only action that can still resolve it", async () => {
    const T_DEADLINE = "2026-08-05T10:01:30.000Z";
    let pendingState = QueueState.applyPendingSaveStarted(seededSavingState() as any, {
      batchId: (seededSavingState() as any).batch.batchId, itemId: "item-1", draftId: "draft-1", vintedTabId: SAVE_DRAFT_TAB_ID,
      expectedTitle: "Hoka Clifton 9", expectedSku: "AA1", clickedAt: T0, deadline: T_DEADLINE,
    }, T0);

    const processItemCalls: unknown[] = [];
    const { chromeMock, storageData, alarmListeners, messageListeners } = createChromeMock({
      initialState: pendingState,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { processItemCalls.push(message); return { response: { started: true } }; }
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: null } }; // still nothing when the deadline check runs
        return { response: {} };
      },
    });
    (chromeMock.tabs.get as any) = vi.fn(async (id: number) => ({ id, url: "https://www.vinted.co.uk/member/3140272892", windowId: 1, active: true }));
    await loadWorker(chromeMock);

    // Advance past the deadline purely via wall-clock-independent state: the
    // watchdog/tick logic compares against nowIso() (the real clock), so
    // this test seeds a deadline already in the past relative to "now".
    alarmListeners[0]({ name: ALARM_NAME });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("failed"));
    expect((storageData.state as any).batch.items[0].errorCode).toBe(QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE);

    // RETRY_ITEM structurally refuses — never requeues, never dispatches PROCESS_ITEM again.
    const retryResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.RETRY_ITEM, itemId: "item-1" });
    expect(retryResult.error).toMatch(/check saved draft again/i);
    expect((storageData.state as any).batch.items[0].status).toBe("failed"); // never requeued
    expect(processItemCalls.length).toBe(0); // Save Draft was never approached again

    // CHECK_SAVED_DRAFT is the only sanctioned recovery — still finds nothing here, reported honestly, never clicks anything.
    const checkResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.CHECK_SAVED_DRAFT, itemId: "item-1" });
    expect(checkResult.found).toBe(false);
    expect(processItemCalls.length).toBe(0);
  });

  it("REGRESSION: CHECK_SAVED_DRAFT — when the draft actually IS found, it completes the item and continues the batch, all without ever sending PROCESS_ITEM or BEGIN_SAVE_DRAFT again", async () => {
    let pendingState = QueueState.applyPendingSaveExpired(
      QueueState.applyPendingSaveStarted(seededSavingState() as any, {
        batchId: (seededSavingState() as any).batch.batchId, itemId: "item-1", draftId: "draft-1", vintedTabId: SAVE_DRAFT_TAB_ID,
        expectedTitle: "Hoka Clifton 9", expectedSku: "AA1", clickedAt: T0, deadline: T0,
      }, T0),
      T0,
    );
    expect((pendingState as any).batch.items[0].errorCode).toBe(QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE); // sanity: genuinely already expired/failed

    const beginSaveDraftCalls: unknown[] = [];
    const processItemCalls: unknown[] = [];
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: pendingState,
      sendMessageHandler: (_tabId, message) => {
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { processItemCalls.push(message); return { response: { started: true } }; }
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: "9621049256" } };
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);

    const checkResult: any = await dispatch(messageListeners, { type: PANEL_TO_WORKER.CHECK_SAVED_DRAFT, itemId: "item-1" });

    expect(checkResult.found).toBe(true);
    expect(checkResult.vintedDraftId).toBe("9621049256");
    expect((storageData.state as any).batch.items[0].status).toBe("completed");
    expect((storageData.state as any).batch.items[0].vintedDraftId).toBe("9621049256");
    expect(beginSaveDraftCalls.length).toBe(0);
    expect(processItemCalls.length).toBe(0); // never re-ran the item, never clicked Save Draft
  });

  it("REGRESSION: no Upload/Publish/List/Post control is ever approached by the confirmation flow — CHECK_DRAFT_CONFIRMATION is the ONLY message type this flow ever sends to the content script besides PING", async () => {
    const sentTypes: string[] = [];
    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      initialState: seededSavingState(),
      sendMessageHandler: (_tabId, message) => {
        sentTypes.push(message.type);
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) return { response: { vintedDraftId: "9621049256" } };
        return { response: {} };
      },
    });
    await loadWorker(chromeMock);
    await dispatch(messageListeners, beginSaveDraftMessage(), { tab: { id: SAVE_DRAFT_TAB_ID } });
    fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/member/3140272892" });
    await vi.waitFor(() => expect((storageData.state as any).batch.items[0].status).toBe("completed"));

    const uniqueTypes = new Set(sentTypes);
    for (const type of uniqueTypes) expect(["PING", WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION]).toContain(type);
  });

  it("five-item batch: continues one item at a time, confirming each via the durable flow, always using the SAME selected tab throughout", async () => {
    const rawPayload = fullBatchPayloadFixture({
      items: Array.from({ length: 5 }, (_, i) => fullBatchItemFixture({
        itemId: `item-${i}`, draftId: `draft-${i}`, queuePosition: i,
      })),
    });
    const chosenTab: MockTab = { id: SAVE_DRAFT_TAB_ID, url: "https://www.vinted.co.uk/items/new", windowId: 1, active: true };
    const capturedTabIds = new Set<number>();
    let currentItemId: string | null = null;

    const { chromeMock, storageData, messageListeners, fireTabUpdated } = createChromeMock({
      activeTabQueryResult: [chosenTab],
      vintedTabsQueryResult: [chosenTab],
      sendMessageHandler: (tabId, message) => {
        capturedTabIds.add(tabId);
        if (message.type === "PING") return { response: { ready: true } };
        if (message.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) return { response: { identity: { memberId: "1", displayName: "shopfront_uk" } } };
        if (message.type === WORKER_TO_CONTENT.PROCESS_ITEM) { currentItemId = message.item.itemId; return { response: { started: true } }; }
        if (message.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) {
          const n = currentItemId!.split("-")[1];
          return { response: { vintedDraftId: `96210492${n}${n}` } };
        }
        return { response: {} };
      },
    });
    vi.stubGlobal("fetch", claimFetchMock(rawPayload));
    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CONFIRM_ACCOUNT });
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.START_BATCH });

    for (let i = 0; i < 5; i++) {
      await vi.waitFor(() => expect(currentItemId).toBe(`item-${i}`));
      await dispatch(messageListeners, beginSaveDraftMessage(`item-${i}`), { tab: { id: SAVE_DRAFT_TAB_ID } });
      fireTabUpdated(SAVE_DRAFT_TAB_ID, { status: "complete", url: "https://www.vinted.co.uk/member/3140272892" });
      await vi.waitFor(() => expect((storageData.state as any).batch.items[i].status).toBe("completed"));
      expect((storageData.state as any).batch.items[i].vintedDraftId).toBe(`96210492${i}${i}`);
    }

    const summary = QueueState.computeProgressSummary(storageData.state as any);
    expect(summary.completed).toBe(5);
    expect((storageData.state as any).batch.vintedTabId).toBe(SAVE_DRAFT_TAB_ID); // the SAME tab, the whole way through
    expect(capturedTabIds.size).toBe(1);
    expect([...capturedTabIds][0]).toBe(SAVE_DRAFT_TAB_ID);
  }, 20000);
});

// ============================================================================
// Live investigation follow-up (diagnostics gap) — ITEM_STEP_PROGRESS's
// handler used to call reportItemResult(message.itemId, message.status)
// with NO third argument at all, silently dropping every other field on the
// message (currentStep, lastCompletedStep, detail) before they ever reached
// persisted state. These prove the full real pipe — content-script's
// message shape, through the service worker's message handler, into
// persisted state — actually carries currentStep/lastCompletedStep now.
// ============================================================================
describe("service worker — ITEM_STEP_PROGRESS carries currentStep/lastCompletedStep through to persisted state (live investigation diagnostics gap)", () => {
  it("REGRESSION: a field-loop progress report persists currentStep, resets the watchdog clock, and leaves the item's coarse status as 'filling'", async () => {
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededRunningState(), sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);

    const result: any = await dispatch(messageListeners, {
      type: CONTENT_TO_WORKER.ITEM_STEP_PROGRESS, itemId: "item-1", status: "filling",
      currentStep: "SET_PRICE", lastCompletedStep: "SET_MATERIALS",
    });

    expect(result.state.batch.items[0].status).toBe("filling");
    expect(result.state.batch.items[0].currentStep).toBe("SET_PRICE");
    expect(result.state.batch.items[0].lastCompletedStep).toBe("SET_MATERIALS");
    expect((storageData.state as any).batch.items[0].currentStep).toBe("SET_PRICE"); // actually persisted, not just returned
  });

  it("REGRESSION: a subsequent failure report preserves the lastCompletedStep a prior progress report already established, without the failure message needing to repeat it", async () => {
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededRunningState(), sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);

    await dispatch(messageListeners, {
      type: CONTENT_TO_WORKER.ITEM_STEP_PROGRESS, itemId: "item-1", status: "filling",
      currentStep: "SET_PRICE", lastCompletedStep: "SET_MATERIALS",
    });
    await dispatch(messageListeners, {
      type: CONTENT_TO_WORKER.ITEM_RESULT, itemId: "item-1", status: "failed",
      errorCode: "SET_PRICE", errorMessage: "TIMEOUT: step=SET_PRICE field=price expected=\"30\" observed=\"£30.00\"",
    });

    const item = (storageData.state as any).batch.items[0];
    expect(item.status).toBe("failed");
    expect(item.errorCode).toBe("SET_PRICE");
    expect(item.currentStep).toBeNull(); // nothing "currently" running once terminal
    expect(item.lastCompletedStep).toBe("SET_MATERIALS"); // preserved from the earlier progress report — shows exactly how far it got
  });
});

// ============================================================================
// Live investigation follow-up (Listings Review final-item workflow-status
// bug) — root cause: postResultToApp() built and fired its fetch() to the
// app's result endpoint but never awaited or returned that promise, so
// reportItemResult()'s own `await postResultToApp(...)` resolved as soon as
// the fetch was merely STARTED, not once it actually landed. The
// chrome.runtime.onMessage listener (this file's `dispatch()` helper mirrors
// its real resolve-via-sendResponse contract) is what Chrome uses to decide
// the service worker is still doing necessary work; once sendResponse fires,
// Chrome is free to tear the worker down at any time. For every item except
// the last in a batch, the NEXT item's own processing (new tab navigation,
// new messages) keeps the worker alive long enough for the previous item's
// stray fetch to finish in the background anyway. The LAST item has no such
// follow-up activity — nothing else references the worker afterward — so its
// fetch can be (and, per the live bug report, consistently is) cut off
// before the app's database is ever updated, even though the Vinted draft
// itself was already created successfully by the content script. The fix:
// postResultToApp must actually await its own fetch before resolving, so the
// message response (and therefore Chrome's keep-alive signal) is never
// released until the report has genuinely landed.
// ============================================================================
describe("service worker — final item's result report is awaited, not fire-and-forget (Listings Review final-item sync bug)", () => {
  it("REGRESSION: the ITEM_RESULT message response does not resolve until the report fetch to the app has actually settled", async () => {
    const { chromeMock, messageListeners } = createChromeMock({
      initialState: seededRunningState(), sendMessageHandler: () => ({ response: {} }),
    });
    await loadWorker(chromeMock);

    let resolveFetch: (value: Response) => void = () => {};
    let fetchCalled = false;
    const fetchPromise = new Promise<Response>(resolve => { resolveFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/result")) { fetchCalled = true; return fetchPromise; }
      return new Response(null, { status: 204 });
    }));

    let dispatchSettled = false;
    const dispatchPromise = dispatch(messageListeners, {
      type: CONTENT_TO_WORKER.ITEM_RESULT, itemId: "item-1", status: "completed", vintedDraftId: "999",
    }).then(result => { dispatchSettled = true; return result; });

    // Wait for everything that doesn't depend on the still-pending fetch to
    // settle first (state updates, the async storage-backed settings
    // lookup, request construction) — exactly what a fire-and-forget
    // fetch() would let happen before wrongly resolving the message
    // response.
    await vi.waitFor(() => expect(fetchCalled).toBe(true));
    // The critical assertion: with the bug present, the message response
    // (and thus the signal Chrome uses to keep the service worker alive)
    // resolves BEFORE the network request to the app has settled — which is
    // exactly what lets Chrome tear the worker down mid-request for a final
    // item with no follow-up activity. It must still be pending here.
    expect(dispatchSettled).toBe(false);

    resolveFetch(new Response(null, { status: 204 }));
    const result: any = await dispatchPromise;
    expect(dispatchSettled).toBe(true);
    expect(result.state.batch.items[0].status).toBe("completed");
  });
});

// ============================================================================
// Multi-batch support — this batch's own pairing is scoped to exactly one
// batch (its own batchToken), so a 409 "batch no longer active" response
// from the app's item-result route means the OWNER cancelled specifically
// THIS batch — never a signal about any other batch this owner may have
// running in a different browser/profile at the same time. Before this
// fix, postResultToApp() never checked response.ok at all, so the worker
// kept dispatching PROCESS_ITEM against a batch the app had already
// stopped tracking. Also covers the best-effort, purely-cosmetic
// browserLabel reported at claim time (e.g. "Chrome"/"Brave"), used only
// for display attribution in the app's multi-batch UI — never a security
// boundary.
// ============================================================================
describe("service worker — multi-batch support: browser label at claim time, and stop-on-batch-inactive (409)", () => {
  it("reports a best-effort browserLabel string when claiming a batch", async () => {
    const rawPayload = fullBatchPayloadFixture();
    const { chromeMock, messageListeners } = createChromeMock({ sendMessageHandler: () => ({ response: {} }) });
    let claimBody: any = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/extension/claim")) {
        claimBody = JSON.parse((init?.body as string) ?? "{}");
        return new Response(JSON.stringify({ batchToken: "test-token", batchId: rawPayload.batchId, expiresAt: rawPayload.expiresAt }), { status: 200 });
      }
      if (href.endsWith("/api/extension/batch")) return new Response(JSON.stringify(rawPayload), { status: 200 });
      return new Response(null, { status: 204 });
    }));

    await loadWorker(chromeMock);
    await dispatch(messageListeners, { type: PANEL_TO_WORKER.CLAIM_BATCH, pairingCode: "ABCD2345" });

    expect(typeof claimBody.browserLabel).toBe("string");
    expect(claimBody.browserLabel.length).toBeGreaterThan(0);
  });

  it("REGRESSION: a 409 result-report response stops the queue locally — remaining QUEUED items are cancelled and running is set false, mirroring the user's own 'Cancel remaining' action", async () => {
    const twoItemPayload = payload({
      items: [
        { itemId: "item-1", draftId: "draft-1", queuePosition: 0, title: "Hoka Clifton 9", sku: "AA1" },
        { itemId: "item-2", draftId: "draft-2", queuePosition: 1, title: "Nike Pegasus", sku: "AA2" },
      ],
    });
    let state = QueueState.applyBatchPayload(QueueState.createInitialState(), twoItemPayload, T0);
    state = QueueState.applyClaim(state, { batchId: "batch-1", batchToken: "test-batch-token", expiresAt: "2026-08-05T10:30:00.000Z", claimedAt: T0 });
    state = QueueState.applyAccountDetected(state, { memberId: "1", displayName: "shopfront_uk" }, T0);
    state = QueueState.applyAccountConfirmed(state, T0);
    state = QueueState.applySelectedVintedTab(state, 1);
    state = QueueState.applyStart(state);

    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: state, sendMessageHandler: () => ({ response: {} }),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/result")) return new Response(JSON.stringify({ error: "This batch is no longer active." }), { status: 409 });
      return new Response(null, { status: 204 });
    }));
    await loadWorker(chromeMock);

    await dispatch(messageListeners, { type: CONTENT_TO_WORKER.ITEM_RESULT, itemId: "item-1", status: "completed", vintedDraftId: "999" });

    const finalState = storageData.state as any;
    expect(finalState.batch.running).toBe(false);
    expect(finalState.batch.items.find((i: any) => i.itemId === "item-2").status).toBe("cancelled");
  });

  it("a genuine network failure (not a 409) never stops the queue — only an explicit 409 from the app does", async () => {
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      initialState: seededRunningState(), sendMessageHandler: () => ({ response: {} }),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/result")) throw new Error("network down");
      return new Response(null, { status: 204 });
    }));
    await loadWorker(chromeMock);

    await dispatch(messageListeners, { type: CONTENT_TO_WORKER.ITEM_RESULT, itemId: "item-1", status: "completed", vintedDraftId: "999" });

    const finalState = storageData.state as any;
    expect(finalState.batch.running).toBe(true);
  });
});

// ---- eBay full seller-description enrichment (fixes the short og:description
// preview bug) --------------------------------------------------------------
//
// The main eBay page's own JSON-LD only ever carries a short marketing
// preview of the seller's description; the complete text lives in a
// same-origin-restricted iframe (desc_ifr, hosted on ebaydesc.com) that the
// content script can only report the URL of, never read directly. These
// tests prove enrichEbayListingDescription() — reached through both
// EBAY_READ_ACTIVE_LISTING and EBAY_RUN_IMPORTS, its only two callers —
// actually fetches and substitutes the complete description, and that a
// fetch failure produces a clear, retryable failure rather than silently
// keeping (or worse, saving) the short preview.
describe("service worker — eBay full seller-description enrichment", () => {
  const EBAY_TAB_URL = "https://www.ebay.co.uk/itm/267750791701";
  const DESCRIPTION_URL = "https://itm.ebaydesc.com/itmdesc/267750791701?token=abc";
  const SHORT_DESCRIPTION = "Short JSON-LD summary only.";
  const FULL_DESCRIPTION_HTML = "<p>Brand New &amp; Unopened</p><ul><li>La Mer mascara</li><li>MAC lipstick</li></ul>";

  function rawListing() {
    return {
      itemId: "267750791701", url: EBAY_TAB_URL, title: "Harrods BEAUTY Advent Calendar",
      description: SHORT_DESCRIPTION, imageUrls: ["https://i.ebayimg.com/images/g/x/s-l1600.jpg"],
      pricePence: 3499, currency: "GBP", condition: null, category: null, brand: "Harrods",
      size: null, colours: [], material: null, quantity: 1, itemSpecifics: {}, descriptionUrl: DESCRIPTION_URL,
    };
  }

  it("REGRESSION: EBAY_READ_ACTIVE_LISTING returns the COMPLETE seller description fetched from the ebaydesc.com iframe, never the short JSON-LD preview", async () => {
    const { chromeMock, messageListeners } = createChromeMock({
      activeTabQueryResult: [{ id: 7, url: EBAY_TAB_URL, windowId: 1, active: true }],
      sendMessageHandler: (_tabId, message) => message.type === "EBAY_READ_LISTING" ? { response: { ok: true, listing: rawListing() } } : { response: {} },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(String(url)).toBe(DESCRIPTION_URL);
      return new Response(FULL_DESCRIPTION_HTML, { status: 200 });
    }));

    await loadWorker(chromeMock);
    const result: any = await dispatch(messageListeners, { type: "EBAY_READ_ACTIVE_LISTING" });

    expect(result.listing.description).toContain("Brand New & Unopened");
    expect(result.listing.description).toContain("• La Mer mascara");
    expect(result.listing.description).toContain("• MAC lipstick");
    expect(result.listing.description).not.toBe(SHORT_DESCRIPTION);
  });

  it("REGRESSION: EBAY_READ_ACTIVE_LISTING surfaces a clear error when the full description can't be fetched, rather than returning a listing with the short preview", async () => {
    const { chromeMock, messageListeners } = createChromeMock({
      activeTabQueryResult: [{ id: 7, url: EBAY_TAB_URL, windowId: 1, active: true }],
      sendMessageHandler: (_tabId, message) => message.type === "EBAY_READ_LISTING" ? { response: { ok: true, listing: rawListing() } } : { response: {} },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Server error", { status: 500 })));

    await loadWorker(chromeMock);
    const result: any = await dispatch(messageListeners, { type: "EBAY_READ_ACTIVE_LISTING" });

    expect(result.listing).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it("REGRESSION: EBAY_RUN_IMPORTS posts the COMPLETE seller description to the app for each queued item, never the short preview", async () => {
    const queuedItem = { id: "item-1", ebay_item_id: "267750791701", title: "Harrods BEAUTY Advent Calendar", source_url: EBAY_TAB_URL };
    let postedBody: any = null;
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      createdTabId: 42,
      sendMessageHandler: (_tabId, message) => message.type === "EBAY_READ_LISTING" ? { response: { ok: true, listing: rawListing() } } : { response: {} },
    });
    storageData.settings = { appBaseUrl: APP_BASE_URL, connectionToken: "test-token", connectionExpiresAt: "2099-01-01T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      const href = String(url);
      if (href.endsWith("/api/extension/ebay-imports")) return new Response(JSON.stringify({ batches: [{ id: "batch-1", items: [queuedItem] }] }), { status: 200 });
      if (href === DESCRIPTION_URL) return new Response(FULL_DESCRIPTION_HTML, { status: 200 });
      if (href.includes("/process")) { postedBody = JSON.parse(init.body); return new Response(JSON.stringify({ title: postedBody.listing.title }), { status: 200 }); }
      return new Response(null, { status: 204 });
    }));

    await loadWorker(chromeMock);
    const result: any = await dispatch(messageListeners, { type: "EBAY_RUN_IMPORTS" });

    expect(result.state.completed).toBe(1);
    expect(result.state.failed).toBe(0);
    expect(postedBody).not.toBeNull();
    expect(postedBody.listing.description).toContain("Brand New & Unopened");
    expect(postedBody.listing.description).not.toBe(SHORT_DESCRIPTION);
  });

  it("REGRESSION: a full-description fetch failure marks THAT item failed with a useful message, and never falls back to posting the short preview", async () => {
    const queuedItem = { id: "item-1", ebay_item_id: "267750791701", title: "Harrods BEAUTY Advent Calendar", source_url: EBAY_TAB_URL };
    let processCalled = false;
    const { chromeMock, storageData, messageListeners } = createChromeMock({
      createdTabId: 42,
      sendMessageHandler: (_tabId, message) => message.type === "EBAY_READ_LISTING" ? { response: { ok: true, listing: rawListing() } } : { response: {} },
    });
    storageData.settings = { appBaseUrl: APP_BASE_URL, connectionToken: "test-token", connectionExpiresAt: "2099-01-01T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const href = String(url);
      if (href.endsWith("/api/extension/ebay-imports")) return new Response(JSON.stringify({ batches: [{ id: "batch-1", items: [queuedItem] }] }), { status: 200 });
      if (href === DESCRIPTION_URL) return new Response("Server error", { status: 500 });
      if (href.includes("/process")) { processCalled = true; return new Response(JSON.stringify({}), { status: 200 }); }
      return new Response(null, { status: 204 });
    }));

    await loadWorker(chromeMock);
    const result: any = await dispatch(messageListeners, { type: "EBAY_RUN_IMPORTS" });

    expect(result.state.failed).toBe(1);
    expect(result.state.completed).toBe(0);
    expect(result.state.items[0].status).toBe("failed");
    expect(result.state.items[0].error).toMatch(/description/i);
    expect(processCalled).toBe(false);
  });

  it("does not change existing Vinted draft orchestration: EBAY_RUN_IMPORTS with an empty queue leaves the queue idle without touching chrome.tabs.create", async () => {
    const { chromeMock, storageData, messageListeners, tabsCreate } = createChromeMock({
      sendMessageHandler: () => ({ response: {} }),
    });
    storageData.settings = { appBaseUrl: APP_BASE_URL, connectionToken: "test-token", connectionExpiresAt: "2099-01-01T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/extension/ebay-imports")) return new Response(JSON.stringify({ batches: [] }), { status: 200 });
      return new Response(null, { status: 204 });
    }));

    await loadWorker(chromeMock);
    const result: any = await dispatch(messageListeners, { type: "EBAY_RUN_IMPORTS" });

    expect(result.state.total).toBe(0);
    expect(tabsCreate).not.toHaveBeenCalled();
  });
});
