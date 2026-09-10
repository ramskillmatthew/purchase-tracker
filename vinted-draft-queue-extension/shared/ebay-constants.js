// eBay Seller Hub extension drafter — small constants shared between the
// service worker and tests. Kept separate from ebay-queue-state.js (pure
// state functions only, no magic numbers baked in) and from
// ebay-fields.js/ebay-form-steps.js (DOM/step-timing constants, a
// different concern).

// How long an in-flight (preparing/filling) item may go with no reported
// progress before the watchdog treats it as stalled — mirrors Vinted's own
// WATCHDOG_TIMEOUT_MS precedent (service-worker.js), same order of
// magnitude, kept independent so tuning one never silently affects the
// other queue.
export const EBAY_EXTENSION_STALL_TIMEOUT_MS = 60_000;
