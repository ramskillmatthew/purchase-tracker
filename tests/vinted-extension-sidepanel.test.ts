// @vitest-environment jsdom
//
// Follow-up correction (durable Save Draft confirmation, side-panel gap) —
// proves the REAL side-panel module (sidepanel.js), rendered against the
// REAL sidepanel.html, shows the "Check saved draft again" action — and
// never the ordinary Retry action — for an item that failed with
// SAVE_DRAFT_UNCONFIRMED (see shared/queue-state.js's own top comment on
// why applyRetryItem structurally refuses that exact errorCode). Also
// proves the button is confirmation-only: it only ever sends
// PANEL_TO_WORKER.CHECK_SAVED_DRAFT, never refills the form, never clicks
// Save draft, never re-runs the item — those guarantees are structural
// (there is no code path in the click handler that could do any of them),
// but this file still proves the ONLY outbound message is CHECK_SAVED_DRAFT
// and that the visible states (checking / found / not-found / error) all
// render as expected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { PANEL_TO_WORKER } from "../vinted-draft-queue-extension/shared/messages.js";
import { ITEM_STATUSES, SAVE_DRAFT_UNCONFIRMED_ERROR_CODE, SAVE_DRAFT_UNCONFIRMED_MESSAGE } from "../vinted-draft-queue-extension/shared/queue-state.js";

const SIDEPANEL_HTML = readFileSync(path.resolve("vinted-draft-queue-extension/sidepanel.html"), "utf8");

function baseState(itemOverrides: Record<string, unknown> = {}, batchOverrides: Record<string, unknown> = {}) {
  return {
    pairing: { batchId: "batch-1", expiresAt: "2026-08-05T10:30:00.000Z" },
    batch: {
      batchId: "batch-1",
      running: false,
      paused: false,
      account: { memberId: "1", displayName: "shopfront_uk" },
      pendingConfirmation: null,
      accountIdentificationError: null,
      pendingAccountChange: null,
      vintedTabId: null,
      pendingSave: null,
      items: [
        {
          itemId: "item-1", queuePosition: 0, title: "Hoka Clifton 9", sku: "AA1",
          status: ITEM_STATUSES.FAILED,
          errorCode: SAVE_DRAFT_UNCONFIRMED_ERROR_CODE,
          errorMessage: SAVE_DRAFT_UNCONFIRMED_MESSAGE,
          vintedDraftId: null,
          ...itemOverrides,
        },
      ],
      ...batchOverrides,
    },
  };
}

/**
 * Loads the REAL sidepanel.html into a fresh JSDOM document, stubs a
 * minimal chrome.* surface (runtime.sendMessage routed through
 * `sendMessageHandler`, storage.local.get/set, storage.onChanged), and
 * dynamically imports the REAL sidepanel.js against it — mirroring how
 * vinted-extension-service-worker.test.ts's loadWorker() loads the real
 * service-worker.js against a stubbed chrome.*. sidepanel.js runs
 * loadSettings()/refresh() as an import-time side effect, so the initial
 * GET_STATE response is always awaited before this resolves.
 */
async function loadSidepanel(sendMessageHandler: (type: string, payload: Record<string, unknown>) => any) {
  const dom = new JSDOM(SIDEPANEL_HTML, { url: "http://localhost/sidepanel.html" });
  vi.stubGlobal("window", dom.window as any);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);

  const onChangedListeners: Array<(changes: any) => void> = [];
  const sendMessage = vi.fn(async (message: any) => sendMessageHandler(message.type, message));
  const chromeMock: any = {
    runtime: { sendMessage },
    storage: {
      local: {
        get: vi.fn(async () => ({ settings: { appBaseUrl: "http://test-app.local" } })),
        set: vi.fn(async () => {}),
      },
      onChanged: { addListener: (fn: any) => onChangedListeners.push(fn) },
    },
  };
  vi.stubGlobal("chrome", chromeMock);

  vi.resetModules();
  await import("../vinted-draft-queue-extension/sidepanel.js");
  // loadSettings()/refresh() are fire-and-forget at import time — let their microtasks settle.
  await new Promise(resolve => setTimeout(resolve, 0));

  function fireStorageChanged(state: unknown) {
    for (const fn of onChangedListeners) fn({ state: { newValue: state } });
  }

  return { dom, document: dom.window.document, sendMessage, fireStorageChanged };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("side panel — 'Check saved draft again' for a SAVE_DRAFT_UNCONFIRMED failure", () => {
  it("REGRESSION: renders 'Check saved draft again' (not the ordinary Retry button) for an item failed with SAVE_DRAFT_UNCONFIRMED", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: baseState() } : {}));

    const checkButton = document.querySelector(".queue-item-check-saved-draft") as HTMLButtonElement;
    expect(checkButton).not.toBeNull();
    expect(checkButton.textContent).toBe("Check saved draft again");
    expect(document.querySelector(".queue-item-retry")).toBeNull(); // never the ordinary Retry action for this specific errorCode
  });

  it("REGRESSION: an ordinary failure (a different errorCode) still shows the normal Retry button, never 'Check saved draft again'", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ errorCode: "CONTENT_SCRIPT_UNAVAILABLE", errorMessage: "Could not reach the Vinted tab — refresh the vinted tab and retry." }) }
        : {},
    );

    expect(document.querySelector(".queue-item-retry")).not.toBeNull();
    expect(document.querySelector(".queue-item-check-saved-draft")).toBeNull();
  });

  it("REGRESSION: a non-failed item (e.g. completed) shows neither action button", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "9621049256" }) }
        : {},
    );

    expect(document.querySelector(".queue-item-retry")).toBeNull();
    expect(document.querySelector(".queue-item-check-saved-draft")).toBeNull();
  });

  it("REGRESSION: clicking the button sends ONLY PANEL_TO_WORKER.CHECK_SAVED_DRAFT — never RETRY_ITEM, never START_BATCH, never anything else — and shows a disabled 'Checking…' state while the request is in flight", async () => {
    let resolveCheck!: (value: any) => void;
    const checkPromise = new Promise(resolve => { resolveCheck = resolve; });
    const sentTypes: string[] = [];

    const { document, sendMessage } = await loadSidepanel((type) => {
      sentTypes.push(type);
      if (type === PANEL_TO_WORKER.GET_STATE) return { state: baseState() };
      if (type === PANEL_TO_WORKER.CHECK_SAVED_DRAFT) return checkPromise;
      return {};
    });

    const checkButton = document.querySelector(".queue-item-check-saved-draft") as HTMLButtonElement;
    checkButton.click();
    await Promise.resolve(); // let the click handler's first microtask (disabling the button) run

    expect(checkButton.disabled).toBe(true);
    expect(checkButton.textContent).toBe("Checking…");
    expect(sentTypes.filter(t => t !== PANEL_TO_WORKER.GET_STATE)).toEqual([PANEL_TO_WORKER.CHECK_SAVED_DRAFT]);

    resolveCheck({ found: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: PANEL_TO_WORKER.CHECK_SAVED_DRAFT, itemId: "item-1" }));
  });

  it("REGRESSION: a 'not found' result shows a clear inline message and re-enables the button — never treated as a hard failure", async () => {
    const { document } = await loadSidepanel(type => {
      if (type === PANEL_TO_WORKER.GET_STATE) return { state: baseState() };
      if (type === PANEL_TO_WORKER.CHECK_SAVED_DRAFT) return { found: false };
      return {};
    });

    const checkButton = document.querySelector(".queue-item-check-saved-draft") as HTMLButtonElement;
    checkButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(checkButton.disabled).toBe(false);
    expect(checkButton.textContent).toBe("Check saved draft again");
    const statusMsg = document.querySelector(".queue-item-check-status") as HTMLElement;
    expect(statusMsg.hidden).toBe(false);
    expect(statusMsg.textContent).toMatch(/still not confirmed/i);
  });

  it("REGRESSION: an error result (e.g. a network failure) shows the error message and re-enables the button", async () => {
    const { document } = await loadSidepanel(type => {
      if (type === PANEL_TO_WORKER.GET_STATE) return { state: baseState() };
      if (type === PANEL_TO_WORKER.CHECK_SAVED_DRAFT) return { error: "No active batch." };
      return {};
    });

    const checkButton = document.querySelector(".queue-item-check-saved-draft") as HTMLButtonElement;
    checkButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(checkButton.disabled).toBe(false);
    expect(checkButton.textContent).toBe("Check saved draft again");
    const statusMsg = document.querySelector(".queue-item-check-status") as HTMLElement;
    expect(statusMsg.hidden).toBe(false);
    expect(statusMsg.textContent).toBe("No active batch.");
  });

  it("REGRESSION: a 'found' result relies on the normal chrome.storage.onChanged re-render — once the worker persists the item as completed, the panel shows the confirmed draft like any other completed item, with no separate success-branch UI needed", async () => {
    const { document, fireStorageChanged } = await loadSidepanel(type => {
      if (type === PANEL_TO_WORKER.GET_STATE) return { state: baseState() };
      if (type === PANEL_TO_WORKER.CHECK_SAVED_DRAFT) return { found: true, vintedDraftId: "9621049256" };
      return {};
    });

    const checkButton = document.querySelector(".queue-item-check-saved-draft") as HTMLButtonElement;
    checkButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    // The click handler itself does nothing further on "found" — the completed state only ever
    // appears once the service worker's own persisted state change is observed, exactly like every
    // other status transition in this panel.
    fireStorageChanged(baseState({ status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "9621049256" }));

    expect(document.querySelector(".queue-item-check-saved-draft")).toBeNull();
    expect(document.querySelector(".queue-item-retry")).toBeNull();
    expect(document.body.textContent).toContain("Vinted draft 9621049256");
  });
});

// ============================================================================
// Live investigation follow-up — the reported failure showed only the
// generic "TIMEOUT: field did not confirm the entered value." in the side
// panel, with no way to tell which field or how far the item had gotten.
// These prove the panel now shows the EXACT failed step (from errorCode,
// human-readable), and — for a still-running item — the current step and
// the last one that actually succeeded.
// ============================================================================
describe("side panel — exact failed step / current step / last completed step (live investigation follow-up)", () => {
  it("REGRESSION: a SET_PRICE failure shows 'Failed step: Price' — not just the generic error message", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? {
            state: baseState({
              errorCode: "SET_PRICE",
              errorMessage: 'TIMEOUT: step=SET_PRICE field=price selector="[data-testid=\\"price-input--input\\"]" expected="30.00" observed="£30.00" reason="the field\'s live value never matched the expected value"',
              lastCompletedStep: "SET_MATERIALS",
            }),
          }
        : {},
    );

    const failedStepEl = document.querySelector(".queue-item-failed-step");
    expect(failedStepEl).not.toBeNull();
    expect(failedStepEl!.textContent).toBe("Failed step: Price");
    // The full structured diagnostic message is still shown too — never hidden in favour of the summary.
    expect(document.querySelector(".queue-item-error")!.textContent).toContain("step=SET_PRICE");
    // How far it got before failing is shown alongside the failed step.
    const progressEl = document.querySelector(".queue-item-step-progress");
    expect(progressEl!.textContent).toContain("Last completed: Material");
  });

  it("REGRESSION: a different failed step (e.g. SET_CATEGORY) shows its own label — proves the mapping isn't hardcoded to price", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ errorCode: "SET_CATEGORY", errorMessage: "UNVERIFIED: step=SET_CATEGORY field=category ..." }) }
        : {},
    );
    expect(document.querySelector(".queue-item-failed-step")!.textContent).toBe("Failed step: Category");
  });

  it("an unrecognised errorCode (e.g. a non-step failure like LOGIN_REQUIRED) still shows a failed-step line, falling back to the raw code rather than hiding it", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ errorCode: "LOGIN_REQUIRED", errorMessage: "Vinted is asking to log in." }) }
        : {},
    );
    expect(document.querySelector(".queue-item-failed-step")!.textContent).toBe("Failed step: LOGIN_REQUIRED");
  });

  it("a still-running (filling) item shows its live current step, with no failed-step line at all", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? {
            state: baseState({
              status: ITEM_STATUSES.FILLING, errorCode: null, errorMessage: null,
              currentStep: "SET_PRICE", lastCompletedStep: "SET_MATERIALS",
            }),
          }
        : {},
    );

    expect(document.querySelector(".queue-item-failed-step")).toBeNull();
    const progressEl = document.querySelector(".queue-item-step-progress");
    expect(progressEl!.textContent).toBe("Current step: Price — Last completed: Material");
  });

  it("a queued item with no step history yet shows no step-progress line at all", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, currentStep: null, lastCompletedStep: null }) }
        : {},
    );
    expect(document.querySelector(".queue-item-step-progress")).toBeNull();
  });
});
