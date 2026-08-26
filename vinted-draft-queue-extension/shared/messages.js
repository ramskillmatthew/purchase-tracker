// Vinted Draft Queue extension — the one shared message-type contract every
// part of the extension (side panel, service worker, content script) uses.
// Plain ES module: statically importable by the service worker and side
// panel (both run as modules), dynamically importable by the content
// script (chrome.runtime.getURL + import(), since content scripts can't
// use a static top-level `import`), and directly importable by vitest for
// testing — one file, one shape, no drift between any of them.

// Side panel -> service worker.
export const PANEL_TO_WORKER = Object.freeze({
  GET_STATE: "GET_STATE",
  CLAIM_BATCH: "CLAIM_BATCH",
  START_BATCH: "START_BATCH",
  PAUSE_BATCH: "PAUSE_BATCH",
  RESUME_BATCH: "RESUME_BATCH",
  RETRY_ITEM: "RETRY_ITEM",
  CANCEL_REMAINING: "CANCEL_REMAINING",
  CLEAR_BATCH: "CLEAR_BATCH",
  CONFIRM_ACCOUNT: "CONFIRM_ACCOUNT",
  CONFIRM_ACCOUNT_CHANGE: "CONFIRM_ACCOUNT_CHANGE",
  RETRY_ACCOUNT_DETECTION: "RETRY_ACCOUNT_DETECTION",
  // Follow-up correction (durable Save Draft confirmation) — the ONLY
  // sanctioned recovery action for an item that failed with
  // SAVE_DRAFT_UNCONFIRMED (see shared/queue-state.js's own top comment).
  // Deliberately separate from RETRY_ITEM (which that specific failure
  // structurally refuses — see applyRetryItem): this searches for the
  // real, already-observed Vinted success marker on the selected tab and
  // NEVER clicks Save Draft, Upload, or anything else — the "separate
  // deliberate action" the live investigation's follow-up requires before
  // another Save Draft click could ever occur again.
  CHECK_SAVED_DRAFT: "CHECK_SAVED_DRAFT",
  // Follow-up correction (native browser reload-confirmation bug) — the
  // ONLY sanctioned way to trigger another same-tab reload attempt while
  // state.batch.manualReload is pending (see shared/queue-state.js's own
  // top comment on that section). Issues EXACTLY ONE new navigation
  // attempt — never a loop, never automatic — matching "never repeatedly
  // trigger reload requests while unresolved."
  RETRY_MANUAL_RELOAD: "RETRY_MANUAL_RELOAD",
});

// Service worker -> content script (vinted.co.uk tab).
export const WORKER_TO_CONTENT = Object.freeze({
  DETECT_ACCOUNT: "DETECT_ACCOUNT",
  PROCESS_ITEM: "PROCESS_ITEM",
  // Follow-up correction (durable Save Draft confirmation) — sent to
  // whichever content-script instance is CURRENTLY running on the
  // selected tab (very possibly a freshly-injected one, on a completely
  // different page, than whichever instance clicked Save Draft — see
  // shared/form-steps.js's findConfirmedDraftId for why that's fine: this
  // handler only ever reads the CURRENT page's own DOM/URL, never
  // anything held over from before). Asks it to look for the real,
  // observed Vinted success marker on the page it's sitting on right now
  // and report back the numeric Vinted draft id, or null if not found yet.
  CHECK_DRAFT_CONFIRMATION: "CHECK_DRAFT_CONFIRMATION",
  // Clean-create-form boundary (fixes: a failed item's leftover
  // photos/fields contaminating the next item) — asks whichever
  // content-script instance is currently running on the selected tab to
  // read-only inspect its own current page (see shared/form-steps.js's
  // inspectPageState) and report back one of PAGE_STATE's four values.
  // Never itself resets anything — see service-worker.js's
  // ensureCleanCreateForm, the sole caller, for the actual reset decision.
  INSPECT_PAGE_STATE: "INSPECT_PAGE_STATE",
});

// Content script -> service worker.
export const CONTENT_TO_WORKER = Object.freeze({
  ACCOUNT_DETECTED: "ACCOUNT_DETECTED",
  ITEM_STEP_PROGRESS: "ITEM_STEP_PROGRESS",
  ITEM_RESULT: "ITEM_RESULT",
  // Follow-up correction (photo-download CORS bug): a Vinted-page content
  // script must never itself fetch a private app/Supabase photo URL — its
  // network requests carry the PAGE's origin (https://www.vinted.co.uk),
  // which the app's CORS config never allows (only chrome-extension://<id>
  // is allowed — see lib/listing-studio/extension-cors.ts). The content
  // script instead asks the service worker (whose own fetches DO match
  // that allowed origin, and which already holds host_permissions for the
  // app) for one photo at a time; see service-worker.js's
  // downloadPhotoForContentScript().
  REQUEST_PHOTO: "REQUEST_PHOTO",
  // Follow-up correction (message-lifecycle hang bug): served only when a
  // photo's base64 payload is too large to trust in a single sendResponse
  // (see service-worker.js's SAFE_SINGLE_MESSAGE_BASE64_CHARS) — the
  // content script (shared/photo-transfer.js) requests each bounded chunk
  // in order and reassembles them, rather than gambling on one very large
  // message "just working" (or silently failing/hanging).
  REQUEST_PHOTO_CHUNK: "REQUEST_PHOTO_CHUNK",
  // Follow-up correction (durable Save Draft confirmation) — sent BEFORE
  // stepSaveDraft is ever allowed to click the real Save Draft button.
  // The service worker persists a pending-save record (durable across
  // this very script being destroyed by the click's own resulting
  // navigation — see shared/queue-state.js's applyPendingSaveStarted) and
  // only then acknowledges — the click never happens until this
  // round-trip resolves { ok: true }. The tab id is deliberately NEVER
  // taken from this message's own payload — the service worker always
  // uses the message sender's own sender.tab.id instead, so a content
  // script can never claim to be a tab it isn't.
  BEGIN_SAVE_DRAFT: "BEGIN_SAVE_DRAFT",
});

/** Every message in this extension is `{ type, ...payload }` — this just documents/enforces that one shape in one place. */
export function makeMessage(type, payload = {}) {
  return { type, ...payload };
}
