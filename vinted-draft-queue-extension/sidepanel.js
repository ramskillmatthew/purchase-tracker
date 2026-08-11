// Vinted Draft Queue extension — side panel. Talks ONLY to the service
// worker via chrome.runtime.sendMessage (never directly to the content
// script, never directly to the app) — see service-worker.js's own top
// comment. Re-renders from chrome.storage.local on every change via
// chrome.storage.onChanged, so closing and reopening the panel (or Chrome
// restarting it) always shows the real, current, persisted state — this
// file holds no state of its own beyond what's on screen right now, plus
// one small SESSION-ONLY presentation projection (the Live Activity feed
// — see renderActivityLog's own comment): purely derived by diffing
// successive renders, never authoritative, never persisted, and never
// read by any other part of the extension. No queue-state.js transition,
// no message contract, and no Vinted automation logic changed for this
// visual redesign.

import { PANEL_TO_WORKER } from "./shared/messages.js";
import {
  computeProgressSummary, ITEM_STATUSES, isVintedTabLostPause, VINTED_TAB_LOST_MESSAGE,
  SAVE_DRAFT_UNCONFIRMED_ERROR_CODE,
} from "./shared/queue-state.js";

const IN_FLIGHT_STATUSES = new Set([ITEM_STATUSES.PREPARING, ITEM_STATUSES.FILLING, ITEM_STATUSES.SAVING]);
const TERMINAL_ITEM_STATUSES = new Set([ITEM_STATUSES.COMPLETED, ITEM_STATUSES.FAILED, ITEM_STATUSES.CANCELLED]);

const els = {
  brandMark: document.getElementById("brand-mark"),
  connectionBadge: document.getElementById("connection-badge"),
  connectionBadgeLabel: document.getElementById("connection-badge-label"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsPanel: document.getElementById("settings-panel"),

  appUrlDisplay: document.getElementById("app-url-display"),
  appUrlInput: document.getElementById("app-base-url"),
  appUrlSaved: document.getElementById("app-url-saved"),
  appUrlEdit: document.getElementById("app-url-edit"),
  appUrlSave: document.getElementById("app-url-save"),

  pairingPanel: document.getElementById("pairing-panel"),
  pairingCode: document.getElementById("pairing-code"),
  claimButton: document.getElementById("claim-button"),
  pairingError: document.getElementById("pairing-error"),
  connectionSummary: document.getElementById("connection-summary"),

  accountPendingCard: document.getElementById("account-pending-card"),
  accountName: document.getElementById("account-name"),
  confirmAccount: document.getElementById("confirm-account"),
  accountErrorBox: document.getElementById("account-error-box"),
  accountErrorMessage: document.getElementById("account-error-message"),
  retryAccountDetection: document.getElementById("retry-account-detection"),
  accountChangeBanner: document.getElementById("account-change-banner"),
  accountOld: document.getElementById("account-old"),
  accountNew: document.getElementById("account-new"),
  confirmAccountChange: document.getElementById("confirm-account-change"),
  vintedTabLostBanner: document.getElementById("vinted-tab-lost-banner"),
  vintedTabLostMessage: document.getElementById("vinted-tab-lost-message"),

  disconnectedEmptyState: document.getElementById("disconnected-empty-state"),
  idleEmptyState: document.getElementById("idle-empty-state"),

  batchSection: document.getElementById("batch-section"),
  batchProgressCard: document.getElementById("batch-progress-card"),
  batchProgressTitle: document.getElementById("batch-progress-title"),
  batchProgressLabel: document.getElementById("batch-progress-label"),
  progressBar: document.getElementById("progress-bar"),
  progressFill: document.getElementById("progress-fill"),
  progressPercent: document.getElementById("progress-percent"),
  statGrid: document.getElementById("stat-grid"),
  statTotal: document.getElementById("stat-total"),
  statCompleted: document.getElementById("stat-completed"),
  statActive: document.getElementById("stat-active"),
  statQueued: document.getElementById("stat-queued"),
  statBoxFailed: document.getElementById("stat-box-failed"),
  statFailed: document.getElementById("stat-failed"),
  queueList: document.getElementById("queue-list"),
  activityLog: document.getElementById("activity-log"),
  autoScrollToggle: document.getElementById("auto-scroll-toggle"),

  completedBanner: document.getElementById("completed-banner"),
  completedSummary: document.getElementById("completed-summary"),

  actionBar: document.getElementById("action-bar"),
  startButton: document.getElementById("start-button"),
  pauseButton: document.getElementById("pause-button"),
  resumeButton: document.getElementById("resume-button"),
  cancelButton: document.getElementById("cancel-button"),
  clearButton: document.getElementById("clear-button"),
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

const STATUS_LABELS = {
  [ITEM_STATUSES.QUEUED]: "Queued",
  [ITEM_STATUSES.PREPARING]: "Preparing",
  [ITEM_STATUSES.FILLING]: "Drafting",
  [ITEM_STATUSES.SAVING]: "Saving",
  [ITEM_STATUSES.COMPLETED]: "Completed",
  [ITEM_STATUSES.FAILED]: "Failed",
  [ITEM_STATUSES.PAUSED]: "Paused",
  [ITEM_STATUSES.CANCELLED]: "Cancelled",
};

// Follow-up correction (live-investigation diagnostics gap) — human-
// readable labels for the step names persisted on every item (see
// shared/form-steps.js's runItem and shared/queue-state.js's
// QUEUE_CONTROLLED_FIELDS). A step this map doesn't know about (a non-step
// errorCode like LOGIN_REQUIRED, or a future step) falls back to the raw
// code as-is — never hidden, just unformatted.
const STEP_LABELS = {
  OPEN_FORM: "Opening form", UPLOAD_PHOTOS: "Uploading photos", SET_TITLE: "Entering title", SET_DESCRIPTION: "Entering description",
  SET_CATEGORY: "Entering category", SET_BRAND: "Entering brand", SET_SIZE: "Selecting size", SET_CONDITION: "Entering condition",
  SET_COLOURS: "Entering colours", SET_MATERIALS: "Entering material", SET_PRICE: "Setting price", SAVE_DRAFT: "Saving draft",
};
function stepLabel(step) { return step ? (STEP_LABELS[step] ?? step) : null; }
// A shorter, non-gerund form for "Failed step: X" / stat lines, matching the original panel's wording.
const STEP_LABELS_SHORT = {
  OPEN_FORM: "Open form", UPLOAD_PHOTOS: "Photos", SET_TITLE: "Title", SET_DESCRIPTION: "Description",
  SET_CATEGORY: "Category", SET_BRAND: "Brand", SET_SIZE: "Size", SET_CONDITION: "Condition",
  SET_COLOURS: "Colours", SET_MATERIALS: "Material", SET_PRICE: "Price", SAVE_DRAFT: "Save draft",
};
function stepLabelShort(step) { return step ? (STEP_LABELS_SHORT[step] ?? step) : null; }

function formatTime(isoTimestamp) {
  try { return new Date(isoTimestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }); }
  catch { return ""; }
}

// ---------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------
function renderHeader(state) {
  const connected = Boolean(state.pairing);
  els.brandMark.classList.toggle("is-connected", connected);
  els.connectionBadge.classList.toggle("is-connected", connected);
  els.connectionBadgeLabel.textContent = connected ? "Connected" : "Not connected";
}

// ---------------------------------------------------------------------
// App-connection settings (App URL) — collapsed behind the gear once
// connected, open by default while disconnected (the default can still be
// overridden by the user clicking the gear either way).
// ---------------------------------------------------------------------
let settingsOpenOverride = null; // null = use the connection-based default; boolean = explicit user choice
let appUrlEditing = false;

function renderSettingsPanel(state, settings) {
  const connected = Boolean(state.pairing);
  const open = settingsOpenOverride === null ? !connected : settingsOpenOverride;
  els.settingsPanel.hidden = !open;
  els.settingsToggle.setAttribute("aria-expanded", String(open));

  const appBaseUrl = settings?.appBaseUrl ?? "";
  els.appUrlInput.hidden = !appUrlEditing;
  els.appUrlSave.hidden = !appUrlEditing;
  els.appUrlDisplay.hidden = appUrlEditing;
  els.appUrlSaved.hidden = appUrlEditing || !appBaseUrl;
  els.appUrlEdit.hidden = appUrlEditing;
  if (!appUrlEditing) {
    els.appUrlDisplay.textContent = appBaseUrl || "Not set";
    els.appUrlDisplay.title = appBaseUrl || "Not set";
  }
}

els.settingsToggle.addEventListener("click", () => {
  const currentlyOpen = !els.settingsPanel.hidden;
  settingsOpenOverride = !currentlyOpen;
  renderSettingsPanel(lastState, lastSettings);
});

els.appUrlEdit.addEventListener("click", async () => {
  appUrlEditing = true;
  const { settings } = await chrome.storage.local.get("settings");
  els.appUrlInput.value = settings?.appBaseUrl ?? "";
  renderSettingsPanel(lastState, settings);
  els.appUrlInput.focus();
});

els.appUrlSave.addEventListener("click", async () => {
  const appBaseUrl = els.appUrlInput.value.trim().replace(/\/$/, "");
  const { settings } = await chrome.storage.local.get("settings");
  const nextSettings = { ...settings, appBaseUrl };
  await chrome.storage.local.set({ settings: nextSettings });
  appUrlEditing = false;
  lastSettings = nextSettings;
  renderSettingsPanel(lastState, nextSettings);
});

// ---------------------------------------------------------------------
// Pairing / connection summary
// ---------------------------------------------------------------------
function renderPairingAndConnection(state) {
  const connected = Boolean(state.pairing);
  els.pairingPanel.hidden = connected;
  els.connectionSummary.hidden = !connected;
  els.pairingError.hidden = true;

  if (!connected) return;
  const account = state.batch?.account;
  const expiresAt = state.pairing.expiresAt ? new Date(state.pairing.expiresAt) : null;
  els.connectionSummary.innerHTML = "";
  const appConnectedSpan = document.createElement("span");
  appConnectedSpan.textContent = "App connected";
  els.connectionSummary.append(appConnectedSpan);
  if (account) {
    els.connectionSummary.append(document.createTextNode(" · "));
    const memberStrong = document.createElement("strong");
    memberStrong.textContent = account.displayName || `Member ${account.memberId}`;
    els.connectionSummary.append(memberStrong);
  }
  if (expiresAt && !state.batch) {
    els.connectionSummary.append(document.createTextNode(` · batch expires ${expiresAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`));
  }
}

// ---------------------------------------------------------------------
// Account confirmation gate / banners
// ---------------------------------------------------------------------
function renderAccountSection(state) {
  if (!state.batch) {
    els.accountPendingCard.hidden = true;
    els.accountErrorBox.hidden = true;
    els.accountChangeBanner.hidden = true;
    els.vintedTabLostBanner.hidden = true;
    return;
  }
  const { account: confirmed, pendingConfirmation: pending, accountIdentificationError: detectionError } = state.batch;

  els.accountPendingCard.hidden = !pending || Boolean(confirmed);
  if (pending) els.accountName.textContent = pending.displayName || `Member ${pending.memberId}`;

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
}

// ---------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------
function renderEmptyStates(state) {
  const connected = Boolean(state.pairing);
  els.disconnectedEmptyState.hidden = connected;
  els.idleEmptyState.hidden = !connected || Boolean(state.batch);
}

// ---------------------------------------------------------------------
// Batch progress + stat grid
// ---------------------------------------------------------------------
function renderBatchProgress(state, summary) {
  const allTerminal = summary.total > 0 && summary.remaining === 0 && !summary.currentItem;
  const percent = summary.total > 0 ? Math.round((summary.completed / summary.total) * 100) : 0;

  els.batchProgressLabel.textContent = `${summary.completed} of ${summary.total} complete`;
  els.progressFill.style.width = `${percent}%`;
  els.progressBar.setAttribute("aria-valuenow", String(percent));
  els.progressBar.setAttribute("aria-valuetext", `${percent}% complete, ${summary.completed} of ${summary.total}`);
  els.progressPercent.textContent = `${percent}%`;

  els.statTotal.textContent = String(summary.total);
  els.statCompleted.textContent = String(summary.completed);
  const active = summary.currentItem ? 1 : 0;
  els.statActive.textContent = String(active);
  els.statQueued.textContent = String(Math.max(0, summary.remaining - active));
  els.statBoxFailed.hidden = summary.failed === 0;
  els.statFailed.textContent = String(summary.failed);

  // Once every item is terminal, the completed banner replaces the active
  // progress card, but the queue rows (with real draft ids) and the
  // activity log stay visible below it — never hidden after completion.
  els.batchProgressCard.hidden = allTerminal;
  els.completedBanner.hidden = !allTerminal;
  if (allTerminal) {
    const parts = [];
    if (summary.completed > 0) parts.push(`${summary.completed} draft${summary.completed === 1 ? "" : "s"} saved`);
    if (summary.failed > 0) parts.push(`${summary.failed} failed`);
    if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
    els.completedSummary.textContent = `${summary.total} of ${summary.total} — ${parts.join(", ") || "nothing saved"}`;
  }
}

// ---------------------------------------------------------------------
// Queue rows
// ---------------------------------------------------------------------
function progressIconFor(status) {
  if (status === ITEM_STATUSES.COMPLETED) {
    return { tone: "success", svg: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 8.2 7.1 10l3.6-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' };
  }
  if (IN_FLIGHT_STATUSES.has(status)) return { tone: "active", svg: "" };
  if (status === ITEM_STATUSES.FAILED) {
    return { tone: "danger", svg: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.4"/><path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' };
  }
  if (status === ITEM_STATUSES.PAUSED) {
    return { tone: "warning", svg: '<svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="4.5" width="1.8" height="7" rx="0.6" fill="currentColor"/><rect x="8.7" y="4.5" width="1.8" height="7" rx="0.6" fill="currentColor"/></svg>' };
  }
  return { tone: "neutral", svg: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.7V8l2.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' };
}

function buildQueueRow(item, isCurrent) {
  const li = document.createElement("li");
  li.className = `queue-item status-${item.status}${isCurrent ? " is-current" : ""}`;

  const indexEl = document.createElement("span");
  indexEl.className = "queue-item-index";
  indexEl.textContent = String(item.queuePosition + 1);

  const main = document.createElement("div");
  main.className = "queue-item-main";
  const title = document.createElement("div");
  title.className = "queue-item-title";
  title.textContent = item.title || "(untitled)";
  title.title = item.title || "(untitled)";
  const sku = document.createElement("div");
  sku.className = "queue-item-sku";
  sku.textContent = item.sku ? `SKU ${item.sku}` : " ";
  main.append(title, sku);

  const statusCol = document.createElement("div");
  statusCol.className = "status-col";
  const pill = document.createElement("span");
  pill.className = `status-pill status-${item.status}`;
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = STATUS_LABELS[item.status] ?? item.status;
  pill.append(dot, label);
  statusCol.append(pill);

  let secondaryText = null;
  if (item.status === ITEM_STATUSES.COMPLETED && item.vintedDraftId) secondaryText = `Draft ${item.vintedDraftId}`;
  else if (IN_FLIGHT_STATUSES.has(item.status) && item.currentStep) secondaryText = stepLabel(item.currentStep);
  if (secondaryText) {
    const secondary = document.createElement("div");
    secondary.className = "status-secondary";
    secondary.textContent = secondaryText;
    secondary.title = secondaryText;
    statusCol.append(secondary);
  }

  const progressCol = document.createElement("div");
  progressCol.className = "progress-col";
  const { tone, svg } = progressIconFor(item.status);
  const progressIcon = document.createElement("span");
  progressIcon.className = `progress-icon tone-${tone}`;
  progressIcon.setAttribute("aria-hidden", "true");
  progressIcon.innerHTML = svg;
  progressCol.append(progressIcon);

  li.append(indexEl, main, statusCol, progressCol);

  // Failure detail row — spans the full row width, never breaks the grid.
  if (item.status === ITEM_STATUSES.FAILED) {
    const errorRow = document.createElement("div");
    errorRow.className = "queue-item-error-row";
    errorRow.id = `queue-item-${item.itemId}-error`;

    const errorCopy = document.createElement("div");
    if (item.errorCode) {
      const stepP = document.createElement("p");
      stepP.className = "queue-item-error-step";
      stepP.textContent = `Failed step: ${stepLabelShort(item.errorCode)}`;
      errorCopy.append(stepP);
    }
    // How far the item got before failing — always visible from persisted
    // state, live or after the fact, never only inferable from extension logs.
    if (item.lastCompletedStep) {
      const lastCompletedP = document.createElement("p");
      lastCompletedP.className = "queue-item-error-step queue-item-last-completed";
      lastCompletedP.textContent = `Last completed: ${stepLabelShort(item.lastCompletedStep)}`;
      errorCopy.append(lastCompletedP);
    }
    const messageP = document.createElement("p");
    messageP.className = "queue-item-error-text";
    // Keep the row itself readable — the full technical message, if long, is
    // still fully shown but wraps rather than ever overflowing the card.
    const shortMessage = (item.errorMessage || "Unknown error");
    messageP.textContent = shortMessage.length > 140 ? `${shortMessage.slice(0, 140)}…` : shortMessage;
    errorCopy.append(messageP);
    if (item.errorMessage && item.errorMessage.length > 140) {
      const detailsToggle = document.createElement("button");
      detailsToggle.type = "button";
      detailsToggle.className = "error-details-toggle";
      detailsToggle.textContent = "Show full error";
      detailsToggle.setAttribute("aria-expanded", "false");
      const detailsBox = document.createElement("pre");
      detailsBox.className = "error-details";
      detailsBox.textContent = item.errorMessage;
      detailsBox.hidden = true;
      detailsToggle.addEventListener("click", () => {
        detailsBox.hidden = !detailsBox.hidden;
        detailsToggle.setAttribute("aria-expanded", String(!detailsBox.hidden));
        detailsToggle.textContent = detailsBox.hidden ? "Show full error" : "Hide full error";
      });
      errorCopy.append(detailsToggle, detailsBox);
    }
    errorCopy.setAttribute("aria-describedby", `queue-item-${item.itemId}-error`);
    errorRow.append(errorCopy);

    // Follow-up correction (durable Save Draft confirmation) — a
    // SAVE_DRAFT_UNCONFIRMED failure means Save Draft may already have been
    // clicked and the draft may already exist on Vinted: the ordinary Retry
    // action is never offered for it (applyRetryItem itself structurally
    // refuses this exact errorCode). "Check saved draft again" is the ONLY
    // recovery action offered instead — confirmation-only, never refills
    // the form, never clicks Save draft, never re-runs the item.
    if (item.errorCode === SAVE_DRAFT_UNCONFIRMED_ERROR_CODE) {
      const checkButton = document.createElement("button");
      checkButton.type = "button";
      checkButton.className = "retry-button queue-item-check-saved-draft";
      checkButton.textContent = "Check saved draft again";

      const statusMsg = document.createElement("p");
      statusMsg.className = "queue-item-check-status muted-text";
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
          if (result.found) return; // storage.onChanged re-renders as completed.
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
      errorRow.append(checkButton, statusMsg);
    } else {
      const retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "retry-button queue-item-retry";
      retryButton.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8A5 5 0 1 1 11.3 4.3M13 8V4.5M13 8H9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Retry</span>';
      retryButton.addEventListener("click", () => send(PANEL_TO_WORKER.RETRY_ITEM, { itemId: item.itemId }).then(refresh));
      errorRow.append(retryButton);
    }
    li.append(errorRow);
  }

  return li;
}

function renderQueueList(state) {
  if (!state.batch) { els.queueList.innerHTML = ""; return; }
  const summary = computeProgressSummary(state);
  const currentItemId = summary.currentItem?.itemId ?? null;
  els.queueList.innerHTML = "";
  for (const item of state.batch.items) {
    els.queueList.append(buildQueueRow(item, item.itemId === currentItemId));
  }
}

// ---------------------------------------------------------------------
// Live activity — a SESSION-ONLY presentation projection, never persisted
// and never authoritative. Diffs the previous render's item snapshots
// against the current ones and appends one entry per genuinely OBSERVED
// transition, using only real, already-persisted data (queuePosition,
// title, currentStep, vintedDraftId, errorMessage, startedAt/completedAt)
// — never inventing a value (e.g. no fabricated price). Mirrors the same
// pattern already used for the app's own Listings Review Live Activity
// panel (ListingsReviewWorkspace.tsx). Resets whenever the batch id
// changes, so a page reload mid-batch never fabricates history it never
// actually observed — it just seeds one real "queued" event and starts
// diffing from there.
// ---------------------------------------------------------------------
let activityEvents = [];
let previousItemsById = null;
let previousBatchId = null;
let batchCompleteLogged = false;

function pushActivity(entry) {
  activityEvents = [entry, ...activityEvents].slice(0, 60);
}

function updateActivityLog(state) {
  const batch = state.batch;
  if (!batch) {
    activityEvents = []; previousItemsById = null; previousBatchId = null; batchCompleteLogged = false;
    return;
  }
  if (batch.batchId !== previousBatchId) {
    activityEvents = [{
      id: `${batch.batchId}:sent`, tone: "sent",
      message: `${batch.items.length} listing${batch.items.length === 1 ? "" : "s"} added to the queue`,
      timestampIso: new Date().toISOString(),
    }];
    previousItemsById = new Map(batch.items.map(item => [item.itemId, item]));
    previousBatchId = batch.batchId;
    batchCompleteLogged = false;
    return;
  }

  const prevMap = previousItemsById;
  for (const item of batch.items) {
    const prev = prevMap?.get(item.itemId);
    if (!prev) continue;
    const label = `Item ${item.queuePosition + 1}`;
    if (item.status !== prev.status) {
      if (item.status === ITEM_STATUSES.COMPLETED) {
        pushActivity({ id: `${item.itemId}:completed`, tone: "success", message: item.vintedDraftId ? `${label} completed — Draft ${item.vintedDraftId} saved` : `${label} completed`, timestampIso: item.completedAt ?? new Date().toISOString() });
      } else if (item.status === ITEM_STATUSES.FAILED) {
        pushActivity({ id: `${item.itemId}:failed-${item.attemptCount ?? 0}`, tone: "failure", message: `${label} — ${item.errorMessage || "draft failed"}`, timestampIso: item.completedAt ?? new Date().toISOString() });
      } else if (IN_FLIGHT_STATUSES.has(item.status) && !IN_FLIGHT_STATUSES.has(prev.status)) {
        pushActivity({ id: `${item.itemId}:started`, tone: "progress", message: `${label} — draft started`, timestampIso: item.startedAt ?? new Date().toISOString() });
      }
    } else if (IN_FLIGHT_STATUSES.has(item.status) && item.currentStep && item.currentStep !== prev.currentStep) {
      pushActivity({ id: `${item.itemId}:step-${item.currentStep}`, tone: "progress", message: `${label} — ${stepLabel(item.currentStep)}`, timestampIso: new Date().toISOString() });
    }
  }
  previousItemsById = new Map(batch.items.map(item => [item.itemId, item]));

  const summary = computeProgressSummary(state);
  const allTerminal = summary.total > 0 && summary.remaining === 0 && !summary.currentItem;
  if (allTerminal && !batchCompleteLogged) {
    batchCompleteLogged = true;
    pushActivity({ id: `${batch.batchId}:batch-complete`, tone: "success", message: `Batch completed — ${summary.completed} of ${summary.total} drafts saved`, timestampIso: new Date().toISOString() });
  }
}

function renderActivityLog() {
  els.activityLog.innerHTML = "";
  if (activityEvents.length === 0) {
    const empty = document.createElement("li");
    empty.className = "activity-empty";
    empty.textContent = "No activity yet.";
    els.activityLog.append(empty);
    return;
  }
  for (const entry of activityEvents) {
    const li = document.createElement("li");
    li.className = `activity-entry tone-${entry.tone}`;
    const time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = formatTime(entry.timestampIso);
    const dot = document.createElement("span");
    dot.className = "activity-dot";
    dot.setAttribute("aria-hidden", "true");
    const message = document.createElement("span");
    message.className = "activity-message";
    message.textContent = entry.message;
    li.append(time, dot, message);
    els.activityLog.append(li);
  }
  if (els.autoScrollToggle.checked) els.activityLog.scrollTop = 0;
}

// ---------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------
function renderActionBar(state, summary) {
  if (!state.batch) { els.actionBar.hidden = true; return; }
  const allTerminal = summary.total > 0 && summary.remaining === 0 && !summary.currentItem;
  els.actionBar.hidden = false;

  // "Do not continue showing active processing controls after
  // completion" — Start/Pause/Resume/Cancel are all genuinely HIDDEN
  // (never merely disabled) once every item is terminal.
  els.startButton.hidden = allTerminal || state.batch.running;
  // Mandatory initial account confirmation gate: Start batch is never
  // actionable until the account has been explicitly confirmed.
  els.startButton.disabled = summary.total === 0 || !state.batch.account;
  els.pauseButton.hidden = allTerminal || !state.batch.running || state.batch.paused;
  els.resumeButton.hidden = allTerminal || !state.batch.paused;
  els.cancelButton.hidden = allTerminal;
  // Clear stays visible throughout an active batch (matching the reference
  // — it is not only a post-completion action), just disabled until every
  // item is genuinely terminal, exactly like the original panel's own
  // `clearButton.disabled = !allTerminal` — never enabled early.
  els.clearButton.hidden = false;
  els.clearButton.disabled = !allTerminal;
}

// ---------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------
let lastState = { pairing: null, batch: null };
let lastSettings = null;

function render(state) {
  lastState = state;
  renderHeader(state);
  renderSettingsPanel(state, lastSettings);
  renderPairingAndConnection(state);
  renderAccountSection(state);
  renderEmptyStates(state);

  if (!state.batch) {
    els.batchSection.hidden = true;
    els.completedBanner.hidden = true;
    els.actionBar.hidden = true;
    updateActivityLog(state);
    return;
  }

  const summary = computeProgressSummary(state);
  els.batchSection.hidden = false;
  renderBatchProgress(state, summary);
  renderQueueList(state);
  updateActivityLog(state);
  renderActivityLog();
  renderActionBar(state, summary);
}

async function refresh() {
  const { state } = await send(PANEL_TO_WORKER.GET_STATE);
  render(state);
}

async function loadSettings() {
  const { settings } = await send(PANEL_TO_WORKER.GET_STATE);
  lastSettings = settings ?? {};
  renderSettingsPanel(lastState, lastSettings);
}

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
