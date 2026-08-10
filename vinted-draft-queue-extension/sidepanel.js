// Vinted Draft Queue extension — side panel. Talks ONLY to the service
// worker via chrome.runtime.sendMessage (never directly to the content
// script, never directly to the app) — see service-worker.js's own top
// comment. Re-renders from chrome.storage.local on every change via
// chrome.storage.onChanged, so closing and reopening the panel (or Chrome
// restarting it) always shows the real, current, persisted state — this
// file holds no state of its own beyond what's on screen right now.

import { PANEL_TO_WORKER } from "./shared/messages.js";
import {
  computeProgressSummary, ITEM_STATUSES, isVintedTabLostPause, VINTED_TAB_LOST_MESSAGE,
  SAVE_DRAFT_UNCONFIRMED_ERROR_CODE,
} from "./shared/queue-state.js";

const els = {
  appBaseUrl: document.getElementById("app-base-url"),
  saveSettings: document.getElementById("save-settings"),
  pairingStatus: document.getElementById("pairing-status"),
  pairingCode: document.getElementById("pairing-code"),
  claimButton: document.getElementById("claim-button"),
  pairingError: document.getElementById("pairing-error"),
  accountSection: document.getElementById("account"),
  accountPending: document.getElementById("account-pending"),
  accountName: document.getElementById("account-name"),
  confirmAccount: document.getElementById("confirm-account"),
  accountConfirmedBox: document.getElementById("account-confirmed-box"),
  accountConfirmedName: document.getElementById("account-confirmed-name"),
  accountErrorBox: document.getElementById("account-error-box"),
  accountErrorMessage: document.getElementById("account-error-message"),
  retryAccountDetection: document.getElementById("retry-account-detection"),
  accountChangeBanner: document.getElementById("account-change-banner"),
  accountOld: document.getElementById("account-old"),
  accountNew: document.getElementById("account-new"),
  confirmAccountChange: document.getElementById("confirm-account-change"),
  vintedTabLostBanner: document.getElementById("vinted-tab-lost-banner"),
  vintedTabLostMessage: document.getElementById("vinted-tab-lost-message"),
  batchSection: document.getElementById("batch"),
  batchId: document.getElementById("batch-id"),
  progressSummary: document.getElementById("progress-summary"),
  startButton: document.getElementById("start-button"),
  pauseButton: document.getElementById("pause-button"),
  resumeButton: document.getElementById("resume-button"),
  cancelButton: document.getElementById("cancel-button"),
  clearButton: document.getElementById("clear-button"),
  queueList: document.getElementById("queue-list"),
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

const STATUS_LABELS = {
  [ITEM_STATUSES.QUEUED]: "Queued",
  [ITEM_STATUSES.PREPARING]: "Preparing",
  [ITEM_STATUSES.FILLING]: "Filling form",
  [ITEM_STATUSES.SAVING]: "Saving draft",
  [ITEM_STATUSES.COMPLETED]: "Completed",
  [ITEM_STATUSES.FAILED]: "Failed",
  [ITEM_STATUSES.PAUSED]: "Paused",
  [ITEM_STATUSES.CANCELLED]: "Cancelled",
};

// Follow-up correction (live-investigation diagnostics gap) — human-
// readable labels for the step names now persisted on every item (see
// shared/form-steps.js's runItem and shared/queue-state.js's
// QUEUE_CONTROLLED_FIELDS). A step this map doesn't know about (a non-step
// errorCode like LOGIN_REQUIRED, or a future step) falls back to the raw
// code as-is — never hidden, just unformatted.
const STEP_LABELS = {
  OPEN_FORM: "Open form", UPLOAD_PHOTOS: "Photos", SET_TITLE: "Title", SET_DESCRIPTION: "Description",
  SET_CATEGORY: "Category", SET_BRAND: "Brand", SET_SIZE: "Size", SET_CONDITION: "Condition",
  SET_COLOURS: "Colours", SET_MATERIALS: "Material", SET_PRICE: "Price", SAVE_DRAFT: "Save draft",
};
function stepLabel(step) { return step ? (STEP_LABELS[step] ?? step) : null; }

function render(state) {
  els.pairingError.hidden = true;

  if (!state.pairing) {
    els.pairingStatus.textContent = "Not paired yet.";
    els.accountSection.hidden = true;
    els.batchSection.hidden = true;
    els.accountChangeBanner.hidden = true;
    els.vintedTabLostBanner.hidden = true;
    return;
  }
  els.pairingStatus.textContent = `Paired — batch ${state.pairing.batchId.slice(0, 8)}… expires ${new Date(state.pairing.expiresAt).toLocaleTimeString()}`;

  if (!state.batch) { els.batchSection.hidden = true; els.accountSection.hidden = true; return; }
  els.batchSection.hidden = false;
  els.batchId.textContent = state.batch.batchId;

  const { account: confirmed, pendingConfirmation: pending, accountIdentificationError: detectionError } = state.batch;

  // The account section is the mandatory confirmation gate — shown
  // whenever there's a batch at all, so the user always sees exactly one
  // of: "detected, please confirm", "confirmed", or "could not identify".
  els.accountSection.hidden = false;

  els.accountPending.hidden = !pending;
  if (pending) els.accountName.textContent = pending.displayName || `Member ${pending.memberId}`;

  els.accountConfirmedBox.hidden = !confirmed;
  if (confirmed) els.accountConfirmedName.textContent = confirmed.displayName || `Member ${confirmed.memberId}`;

  els.accountErrorBox.hidden = !detectionError;
  if (detectionError) els.accountErrorMessage.textContent = detectionError;

  if (state.batch.pendingAccountChange) {
    els.accountChangeBanner.hidden = false;
    const { previous, current } = state.batch.pendingAccountChange;
    els.accountOld.textContent = previous.displayName || `Member ${previous.memberId}`;
    els.accountNew.textContent = current.displayName || `Member ${current.memberId}`;
  } else {
    els.accountChangeBanner.hidden = true;
  }

  if (isVintedTabLostPause(state)) {
    els.vintedTabLostBanner.hidden = false;
    els.vintedTabLostMessage.textContent = VINTED_TAB_LOST_MESSAGE;
  } else {
    els.vintedTabLostBanner.hidden = true;
  }

  const summary = computeProgressSummary(state);
  const position = summary.completed + summary.failed + summary.cancelled + (summary.currentItem ? 1 : 0);
  els.progressSummary.textContent = `${Math.min(position, summary.total)} of ${summary.total} — ${summary.completed} completed, ${summary.failed} failed`;

  const allTerminal = summary.total > 0 && summary.remaining === 0 && !summary.currentItem;
  els.startButton.hidden = state.batch.running || allTerminal;
  // Mandatory initial account confirmation gate: Start batch is never
  // actionable until the account has been explicitly confirmed (a click
  // on "Confirm this account" — see the confirmAccount handler below).
  els.startButton.disabled = summary.total === 0 || !confirmed;
  els.pauseButton.hidden = !state.batch.running || state.batch.paused;
  els.resumeButton.hidden = !state.batch.paused;
  els.cancelButton.disabled = allTerminal;
  els.clearButton.disabled = !allTerminal;

  els.queueList.innerHTML = "";
  for (const item of state.batch.items) {
    const li = document.createElement("li");
    li.className = "queue-item";
    const main = document.createElement("div");
    main.className = "queue-item-main";
    const title = document.createElement("div");
    title.className = "queue-item-title";
    title.textContent = `${item.queuePosition + 1}. ${item.title || "(untitled)"}`;
    const sku = document.createElement("div");
    sku.className = "queue-item-sku";
    sku.textContent = item.sku ? `SKU ${item.sku}` : "";
    main.append(title, sku);
    // Follow-up correction (live-investigation diagnostics gap) — the exact
    // failed field/stage (errorCode already IS that — see queue-state.js's
    // own comment on why there's no separate "failedStep" field) and how
    // far the item got before failing (lastCompletedStep), never just the
    // generic errorMessage on its own.
    if (item.status === "failed" && item.errorCode) {
      const failedStepEl = document.createElement("div");
      failedStepEl.className = "queue-item-failed-step";
      failedStepEl.textContent = `Failed step: ${stepLabel(item.errorCode)}`;
      main.append(failedStepEl);
    }
    if (item.status === "failed" && item.errorMessage) {
      const errorEl = document.createElement("div");
      errorEl.className = "queue-item-error";
      errorEl.textContent = item.errorMessage;
      main.append(errorEl);
    }
    // Shown for BOTH a still-running item (currentStep set, status
    // filling/saving) and a failed one (lastCompletedStep alone, currentStep
    // already cleared — see applyItemFailed's own comment) — "how far did
    // it get" is always visible from persisted state, live or after the
    // fact, never only inferable from extension logs.
    if (item.currentStep || item.lastCompletedStep) {
      const progressEl = document.createElement("div");
      progressEl.className = "muted queue-item-step-progress";
      const parts = [];
      if (item.currentStep) parts.push(`Current step: ${stepLabel(item.currentStep)}`);
      if (item.lastCompletedStep) parts.push(`Last completed: ${stepLabel(item.lastCompletedStep)}`);
      progressEl.textContent = parts.join(" — ");
      main.append(progressEl);
    }
    if (item.vintedDraftId) {
      const draftEl = document.createElement("div");
      draftEl.className = "queue-item-sku";
      draftEl.textContent = `Vinted draft ${item.vintedDraftId}`;
      main.append(draftEl);
    }

    const right = document.createElement("div");
    const statusEl = document.createElement("span");
    statusEl.className = `queue-item-status status-${item.status}`;
    statusEl.textContent = STATUS_LABELS[item.status] ?? item.status;
    right.append(statusEl);

    // Follow-up correction (durable Save Draft confirmation) — a
    // SAVE_DRAFT_UNCONFIRMED failure means Save Draft may already have
    // been clicked and the draft may already exist on Vinted: the
    // ordinary Retry action is never offered for it (applyRetryItem
    // itself structurally refuses this exact errorCode — see
    // shared/queue-state.js's own comment — so showing Retry here would
    // just silently do nothing useful). "Check saved draft again" is the
    // ONLY recovery action offered instead — confirmation-only, never
    // refills the form, never clicks Save draft, never re-runs the item.
    if (item.status === "failed" && item.errorCode === SAVE_DRAFT_UNCONFIRMED_ERROR_CODE) {
      const checkButton = document.createElement("button");
      checkButton.className = "button-secondary queue-item-check-saved-draft";
      checkButton.type = "button";
      checkButton.textContent = "Check saved draft again";

      const statusMsg = document.createElement("div");
      statusMsg.className = "muted queue-item-check-status";
      statusMsg.hidden = true;

      checkButton.addEventListener("click", async () => {
        checkButton.disabled = true;
        checkButton.textContent = "Checking…";
        statusMsg.hidden = true;
        try {
          const result = await send(PANEL_TO_WORKER.CHECK_SAVED_DRAFT, { itemId: item.itemId });
          if (result.error) {
            statusMsg.textContent = result.error;
            statusMsg.hidden = false;
            checkButton.disabled = false;
            checkButton.textContent = "Check saved draft again";
            return;
          }
          if (result.found) {
            // The item is now COMPLETED in persisted state — the normal
            // chrome.storage.onChanged listener below will re-render this
            // whole list with the confirmed draft id shown, exactly like
            // any other completed item; nothing further to do here.
            return;
          }
          // Confirmed still not found — never treated as a hard failure;
          // the deadline (not this one check) is what eventually decides
          // that, and this button always remains available to try again.
          statusMsg.textContent = "Still not confirmed — Vinted may still be processing, or the draft genuinely wasn't saved. You can try again, or wait for automatic recovery.";
          statusMsg.hidden = false;
          checkButton.disabled = false;
          checkButton.textContent = "Check saved draft again";
        } catch (error) {
          statusMsg.textContent = `Could not check: ${error?.message || error}`;
          statusMsg.hidden = false;
          checkButton.disabled = false;
          checkButton.textContent = "Check saved draft again";
        }
      });

      right.append(document.createElement("br"), checkButton, statusMsg);
    } else if (item.status === "failed") {
      const retryButton = document.createElement("button");
      retryButton.className = "button-secondary queue-item-retry";
      retryButton.type = "button";
      retryButton.textContent = "Retry";
      retryButton.addEventListener("click", () => send(PANEL_TO_WORKER.RETRY_ITEM, { itemId: item.itemId }).then(refresh));
      right.append(document.createElement("br"), retryButton);
    }

    li.append(main, right);
    els.queueList.append(li);
  }
}

async function refresh() {
  const { state } = await send(PANEL_TO_WORKER.GET_STATE);
  render(state);
}

async function loadSettings() {
  const { settings } = await send(PANEL_TO_WORKER.GET_STATE);
  els.appBaseUrl.value = settings?.appBaseUrl ?? "";
}

els.saveSettings.addEventListener("click", async () => {
  const appBaseUrl = els.appBaseUrl.value.trim().replace(/\/$/, "");
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, appBaseUrl } });
});

els.claimButton.addEventListener("click", async () => {
  els.claimButton.disabled = true;
  try {
    const result = await send(PANEL_TO_WORKER.CLAIM_BATCH, { pairingCode: els.pairingCode.value });
    if (result.error) {
      els.pairingError.textContent = result.error;
      els.pairingError.hidden = false;
      return;
    }
    els.pairingCode.value = "";
    render(result.state);
  } finally {
    els.claimButton.disabled = false;
  }
});

els.startButton.addEventListener("click", () => send(PANEL_TO_WORKER.START_BATCH).then(r => { if (r.state) render(r.state); }));
els.pauseButton.addEventListener("click", () => send(PANEL_TO_WORKER.PAUSE_BATCH).then(r => render(r.state)));
els.resumeButton.addEventListener("click", () => send(PANEL_TO_WORKER.RESUME_BATCH).then(r => render(r.state)));
els.cancelButton.addEventListener("click", () => send(PANEL_TO_WORKER.CANCEL_REMAINING).then(r => render(r.state)));
els.clearButton.addEventListener("click", () => send(PANEL_TO_WORKER.CLEAR_BATCH).then(refresh));
els.confirmAccountChange.addEventListener("click", () => send(PANEL_TO_WORKER.CONFIRM_ACCOUNT_CHANGE).then(r => render(r.state)));
els.confirmAccount.addEventListener("click", () => send(PANEL_TO_WORKER.CONFIRM_ACCOUNT).then(r => render(r.state)));
els.retryAccountDetection.addEventListener("click", () => send(PANEL_TO_WORKER.RETRY_ACCOUNT_DETECTION).then(r => render(r.state)));

chrome.storage.onChanged.addListener(changes => {
  if (changes.state) render(changes.state.newValue ?? { pairing: null, batch: null });
});

loadSettings();
refresh();
