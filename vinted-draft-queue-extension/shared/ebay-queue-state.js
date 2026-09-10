// eBay Seller Hub extension drafter — the ONE place eBay queue/batch state
// is computed. Mirrors shared/queue-state.js's own "every function here is
// PURE" discipline exactly (see that file's own top comment for the full
// reasoning) — deliberately a SEPARATE module, not a generalised/shared
// one, so eBay state can never accidentally be computed by a Vinted
// function or vice versa.
//
// Deliberately MUCH simpler than queue-state.js: this milestone never
// clicks Save Draft, so there is no cross-navigation "pendingSave"
// durability section, no "manualReload" native-dialog section, and no
// per-item retry-attempt-count coupling to a real save click. The item
// never reaches a truly "completed" state yet — WAITING_FOR_REVIEW is the
// real terminal-for-now status (see supabase-ebay-extension-batches.sql's
// own matching comment on the narrower status vocabulary). When automatic
// Save Draft is enabled in a future task, this file is where the
// Vinted-style pendingSave durability pattern would be ported in — not
// before, since there is nothing yet for it to protect.

export const EBAY_ITEM_STATUSES = Object.freeze({
  QUEUED: "queued",
  PREPARING: "preparing",
  FILLING: "filling",
  WAITING_FOR_REVIEW: "waiting_for_review",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const TERMINAL_STATUSES = new Set([
  EBAY_ITEM_STATUSES.WAITING_FOR_REVIEW, EBAY_ITEM_STATUSES.FAILED, EBAY_ITEM_STATUSES.CANCELLED,
]);
const IN_FLIGHT_STATUSES = new Set([EBAY_ITEM_STATUSES.PREPARING, EBAY_ITEM_STATUSES.FILLING]);

export function isTerminalEbayStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function createInitialEbayState() {
  return { pairing: null, batch: null };
}

export function applyEbayClaim(state, { batchId, batchToken, expiresAt, claimedAt }) {
  return { ...state, pairing: { batchId, batchToken, expiresAt, claimedAt } };
}

// Mirrors queue-state.js's own QUEUE_CONTROLLED_FIELDS convention exactly —
// the ONLY fields this module ever controls once an item exists; every
// other property is the complete, immutable EbayExtensionBatchItem payload
// from the app.
const QUEUE_CONTROLLED_FIELDS = [
  "status", "attemptCount", "errorCode", "errorMessage",
  "startedAt", "completedAt", "lastProgressAt", "currentStep", "lastCompletedStep",
  "photosRequested", "photosUploaded", "photosFailed",
];

function pickQueueControlledFields(item) {
  const picked = {};
  for (const field of QUEUE_CONTROLLED_FIELDS) picked[field] = item[field];
  return picked;
}

/** Mirrors applyBatchPayload in queue-state.js exactly — see that function's own doc comment. */
export function applyEbayBatchPayload(state, payload, nowIso) {
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
            status: EBAY_ITEM_STATUSES.QUEUED, attemptCount: 0,
            errorCode: null, errorMessage: null,
            startedAt: null, completedAt: null, lastProgressAt: null,
            currentStep: null, lastCompletedStep: null,
            photosRequested: null, photosUploaded: null, photosFailed: null,
          };
    });
  return {
    ...state,
    batch: {
      batchId: payload.batchId, items, running: false,
      createdAt: state.batch?.batchId === payload.batchId ? state.batch.createdAt : nowIso,
      expiresAt: payload.expiresAt,
      // One active eBay listing tab at a time, exactly like Vinted's own
      // vintedTabId — see this feature's own scope: "A single active eBay
      // listing tab initially."
      ebayTabId: null,
    },
  };
}

export function nextQueuedEbayItem(state) {
  if (!state.batch) return null;
  return state.batch.items.find(item => item.status === EBAY_ITEM_STATUSES.QUEUED) ?? null;
}

export function allEbayItemsTerminal(items) {
  return items.length > 0 && items.every(item => isTerminalEbayStatus(item.status));
}

export function applyEbayItemStatus(state, itemId, updates, nowIso) {
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

export function applyEbayItemAttemptStarting(state, itemId, nowIso) {
  if (!state.batch) return state;
  const item = state.batch.items.find(i => i.itemId === itemId);
  if (!item) return state;
  return applyEbayItemStatus(state, itemId, {
    status: EBAY_ITEM_STATUSES.PREPARING,
    attemptCount: item.attemptCount + 1,
    startedAt: item.startedAt ?? nowIso,
    errorCode: null, errorMessage: null, currentStep: null, lastCompletedStep: null,
    photosRequested: null, photosUploaded: null, photosFailed: null,
  }, nowIso);
}

/**
 * Reaches the milestone's real terminal-for-now state: the form is
 * populated, photos are verified uploaded, and a human needs to review and
 * save it themselves. Deliberately never called "completed" anywhere in
 * this module — see this file's own top comment.
 */
export function applyEbayItemWaitingForReview(state, itemId, nowIso) {
  return applyEbayItemStatus(state, itemId, {
    status: EBAY_ITEM_STATUSES.WAITING_FOR_REVIEW, completedAt: nowIso, errorCode: null, errorMessage: null, currentStep: null,
  }, nowIso);
}

export function applyEbayItemFailed(state, itemId, errorCode, errorMessage, nowIso, lastCompletedStep) {
  const item = state.batch?.items?.find(i => i.itemId === itemId);
  return applyEbayItemStatus(state, itemId, {
    status: EBAY_ITEM_STATUSES.FAILED, errorCode, errorMessage, completedAt: nowIso, currentStep: null,
    lastCompletedStep: lastCompletedStep !== undefined ? lastCompletedStep : (item?.lastCompletedStep ?? null),
  }, nowIso);
}

/**
 * Duplicate-protection (Phase 8) — one active operation per listing ID and
 * per SKU is enforced server-side (the create-batch RPC's own advisory-
 * lock + conflict check — see supabase-ebay-extension-batches.sql). This
 * function is the CLIENT-side half: re-sending an item that is already
 * queued/in-flight/waiting-for-review is a safe no-op (same reference
 * back) — it never starts a second attempt, mirroring "re-sending the same
 * operation focuses/resumes it rather than opening another form."  Only a
 * genuinely FAILED item may be retried, and only via applyRetryEbayItem
 * below, never this one.
 */
export function isEbayItemAlreadyActive(state, itemId) {
  const item = state.batch?.items?.find(i => i.itemId === itemId);
  if (!item) return false;
  return item.status === EBAY_ITEM_STATUSES.QUEUED || IN_FLIGHT_STATUSES.has(item.status) || item.status === EBAY_ITEM_STATUSES.WAITING_FOR_REVIEW;
}

/** Only a FAILED item may be retried — a true no-op (same reference back) for anything else, including WAITING_FOR_REVIEW (a completed operation can never be replayed by this function) and CANCELLED (explicit, deliberate — a cancelled item needs a fresh send from the app, not a queue-level retry). */
export function applyRetryEbayItem(state, itemId) {
  const item = state.batch?.items?.find(i => i.itemId === itemId);
  if (!item || item.status !== EBAY_ITEM_STATUSES.FAILED) return state;
  return applyEbayItemStatus(state, itemId, { status: EBAY_ITEM_STATUSES.QUEUED, errorCode: null, errorMessage: null });
}

/** Only a QUEUED item may be cancelled — anything genuinely in flight is left alone, mirroring queue-state.js's own applyCancelRemaining. */
export function applyCancelEbayItem(state, itemId) {
  const item = state.batch?.items?.find(i => i.itemId === itemId);
  if (!item || item.status !== EBAY_ITEM_STATUSES.QUEUED) return state;
  return applyEbayItemStatus(state, itemId, { status: EBAY_ITEM_STATUSES.CANCELLED });
}

export function applyEbaySelectedTab(state, tabId) {
  if (!state.batch) return state;
  return { ...state, batch: { ...state.batch, ebayTabId: tabId } };
}

/**
 * Resume-after-restart — mirrors resumeAfterRestart in queue-state.js, but
 * much simpler: any item still IN_FLIGHT (preparing/filling) when this
 * state is first loaded can never be trusted (the content script that was
 * running it is gone) and is reset to QUEUED for a clean re-run — the eBay
 * Seller Hub form is always safe to reopen and refill from scratch, since
 * nothing is ever saved by this milestone's own code. The stale tab id is
 * always cleared too, so the next dispatch reselects a fresh, validated
 * tab rather than trusting an id that may now point at nothing or at a
 * completely different tab Chrome has reused.
 */
export function resumeEbayAfterRestart(state) {
  if (!state.batch) return state;
  let changed = false;
  const items = state.batch.items.map(item => {
    if (!IN_FLIGHT_STATUSES.has(item.status)) return item;
    changed = true;
    return { ...item, status: EBAY_ITEM_STATUSES.QUEUED };
  });
  if (!changed && state.batch.ebayTabId == null) return state;
  return { ...state, batch: { ...state.batch, items, ebayTabId: null } };
}

export function computeEbayProgressSummary(state) {
  if (!state.batch) return { total: 0, waitingForReview: 0, failed: 0, cancelled: 0, remaining: 0, currentItem: null };
  const items = state.batch.items;
  const waitingForReview = items.filter(i => i.status === EBAY_ITEM_STATUSES.WAITING_FOR_REVIEW).length;
  const failed = items.filter(i => i.status === EBAY_ITEM_STATUSES.FAILED).length;
  const cancelled = items.filter(i => i.status === EBAY_ITEM_STATUSES.CANCELLED).length;
  const currentItem = items.find(i => IN_FLIGHT_STATUSES.has(i.status)) ?? null;
  return { total: items.length, waitingForReview, failed, cancelled, remaining: items.length - waitingForReview - failed - cancelled, currentItem };
}

/** Mirrors findStalledItem in queue-state.js exactly — see that function's own doc comment. */
export function findStalledEbayItem(state, nowIso, timeoutMs) {
  if (!state.batch) return null;
  const now = new Date(nowIso).getTime();
  return state.batch.items.find(item => {
    if (!IN_FLIGHT_STATUSES.has(item.status)) return false;
    if (!item.lastProgressAt) return false;
    return now - new Date(item.lastProgressAt).getTime() >= timeoutMs;
  }) ?? null;
}

export function isEbayBatchExpired(state, nowIso) {
  const expiresAt = state.pairing?.expiresAt ?? state.batch?.expiresAt;
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= new Date(nowIso).getTime();
}
