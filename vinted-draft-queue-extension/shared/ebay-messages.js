// eBay Seller Hub extension drafter — the ONE shared message-type contract
// for the eBay-specific queue. Deliberately a SEPARATE module from
// shared/messages.js (Vinted's own) — every constant here is independently
// named (EBAY_-prefixed types, never overlapping with PANEL_TO_WORKER/
// WORKER_TO_CONTENT/CONTENT_TO_WORKER's own string values) so a message
// object can never be ambiguously routed to the wrong marketplace's handler
// even if it somehow reached the wrong listener. See
// tests/ebay-extension-message-separation.test.ts for the structural proof.

// Side panel -> service worker (eBay tab).
export const EBAY_PANEL_TO_WORKER = Object.freeze({
  EBAY_GET_STATE: "EBAY_GET_STATE",
  EBAY_CLAIM_BATCH: "EBAY_CLAIM_BATCH",
  // Sends exactly one queued item — this milestone's batches only ever
  // contain one item (MAX_EBAY_EXTENSION_BATCH_LISTINGS = 1), but the verb
  // is deliberately per-item (not "START_BATCH") so a later multi-item
  // relaxation doesn't need a new message type.
  EBAY_START_ITEM: "EBAY_START_ITEM",
  EBAY_CANCEL_ITEM: "EBAY_CANCEL_ITEM",
  // CORRECTIVE PASS 6 (retry truthfulness review) — deliberately no
  // EBAY_RETRY_ITEM here any more. A failed item is permanently terminal
  // for its own id; a real retry is a fresh batch/item created through the
  // authenticated app, which this side panel has no session for.
  EBAY_CLEAR_BATCH: "EBAY_CLEAR_BATCH",
});

// Service worker -> content script (an ebay.co.uk/lstng tab).
export const EBAY_WORKER_TO_CONTENT = Object.freeze({
  EBAY_FILL_LISTING: "EBAY_FILL_LISTING",
  EBAY_INSPECT_PAGE_STATE: "EBAY_INSPECT_PAGE_STATE",
});

// Content script -> service worker.
export const EBAY_CONTENT_TO_WORKER = Object.freeze({
  EBAY_ITEM_STEP_PROGRESS: "EBAY_ITEM_STEP_PROGRESS",
  EBAY_ITEM_RESULT: "EBAY_ITEM_RESULT",
  // Mirrors Vinted's CONTENT_TO_WORKER.REQUEST_PHOTO exactly — a
  // Seller-Hub-page content script must never itself fetch a private
  // app/Supabase photo URL (its network requests carry the PAGE's own
  // origin, https://www.ebay.co.uk, which the app's CORS config never
  // allows). It asks the service worker (whose fetches match the allowed
  // chrome-extension:// origin) for one photo at a time instead.
  EBAY_REQUEST_PHOTO: "EBAY_REQUEST_PHOTO",
});

/** Every message in this queue is `{ type, ...payload }` — mirrors shared/messages.js's own makeMessage exactly, duplicated here rather than imported so this module has zero dependency on the Vinted one (see this file's own top comment on marketplace separation). */
export function makeEbayMessage(type, payload = {}) {
  return { type, ...payload };
}
