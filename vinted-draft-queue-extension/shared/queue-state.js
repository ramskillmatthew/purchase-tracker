// Vinted Draft Queue extension — the ONE place queue/batch state is
// computed. Every function here is PURE: given the same state (and, where
// relevant, an explicit `nowIso` timestamp instead of reading the clock
// itself), it always returns the same new state, with no chrome.* calls,
// no mutation of its input, and no hidden globals. This is deliberate and
// load-bearing: "Chrome may suspend the service worker, so never rely on
// global in-memory state" means the ACTUAL state must live in
// chrome.storage.local, and the only way to keep that reliable is for the
// code that computes the next state to never depend on anything BUT the
// state passed in. The service worker (service-worker.js) is the only
// place that reads/writes chrome.storage.local — this file has no idea
// storage even exists, which is what makes it directly unit-testable with
// plain fixtures.

export const ITEM_STATUSES = Object.freeze({
  QUEUED: "queued",
  PREPARING: "preparing",
  FILLING: "filling",
  SAVING: "saving",
  COMPLETED: "completed",
  FAILED: "failed",
  PAUSED: "paused",
  CANCELLED: "cancelled",
});

const TERMINAL_STATUSES = new Set([ITEM_STATUSES.COMPLETED, ITEM_STATUSES.FAILED, ITEM_STATUSES.CANCELLED]);
// "In flight" = the content script was actively working on this item —
// these are exactly the statuses resumeAfterRestart() below resets back to
// QUEUED, since neither the content script's nor the service worker's own
// in-memory progress for a mid-flight item survives a restart, only what
// was already persisted.
const IN_FLIGHT_STATUSES = new Set([ITEM_STATUSES.PREPARING, ITEM_STATUSES.FILLING, ITEM_STATUSES.SAVING]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function createInitialState() {
  return { pairing: null, batch: null };
}

export function applyClaim(state, { batchId, batchToken, expiresAt, claimedAt }) {
  return { ...state, pairing: { batchId, batchToken, expiresAt, claimedAt } };
}

// The ONLY fields this module ever controls once an item exists — every
// other property on a queue item is the complete, immutable
// ExtensionBatchItem payload from the app (itemId, draftId, queuePosition,
// title, sku, description, brand, model, productType, condition, ukSize,
// audience, colours, materials, pricePence, priceDisplay, vintedCategoryId,
// vintedCategoryPath, photos, coverPhotoPosition — see
// lib/listing-studio/extension-batch-schema.ts, the schema this mirrors
// field for field). Follow-up correction (payload-loss bug): a queue item
// used to store only a hand-picked subset of the payload (itemId, draftId,
// queuePosition, title, sku) — every other field the content script needs
// to fill the Vinted form was silently discarded at this exact boundary,
// so startItem() had nothing to restore later no matter how it merged
// values. The fix is to persist the ENTIRE validated payload item
// (`...item` below) and layer only these queue-controlled fields on top,
// never the reverse.
// Follow-up correction (live-investigation diagnostics gap) — currentStep
// (the field/stage step actively being attempted right now, e.g.
// "SET_PRICE") and lastCompletedStep (the most recent one that genuinely
// succeeded) let a failure be diagnosed from persisted state alone — no
// extension logs, no re-running the batch under a debugger. A FAILED
// item's own failedStep is deliberately NOT a separate field: errorCode
// already IS the exact failing step/stage name for every failure this
// extension ever reports (OPEN_FORM, UPLOAD_PHOTOS, every SET_* field,
// SAVE_DRAFT, or one of the non-step codes like LOGIN_REQUIRED that are
// already self-explanatory) — see runItem's own comment.
const QUEUE_CONTROLLED_FIELDS = [
  "status", "attemptCount", "errorCode", "errorMessage", "vintedDraftId",
  "startedAt", "completedAt", "lastProgressAt", "currentStep", "lastCompletedStep",
];

function pickQueueControlledFields(item) {
  const picked = {};
  for (const field of QUEUE_CONTROLLED_FIELDS) picked[field] = item[field];
  return picked;
}

/**
 * Populates batch.items from a freshly-fetched payload. If a batch for
 * this batchId already exists in state (e.g. a re-fetch after a service-
 * worker restart), each item's queue-controlled fields (status,
 * attemptCount, errors, timestamps) are PRESERVED, while every listing
 * field is refreshed from the new payload — so a re-fetch can never leave
 * stale listing data behind, and can never discard real progress either.
 * A genuinely new item (none, in practice, since the app never adds items
 * to an existing batch) starts fresh at "queued".
 */
export function applyBatchPayload(state, payload, nowIso) {
  const existingById = new Map((state.batch?.batchId === payload.batchId ? state.batch.items : []).map(item => [item.itemId, item]));
  const items = payload.items
    .slice()
    .sort((a, b) => a.queuePosition - b.queuePosition)
    .map(item => {
      const existing = existingById.get(item.itemId);
      return existing
        ? { ...item, ...pickQueueControlledFields(existing) }
        : {
            ...item,
            status: ITEM_STATUSES.QUEUED, attemptCount: 0,
            errorCode: null, errorMessage: null, vintedDraftId: null,
            startedAt: null, completedAt: null,
            // Bumped on every status transition once in flight (see
            // applyItemStatus below) — the watchdog (findStalledItem) uses
            // this to detect an item that stopped reporting progress
            // altogether, independent of the (possibly stale) startedAt.
            lastProgressAt: null,
            currentStep: null, lastCompletedStep: null,
          };
    });
  return {
    ...state,
    batch: {
      batchId: payload.batchId, items, running: false, paused: false, pauseReason: null,
      // A fresh batch always starts fully unconfirmed — see this module's
      // own top comment on account awareness below: a NEW batch must
      // always be confirmed again, even if the previous batch's account
      // was already confirmed.
      account: null, pendingConfirmation: null, accountIdentificationError: null, pendingAccountChange: null,
      // Likewise, no Vinted tab has been selected yet for a fresh batch —
      // see the tab-selection comment further down this file.
      vintedTabId: null,
      createdAt: state.batch?.batchId === payload.batchId ? state.batch.createdAt : nowIso,
      expiresAt: payload.expiresAt,
    },
  };
}

export function nextQueuedItem(state) {
  if (!state.batch) return null;
  return state.batch.items.find(item => item.status === ITEM_STATUSES.QUEUED) ?? null;
}

export function allItemsTerminal(items) {
  return items.length > 0 && items.every(item => isTerminalStatus(item.status));
}

export function isBatchActive(state) {
  return Boolean(state.batch) && !allItemsTerminal(state.batch.items);
}

/**
 * Merges `updates` into exactly one item, leaving every other item and the
 * rest of state untouched. Returns the SAME state reference if itemId
 * isn't found (defensive no-op, never throws).
 *
 * `nowIso`, when given, also stamps `lastProgressAt` — every real call
 * site (service-worker.js) always passes it, since ANY status transition
 * (a step progress report, a completion, a failure) is itself "progress"
 * for the watchdog's purposes (see findStalledItem below) and should reset
 * its clock. Left optional (falling back to the item's existing value)
 * purely so callers that only ever touch non-timing fields don't have to
 * thread a timestamp through for no reason.
 */
export function applyItemStatus(state, itemId, updates, nowIso) {
  if (!state.batch) return state;
  let changed = false;
  const items = state.batch.items.map(item => {
    if (item.itemId !== itemId) return item;
    changed = true;
    return { ...item, ...updates, lastProgressAt: nowIso ?? item.lastProgressAt };
  });
  if (!changed) return state;
  return { ...state, batch: { ...state.batch, items } };
}

/** A fresh attempt is starting — bumps attemptCount and sets startedAt on the first attempt only. */
export function applyItemAttemptStarting(state, itemId, nowIso) {
  if (!state.batch) return state;
  const item = state.batch.items.find(i => i.itemId === itemId);
  if (!item) return state;
  return applyItemStatus(state, itemId, {
    status: ITEM_STATUSES.PREPARING,
    attemptCount: item.attemptCount + 1,
    startedAt: item.startedAt ?? nowIso,
    errorCode: null, errorMessage: null,
    // A fresh attempt starts step-tracking fresh too — a step that
    // succeeded on a PRIOR attempt is never shown as "already completed"
    // for an attempt that hasn't actually re-run it yet.
    currentStep: null, lastCompletedStep: null,
  }, nowIso);
}

export function applyItemCompleted(state, itemId, vintedDraftId, nowIso) {
  return applyItemStatus(state, itemId, { status: ITEM_STATUSES.COMPLETED, vintedDraftId, completedAt: nowIso, errorCode: null, errorMessage: null, currentStep: null }, nowIso);
}

export function applyItemFailed(state, itemId, errorCode, errorMessage, nowIso, lastCompletedStep) {
  // currentStep is cleared here too (nothing is "currently" running once
  // terminal) — errorCode is already the exact failing step/stage name
  // (see QUEUE_CONTROLLED_FIELDS's own comment), so a failed item's
  // "current step" display is that, not a stale duplicate. lastCompletedStep
  // is the one piece of information this failure doesn't itself carry (how
  // far it got BEFORE failing) — explicitly passed by the caller (the
  // report() call that observed it, see runItem's own comment) rather than
  // relying on it having already been persisted by an earlier report;
  // falls back to the item's own existing value when the caller doesn't
  // have one to give (e.g. a non-step failure like LOGIN_REQUIRED, reported
  // before any field-loop progress ever ran).
  const item = state.batch?.items?.find(i => i.itemId === itemId);
  return applyItemStatus(state, itemId, {
    status: ITEM_STATUSES.FAILED, errorCode, errorMessage, completedAt: nowIso, currentStep: null,
    lastCompletedStep: lastCompletedStep !== undefined ? lastCompletedStep : (item?.lastCompletedStep ?? null),
  }, nowIso);
}

/** Only a QUEUED-or-already-terminal item is untouched; anything genuinely in flight is left alone (mirrors the server's own cooperative-cancel: never interrupt an active save). */
export function applyCancelRemaining(state) {
  if (!state.batch) return state;
  const items = state.batch.items.map(item => item.status === ITEM_STATUSES.QUEUED ? { ...item, status: ITEM_STATUSES.CANCELLED } : item);
  return { ...state, batch: { ...state.batch, items, running: false } };
}

/**
 * Resets exactly one item back to QUEUED — used by "Retry failed" (only
 * ever offered for a FAILED item in the UI, but this function itself
 * doesn't enforce that — the caller does, since retry is a deliberate
 * user action, not something this pure function should silently gate).
 *
 * Follow-up correction (durable Save Draft confirmation) — ONE deliberate
 * exception: an item that failed with SAVE_DRAFT_UNCONFIRMED (see
 * applyPendingSaveExpired below) is NEVER requeued by this function — a
 * structural, state-machine-level refusal (a true no-op, same reference
 * back), not just a UI convention. Save Draft may already have been
 * clicked for that item; requeuing it here would re-run the whole item
 * from a fresh /items/new form and click Save Draft a SECOND time,
 * creating a duplicate Vinted draft. The only recovery path for this
 * specific failure is the separate, click-free "Check saved draft again"
 * action (see service-worker.js's checkSavedDraftAgain) — a deliberately
 * different action than this one, exactly as required.
 */
export function applyRetryItem(state, itemId) {
  const item = state.batch?.items?.find(i => i.itemId === itemId);
  if (item?.errorCode === SAVE_DRAFT_UNCONFIRMED_ERROR_CODE) return state;
  return applyItemStatus(state, itemId, { status: ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null });
}

// ---- Durable Save Draft confirmation (live Save Draft investigation, follow-up) --------
//
// The live investigation confirmed clicking Vinted's real Save Draft
// button performs a genuine top-level navigation (/items/new ->
// /member/<sellerId>, with a "Finish editing" link -> /items/<draftId>/edit
// on the far side) that can destroy the content script mid-flight before
// it ever records success. A single in-page poll can never reliably
// survive that. This section is the durable alternative: a
// state.batch.pendingSave record, persisted BEFORE the click is ever
// allowed, that the service worker (never the content script alone) uses
// to confirm success across the navigation boundary — via chrome.tabs
// navigation events, periodic recovery on every queue tick, and recovery
// on service-worker/browser restart. See service-worker.js's own comments
// for the chrome.* orchestration; every actual DECISION (what counts as
// expired, confirmed, or a safe retry) lives here as a pure function, per
// this file's own top comment.
//
// pendingSave shape: { batchId, itemId, draftId, vintedTabId,
// expectedTitle, expectedSku, clickedAt, deadline, state, attempts }
// — `state` is "awaiting_navigation_confirmation" for the whole time
// it's live; the record is always fully CLEARED (never lingers with a
// different `state` value) the moment it resolves, either way (confirmed
// or expired), so "does state.batch.pendingSave exist at all" is always
// the single source of truth for "is a confirmation currently pending."

export const SAVE_DRAFT_UNCONFIRMED_ERROR_CODE = "SAVE_DRAFT_UNCONFIRMED";
export const SAVE_DRAFT_UNCONFIRMED_MESSAGE =
  "Save draft was clicked but Vinted's confirmation could not be found before the deadline. "
  + "The draft may already have been created — use \"Check saved draft again\" before retrying, to avoid creating a duplicate.";

const PENDING_SAVE_STATE = "awaiting_navigation_confirmation";

/**
 * Persists the pending-save record BEFORE the click is ever allowed to
 * happen (the caller — service-worker.js's BEGIN_SAVE_DRAFT handler —
 * only permits the content script to click Save Draft once this has
 * resolved) and marks the item SAVING with fresh progress — both the
 * general watchdog (findStalledItem) and this record's own deadline now
 * have a live clock to measure against.
 */
export function applyPendingSaveStarted(state, record, nowIso) {
  if (!state.batch) return state;
  const pendingSave = {
    batchId: record.batchId, itemId: record.itemId, draftId: record.draftId ?? null,
    vintedTabId: record.vintedTabId, expectedTitle: record.expectedTitle ?? null, expectedSku: record.expectedSku ?? null,
    clickedAt: record.clickedAt, deadline: record.deadline,
    state: PENDING_SAVE_STATE, attempts: 0,
  };
  const withPending = { ...state, batch: { ...state.batch, pendingSave } };
  return applyItemStatus(withPending, record.itemId, { status: ITEM_STATUSES.SAVING }, nowIso);
}

/**
 * The real, observed Vinted success marker (a confirmed Finish-editing
 * draft link, or the direct /items/<id>/edit URL — see form-steps.js's
 * findConfirmedDraftId) was found. Clears the pending record and
 * completes the item — idempotent: a SECOND confirmation for the SAME
 * (already-cleared) pending save is a safe no-op, never a duplicate
 * completion, covering duplicate/late navigation events firing after the
 * first one already resolved this.
 */
export function applyPendingSaveConfirmed(state, vintedDraftId, nowIso) {
  if (!state.batch?.pendingSave) return state;
  const { itemId } = state.batch.pendingSave;
  const cleared = { ...state, batch: { ...state.batch, pendingSave: null } };
  return applyItemCompleted(cleared, itemId, vintedDraftId, nowIso);
}

/**
 * A confirmation attempt was made (a tab-navigation event fired, or a
 * periodic recovery tick ran) but no success marker was found YET — e.g.
 * Vinted's destination page is still rendering. Bumps `attempts` purely
 * for observability and refreshes the item's own progress clock, so the
 * UNRELATED general watchdog (findStalledItem, WATCHDOG_TIMEOUT_MS) never
 * races ahead of this record's own, more specific deadline — that
 * deadline (isPendingSaveExpired/applyPendingSaveExpired below) is always
 * the first, clearer signal to fire. A safe no-op if nothing is pending.
 */
export function applyPendingSaveCheckAttempted(state, nowIso) {
  if (!state.batch?.pendingSave) return state;
  const pendingSave = { ...state.batch.pendingSave, attempts: state.batch.pendingSave.attempts + 1 };
  const withAttempt = { ...state, batch: { ...state.batch, pendingSave } };
  return applyItemStatus(withAttempt, pendingSave.itemId, {}, nowIso);
}

export function isPendingSaveExpired(state, nowIso) {
  const pending = state.batch?.pendingSave;
  if (!pending) return false;
  return new Date(nowIso).getTime() >= new Date(pending.deadline).getTime();
}

/**
 * Follow-up correction (restart-recovery gap) — records a freshly
 * reacquired tab id against a pending save whose own copy was cleared by
 * resumeAfterRestart (the old id could never be trusted after a restart —
 * see that function's own comment). The caller (service-worker.js's
 * attemptPendingSaveConfirmation) always reacquires via the SAME
 * ensureVintedTab() every other flow already uses — never a new/separate
 * tab-selection mechanism — so this only ever records an id that's
 * already been validated as an appropriate, allowed Vinted tab. Also
 * refreshes the item's own progress clock, exactly like
 * applyPendingSaveCheckAttempted, so the general watchdog never races
 * ahead of this record's own deadline. A safe no-op if nothing is
 * pending.
 */
export function applyPendingSaveTabReacquired(state, tabId, nowIso) {
  if (!state.batch?.pendingSave) return state;
  const pendingSave = { ...state.batch.pendingSave, vintedTabId: tabId };
  const withTab = { ...state, batch: { ...state.batch, pendingSave } };
  return applyItemStatus(withTab, pendingSave.itemId, {}, nowIso);
}

/**
 * The deadline passed with no confirmation ever found. This is
 * deliberately NOT a silent failure and NOT an automatic re-click — see
 * this module's own top comment and applyRetryItem's refusal above:
 * SAVE_DRAFT_UNCONFIRMED is a clear, specific, retryable failure whose
 * ONLY sanctioned recovery is the separate "Check saved draft again"
 * action. A safe no-op if nothing is pending (idempotent against being
 * called more than once for the same already-resolved item).
 */
export function applyPendingSaveExpired(state, nowIso) {
  if (!state.batch?.pendingSave) return state;
  const { itemId } = state.batch.pendingSave;
  const cleared = { ...state, batch: { ...state.batch, pendingSave: null } };
  return applyItemFailed(cleared, itemId, SAVE_DRAFT_UNCONFIRMED_ERROR_CODE, SAVE_DRAFT_UNCONFIRMED_MESSAGE, nowIso);
}

/**
 * Mandatory initial account confirmation gate: a safe no-op — never
 * starts the batch — unless `state.batch.account` is already set, which
 * only ever happens via applyAccountConfirmed() below (the side panel's
 * explicit "Confirm this account" click). This is the hard backstop for
 * "must not start a batch without explicit initial account confirmation"
 * — even if a caller's UI somehow allowed the click before confirming.
 */
export function applyStart(state) {
  if (!state.batch || !state.batch.account) return state;
  return { ...state, batch: { ...state.batch, running: true, paused: false, pauseReason: null } };
}
export function applyPause(state, reason) {
  if (!state.batch) return state;
  return { ...state, batch: { ...state.batch, paused: true, pauseReason: reason } };
}
export function applyResume(state) {
  if (!state.batch) return state;
  return { ...state, batch: { ...state.batch, paused: false, pauseReason: null, pendingAccountChange: null } };
}

// The exact, required user-facing message when no reliable identity can
// be established at all (see detectAccountIdentity() in
// shared/form-steps.js) — exported so the side panel and tests reference
// this ONE string rather than each re-typing it, which would let the two
// silently drift apart.
export const ACCOUNT_IDENTIFICATION_ERROR = "Could not reliably identify the logged-in Vinted account.";

/**
 * Account awareness (never reads cookies — the caller passes in an
 * identity `{ memberId, displayName }` read visibly off the Vinted page's
 * own DOM, or `null` if none could be reliably established). Identity is
 * always compared by the stable `memberId`, never by `displayName` — a
 * display-name change alone (e.g. the seller renames their shop) is NOT a
 * different account and must never be mistaken for one.
 *
 * Three phases, mirrored in state:
 *   - `pendingConfirmation` — an identity has been detected but the side
 *     panel's "Confirm this account" button has not yet been clicked. No
 *     batch may start while this is the only thing set (see applyStart).
 *   - `account` — the identity the user has explicitly confirmed (via
 *     applyAccountConfirmed, the initial gate) or re-confirmed (via
 *     applyAccountChangeConfirmed, after a mid-batch account change).
 *   - `accountIdentificationError` — set instead of `pendingConfirmation`
 *     when detection could not reliably establish ANY identity at all;
 *     cleared the moment a reliable identity is next detected.
 *
 * Once an account is confirmed, a LATER detection with a DIFFERENT
 * memberId pauses the batch and records both identities for display — the
 * batch never auto-resumes; that requires applyAccountChangeConfirmed,
 * called only after the side panel's own explicit re-confirmation click.
 * A later detection failure (identity === null) once already confirmed is
 * NOT treated as a change — a single failed/transient re-read should
 * never itself invalidate an already-confirmed account.
 */
export function applyAccountDetected(state, identity, nowIso) {
  if (!state.batch) return state;
  const confirmed = state.batch.account;
  const pending = state.batch.pendingConfirmation;

  if (!identity) {
    if (confirmed) return state;
    // Already recorded exactly this failure and nothing pending to clear — a true no-op, not merely "no error yet".
    if (state.batch.accountIdentificationError && !pending) return state;
    return { ...state, batch: { ...state.batch, pendingConfirmation: null, accountIdentificationError: ACCOUNT_IDENTIFICATION_ERROR } };
  }

  if (!confirmed) {
    if (pending && pending.memberId === identity.memberId && pending.displayName === identity.displayName) return state;
    const nextPending = pending && pending.memberId === identity.memberId
      ? { ...pending, displayName: identity.displayName }
      : { memberId: identity.memberId, displayName: identity.displayName, detectedAt: nowIso };
    return { ...state, batch: { ...state.batch, pendingConfirmation: nextPending, accountIdentificationError: null } };
  }

  if (confirmed.memberId === identity.memberId) {
    const displayNameChanged = confirmed.displayName !== identity.displayName;
    if (!displayNameChanged && !state.batch.pendingAccountChange) return state;
    return {
      ...state,
      batch: {
        ...state.batch,
        account: displayNameChanged ? { ...confirmed, displayName: identity.displayName } : confirmed,
        pendingAccountChange: null,
      },
    };
  }

  return applyPause(
    { ...state, batch: { ...state.batch, pendingAccountChange: { previous: confirmed, current: identity, detectedAt: nowIso } } },
    "account_change",
  );
}

/** The mandatory INITIAL confirmation gate — the side panel's "Confirm this account" click, promoting the detected-but-unconfirmed identity to the confirmed one. A safe no-op if nothing is pending (e.g. a stray double-click, or detection never having produced anything reliable). */
export function applyAccountConfirmed(state, nowIso) {
  if (!state.batch?.pendingConfirmation) return state;
  const { memberId, displayName } = state.batch.pendingConfirmation;
  return { ...state, batch: { ...state.batch, account: { memberId, displayName, confirmedAt: nowIso }, pendingConfirmation: null, accountIdentificationError: null } };
}

/** The user has reviewed the old/new identities shown in the side panel and deliberately confirmed continuing after a mid-batch account CHANGE — updates the confirmed account to the new one and clears the pause. Distinct from applyAccountConfirmed above, which is the initial (pre-batch-start) confirmation. */
export function applyAccountChangeConfirmed(state, nowIso) {
  if (!state.batch?.pendingAccountChange) return state;
  const { current } = state.batch.pendingAccountChange;
  return applyResume({ ...state, batch: { ...state.batch, account: { memberId: current.memberId, displayName: current.displayName, confirmedAt: nowIso } } });
}

// Follow-up correction (arbitrary-tab-selection bug): the tab used for
// account detection, readiness checks and every item's form-filling is
// chosen ONCE per batch by service-worker.js's deterministic
// selectVintedTab() and persisted here — never re-picked from scratch on
// every call, and never silently swapped for a different arbitrary tab if
// it disappears (see applyVintedTabLost below).
const VINTED_TAB_LOST_PAUSE_REASON = "vinted_tab_lost";
export const VINTED_TAB_LOST_MESSAGE = "The selected Vinted tab was closed or navigated away from the Create Listing page. Reopen it, then resume.";

/** Records the tab selectVintedTab() chose for this batch. */
export function applySelectedVintedTab(state, tabId) {
  if (!state.batch) return state;
  return { ...state, batch: { ...state.batch, vintedTabId: tabId } };
}

/** The previously-selected tab was closed or navigated away — pauses immediately with a clear recovery reason and clears the stale id, rather than ever silently choosing a different tab. The next resume re-selects fresh (see service-worker.js's ensureVintedTab). */
export function applyVintedTabLost(state) {
  if (!state.batch) return state;
  return applyPause({ ...state, batch: { ...state.batch, vintedTabId: null } }, VINTED_TAB_LOST_PAUSE_REASON);
}

export function isVintedTabLostPause(state) {
  return Boolean(state.batch?.paused) && state.batch.pauseReason === VINTED_TAB_LOST_PAUSE_REASON;
}

/**
 * Resume-after-restart: any item still showing an IN_FLIGHT status when
 * this state is first loaded (service worker start, browser restart) can
 * never be trusted to reflect real DOM/network progress — the content
 * script that was running it is gone. Reset to QUEUED (attemptCount is
 * untouched — the next real attempt still increments it) so the item is
 * cleanly reprocessed from the top rather than the extension guessing at
 * a mid-form resume point.
 *
 * Follow-up correction (durable Save Draft confirmation, restart-recovery
 * gap) — ONE deliberate exception to that blanket reset: a SAVING item
 * with a live state.batch.pendingSave record means Save Draft may already
 * have been CLICKED before the restart. Resetting it to QUEUED like every
 * other in-flight item would let a fresh PROCESS_ITEM run refill the
 * whole form from scratch and click Save Draft a SECOND time — a
 * duplicate Vinted draft — so this item is NEVER touched by the blanket
 * reset below, regardless of how the pendingSave itself is resolved.
 *
 * The pendingSave itself is resolved in exactly ONE of two ways, mirroring
 * a normal (non-restart) confirmation deadline check as closely as
 * possible — restart recovery is never treated as an automatic hard
 * failure:
 *
 *   - Already past its OWN deadline (real elapsed time, not "a restart
 *     happened") → applyPendingSaveExpired, exactly like an ordinary
 *     mid-session timeout: a clear SAVE_DRAFT_UNCONFIRMED failure,
 *     recoverable only via the separate, click-free "Check saved draft
 *     again" action — never an automatic re-click.
 *   - Still within its deadline → PRESERVED, not failed. Its own
 *     vintedTabId is cleared (a Chrome tab id from a previous session can
 *     never be trusted — see below) so the service worker's own recovery
 *     logic (attemptPendingSaveConfirmation) knows it must reacquire a
 *     fresh, appropriate Vinted tab (via the SAME ensureVintedTab() every
 *     other flow already uses) before it can attempt another
 *     confirmation-ONLY check — never PROCESS_ITEM, never a click. If a
 *     tab genuinely cannot be reacquired (e.g. a full browser restart
 *     with nothing Vinted-related left open, or the account is no longer
 *     signed in), this degrades gracefully once the SAME deadline is
 *     later reached — never a special-cased "restart made this
 *     impossible" failure, just the ordinary expiry path above, reached
 *     naturally on a later tick.
 *
 * Also clears batch.vintedTabId regardless (distinct from the
 * pendingSave's own copy above, and from applyVintedTabLost's mid-session
 * pause): a Chrome tab id persisted before a browser restart may now
 * refer to nothing, or to a completely different tab reused by Chrome.
 * Clearing it here makes the next ensureVintedTab() call transparently
 * reselect a fresh tab rather than trying to validate a stale,
 * meaningless id.
 *
 * Idempotent: calling this on already-consistent state returns it
 * unchanged (same reference when nothing needed resetting). `nowIso` is
 * only ever consulted for the pendingSave-expiry check above — every
 * other caller may omit it exactly as before, in which case a live
 * pendingSave is always conservatively treated as NOT yet expired
 * (preserved), never guessed as failed.
 */
export function resumeAfterRestart(state, nowIso) {
  if (!state.batch) return state;

  const pending = state.batch.pendingSave;
  let afterPendingSave = state;
  if (pending) {
    afterPendingSave = (nowIso != null && isPendingSaveExpired(state, nowIso))
      ? applyPendingSaveExpired(state, nowIso)
      : { ...state, batch: { ...state.batch, pendingSave: { ...pending, vintedTabId: null } } };
  }

  const stillPendingItemId = afterPendingSave.batch.pendingSave?.itemId ?? null;
  let changed = afterPendingSave !== state;
  const items = afterPendingSave.batch.items.map(item => {
    if (!IN_FLIGHT_STATUSES.has(item.status)) return item;
    if (item.itemId === stillPendingItemId) return item; // never reset the item a LIVE (preserved, not expired) pendingSave belongs to
    changed = true;
    return { ...item, status: ITEM_STATUSES.QUEUED };
  });
  if (!changed && afterPendingSave.batch.vintedTabId == null) return afterPendingSave;
  return { ...afterPendingSave, batch: { ...afterPendingSave.batch, items, vintedTabId: null } };
}

export function computeProgressSummary(state) {
  if (!state.batch) return { total: 0, completed: 0, failed: 0, cancelled: 0, remaining: 0, currentItem: null };
  const items = state.batch.items;
  const completed = items.filter(i => i.status === ITEM_STATUSES.COMPLETED).length;
  const failed = items.filter(i => i.status === ITEM_STATUSES.FAILED).length;
  const cancelled = items.filter(i => i.status === ITEM_STATUSES.CANCELLED).length;
  const currentItem = items.find(i => IN_FLIGHT_STATUSES.has(i.status)) ?? null;
  return { total: items.length, completed, failed, cancelled, remaining: items.length - completed - failed - cancelled, currentItem };
}

/**
 * Watchdog: finds an IN-FLIGHT item (preparing/filling/saving) that has
 * gone at least `timeoutMs` since its last reported progress — i.e. the
 * content script confirmed readiness and started, but then nothing
 * (a step, a completion, a failure) was ever reported again. This is
 * DIFFERENT from resumeAfterRestart(): that recovers state lost to a
 * service-worker restart; this recovers a genuinely stuck item while the
 * service worker is still very much alive and the state is otherwise
 * trustworthy. An item with no lastProgressAt yet (mid-way through being
 * marked preparing) is never considered stalled — there is nothing to
 * measure elapsed time against, and it is momentary in practice since
 * applyItemAttemptStarting always stamps it in the same update.
 */
export function findStalledItem(state, nowIso, timeoutMs) {
  if (!state.batch) return null;
  const now = new Date(nowIso).getTime();
  return state.batch.items.find(item => {
    if (!IN_FLIGHT_STATUSES.has(item.status)) return false;
    if (!item.lastProgressAt) return false;
    return now - new Date(item.lastProgressAt).getTime() >= timeoutMs;
  }) ?? null;
}

export function isBatchExpired(state, nowIso) {
  const expiresAt = state.pairing?.expiresAt ?? state.batch?.expiresAt;
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= new Date(nowIso).getTime();
}
