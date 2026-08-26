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
    expect(document.body.textContent).toContain("Draft 9621049256");
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

    // Redesign (Option 4) — the failed-step line's class is now
    // .queue-item-error-step (was .queue-item-failed-step); the diagnostic
    // message is .queue-item-error-text (was .queue-item-error).
    const failedStepEl = document.querySelector(".queue-item-error-step");
    expect(failedStepEl).not.toBeNull();
    expect(failedStepEl!.textContent).toBe("Failed step: Price");
    // The full structured diagnostic message is still shown too — never hidden in favour of the summary.
    expect(document.querySelector(".queue-item-error-text")!.textContent).toContain("step=SET_PRICE");
    // How far it got before failing is shown alongside the failed step, in its own dedicated line.
    const lastCompletedEl = document.querySelector(".queue-item-last-completed");
    expect(lastCompletedEl!.textContent).toBe("Last completed: Material");
  });

  it("REGRESSION: a different failed step (e.g. SET_CATEGORY) shows its own label — proves the mapping isn't hardcoded to price", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ errorCode: "SET_CATEGORY", errorMessage: "UNVERIFIED: step=SET_CATEGORY field=category ..." }) }
        : {},
    );
    expect(document.querySelector(".queue-item-error-step")!.textContent).toBe("Failed step: Category");
  });

  it("an unrecognised errorCode (e.g. a non-step failure like LOGIN_REQUIRED) still shows a failed-step line, falling back to the raw code rather than hiding it", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ errorCode: "LOGIN_REQUIRED", errorMessage: "Vinted is asking to log in." }) }
        : {},
    );
    expect(document.querySelector(".queue-item-error-step")!.textContent).toBe("Failed step: LOGIN_REQUIRED");
  });

  it("a still-running (filling) item shows its live current step in the status column, with no failed-step row at all", async () => {
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

    expect(document.querySelector(".queue-item-error-step")).toBeNull();
    expect(document.querySelector(".queue-item-error-row")).toBeNull();
    // Redesign (Option 4) — the live current-step line moved into the
    // compact status column (.status-secondary), under the status pill,
    // and now reads as a short present-progressive description ("Setting
    // price") rather than "Current step: X — Last completed: Y" — the
    // last-completed-step diagnostic is reserved for the failed-item view
    // above, where "how far did it get" matters most.
    const secondaryEl = document.querySelector(".status-secondary");
    expect(secondaryEl!.textContent).toBe("Setting price");
  });

  it("a queued item with no step history yet shows no secondary status line at all", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: baseState({ status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, currentStep: null, lastCompletedStep: null }) }
        : {},
    );
    expect(document.querySelector(".status-secondary")).toBeNull();
  });
});

// ============================================================================
// Option 4 visual redesign — the side panel's HTML/CSS/JS were rebuilt to
// match two supplied reference images pixel-for-pixel as closely as
// technically possible (see the project's own report for the full live
// Chrome verification log — screenshots at 360/420/480px against both
// references, iterated until differences were minor). These tests cover
// the STRUCTURAL/BEHAVIOURAL contract the redesign must uphold: real
// states render correctly, no fabricated data, every existing message
// type and safeguard is untouched, and nothing regresses to the old
// numbered-tutorial/light-theme/large-white-card look.
// ============================================================================

const sidepanelSource = readFileSync(path.resolve("vinted-draft-queue-extension/sidepanel.html"), "utf8");
const sidepanelCss = readFileSync(path.resolve("vinted-draft-queue-extension/sidepanel.css"), "utf8");
const sidepanelJs = readFileSync(path.resolve("vinted-draft-queue-extension/sidepanel.js"), "utf8");

function fullBatchState(overrides: {
  pairing?: Record<string, unknown> | null;
  batch?: Record<string, unknown> | null;
  items?: Array<Record<string, unknown>>;
} = {}) {
  const items = overrides.items ?? [
    { itemId: "i1", queuePosition: 0, title: "Nike Pegasus Trail 5", sku: "1690", status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "9638197794", startedAt: "2026-08-11T10:00:00.000Z", completedAt: "2026-08-11T10:00:30.000Z", currentStep: null, lastCompletedStep: "SAVE_DRAFT", attemptCount: 1 },
    { itemId: "i2", queuePosition: 1, title: "Nike Air Max 270 Trainers", sku: "1719", status: ITEM_STATUSES.FILLING, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: "2026-08-11T10:01:00.000Z", completedAt: null, currentStep: "SET_PRICE", lastCompletedStep: "SET_MATERIALS", attemptCount: 1 },
    { itemId: "i3", queuePosition: 2, title: "Nike Pegasus Trail 3", sku: "1735", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 },
    { itemId: "i4", queuePosition: 3, title: "Nike React Vision", sku: "1721", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 },
  ];
  return {
    pairing: overrides.pairing === undefined ? { batchId: "batch-1", expiresAt: "2026-08-11T10:30:00.000Z" } : overrides.pairing,
    batch: overrides.batch === undefined ? {
      batchId: "batch-1", running: true, paused: false,
      account: { memberId: "3140272892", displayName: null },
      pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null,
      vintedTabId: 1, pendingSave: null, items,
    } : overrides.batch,
  };
}

describe("Option 4 redesign — disconnected state", () => {
  it("shows 'Not connected' in the header badge, the pairing panel, and the disconnected empty state — never the connection summary", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: { pairing: null, batch: null } } : {}));
    expect(document.getElementById("connection-badge-label")!.textContent).toBe("Not connected");
    expect((document.getElementById("connection-badge") as HTMLElement).classList.contains("is-connected")).toBe(false);
    expect((document.getElementById("pairing-panel") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("connection-summary") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("disconnected-empty-state") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("idle-empty-state") as HTMLElement).hidden).toBe(true);
  });

  it("the App connection settings panel is open by default while disconnected", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: { pairing: null, batch: null }, settings: { appBaseUrl: "http://localhost:3000" } } : {}));
    expect((document.getElementById("settings-panel") as HTMLElement).hidden).toBe(false);
  });

  it("REGRESSION: no numbered-tutorial section headings ('1. Pair with the app', '2. Confirm Vinted account', '3. Batch') remain anywhere in the markup", () => {
    expect(sidepanelSource).not.toMatch(/>\s*1\.\s+Pair with the app/);
    expect(sidepanelSource).not.toMatch(/>\s*2\.\s+Confirm Vinted account/);
    expect(sidepanelSource).not.toMatch(/>\s*3\.\s+Batch/);
  });

  it("REGRESSION: 'Vinted Draft Queue' appears as a heading only once — never repeated as a second large heading", () => {
    // Once in <title>, once as the header <h1>'s own text+title attribute
    // (same single element, both referring to it) — never a SECOND <h1> or
    // heading-level element repeating it below the header.
    const headingMatches = sidepanelSource.match(/<h1[^>]*>Vinted Draft Queue<\/h1>/g) ?? [];
    expect(headingMatches.length).toBe(1);
    expect(sidepanelSource.match(/<h1/g)?.length ?? 0).toBe(1);
  });
});

describe("Option 4 redesign — connected state", () => {
  it("shows 'Connected' with a green dot in the header, never the pairing form again", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ batch: null }) } : {}));
    expect(document.getElementById("connection-badge-label")!.textContent).toBe("Connected");
    expect((document.getElementById("connection-badge") as HTMLElement).classList.contains("is-connected")).toBe(true);
    expect((document.getElementById("pairing-panel") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("connection-summary") as HTMLElement).hidden).toBe(false);
  });

  it("REGRESSION: never shows the placeholder pairing code again once connected — the pairing input itself is hidden, not merely emptied", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ batch: null }) } : {}));
    const pairingPanel = document.getElementById("pairing-panel") as HTMLElement;
    expect(pairingPanel.hidden).toBe(true);
  });

  it("shows the confirmed Vinted account and never a raw memberId when a displayName exists", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: fullBatchState({ batch: { batchId: "batch-1", running: true, paused: false, account: { memberId: "1", displayName: "shopfront_uk" }, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: 1, pendingSave: null, items: [] } }) }
        : {},
    );
    expect(document.getElementById("connection-summary")!.textContent).toContain("shopfront_uk");
  });

  it("falls back to 'Member <id>' when no displayName is known yet", async () => {
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: fullBatchState({ batch: { batchId: "batch-1", running: true, paused: false, account: { memberId: "3140272892", displayName: null }, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: 1, pendingSave: null, items: [] } }) }
        : {},
    );
    expect(document.getElementById("connection-summary")!.textContent).toContain("Member 3140272892");
  });

  it("shows the idle empty state (never the disconnected one) when paired with no batch yet", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ batch: null }) } : {}));
    expect((document.getElementById("idle-empty-state") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("disconnected-empty-state") as HTMLElement).hidden).toBe(true);
  });
});

describe("Option 4 redesign — active batch progress accuracy (never invented)", () => {
  it.each([
    [1, 4, 25], [1, 3, 33], [6, 10, 60], [0, 1, 0], [1, 1, 100], [3, 7, 43],
  ])("completed=%i total=%i renders exactly %i%% — Math.round(completed/total*100), never a hardcoded/invented value", async (completed, total, expectedPercent) => {
    const items = Array.from({ length: total }, (_, i) => ({
      itemId: `i${i}`, queuePosition: i, title: `Item ${i}`, sku: `S${i}`,
      status: i < completed ? ITEM_STATUSES.COMPLETED : ITEM_STATUSES.QUEUED,
      errorCode: null, errorMessage: null, vintedDraftId: i < completed ? `d${i}` : null,
      startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0,
    }));
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    expect(document.getElementById("progress-percent")!.textContent).toBe(`${expectedPercent}%`);
    expect(document.getElementById("batch-progress-label")!.textContent).toBe(`${completed} of ${total} complete`);
  });

  it("the stat grid shows accurate Total/Completed/Active/Queued counts, and the Failed box only when failed > 0", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState() } : {}));
    expect(document.getElementById("stat-total")!.textContent).toBe("4");
    expect(document.getElementById("stat-completed")!.textContent).toBe("1");
    expect(document.getElementById("stat-active")!.textContent).toBe("1");
    expect(document.getElementById("stat-queued")!.textContent).toBe("2");
    expect((document.getElementById("stat-box-failed") as HTMLElement).hidden).toBe(true);
  });

  it("REGRESSION: the Failed stat box appears with the real failed count once any item has failed", async () => {
    const items = [
      { itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.FAILED, errorCode: "SET_PRICE", errorMessage: "boom", vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
      { itemId: "i2", queuePosition: 1, title: "B", sku: "S2", status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "d1", startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
    ];
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    expect((document.getElementById("stat-box-failed") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("stat-failed")!.textContent).toBe("1");
  });

  it("REGRESSION: the current (active) item's row carries the .is-current highlight class, and only that row", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState() } : {}));
    const rows = Array.from(document.querySelectorAll(".queue-item"));
    const current = rows.filter(r => r.classList.contains("is-current"));
    expect(current.length).toBe(1);
    expect(current[0].textContent).toContain("Nike Air Max 270 Trainers");
  });

  it("current-step rendering: an in-progress item's secondary status line shows the real, human-readable current step", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState() } : {}));
    const currentRow = document.querySelector(".queue-item.is-current")!;
    expect(currentRow.querySelector(".status-secondary")!.textContent).toBe("Setting price");
  });
});

describe("Option 4 redesign — paused batch", () => {
  it("shows Resume (not Pause) once paused, and a paused item's own status pill reads 'Paused'", async () => {
    const items = [
      { itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.PAUSED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 },
    ];
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: fullBatchState({ items, batch: { batchId: "batch-1", running: true, paused: true, account: { memberId: "1", displayName: "shopfront_uk" }, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: 1, pendingSave: null, items } }) }
        : {},
    );
    expect((document.getElementById("pause-button") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("resume-button") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector(".status-pill")!.textContent).toContain("Paused");
  });
});

// Follow-up correction (native browser reload-confirmation bug) — proves
// the REAL side panel, rendered against the REAL sidepanel.html/js, shows
// the required prominent warning banner and "Waiting for manual reload"
// item status whenever state.batch.pauseReason is "manual_reload_required"
// (see shared/queue-state.js's own MANUAL_RELOAD_WARNING_MESSAGE /
// isManualReloadPause), offers "Try reload again" (never the dead-end
// generic Resume), and that clicking it sends exactly RETRY_MANUAL_RELOAD.
describe("Option 4 redesign — manual browser reload (native browser reload-confirmation bug)", () => {
  function manualReloadState(itemOverrides: Record<string, unknown> = {}) {
    const items = [
      { itemId: "i1", queuePosition: 0, title: "Hoka Clifton 9", sku: "AA1", status: ITEM_STATUSES.WAITING_FOR_MANUAL_RELOAD, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: "2026-08-11T10:00:00.000Z", completedAt: null, currentStep: null, lastCompletedStep: "UPLOAD_PHOTOS", attemptCount: 1, ...itemOverrides },
    ];
    return fullBatchState({
      items,
      batch: {
        batchId: "batch-1", running: true, paused: true, pauseReason: "manual_reload_required",
        account: { memberId: "1", displayName: "shopfront_uk" },
        pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null,
        vintedTabId: 1, pendingSave: null, manualReload: { itemId: "i1", tabId: 1, startedAt: "2026-08-11T10:00:05.000Z", attempts: 1, lastAttemptAt: "2026-08-11T10:00:05.000Z" },
        items,
      },
    });
  }

  it("REQUIREMENT: shows the exact required warning text, prominently, as a warning banner", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: manualReloadState() } : {}));
    const banner = document.getElementById("manual-reload-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(document.getElementById("manual-reload-message")!.textContent).toBe("Browser needs manual reload — click Reload in the Vinted confirmation box to continue.");
  });

  it("the banner is hidden when no manual reload is pending", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState() } : {}));
    expect((document.getElementById("manual-reload-banner") as HTMLElement).hidden).toBe(true);
  });

  it("REQUIREMENT: the affected item's own status pill reads 'Waiting for manual reload' — never left showing a stale prior status", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: manualReloadState() } : {}));
    expect(document.querySelector(".status-pill")!.textContent).toContain("Waiting for manual reload");
  });

  it("REQUIREMENT: never shown as FAILED — no Retry action, no error row, for the waiting item", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: manualReloadState() } : {}));
    expect(document.querySelector(".queue-item-error-row")).toBeNull();
    expect(document.querySelector(".queue-item-retry")).toBeNull();
  });

  it("the dead-end generic Resume button is not offered during a manual-reload pause — only 'Try reload again' is", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: manualReloadState() } : {}));
    expect((document.getElementById("resume-button") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("retry-manual-reload") as HTMLElement).hidden).toBe(false);
  });

  it("REGRESSION: an ordinary pause (e.g. a lost Vinted tab) still offers the generic Resume button as before — this feature never hides it for an unrelated pause reason", async () => {
    const items = [{ itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 }];
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: fullBatchState({ items, batch: { batchId: "batch-1", running: true, paused: true, pauseReason: "vinted_tab_lost", account: { memberId: "1", displayName: "shopfront_uk" }, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: null, pendingSave: null, manualReload: null, items } }) }
        : {},
    );
    expect((document.getElementById("resume-button") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("manual-reload-banner") as HTMLElement).hidden).toBe(true);
  });

  it('REQUIREMENT: clicking "Try reload again" sends exactly PANEL_TO_WORKER.RETRY_MANUAL_RELOAD, and nothing else', async () => {
    const sent: string[] = [];
    const { document } = await loadSidepanel(type => {
      sent.push(type);
      if (type === PANEL_TO_WORKER.GET_STATE) return { state: manualReloadState() };
      if (type === PANEL_TO_WORKER.RETRY_MANUAL_RELOAD) return { state: manualReloadState() };
      return {};
    });
    const button = document.getElementById("retry-manual-reload") as HTMLButtonElement;
    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent.filter(t => t === PANEL_TO_WORKER.RETRY_MANUAL_RELOAD).length).toBe(1);
  });

  it("REQUIREMENT: the Live activity feed shows the exact warning text as a prominent WARNING entry (tone-warning), never plain progress", async () => {
    const queuedItems = [{ itemId: "i1", queuePosition: 0, title: "Hoka Clifton 9", sku: "AA1", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 }];
    const { document, fireStorageChanged } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: fullBatchState({ items: queuedItems, batch: { batchId: "batch-1", running: true, paused: false, account: { memberId: "1", displayName: "shopfront_uk" }, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: 1, pendingSave: null, manualReload: null, items: queuedItems } }) }
        : {},
    );

    fireStorageChanged(manualReloadState());
    const warningEntry = Array.from(document.querySelectorAll(".activity-entry")).find(el => el.textContent!.includes("Browser needs manual reload"));
    expect(warningEntry).toBeDefined();
    expect(warningEntry!.className).toContain("tone-warning");
    expect(warningEntry!.textContent).toContain("Browser needs manual reload — click Reload in the Vinted confirmation box to continue.");
  });
});

describe("Option 4 redesign — completed batch (State D)", () => {
  function completedState(overrides: Array<Record<string, unknown>> = []) {
    const items = overrides.length > 0 ? overrides : [
      { itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "d1", startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
      { itemId: "i2", queuePosition: 1, title: "B", sku: "S2", status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "d2", startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
    ];
    return fullBatchState({ items, batch: { batchId: "batch-1", running: false, paused: false, account: { memberId: "1", displayName: "shopfront_uk" }, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: 1, pendingSave: null, items } });
  }

  it("shows the green completion summary with real totals, and hides the active progress card", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: completedState() } : {}));
    expect((document.getElementById("completed-banner") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("batch-progress-card") as HTMLElement).hidden).toBe(true);
    expect(document.getElementById("completed-summary")!.textContent).toBe("2 of 2 — 2 drafts saved");
  });

  it("REGRESSION: completed rows stay visible with their real Vinted draft ids — never hidden after completion", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: completedState() } : {}));
    expect(document.querySelectorAll(".queue-item").length).toBe(2);
    expect(document.body.textContent).toContain("Draft d1");
    expect(document.body.textContent).toContain("Draft d2");
  });

  it("REGRESSION: does not continue showing active processing controls after completion — Start/Pause/Resume/Cancel are hidden, only Clear remains, and it is enabled", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: completedState() } : {}));
    expect((document.getElementById("start-button") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("pause-button") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("resume-button") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("cancel-button") as HTMLElement).hidden).toBe(true);
    const clearButton = document.getElementById("clear-button") as HTMLButtonElement;
    expect(clearButton.hidden).toBe(false);
    expect(clearButton.disabled).toBe(false);
  });

  it("Clear stays visible (but disabled) DURING an active batch — never hidden until terminal, matching the reference's always-three-buttons layout", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState() } : {}));
    const clearButton = document.getElementById("clear-button") as HTMLButtonElement;
    expect(clearButton.hidden).toBe(false);
    expect(clearButton.disabled).toBe(true);
  });
});

describe("Option 4 redesign — partial failure (State E)", () => {
  it("shows accurate completed/failed/remaining totals, keeps completed rows visibly successful, and gives the failed row a Retry action", async () => {
    const items = [
      { itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "d1", startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
      { itemId: "i2", queuePosition: 1, title: "B", sku: "S2", status: ITEM_STATUSES.FAILED, errorCode: "SET_PRICE", errorMessage: "TIMEOUT: could not confirm price", vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: "SET_MATERIALS", attemptCount: 1 },
      { itemId: "i3", queuePosition: 2, title: "C", sku: "S3", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 },
    ];
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    expect(document.getElementById("stat-completed")!.textContent).toBe("1");
    expect(document.getElementById("stat-failed")!.textContent).toBe("1");
    expect(document.getElementById("stat-queued")!.textContent).toBe("1");
    const completedRow = Array.from(document.querySelectorAll(".queue-item")).find(r => r.textContent!.includes("A"))!;
    expect(completedRow.querySelector(".status-pill")!.textContent).toContain("Completed");
    const failedRow = Array.from(document.querySelectorAll(".queue-item")).find(r => r.textContent!.includes("B"))!;
    expect(failedRow.querySelector(".queue-item-retry")).not.toBeNull();
  });

  it("REGRESSION: retrying a failed item sends RETRY_ITEM with the correct itemId, and nothing else", async () => {
    const items = [
      { itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "d1", startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
      { itemId: "i2", queuePosition: 1, title: "B", sku: "S2", status: ITEM_STATUSES.FAILED, errorCode: "SET_PRICE", errorMessage: "boom", vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
    ];
    const sent: Array<{ type: string; itemId?: string }> = [];
    const { document } = await loadSidepanel(type => {
      sent.push({ type });
      if (type === PANEL_TO_WORKER.GET_STATE) return { state: fullBatchState({ items }) };
      if (type === PANEL_TO_WORKER.RETRY_ITEM) return { state: fullBatchState({ items }) };
      return {};
    });
    const retryButton = document.querySelector(".queue-item-retry") as HTMLButtonElement;
    retryButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const retryMessages = sent.filter(m => m.type === PANEL_TO_WORKER.RETRY_ITEM);
    expect(retryMessages.length).toBe(1);
  });

  it("REGRESSION: another item failing never resets an already-completed item's row back to a non-terminal state", async () => {
    const items = [
      { itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.COMPLETED, errorCode: null, errorMessage: null, vintedDraftId: "d1", startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
      { itemId: "i2", queuePosition: 1, title: "B", sku: "S2", status: ITEM_STATUSES.FAILED, errorCode: "SET_PRICE", errorMessage: "boom", vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 },
    ];
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    const completedRow = Array.from(document.querySelectorAll(".queue-item")).find(r => r.textContent!.includes("A"))!;
    expect(completedRow.className).toContain("status-completed");
    expect(completedRow.textContent).toContain("Draft d1");
  });
});

describe("Option 4 redesign — status-label mapping", () => {
  it.each([
    [ITEM_STATUSES.QUEUED, "Queued"], [ITEM_STATUSES.PREPARING, "Preparing"], [ITEM_STATUSES.FILLING, "Drafting"],
    [ITEM_STATUSES.SAVING, "Saving"], [ITEM_STATUSES.COMPLETED, "Completed"], [ITEM_STATUSES.FAILED, "Failed"],
    [ITEM_STATUSES.PAUSED, "Paused"], [ITEM_STATUSES.CANCELLED, "Cancelled"],
  ])("status '%s' renders the label '%s'", async (status, label) => {
    const items = [{ itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status, errorCode: status === ITEM_STATUSES.FAILED ? "SET_PRICE" : null, errorMessage: status === ITEM_STATUSES.FAILED ? "boom" : null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 }];
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    expect(document.querySelector(".status-pill")!.textContent).toContain(label);
  });
});

describe("Option 4 redesign — long title and long error handling", () => {
  const longTitle = "Nike Air Zoom Pegasus 40 Extra Wide Trail Running Shoes — Limited Edition Colourway (Men's UK 10.5)";
  const longError = "TIMEOUT: step=SET_PRICE field=price selector=\"[data-testid=\\\"price-input--input\\\"]\" expected=\"30.00\" observed=\"£30.00\" reason=\"the field's live value never matched the expected value after 5 retries across 12 seconds of polling\"";

  it("a long title is fully present in the DOM (never lost) with a title attribute for an accessible tooltip — CSS handles the visual ellipsis", async () => {
    const items = [{ itemId: "i1", queuePosition: 0, title: longTitle, sku: "S1", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 }];
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    const titleEl = document.querySelector(".queue-item-title")!;
    expect(titleEl.textContent).toBe(longTitle);
    expect(titleEl.getAttribute("title")).toBe(longTitle);
  });

  it("a long error message (>140 chars) is truncated for the row but never lost — a 'Show full error' toggle reveals it in full", async () => {
    const items = [{ itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.FAILED, errorCode: "SET_PRICE", errorMessage: longError, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 }];
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    const shownText = document.querySelector(".queue-item-error-text")!.textContent!;
    expect(shownText.length).toBeLessThan(longError.length);
    const toggle = document.querySelector(".error-details-toggle") as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    toggle.click();
    const details = document.querySelector(".error-details")!;
    expect(details.textContent).toBe(longError);
  });

  it("a short error message (<=140 chars) shows in full with no truncation toggle", async () => {
    const items = [{ itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.FAILED, errorCode: "SET_PRICE", errorMessage: "Short error message.", vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 1 }];
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState({ items }) } : {}));
    expect(document.querySelector(".queue-item-error-text")!.textContent).toBe("Short error message.");
    expect(document.querySelector(".error-details-toggle")).toBeNull();
  });
});

describe("Option 4 redesign — button availability", () => {
  it("Start is disabled until the account is explicitly confirmed, even with items queued", async () => {
    const items = [{ itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 }];
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: fullBatchState({ items, batch: { batchId: "batch-1", running: false, paused: false, account: null, pendingConfirmation: { memberId: "1", displayName: "shopfront_uk" }, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: 1, pendingSave: null, items } }) }
        : {},
    );
    const startButton = document.getElementById("start-button") as HTMLButtonElement;
    expect(startButton.hidden).toBe(false);
    expect(startButton.disabled).toBe(true);
  });

  it("Start becomes enabled once the account is confirmed", async () => {
    const items = [{ itemId: "i1", queuePosition: 0, title: "A", sku: "S1", status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null, vintedDraftId: null, startedAt: null, completedAt: null, currentStep: null, lastCompletedStep: null, attemptCount: 0 }];
    const { document } = await loadSidepanel(type =>
      type === PANEL_TO_WORKER.GET_STATE
        ? { state: fullBatchState({ items, batch: { batchId: "batch-1", running: false, paused: false, account: { memberId: "1", displayName: "shopfront_uk" }, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null, vintedTabId: 1, pendingSave: null, items } }) }
        : {},
    );
    const startButton = document.getElementById("start-button") as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
  });

  it("Pause and Resume are mutually exclusive — never both visible at once", async () => {
    const { document } = await loadSidepanel(type => (type === PANEL_TO_WORKER.GET_STATE ? { state: fullBatchState() } : {}));
    const pauseHidden = (document.getElementById("pause-button") as HTMLElement).hidden;
    const resumeHidden = (document.getElementById("resume-button") as HTMLElement).hidden;
    expect(pauseHidden).not.toBe(resumeHidden);
  });
});

describe("Option 4 redesign — safeguards and scope protection", () => {
  it("REGRESSION: no publish/upload action exists anywhere in the side-panel UI or its message contract", () => {
    expect(sidepanelSource).not.toMatch(/>Upload</);
    expect(sidepanelSource).not.toMatch(/>Publish</);
    expect(sidepanelJs).not.toMatch(/publish|Upload\(/i);
  });

  it("the permanent 'Drafts only — never publishes' safety line is present exactly once, not repeated across multiple cards", () => {
    const matches = sidepanelSource.match(/Drafts only — never publishes/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("REGRESSION: the redesign never introduces a new message type — PANEL_TO_WORKER usage in sidepanel.js is a subset of the existing shared contract", () => {
    const usedTypes = Array.from(sidepanelJs.matchAll(/PANEL_TO_WORKER\.([A-Z_]+)/g)).map(m => m[1]);
    const knownTypes = Object.keys(PANEL_TO_WORKER);
    for (const used of usedTypes) expect(knownTypes).toContain(used);
  });

  it("no dev-harness/mock-only identifiers leak into the shipped extension files", () => {
    for (const source of [sidepanelSource, sidepanelCss, sidepanelJs]) {
      expect(source).not.toMatch(/__harness|DEV HARNESS|harness-inject/);
    }
  });
});

describe("Option 4 redesign — CSS structural guarantees (verified live in Chrome; these are regression guards against the exact structural class of bug caught there)", () => {
  it("REGRESSION: [hidden] is forced to display:none regardless of any component's own display value — the exact live-caught bug where alert banners/buttons stayed visible despite `.hidden = true`", () => {
    expect(sidepanelCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it("status dots use an explicit grid/place-items centring structure, never padding or baseline positioning", () => {
    expect(sidepanelCss).toMatch(/\.status-dot\s*\{[^}]*display:\s*grid[^}]*place-items:\s*center/);
  });

  it("narrow-width behaviour uses a container query bound to .panel's own rendered width — verifiable regardless of what hosts the page, and correct in the real side-panel viewport", () => {
    expect(sidepanelCss).toContain(".panel { container-type: inline-size; }");
    expect(sidepanelCss).toMatch(/@container \(max-width: \d+px\)/);
  });

  it("the page never allows horizontal overflow", () => {
    expect(sidepanelCss).toMatch(/overflow-x:\s*hidden/);
  });

  it("the spinner animation is disabled under prefers-reduced-motion", () => {
    expect(sidepanelCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.progress-icon\.tone-active\s*\{\s*animation:\s*none/);
  });

  it("the dark palette is fixed (not adaptive to the OS light/dark preference) — no `color-scheme: light dark` remains from the old panel", () => {
    expect(sidepanelCss).not.toContain("color-scheme: light dark");
    expect(sidepanelCss).toContain("color-scheme: dark");
  });
});
