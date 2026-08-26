// Vinted Draft Queue extension — the actual state-machine step
// implementations (OPEN_FORM, UPLOAD_PHOTOS, SET_*, SAVE_DRAFT, and the
// per-item orchestrator that runs them in order). Pulled out of
// content-script.js into its own plain ES module, dependency-injected
// (fetch/DataTransfer/File/document are all parameters, never read from a
// module-level global), specifically so it's directly unit-testable with
// vitest + jsdom against a synthetic fixture — no chrome.* mocking
// required at all. content-script.js is a thin wrapper: it supplies the
// real browser globals and chrome.runtime messaging, and delegates every
// real step to the functions here.
//
// Every step: finds its target element with a uniqueness requirement,
// performs exactly one action, waits for a concrete resulting page state
// (never an arbitrary sleep), and returns a structured { ok, ... } result
// — never throws for an expected failure (missing/ambiguous field,
// timeout), which is what lets runItem report a clean, specific error
// instead of an unhandled exception.
//
// Follow-up correction (verified-selector rewrite): every dialog-based
// field step (category/brand/size/condition/colour/material) below is
// built against a REAL, verified DOM contract captured from a live,
// signed-in session at https://www.vinted.co.uk/items/new — see
// vinted-fields.js's VINTED_FIELD_STRATEGIES for the exact ids/data-testids.
// Vinted exposes only Photos/Title/Description/Category/Price/Save-draft
// BEFORE a category is chosen — Brand/Size/Condition/Colours/Material
// don't exist in the DOM at all until the category dialog is saved and
// Vinted re-renders the form, which is why runItem's field order below
// runs category (and waits for the brand field to appear) before ever
// touching those dependent fields, and why every dialog step re-queries
// the DOM after its own save rather than reusing a stale reference.

import {
  getAccessibleName, findByRole, requireUnique, resolveVerifiedField, resolvePhotoInput, resolveTitleInput,
  assertNotForbiddenAction, assertValidInteractionTarget, resolveSaveDraftButton,
  VINTED_FIELD_STRATEGIES, CREATE_LISTING_FORM_SELECTORS, TITLE_INPUT_SELECTOR,
  isVisible, countUploadedPhotoCards, countAddPhotoTiles, hasActiveUploadIndicator,
} from "./vinted-fields.js";
import { validateBatchItem } from "./validation.js";

export const STEP_TIMEOUT_MS = 8000;
export const POLL_INTERVAL_MS = 150;
export const STABILITY_PAUSE_MS = 350; // within the task's permitted ~250-600ms range
export const MAX_STEP_RETRIES = 2;

export function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export async function waitFor(conditionFn, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = conditionFn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await pause(intervalMs);
  }
}

/**
 * Follow-up correction (root-scoping rewrite) — root cause: the live
 * Create Listing page has NO wrapping <form> element around ANY of its
 * content (confirmed directly against a live, signed-in session — see
 * CREATE_LISTING_FORM_SELECTORS's own comment in vinted-fields.js). The
 * old bare `"form"` fallback selector matched the header's own unrelated
 * search-bar form instead, silently returning the WRONG root for every
 * single field on the page. CREATE_LISTING_FORM_SELECTORS is now a set of
 * page-presence LANDMARKS, not a container to scope queries within —
 * once any one is found, this returns `doc.body` (i.e. "search the whole
 * document", exactly like resolvePhotoInput/resolveTitleInput already do
 * for their own fields) rather than the matched element itself. Returns
 * `null` — the genuine "not on the Create Listing page" signal
 * stepOpenForm checks for — only when NONE of the landmarks are found.
 */
export function findFormRoot(doc) {
  const onCreateListingPage = CREATE_LISTING_FORM_SELECTORS.some(selector => doc.querySelector(selector));
  return onCreateListingPage ? doc.body : null;
}

// React (and most modern frameworks) track <input>/<textarea> value via a
// property setter that a plain `.value = x` assignment bypasses, leaving
// the framework's own state stale even though the DOM shows the new text.
// This is the standard, well-established workaround: call the native
// prototype's setter directly, then dispatch a real "input" event so the
// framework's own change handler actually fires.
export function setNativeValue(element, value, win) {
  const prototype = element.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value); else element.value = value;
  element.dispatchEvent(new win.Event("input", { bubbles: true }));
  element.dispatchEvent(new win.Event("change", { bubbles: true }));
}

export function normaliseText(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---- Field-timeout diagnostics (live-investigation follow-up) -------------
//
// Root cause of the reported live "TIMEOUT: field did not confirm the
// entered value" symptom: the generic message named neither the field nor
// what was actually observed, so diagnosing it required re-running the
// whole batch under a debugger against the live page. Every field-
// confirmation timeout below now goes through buildFieldTimeoutReason so a
// real failure is self-diagnosing from the persisted errorMessage alone —
// see docs/investigation notes for the concrete SET_PRICE case this fixed
// (Vinted's own price input reformats "30" to "£30.00" immediately, which
// the OLD raw string comparison could never match).

/** Bounds a diagnostic value to a single line of sane length — a field's live value (Description especially) can be arbitrarily long or contain newlines; this must never balloon a persisted error message or dump raw page content. */
export function boundDiagnosticValue(value, maxLen = 120) {
  const str = value == null ? "" : String(value);
  const singleLine = str.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen)}…` : singleLine;
}

/**
 * Builds the structured "step=... field=... expected=... observed=..."
 * message every field-confirmation timeout below returns, so the exact
 * failed field, what was typed, and what the page actually showed are all
 * captured in the ONE string that ends up as the item's errorMessage —
 * never just a generic "field did not confirm" with no way to tell which
 * field, or why, without re-running the batch under a debugger.
 */
export function buildFieldTimeoutReason({ prefix = "TIMEOUT", step, field, selector, expected, observed, cause }) {
  const parts = [
    `step=${step}`,
    `field=${field}`,
    selector != null ? `selector=${JSON.stringify(selector)}` : null,
    expected !== undefined ? `expected=${JSON.stringify(boundDiagnosticValue(expected))}` : null,
    observed !== undefined ? `observed=${JSON.stringify(boundDiagnosticValue(observed))}` : null,
    cause ? `reason=${JSON.stringify(cause)}` : null,
  ].filter(Boolean);
  return `${prefix}: ${parts.join(" ")}`;
}

function strictValueMatch(current, expected) { return current === expected; }

/**
 * Parses a currency-formatted price string ("£30.00", "30", " 30.5 ") into
 * integer pence — strips everything but digits and the decimal point, so a
 * currency symbol, thousands separator, or surrounding whitespace never
 * prevents a match. Returns null (never guesses) for anything that doesn't
 * parse to a finite number, e.g. an empty field.
 */
export function parsePriceToPence(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  if (cleaned === "" || cleaned === ".") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * Follow-up correction (live investigation — SET_PRICE currency-format
 * mismatch bug) — root cause, verified directly against a live, signed-in
 * session: Vinted's own Price input (`data-testid="price-input--input"`)
 * immediately reformats whatever is typed into a "£X.XX" display value
 * (typing "30" renders back as "£30.00" in `element.value` itself, not
 * merely a visual overlay) — confirmed live, the raw `.value` property
 * really does carry the "£" prefix and the 2-decimal-place formatting.
 * The OLD confirmation (`element.value === "30"`) could therefore NEVER
 * succeed for any price, on any item, ever — not a one-off flake.
 *
 * This compares the NUMERIC pence value both strings represent, not their
 * raw text — a visibly correct price (any currency-formatted rendering of
 * the same amount) now counts as confirmed, and an already-correct price
 * is recognised on retry (see stepSetText's own idempotent pre-check,
 * which uses this same comparator) rather than being re-typed and re-
 * failing in a loop. Deliberately narrow: this comparator is wired up for
 * the Price field ONLY (see the SET_PRICE step below) — every other
 * stepSetText field (Description) keeps the exact strict string equality
 * it always had; this never weakens confirmation for any other field.
 */
export function priceValueMatch(current, expectedTypedValue) {
  const currentPence = parsePriceToPence(current);
  const expectedPence = parsePriceToPence(expectedTypedValue);
  return currentPence !== null && expectedPence !== null && currentPence === expectedPence;
}

/** Requires the click target's accessible name to pass the forbidden-action guard EVERY time, no exceptions. */
/**
 * Requires the click target's accessible name to pass the forbidden-action
 * guard EVERY time, no exceptions.
 *
 * Follow-up correction (invalid-interaction-target safety bug) — root
 * cause: a page-level container (confirmed live: `document.body`, passed
 * as the "outside click" target to close the Colours/Material multi-select
 * dropdown — see stepSelectMultiOptions's own comment) reached
 * getAccessibleName, whose "own text" fallback returns the ENTIRE page's
 * text for any element with children — a ~1.5MB string embedded whole into
 * the thrown safety error. `assertValidInteractionTarget` now runs FIRST,
 * rejecting `document`/`documentElement`/`body`/a bare `<html>` or
 * `<body>` element before any accessible name is ever computed — see that
 * function's own comment in vinted-fields.js. `stepName` is optional,
 * purely for diagnostics (e.g. "SET_CONDITION") — every call site below
 * that has one passes it.
 */
export function safeClick(element, stepName = "unknown") {
  assertValidInteractionTarget(element, stepName);
  assertNotForbiddenAction(getAccessibleName(element));
  element.click();
}

export async function stepOpenForm({ doc, win, location }) {
  if (!/\/items\/new/.test(location.pathname) && !/\/items\/[^/]+\/edit/.test(location.pathname)) {
    const sellCandidates = findByRole(doc.body, "button", { nameContains: "Sell" }).concat(Array.from(doc.querySelectorAll('a[href*="/items/new"]')));
    const sellLink = requireUnique(sellCandidates, "Sell / Create listing entry point");
    if (!sellLink.ok) return { ok: false, reason: sellLink.reason };
    safeClick(sellLink.element);
    const arrived = await waitFor(() => /\/items\/new/.test(location.pathname) || CREATE_LISTING_FORM_SELECTORS.some(selector => doc.querySelector(selector)));
    if (!arrived) return { ok: false, reason: "TIMEOUT: Create Listing form did not appear." };
  }
  const root = findFormRoot(doc);
  if (!root) return { ok: false, reason: "NOT_FOUND: Create Listing form container." };
  return { ok: true, root };
}

// Filenames are never trusted verbatim from the batch payload — a genuine
// filename (letters/digits/dot/dash/underscore only, no path separators or
// traversal) passes through; anything else falls back to a synthesised,
// always-safe name derived from the photo's own position/mime type,
// matching the app's own extension-batch naming convention (see
// app/api/extension/batch/route.ts's payloadItems.map()).
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9._-]+$/;
function safeFileName(rawName, position, mimeType) {
  const candidate = typeof rawName === "string" ? rawName.trim() : "";
  if (candidate && candidate.length <= 100 && !candidate.includes("..") && SAFE_FILENAME_PATTERN.test(candidate)) return candidate;
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return `${String(position + 1).padStart(2, "0")}.${ext}`;
}

/**
 * Follow-up correction (photo-download CORS bug) — this step used to
 * `fetch()` each photo URL directly, but that ran inside the Vinted
 * content script, whose requests carry the PAGE's origin
 * (https://www.vinted.co.uk). The app's CORS config only ever allows the
 * extension's own origin (chrome-extension://<id>), so that fetch was
 * blocked by the browser before its response could ever be read — surfacing
 * as an opaque "NETWORK: could not download photo" failure. Photos are now
 * requested ONE AT A TIME, in position order, from the service worker
 * (`deps.requestPhoto`) — which fetches with the batch's own bearer token
 * from a context whose origin the app's CORS config DOES allow — and
 * returned as base64 to be reconstructed into a real File here. Sequential
 * (never Promise.all) so a large batch never holds every photo's bytes in
 * memory at once.
 */
/**
 * SAFE, TEMPORARY diagnostics for the message-lifecycle hang bug — only
 * ever a photo position/label and a short fixed word; never a URL, a
 * token, or any byte of the actual photo data.
 */
function logPhotoStage(stage, position, extra = "") {
  console.log(`Vinted Draft Queue [photo ${position}]: ${stage}`, extra);
}

// Follow-up correction (photo-confirmation false-negative bug) — root
// cause: the OLD confirmation check queried `root.querySelectorAll(...)`,
// but `root` is the Create Listing <form> element (see findFormRoot/
// CREATE_LISTING_FORM_SELECTORS), and the live page's entire photo-upload
// area (#photos / [data-testid="media-upload"]) does NOT live inside any
// <form> element at all — confirmed directly against a live, signed-in
// session (`document.querySelector("form").contains(mediaUploadEl)` is
// `false`), exactly the same "lives outside the form root" exception
// resolvePhotoInput() above already documents for the photo INPUT itself.
// So the old check searched an empty subtree and could never find a real
// photo card, no matter how many photos genuinely uploaded — a structural
// bug, not a flaky timing one. Its selector was ALSO wrong even ignoring
// scope: '[data-testid*="photo"]' substring-matches the input itself
// (data-testid="add-photos-input") and the empty add-tile
// (data-testid="add-photos-icon-button"), while never matching a real
// card (data-testid="image-wrapper-N" contains no "photo" substring at
// all); 'img[alt*="photo"]'/'li img' never match anything, since Vinted
// renders thumbnails as background-image DIVs, never <img> elements, and
// uses no <li> structure. See vinted-fields.js's own top comment above
// countUploadedPhotoCards() for the full verified DOM contract.
//
// Confirmation now: (1) the WHOLE document is searched (never `root`);
// (2) only the verified image-wrapper-N marker counts as an "uploaded
// photo card" — the add-tile is structurally excluded by construction,
// never merely filtered out; (3) any active upload/loading indicator (see
// hasActiveUploadIndicator's own comment on why this is defensive) must
// have cleared; (4) the count must stay exactly right for a short
// SETTLING period, not just once, before being trusted.
const PHOTO_CONFIRM_SETTLE_MS = 1500;
const PHOTO_CONFIRM_POLL_MS = 150;

/** Builds a specific, evidence-bearing failure reason — never the bare generic timeout message alone (see this file's own diagnostics requirement). */
function describePhotoConfirmationFailure(doc, expectedCount, actualCount, uploadIndicatorActive) {
  const addTileCount = countAddPhotoTiles(doc);
  const pageUrl = doc.defaultView?.location?.href ?? doc.location?.href ?? "unknown";
  return `TIMEOUT: photos did not appear to be confirmed by Vinted `
    + `(expected ${expectedCount}, found ${actualCount}; `
    + `upload indicator ${uploadIndicatorActive ? "still active" : "not active"}; `
    + `${addTileCount} empty add-photo tile(s); `
    + `checked selector [data-testid^="image-wrapper-"]; `
    + `page ${pageUrl}).`;
}

/**
 * Waits for exactly `expectedCount` verified uploaded-photo cards to be
 * present, with no active upload indicator, held STABLE for
 * PHOTO_CONFIRM_SETTLE_MS before being trusted — a count that transiently
 * passes through the right number (e.g. mid-reorder) and then changes
 * again is never mistaken for confirmation. Returns { ok: true } or a
 * structured, evidence-bearing failure (see describePhotoConfirmationFailure).
 */
export async function waitForPhotoCardsConfirmed(doc, expectedCount, { timeoutMs = STEP_TIMEOUT_MS * 2 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let lastCount = -1;
  let lastBusy = true;
  for (;;) {
    lastCount = countUploadedPhotoCards(doc);
    lastBusy = hasActiveUploadIndicator(doc);
    if (lastCount === expectedCount && !lastBusy) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= PHOTO_CONFIRM_SETTLE_MS) return { ok: true };
    } else {
      stableSince = null;
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: describePhotoConfirmationFailure(doc, expectedCount, lastCount, lastBusy) };
    }
    await pause(PHOTO_CONFIRM_POLL_MS);
  }
}

export async function stepUploadPhotos(root, item, { doc, win, requestPhoto, DataTransferImpl, FileImpl }, report = () => {}) {
  const fileFound = resolvePhotoInput(doc);
  if (!fileFound.ok) return { ok: false, reason: fileFound.reason };
  const input = fileFound.element;

  const orderedPhotos = item.photos.slice().sort((a, b) => a.position - b.position);
  const total = orderedPhotos.length;

  // Idempotent retry (follow-up correction: photo-confirmation
  // false-negative bug) — count whatever's ALREADY on the page BEFORE
  // touching anything. This is exactly what makes a previously-failed
  // item (one whose photos genuinely all made it onto the page, which is
  // the whole bug this fixes) safe to retry: it is recognised as already
  // complete and never re-uploaded as a duplicate set.
  const existingCount = countUploadedPhotoCards(doc);
  if (existingCount === total) {
    report("filling", { detail: `Photos already uploaded (${total} of ${total}) — skipping re-upload.` });
    logPhotoStage("stage 12: Vinted thumbnail detection begins (already present)", "batch", total);
    return waitForPhotoCardsConfirmed(doc, total);
  }
  if (existingCount > 0 && existingCount < total) {
    return { ok: false, reason: `PHOTO_COUNT_MISMATCH: ${existingCount} of ${total} expected photos are already present — refusing to add another full set. Remove the partial photos before retrying.` };
  }
  if (existingCount > total) {
    return { ok: false, reason: `PHOTO_COUNT_MISMATCH: ${existingCount} photos are present but only ${total} were expected — stopping rather than guessing which are correct.` };
  }

  const files = [];
  for (let index = 0; index < orderedPhotos.length; index++) {
    const photo = orderedPhotos[index];
    const label = `photo ${index + 1} of ${total}`;
    logPhotoStage("stage 1: content script starting download", photo.position);
    // Follow-up correction (message-lifecycle hang bug): progress reporting
    // added so the UI can show "Downloading photo N of M" / "Uploading
    // photo N of M" — this is purely informational (forwarded to the side
    // panel via ITEM_STEP_PROGRESS's new `detail` field) and never
    // disguises a genuinely stuck request: it reports once per photo, not
    // on a repeating timer, so a hang still shows no further progress and
    // is still caught by requestPhoto's own bounded timeout.
    report("filling", { detail: `Downloading ${label}` });

    let result;
    try { result = await requestPhoto(item.itemId, photo.position); }
    catch (error) { return { ok: false, reason: `NETWORK: could not download photo at position ${photo.position} (${error?.name || "Error"}: ${String(error?.message || error)}).` }; }
    if (!result || !result.ok) return { ok: false, reason: (result && result.reason) || `NETWORK: could not download photo at position ${photo.position}.` };
    if (result.position !== photo.position) return { ok: false, reason: `MISMATCH: requested photo ${photo.position} but received photo ${result.position}.` };

    let bytes;
    try {
      const binary = win.atob(result.base64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch (error) {
      return { ok: false, reason: `INVALID: could not reconstruct photo ${photo.position} from its transferred bytes (${error?.name || "Error"}: ${String(error?.message || error)}).` };
    }
    files.push(new FileImpl([bytes], safeFileName(result.fileName, photo.position, result.mimeType), { type: result.mimeType }));
    logPhotoStage("stage 10: File reconstructed", photo.position);
    // "Uploading" here is this photo's local processing completing and
    // being staged for the batch file-input assignment below — Vinted has
    // no separate per-photo upload call, so this is the closest honest
    // user-facing signal that photo N is done and the next one is starting.
    report("filling", { detail: `Uploading ${label}` });
  }

  const dataTransfer = new DataTransferImpl();
  for (const file of files) dataTransfer.items.add(file);
  // Standard browser trick for simulating a file-input selection — real
  // Chrome accepts direct assignment of a genuine DataTransfer's FileList.
  // Test environments (jsdom) don't implement real DataTransfer/FileList
  // typing strictly enough to accept that assignment, so this falls back
  // to defining an own "files" property (which every environment,
  // including real Chrome, honours when the input is later read) —
  // functionally equivalent, never a behaviour change for the real page.
  try { input.files = dataTransfer.files; }
  catch { Object.defineProperty(input, "files", { value: dataTransfer.files, configurable: true }); }
  // Both events, matching setNativeValue's own convention elsewhere in this
  // file — never assume which one a given framework's change handler listens for.
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  logPhotoStage("stage 11: file input received the files", "batch", files.length);

  logPhotoStage("stage 12: Vinted thumbnail detection begins", "batch", files.length);
  const result = await waitForPhotoCardsConfirmed(doc, total);
  if (!result.ok) return result;
  logPhotoStage("stage 12: Vinted thumbnail detection completed", "batch", files.length);
  return { ok: true };
}

// Follow-up correction (idempotent-retry rewrite): shared by Description
// and Price. Checks the field's CURRENT value first — an already-correct
// value (the common retry case, once photos/earlier fields are already
// confirmed) is left untouched and never re-typed; a different existing
// value is safely replaced (setNativeValue always overwrites the whole
// value, never appends/merges) — exactly like stepSetTitle's own
// idempotency, which this mirrors.
export async function stepSetText(root, strategy, value, { win }, { step = "SET_TEXT", isMatch = strictValueMatch } = {}) {
  const found = resolveVerifiedField(root, strategy);
  if (!found.ok) return { ok: false, reason: found.reason };
  // Idempotent retry pre-check AND (for Price) recognition of Vinted's own
  // currency reformatting both go through the SAME comparator — a value
  // already correct by this measure is never re-typed.
  if (isMatch(found.element.value, value)) return { ok: true };
  setNativeValue(found.element, value, win);
  const confirmed = await waitFor(() => isMatch(found.element.value, value));
  if (!confirmed) {
    return {
      ok: false,
      reason: buildFieldTimeoutReason({
        step, field: strategy.id, selector: strategy.testId ? `[data-testid="${strategy.testId}"]` : `#${strategy.id}`,
        expected: value, observed: found.element.value,
        cause: "the field's live value never matched the expected value",
      }),
    };
  }
  return { ok: true };
}

/**
 * Follow-up correction (title-field NOT_FOUND bug) — root cause: exactly
 * the same class of bug already fixed for the photo input/grid (see
 * stepUploadPhotos's own comment) — the verified Title input is confirmed
 * NOT rendered inside any <form> element on the live page at all (its
 * only two <form>s are the header's search bar), so
 * resolveVerifiedField(root, ...)'s form-root scoping could never find it,
 * regardless of whether a title was ever entered. There is no
 * click-to-reveal row, dialog, or drawer to locate first — verified
 * directly against a live, signed-in session: it is a completely ordinary,
 * always-editable text input, and a plain native-setter value change
 * persists with no further confirm/apply action required (see
 * resolveTitleInput's own comment in vinted-fields.js for the full
 * verified DOM contract).
 *
 * Idempotent: the field's CURRENT value is checked first — an already-
 * correct title (the exact case that makes a previously-failed item safe
 * to retry once photos are already confirmed) is left untouched and never
 * re-typed; a different existing title is replaced (setNativeValue always
 * overwrites the whole value, never appends/merges).
 */
export async function stepSetTitle(item, { doc, win }) {
  const found = resolveTitleInput(doc);
  if (!found.ok) return { ok: false, reason: found.reason };
  const input = found.element;

  if (input.value === item.title) return { ok: true }; // already correct — skip re-typing entirely

  setNativeValue(input, item.title, win); // overwrites whatever was there, including a different existing title
  const confirmed = await waitFor(() => input.value === item.title);
  if (!confirmed) {
    return {
      ok: false,
      reason: buildFieldTimeoutReason({
        prefix: "UNVERIFIED", step: "SET_TITLE", field: "title", selector: TITLE_INPUT_SELECTOR,
        expected: item.title, observed: input.value,
        cause: "the field's live value never matched the expected value",
      }),
    };
  }
  return { ok: true };
}

// ---- Dialog-picker framework (category/brand/size/condition/colour/material) --
//
// Verified: each of these fields opens a modal dialog (its own opening
// field, e.g. #category / data-testid="catalog-select-dropdown-input"),
// is closed via its own dedicated close button, and is confirmed via the
// ONE shared save button (data-testid="input-dropdown-save-button").
// Vinted RERENDERS the form after every dialog save — every step below
// re-queries the DOM afterwards rather than reusing a reference captured
// before the save, and verifies the value the CLOSED field now displays
// before ever reporting success.

// How long to wait for a category-DEPENDENT field's own opener
// (brand/size/condition/colour/material) to actually exist in the DOM —
// Vinted rerenders the form after the category dialog is saved, and that
// rerender isn't necessarily synchronous with the save click completing.
// Deliberately shorter than STEP_TIMEOUT_MS: this is "give a rerender a
// moment", not "wait for a slow network op" (that's what the dialog's own
// internal waits, e.g. for search results, already use the full budget
// for) — keeping it short also keeps a genuinely MISSING field's 3
// retries (see MAX_STEP_RETRIES) from taking unreasonably long to fail.
const DEPENDENT_FIELD_TIMEOUT_MS = 3000;

/** Follow-up correction (root-scoping rewrite): opens the dropdown by clicking its verified opener, then waits for its CONTENT container (`contentTestId`) to appear — never a close button, which doesn't exist on the real page (see this section's own top comment). */
async function openDialogPicker(root, fieldConfig, deps, stepName = "unknown") {
  let lastResult = null;
  const openerEl = await waitFor(() => {
    lastResult = resolveVerifiedField(root, { id: fieldConfig.openId, testId: fieldConfig.openTestId });
    return lastResult.ok ? lastResult.element : null;
  }, { timeoutMs: DEPENDENT_FIELD_TIMEOUT_MS });
  if (!openerEl) return { ok: false, reason: lastResult?.reason ?? `NOT_FOUND: ${fieldConfig.openId} field did not appear.` };
  safeClick(openerEl, stepName);
  const opened = await waitFor(() => {
    const content = deps.doc.querySelector(`[data-testid="${fieldConfig.contentTestId}"]`);
    return content && isVisible(content);
  });
  if (!opened) return { ok: false, reason: `TIMEOUT: ${fieldConfig.openId} dialog did not open.` };
  return { ok: true };
}

/**
 * Follow-up correction (dialog-interaction rewrite) — root cause: this
 * used to click a shared `input-dropdown-save-button` to close every
 * dialog, but that control does not exist anywhere on the real page.
 * Verified live: single-select dialogs (category/brand/size/condition)
 * close THEMSELVES the instant a matching option is clicked — by the time
 * this runs there is nothing left to click, only the CONTENT container's
 * disappearance to wait for. Multi-select callers (colour/material) click
 * an outside element to close (see stepSelectMultiOptions) BEFORE calling
 * this, so the same "wait for content gone" check applies uniformly here
 * either way. Re-queries the DOM to verify `expectedValueCheck()` (the
 * CLOSED field's displayed value) before ever reporting success — never
 * trusts a stale pre-close reference.
 */
async function confirmDialogPicker(fieldConfig, deps, expectedValueCheck, diag = {}) {
  const { doc } = deps;
  const closed = await waitFor(() => {
    const content = doc.querySelector(`[data-testid="${fieldConfig.contentTestId}"]`);
    return !content || !isVisible(content);
  });
  if (!closed) return { ok: false, reason: `TIMEOUT: ${fieldConfig.openId} dialog did not close after selecting.` };

  if (expectedValueCheck) {
    const verified = await waitFor(expectedValueCheck);
    if (!verified) {
      const observedField = resolveVerifiedField(doc, { id: fieldConfig.openId, testId: fieldConfig.openTestId });
      const observed = observedField.ok ? (observedField.element.value || getAccessibleName(observedField.element)) : "(field not found)";
      return {
        ok: false,
        reason: buildFieldTimeoutReason({
          prefix: "UNVERIFIED", step: diag.step ?? fieldConfig.openId, field: diag.field ?? fieldConfig.openId,
          selector: fieldConfig.openTestId ? `[data-testid="${fieldConfig.openTestId}"]` : `#${fieldConfig.openId}`,
          expected: diag.expected, observed,
          cause: "the field's displayed value did not match after the dialog closed",
        }),
      };
    }
  }
  return { ok: true };
}

/** True once the given field (by verified id/testId) is resolvable and its displayed value/accessible-name contains `expectedText` — the standard "re-query after rerender, verify before advancing" check every single-select dialog step ends with, and also the idempotent-retry "is this already correct" pre-check. */
function fieldDisplaysText(doc, fieldConfig, expectedText) {
  const field = resolveVerifiedField(doc, { id: fieldConfig.openId, testId: fieldConfig.openTestId });
  if (!field.ok) return false;
  const displayed = normaliseText(field.element.value || getAccessibleName(field.element));
  return displayed.includes(normaliseText(expectedText));
}

/**
 * True once the given multi-select field displays EXACTLY the target set
 * of values (order-independent, but never a subset/superset) — used for
 * colour/material's idempotent-retry pre-check. A plain substring check
 * (fieldDisplaysText) isn't safe here: "Black" would still match a field
 * displaying "Black, White, Grey", incorrectly treating an over-broad
 * existing selection as already correct.
 */
function fieldDisplaysExactSet(doc, fieldConfig, values) {
  const field = resolveVerifiedField(doc, { id: fieldConfig.openId, testId: fieldConfig.openTestId });
  if (!field.ok) return false;
  const currentParts = (field.element.value || "").split(",").map(normaliseText).filter(Boolean);
  const targetParts = values.map(normaliseText);
  if (currentParts.length !== targetParts.length) return false;
  const currentSet = new Set(currentParts);
  return targetParts.every(t => currentSet.has(t));
}

/** Waits until at least one visible candidate matches `predicate`, then re-queries and requires EXACTLY one — ambiguity is a failure, never a silent "pick the first". */
async function waitThenRequireUniqueMatch(doc, candidateSelector, predicate, description) {
  const appeared = await waitFor(() => Array.from(doc.querySelectorAll(candidateSelector)).some(el => isVisible(el) && predicate(el)));
  if (!appeared) return { ok: false, reason: `NOT_FOUND: ${description}` };
  const candidates = Array.from(doc.querySelectorAll(candidateSelector)).filter(el => isVisible(el) && predicate(el));
  return requireUnique(candidates, description);
}

// ---- Structure-agnostic multi-select option discovery (Material still
// NOT_FOUND despite being visibly present — follow-up correction) ----------
//
// Confirmed regression: the PREVIOUS virtualised-scrolling fix reached the
// correct open dropdown, but its option discovery still assumed ONE
// specific guessed shape — [data-testid^="material-"][role="button"]
// matched by computed ACCESSIBLE NAME — carried over unchanged from the
// original verified capture. The live failure report ("NOT_FOUND ...
// Suede ... searched the full scrollable dropdown ... no match", with
// screenshots showing Suede genuinely visible and selectable) proves that
// exact shape no longer reliably describes Vinted's real current Material
// rows, or that the accessible-name computation no longer reflects what a
// user actually sees.
//
// IMPORTANT LIMITATION, disclosed rather than silently worked around: no
// authenticated Vinted session was available in this environment this
// session, so the real current DOM could not be captured directly (see
// this fix's own top-level report). Guessing a SECOND specific shape would
// risk reproducing exactly this failure mode again the next time Vinted's
// markup drifts. Discovery below is instead STRUCTURE-AGNOSTIC: any
// visible role="button"/"checkbox"/"option" element inside the verified
// OPEN dropdown's own content container counts as a candidate row,
// matched by its own rendered VISIBLE TEXT (never solely the computed
// accessible name, which can diverge from what a user reads if a nested
// icon/badge/control contributes its own name) — see optionRowVisibleText.
// The original, already-verified data-testid-prefixed shape is still
// included as one of the candidate sources (findOptionRows), so nothing
// about a still-correctly-shaped picker (e.g. Colour, if its own live
// structure never drifted) changes in practice — it simply keeps matching
// via the same broader collector.
const OPTION_ROW_ROLE_SELECTOR = '[role="button"], [role="checkbox"], [role="option"]';

/**
 * The element's own VISIBLE label — a clone with any nested input/svg/
 * aria-hidden content stripped first, so an embedded checkbox's own
 * (often empty or generic, e.g. "checkbox") accessible name can never
 * pollute the row's real, human-readable text. Falls back to the computed
 * accessible name only when no visible text survives stripping at all.
 */
function optionRowVisibleText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('input, svg, [aria-hidden="true"]').forEach(node => node.remove());
  const text = (clone.textContent || "").trim();
  return text || getAccessibleName(el);
}

/**
 * The row's own checked/selected-state indicator, tried in order:
 *   1. the row itself, if it directly carries role="checkbox" or IS a
 *      checkbox/radio input;
 *   2. a checkbox/radio/role="checkbox" NESTED inside the row;
 *   3. the historically-verified SIBLING convention — a checkbox whose id
 *      is derived from the matched row's own `${idPrefix}-<N>` id (e.g.
 *      "material-149" -> "material-checkbox-149"). Preserved deliberately:
 *      this is the ALREADY-VERIFIED live shape this feature originally
 *      captured, and is exactly what Colour's own (never reported broken)
 *      structure still uses — dropping it would have broken Colour
 *      selection while "fixing" Material, the opposite of the explicit
 *      "do not break Colour" requirement.
 * Returns null only if none of the three apply — an honest, never-guessed
 * UNVERIFIED signal, never a silent assumption.
 */
function findSelectionIndicator(doc, el, idPrefix) {
  if (el.getAttribute("role") === "checkbox" || (el.matches && el.matches('input[type="checkbox"], input[type="radio"]'))) return el;
  const nested = el.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"]');
  if (nested) return nested;
  if (idPrefix && el.id) {
    const match = new RegExp(`^${idPrefix}-(\\d+)$`).exec(el.id);
    if (match) {
      const sibling = doc.getElementById(`${idPrefix}-checkbox-${match[1]}`);
      if (sibling) return sibling;
    }
  }
  return null;
}
function isIndicatorChecked(el) {
  if (!el) return false;
  if ("checked" in el) return Boolean(el.checked);
  return el.getAttribute("aria-checked") === "true";
}

/**
 * Every candidate option row currently rendered inside `contentEl` — the
 * verified data-testid-prefixed shape AND the broader role-based
 * fallback, deduplicated by node identity (a row matching both never
 * counts twice). Always a FRESH query against the live DOM, never
 * cached — every caller (checked-state detection, the search below,
 * post-click confirmation) sees the CURRENT render, including across a
 * virtualised rerender that swaps every node out from under a stale
 * reference.
 */
function findOptionRows(doc, contentEl, idPrefix) {
  const legacy = Array.from(contentEl.querySelectorAll(`[data-testid^="${idPrefix}-"][role="button"]`));
  const generic = Array.from(contentEl.querySelectorAll(OPTION_ROW_ROLE_SELECTOR));
  const seen = new Set();
  const rows = [];
  for (const el of [...legacy, ...generic]) {
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    rows.push(el);
  }
  return rows;
}

// ---- Duplicate-representation collapsing (follow-up correction: colour
// AMBIGUOUS despite the two matches being the same logical colour) --------
//
// Confirmed regression: `AMBIGUOUS: color option exactly matching
// "Mustard" (2 matches)` / "Light blue" (2 matches). Vinted renders the
// SAME logical colour twice inside one open Colour dropdown — once in a
// "Suggested" section, again in the full list — both genuine, real,
// clickable rows with identical exact visible text. This was never a
// fuzzy-matching problem: exact, normalised (trim/collapse-whitespace/
// case-insensitive) matching is completely unchanged by this section. The
// only thing that changes is what happens AFTER an exact-match search
// legitimately finds more than one candidate.
//
// This mirrors the ALREADY-SHIPPED, verified-live Size fix exactly (see
// resolveSizeOption/extractSizeOptionId above — confirmed live for UK size
// "3": `size-suggestions-grid-option-56` vs `size-group-7-grid-option-56`,
// both sharing the trailing underlying option id "56"). Vinted's own
// consistent convention on this page is "one canonical numeric option id,
// reused verbatim as the trailing segment of every UI wrapper's own
// id/data-testid, however many places that value is rendered."
//
// IMPORTANT LIMITATION, disclosed rather than silently worked around: no
// authenticated session available this session ever rendered a Colour
// "Suggested" section — Vinted's photo-based colour suggestion appears to
// be computed only once a draft is genuinely saved (never observed live
// during editing, including after uploading test photos and waiting), and
// creating a real saved draft purely to capture that one shape was outside
// this fix's authorised scope ("do not save or publish"). The CURRENT
// (non-suggested) Colour row shape WAS re-confirmed live this session —
// `id="color-<N>"`, `data-testid="color-<N>"`, `role="button"` — and is
// completely unchanged by this fix. The Suggested row's exact wrapper
// naming is therefore never hardcoded as one single guess: the id
// extraction below accepts ANY wrapper id/data-testid ending in
// "-<digits>", checked against the row itself, the row's own data-testid,
// AND its nearest data-testid-bearing ancestor — covering both a bare-id
// shape (like Colour's own, confirmed live) and a wrapper-around-the-row
// shape (like Size's, also confirmed live). If Vinted's real Suggested
// shape ever encodes the id differently, two matches whose ids can't both
// be extracted AND found equal correctly fall through to the same
// AMBIGUOUS failure this always had — this can only ever fail safe, never
// silently collapse two genuinely different colours.
const DUPLICATE_OPTION_ID_PATTERN = /-(\d+)$/;
const SUGGESTED_HINT_PATTERN = /suggest/i;

/**
 * The row's own underlying numeric option id — tried against the row's own
 * `id`, the row's own `data-testid`, and its nearest data-testid-bearing
 * ancestor, in that order. Never guessed beyond that: null (never a
 * fabricated id) if none of the three end in "-<digits>".
 */
function extractOptionEntityId(el) {
  const ownId = DUPLICATE_OPTION_ID_PATTERN.exec(el.id || "");
  if (ownId) return ownId[1];
  const ownTestId = DUPLICATE_OPTION_ID_PATTERN.exec(el.getAttribute("data-testid") || "");
  if (ownTestId) return ownTestId[1];
  const wrapper = el.closest("[data-testid]");
  const wrapperTestId = wrapper ? DUPLICATE_OPTION_ID_PATTERN.exec(wrapper.getAttribute("data-testid") || "") : null;
  return wrapperTestId ? wrapperTestId[1] : null;
}

/**
 * Broad, text-based "is this the Suggested representation" hint, checked
 * against the row's own id/data-testid and its nearest data-testid
 * ancestor's own data-testid/class — since the exact wrapper shape Vinted
 * uses for a Suggested chip was never directly observed live (see this
 * section's own top comment). Only ever used to choose WHICH of two
 * provably-identical rows to click — never to decide whether they ARE the
 * same option; that decision is extractOptionEntityId's alone.
 */
function looksLikeSuggestedRow(el) {
  const wrapper = el.closest("[data-testid]") || el;
  const haystack = [el.id, el.getAttribute("data-testid"), wrapper.getAttribute("data-testid"), wrapper.className]
    .filter(Boolean).join(" ");
  return SUGGESTED_HINT_PATTERN.test(haystack);
}

/**
 * Collapses `matches` (every row whose OWN visible text already exactly,
 * normalised-matches the target — see optionRowVisibleText/normaliseText;
 * completely untouched by this function) down to ONE row to act on:
 *   - 0 or 1 matches: unchanged, exactly the pre-existing requireUnique
 *     behaviour.
 *   - >1 matches: collapsed to ONE only when EVERY match's own
 *     extractOptionEntityId is known AND identical — proving they're
 *     duplicate representations of one logical option (e.g. a Suggested
 *     chip mirroring its own full-list entry). The Suggested
 *     representation is preferred when exactly one match looks like it
 *     (per requirement 5); otherwise the first match is used — with ids
 *     already proven identical, it makes no functional difference which
 *     literal DOM node is clicked. If the ids disagree, or any can't be
 *     extracted at all, this is a genuine, unresolved ambiguity —
 *     AMBIGUOUS, with full diagnostics for every candidate, exactly the
 *     pre-existing failure mode for a real conflict.
 */
function resolveDuplicateOptionMatches(matches, description) {
  if (matches.length <= 1) return requireUnique(matches, description);

  const candidates = matches.map(el => ({ element: el, optionId: extractOptionEntityId(el), suggested: looksLikeSuggestedRow(el) }));
  const ids = new Set(candidates.map(c => c.optionId));
  const allIdsKnownAndEqual = !ids.has(null) && ids.size === 1;

  if (!allIdsKnownAndEqual) {
    const diagnostics = candidates.map(c =>
      `[${c.element.closest("[data-testid]")?.getAttribute("data-testid") ?? c.element.id ?? "no-id"}] optionId=${c.optionId ?? "unknown"} suggested=${c.suggested}`,
    ).join("; ");
    return { ok: false, reason: `AMBIGUOUS: ${description} (${candidates.length} matches, not provably the same underlying option — ${diagnostics})` };
  }

  const suggestedOnes = candidates.filter(c => c.suggested);
  const preferred = suggestedOnes.length === 1 ? suggestedOnes[0] : candidates[0];
  return { ok: true, element: preferred.element };
}

// ---- Safe search diagnostics (never full page content, credentials or
// tokens — only counts/booleans/scroll positions, per the explicit
// diagnostics requirement) ---------------------------------------------
function newSearchDiagnostics() {
  return { dropdownFound: false, rowsInspected: 0, textObserved: false, controlResolved: false, startScrollTop: null, finalScrollTop: null };
}
function describeSearchDiagnostics(diag) {
  return `dropdown_found=${diag.dropdownFound} rows_inspected=${diag.rowsInspected} text_observed=${diag.textObserved} `
    + `control_resolved=${diag.controlResolved} start_scroll=${diag.startScrollTop ?? "n/a"} final_scroll=${diag.finalScrollTop ?? "n/a"}`;
}

const DROPDOWN_SCROLL_MAX_ATTEMPTS = 30;
// Scrolled by a large fraction of the container's own visible height each
// step (never a fixed pixel amount, which could be wildly wrong for a
// picker taller or shorter than expected) — deliberately less than 100% so
// two consecutive windows always overlap, and an option sitting exactly on
// a step boundary can never be scrolled past without ever being rendered.
const DROPDOWN_SCROLL_STEP_RATIO = 0.8;
const DROPDOWN_SCROLL_MIN_STEP_PX = 100;
// How long a rerender is given to settle after each scroll before the DOM
// is re-queried — short, since this is "let a virtualised list's own
// render commit", not a network wait.
const DROPDOWN_SCROLL_SETTLE_MS = 200;
const DROPDOWN_SCROLL_TIMEOUT_MS = 15000;

/**
 * Finds the element that actually scrolls within `root` (`root` itself, or
 * the first descendant whose rendered content genuinely overflows its own
 * box) — never the whole page. A real scroll container's `scrollHeight`
 * exceeds its `clientHeight`; `root` itself is returned as a safe fallback
 * if no descendant qualifies (scrollTop assignment on a non-overflowing
 * element is a harmless no-op, never an error), so a caller never crashes
 * on an unexpectedly non-scrollable picker — it simply won't find anything
 * new by "scrolling" it, which the caller's own progress-detection already
 * treats as reaching the end.
 */
function findScrollableDescendantOrSelf(root) {
  const candidates = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of candidates) {
    if (typeof el.scrollHeight === "number" && typeof el.clientHeight === "number" && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return root;
}

/**
 * Searches `contentEl` — the verified OPEN dropdown's own content
 * container, never anything document-wide (per the explicit "search only
 * inside the verified open Material dropdown" requirement) — for a row
 * whose VISIBLE TEXT exactly matches `targetText` (case/whitespace
 * normalised — never partial/fuzzy matching, never a substitute value).
 * Inspects whatever's currently rendered FIRST (covers both a
 * non-virtualised list and a virtualised one already scrolled to the
 * right place); if nothing matches, scrolls the picker's own scroll
 * container incrementally FROM THE TOP, re-querying fresh after every
 * scroll (see findOptionRows), until the row appears or the genuine end
 * of the list is reached. Bounded three independent ways: a fixed attempt
 * ceiling, a wall-clock timeout, and progress detection (two consecutive
 * no-progress scrolls end the search). On failure, the returned reason
 * carries the full safe diagnostics (see describeSearchDiagnostics).
 */
async function findMultiSelectOptionRow(doc, contentEl, idPrefix, targetText) {
  const diag = newSearchDiagnostics();
  diag.dropdownFound = Boolean(contentEl) && isVisible(contentEl);
  if (!diag.dropdownFound) {
    return { ok: false, reason: `NOT_FOUND: ${idPrefix} option exactly matching "${targetText}" (${describeSearchDiagnostics(diag)}).` };
  }

  const target = normaliseText(targetText);
  function inspectCurrent() {
    const rows = findOptionRows(doc, contentEl, idPrefix);
    diag.rowsInspected = Math.max(diag.rowsInspected, rows.length);
    const matches = rows.filter(el => normaliseText(optionRowVisibleText(el)) === target);
    if (matches.length > 0) diag.textObserved = true;
    return matches;
  }

  let found = inspectCurrent();
  if (found.length > 0) { diag.controlResolved = true; return resolveDuplicateOptionMatches(found, `${idPrefix} option exactly matching "${targetText}"`); }

  const scrollEl = findScrollableDescendantOrSelf(contentEl);
  diag.startScrollTop = scrollEl.scrollTop;

  // Always start the search from the top — a dropdown left scrolled from a
  // previous field/retry must not skip options above its current position.
  if (scrollEl.scrollTop !== 0) {
    scrollEl.scrollTop = 0;
    scrollEl.dispatchEvent(new doc.defaultView.Event("scroll", { bubbles: true }));
    await pause(DROPDOWN_SCROLL_SETTLE_MS);
    found = inspectCurrent();
    if (found.length > 0) { diag.controlResolved = true; diag.finalScrollTop = scrollEl.scrollTop; return resolveDuplicateOptionMatches(found, `${idPrefix} option exactly matching "${targetText}"`); }
  }

  const deadline = Date.now() + DROPDOWN_SCROLL_TIMEOUT_MS;
  let lastScrollTop = scrollEl.scrollTop;
  let noProgressStreak = 0;

  for (let attempt = 0; attempt < DROPDOWN_SCROLL_MAX_ATTEMPTS; attempt++) {
    if (Date.now() >= deadline) break;

    const step = Math.max(scrollEl.clientHeight * DROPDOWN_SCROLL_STEP_RATIO, DROPDOWN_SCROLL_MIN_STEP_PX);
    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    scrollEl.scrollTop = Math.min(scrollEl.scrollTop + step, maxScrollTop);
    scrollEl.dispatchEvent(new doc.defaultView.Event("scroll", { bubbles: true }));
    await pause(DROPDOWN_SCROLL_SETTLE_MS);

    found = inspectCurrent(); // fresh query every attempt — never a stale reference from before this scroll
    if (found.length > 0) { diag.controlResolved = true; diag.finalScrollTop = scrollEl.scrollTop; return resolveDuplicateOptionMatches(found, `${idPrefix} option exactly matching "${targetText}"`); }

    const newScrollTop = scrollEl.scrollTop;
    if (newScrollTop <= lastScrollTop) {
      noProgressStreak += 1;
      if (noProgressStreak >= 2) break; // two consecutive no-progress scrolls — the genuine end of the list
    } else {
      noProgressStreak = 0;
    }
    lastScrollTop = newScrollTop;
  }

  diag.finalScrollTop = scrollEl.scrollTop;
  return { ok: false, reason: `NOT_FOUND: ${idPrefix} option exactly matching "${targetText}" (searched the full scrollable dropdown from top to bottom, no match — ${describeSearchDiagnostics(diag)}).` };
}

// ---- Size — duplicate-representation collapsing (follow-up correction) ----
//
// Root cause: Vinted can render the SAME underlying size in more than one
// section of the size picker, using TWO DIFFERENT wrapper data-testid
// shapes for the two sections — confirmed live for UK size "3":
//   size-suggestions-grid-option-56   <- Suggested section (NO groupId segment at all)
//   size-group-7-grid-option-56       <- full Footwear/Clothing list
// Both wrap the SAME underlying Vinted size-option id ("56") — the exact
// same "one canonical id, multiple UI representations" pattern already
// verified for category ids on this same page (see stepSelectCategory's
// own comment on `catalog-search-<id>-result` vs `catalog-icon-<id>` both
// referring to the same category). The full data-testid is NEVER compared
// directly — the prefixes are deliberately different — only the trailing
// <optionId> segment is the underlying identity. Two options that share a
// label but do NOT share an optionId (or whose id can't be extracted by
// EITHER pattern) are genuinely different sizes and are never collapsed —
// this fails AMBIGUOUS with full diagnostics instead, never a guess.
const SIZE_SUGGESTED_OPTION_PATTERN = /^size-suggestions-grid-option-([^-]+)$/;
const SIZE_GROUP_OPTION_PATTERN = /^size-group-[^-]+-grid-option-([^-]+)$/;

/** Extracts the underlying Vinted size-option id from a wrapper's data-testid, trying BOTH verified live shapes — returns null (never guesses) if neither pattern matches. */
function extractSizeOptionId(testId) {
  if (!testId) return null;
  return (SIZE_SUGGESTED_OPTION_PATTERN.exec(testId) ?? SIZE_GROUP_OPTION_PATTERN.exec(testId))?.[1] ?? null;
}

function describeSizeOptionCandidate(el) {
  const wrapper = el.closest("[data-testid]");
  const testId = wrapper ? wrapper.getAttribute("data-testid") : null;
  const suggested = Boolean(testId) && SIZE_SUGGESTED_OPTION_PATTERN.test(testId);
  const grouped = Boolean(testId) && SIZE_GROUP_OPTION_PATTERN.test(testId);
  return {
    element: el,
    testId,
    optionId: extractSizeOptionId(testId),
    suggested,
    section: suggested ? "Suggested" : grouped ? "Footwear" : "unknown",
    visible: isVisible(el),
    enabled: el.getAttribute("aria-disabled") !== "true",
  };
}

/**
 * Resolves the Size option matching `expectedSizeText` EXACTLY. If more
 * than one match exists, they are collapsed into ONE logical option ONLY
 * when every match's extracted `optionId` is present AND identical
 * (proving they're the same size, e.g. a Suggested chip duplicating its
 * own Footwear grid entry) — in that case the candidate from
 * `size-suggestions-grid-option-*` is preferred and clicked, matching what
 * a human would naturally pick first. If the matches do NOT all share one
 * optionId (or an id couldn't be extracted for one of them at all — an
 * unrecognised test-id shape), this fails AMBIGUOUS with full diagnostics
 * for every candidate — never guesses, never "first match wins".
 */
function resolveSizeOption(doc, expectedSizeText) {
  const target = normaliseText(expectedSizeText);
  const matches = Array.from(doc.querySelectorAll('[role="checkbox"]')).filter(el => isVisible(el) && normaliseText(getAccessibleName(el)) === target);
  if (matches.length === 0) return { ok: false, reason: `NOT_FOUND: size option exactly matching "${expectedSizeText}"` };

  const candidates = matches.map(describeSizeOptionCandidate);
  if (candidates.length === 1) return { ok: true, element: candidates[0].element };

  const optionIds = new Set(candidates.map(c => c.optionId));
  const allIdsKnownAndEqual = !optionIds.has(null) && optionIds.size === 1;

  if (!allIdsKnownAndEqual) {
    const diagnostics = candidates.map(c =>
      `[${c.testId ?? "no-testid"}] section="${c.section}" optionId=${c.optionId ?? "unknown"} visible=${c.visible} enabled=${c.enabled}`,
    ).join("; ");
    return { ok: false, reason: `AMBIGUOUS: size option exactly matching "${expectedSizeText}" (${candidates.length} matches, not provably the same underlying size — ${diagnostics})` };
  }

  // Every match shares the same underlying optionId — provably one
  // logical size. Prefer the Suggested copy (size-suggestions-grid-option-*).
  const preferred = candidates.find(c => c.suggested) ?? candidates[0];
  return { ok: true, element: preferred.element };
}

/** Waits for at least one matching size option to appear, then resolves it via resolveSizeOption's duplicate-aware logic (never a bare requireUnique — see that function's own comment on why two matches aren't automatically ambiguous). */
async function waitForSizeOption(doc, expectedSizeText) {
  const target = normaliseText(expectedSizeText);
  const appeared = await waitFor(() => Array.from(doc.querySelectorAll('[role="checkbox"]')).some(el => isVisible(el) && normaliseText(getAccessibleName(el)) === target));
  if (!appeared) return { ok: false, reason: `NOT_FOUND: size option exactly matching "${expectedSizeText}"` };
  return resolveSizeOption(doc, expectedSizeText);
}

/**
 * Category — the one dialog field where the app already holds the exact
 * verified target id (`item.vintedCategoryId`), so this never matches by
 * text at all: it types the leaf category name into the verified search
 * box, then waits for and selects the SEARCH RESULT whose id is EXACTLY
 * `catalog-search-${vintedCategoryId}-result` (per the verified
 * requirement to check that specific id, not merely a name match).
 *
 * Follow-up correction (dialog-interaction rewrite) — two independent
 * fixes verified directly against a live, signed-in session: (1) a
 * category SEARCH result's real id is `catalog-search-<id>-result`
 * (clickable) with a paired radio `catalog-search-<id>-radio` — NOT the
 * previously-assumed bare `catalog-<id>` / `<id>-catalog-radio`; (2)
 * clicking a search result immediately commits the value AND auto-closes
 * the picker, which un-mounts the radio almost immediately — waiting for
 * that radio's `.checked` to become `true` after the click is a race that
 * always loses in practice (confirmed: the radio is already gone by the
 * time it's checked). The ONLY reliable post-click signal is the
 * category field's OWN displayed value, which is exactly what
 * confirmDialogPicker's expectedValueCheck already verifies — so that
 * check alone is now the sole confirmation, both for a fresh selection
 * and for the idempotent-retry pre-check below.
 */
export async function stepSelectCategory(root, item, deps) {
  const { doc, win } = deps;
  const config = VINTED_FIELD_STRATEGIES.category;
  const leafName = item.vintedCategoryPath.split(">").pop().trim();

  if (fieldDisplaysText(doc, config, leafName)) return { ok: true }; // idempotent: already correct — never re-opens the picker

  const opened = await openDialogPicker(root, config, deps, "SET_CATEGORY");
  if (!opened.ok) return opened;

  const searchFound = resolveVerifiedField(doc, { id: config.searchId });
  if (searchFound.ok) setNativeValue(searchFound.element, leafName, win);

  const resultId = `catalog-search-${item.vintedCategoryId}-result`;
  const resultAppeared = await waitFor(() => {
    const el = doc.getElementById(resultId);
    return el && isVisible(el);
  });
  if (!resultAppeared) return { ok: false, reason: `NOT_FOUND: category result #${resultId} ("${leafName}") did not appear in the picker.` };
  safeClick(doc.getElementById(resultId), "SET_CATEGORY");

  // Confirms category's OWN displayed value — exactly like every other
  // dialog step — rather than depending on the brand field's existence.
  // "Wait for the category-dependent controls" (see this file's own top
  // comment) is instead the responsibility of stepSelectBrand's own
  // openDialogPicker call (via DEPENDENT_FIELD_TIMEOUT_MS above): coupling
  // category's own success to brand's existence would wrongly fail
  // SET_CATEGORY (not SET_BRAND) whenever brand happens to be genuinely
  // absent, and would need to wait out the full retry budget twice over.
  return confirmDialogPicker(config, deps, () => fieldDisplaysText(doc, config, leafName), { step: "SET_CATEGORY", field: "category", expected: leafName });
}

/**
 * Brand — free text, no ID table possible (Vinted has thousands); searches,
 * then requires an EXACT accessible-name match (never partial — see this
 * file's own top comment), deriving the paired radio id from whichever
 * result actually matched.
 *
 * Follow-up correction (dialog-interaction rewrite) — two independent
 * fixes verified live: (1) brand search-result options carry NO
 * data-testid at all (only a plain `id="brand-<id>"` with `role="button"`)
 * — the previous `[data-testid^="brand-"]` selector matched nothing;
 * fixed to match by `id` instead. (2) exactly like category, clicking a
 * result auto-closes the picker and un-mounts its radio almost
 * immediately, so waiting for `brand-radio-<id>`'s `.checked` after the
 * click is the same losing race — removed in favour of
 * confirmDialogPicker's post-close displayed-value check alone.
 */
export async function stepSelectBrand(root, item, deps) {
  const { doc, win } = deps;
  const config = VINTED_FIELD_STRATEGIES.brand;

  if (fieldDisplaysText(doc, config, item.brand)) return { ok: true }; // idempotent: already correct

  const opened = await openDialogPicker(root, config, deps, "SET_BRAND");
  if (!opened.ok) return opened;

  const searchFound = resolveVerifiedField(doc, { testId: config.searchTestId });
  if (searchFound.ok) setNativeValue(searchFound.element, item.brand, win);

  const target = normaliseText(item.brand);
  const resolved = await waitThenRequireUniqueMatch(
    doc, '[role="button"][id^="brand-"]',
    el => /^brand-\d+$/.test(el.id) && normaliseText(getAccessibleName(el)) === target,
    `brand result exactly matching "${item.brand}"`,
  );
  if (!resolved.ok) return resolved;
  safeClick(resolved.element, "SET_BRAND");

  return confirmDialogPicker(config, deps, () => fieldDisplaysText(doc, config, item.brand), { step: "SET_BRAND", field: "brand", expected: item.brand });
}

/**
 * Size — a checkbox-role grid where each option's data-testid suffix is an
 * arbitrary internal id (not derivable from anything the app knows), so
 * selection is by EXACT accessible label only — never guessed, never the
 * "nearest" size. Skipped entirely when the item has no ukSize.
 *
 * Follow-up correction (dialog-interaction rewrite): clicking auto-closes
 * the picker, and the matched option element is stale (un-mounted) by the
 * time its `aria-checked` would be re-read — verified live (it reads back
 * "false"/absent, never "true", regardless of the click having genuinely
 * worked). Removed that verification; confirmDialogPicker's post-close
 * displayed-value check is the sole confirmation, and also the
 * idempotent-retry pre-check.
 */
export async function stepSelectSize(root, item, deps) {
  if (!item.ukSize) return { ok: true };
  const { doc } = deps;
  const config = VINTED_FIELD_STRATEGIES.size;

  if (fieldDisplaysText(doc, config, item.ukSize)) return { ok: true }; // idempotent: already correct

  const opened = await openDialogPicker(root, config, deps, "SET_SIZE");
  if (!opened.ok) return opened;

  const resolved = await waitForSizeOption(doc, item.ukSize);
  if (!resolved.ok) return resolved;
  safeClick(resolved.element, "SET_SIZE");

  return confirmDialogPicker(config, deps, () => fieldDisplaysText(doc, config, item.ukSize), { step: "SET_SIZE", field: "size", expected: item.ukSize });
}

// Verified condition -> data-testid mapping, captured directly from the
// live picker — NOT a guess (see this file's own top comment). Vinted's
// own numeric ids for these five options are fixed; the only variable
// part is which one the item's own (freeform) condition text refers to.
const CONDITION_TESTID_BY_NORMALISED_LABEL = {
  "new with tags": "condition-6",
  "new without tags": "condition-1",
  "very good": "condition-2",
  "good": "condition-3",
  "satisfactory": "condition-4",
};

function conditionTestIdFor(rawCondition) {
  const label = normaliseText((rawCondition || "").replace(/condition/i, ""));
  return CONDITION_TESTID_BY_NORMALISED_LABEL[label] ?? null;
}

/** Condition — selected via the verified label -> data-testid mapping above, never by guessing at a "nearest" condition when the item's own condition text doesn't normalise to one of the five verified labels. Idempotent: skips re-opening the picker if the correct condition is already displayed. */
export async function stepSelectCondition(root, item, deps) {
  const { doc } = deps;
  const config = VINTED_FIELD_STRATEGIES.condition;
  const testId = conditionTestIdFor(item.condition);
  if (!testId) return { ok: false, reason: `NOT_FOUND: no verified condition mapping for "${item.condition}".` };

  const expectedText = item.condition.replace(/condition/i, "");
  if (fieldDisplaysText(doc, config, expectedText)) return { ok: true }; // idempotent: already correct

  const opened = await openDialogPicker(root, config, deps, "SET_CONDITION");
  if (!opened.ok) return opened;

  const optionAppeared = await waitFor(() => {
    const el = doc.querySelector(`[data-testid="${testId}"]`);
    return el && isVisible(el);
  });
  if (!optionAppeared) return { ok: false, reason: `NOT_FOUND: condition option [data-testid="${testId}"] did not appear.` };
  safeClick(doc.querySelector(`[data-testid="${testId}"]`), "SET_CONDITION");

  return confirmDialogPicker(config, deps, () => fieldDisplaysText(doc, config, expectedText), { step: "SET_CONDITION", field: "condition", expected: expectedText });
}

/**
 * Shared multi-select driver for colour/material: both use the SAME
 * verified shape — a `[data-testid^="<prefix>-"]` `role="button"` option
 * (verified live: unlike brand, colour/material options DO carry a
 * data-testid matching their id) paired with a checkbox whose id is
 * derivable from the matched option's own id (`<prefix>-<N>` ->
 * `<prefix>-checkbox-<N>`), enforcing `maxCount` when given (colours: at
 * most 2).
 *
 * Follow-up correction (dialog-interaction rewrite):
 * - Idempotent retry: if the field already displays EXACTLY the target
 *   set, the picker is never opened at all.
 * - RECONCILES against whatever's currently selected rather than blindly
 *   clicking every target value — these are TOGGLE checkboxes, so
 *   re-clicking an already-correct one would uncheck it. Anything
 *   currently checked that isn't wanted is deselected first; anything
 *   wanted that isn't already checked is then selected.
 * - Closing: verified live, this dropdown does NOT auto-close after an
 *   option click (so more than one can be picked) and has no dedicated
 *   close/save button — it closes ONLY on a genuine OUTSIDE click.
 *
 * Follow-up correction (invalid-interaction-target safety bug) — root
 * cause: closing used to call `safeClick(doc.body)`, on the (wrong)
 * assumption that a page-level container has no accessible name and is
 * therefore always a safe click target. In fact `getAccessibleName`'s own
 * fallback returns an element's FULL `textContent` when it has children
 * and no more specific name source — for `document.body` that's the
 * entire rendered page's text (confirmed live: ~1.5MB). Routing that
 * through `assertNotForbiddenAction` both (a) embedded the whole page
 * into a thrown safety error, and (b) could false-positive-match a
 * forbidden pattern purely because SOME forbidden word appears somewhere
 * in the page's own text (e.g. the real Upload button's own label),
 * wrongly refusing a click that could never actually have triggered
 * Upload/Publish in the first place.
 *
 * Re-clicking the field's own opener does NOT work as a replacement —
 * verified live and in this file's own test fixtures: this dropdown
 * closes ONLY via a genuine OUTSIDE click; the opener is explicitly
 * excluded from that listener; there is no dedicated close/save button.
 * There is consequently no narrower "specific actionable element" for
 * this particular dismissal gesture — the outside click structurally has
 * to land somewhere outside the dropdown content, which on this page's
 * own root-scoping design (see CREATE_LISTING_FORM_SELECTORS's own
 * comment) means `doc.body` itself.
 *
 * Fixed via `dismissOpenDropdown` (below): still clicks `doc.body`, but
 * bypasses `safeClick`/`getAccessibleName`/`assertNotForbiddenAction`
 * entirely rather than routing a non-actionable dismissal gesture through
 * machinery meant for genuine control activation. This is safe because a
 * plain synthetic click dispatched AT `doc.body` only bubbles UP to
 * body's own ancestors (document, window) during the bubble phase — it
 * can never reach a sibling or descendant control's OWN click handler
 * (such as the real Upload/Publish button), so it can never itself
 * trigger a forbidden publishing action, regardless of what accessible
 * name body would compute to. `assertValidInteractionTarget` (see
 * vinted-fields.js) still independently refuses
 * `document`/`documentElement`/`body`/bare `<html>`/`<body>` for every
 * OTHER caller of `safeClick` in this file — `dismissOpenDropdown` is the
 * sole, narrow, deliberately-documented exception, reserved only for
 * this specific, structurally-safe gesture.
 *
 * REVIEWED (publishing-safety audit — see
 * tests/vinted-extension-publishing-safety.test.ts's own click-site-count
 * assertion, which this function's literal click below is explicitly
 * carved out of, by name, for exactly the structural reason above): this
 * is the ONLY click in this file that intentionally has no
 * assertNotForbiddenAction immediately before it.
 */
function dismissOpenDropdown(doc) {
  doc.body.click(); // deliberately unguarded — see this function's own comment above
}

async function stepSelectMultiOptions(root, config, values, { idPrefix, maxCount }, deps, stepName = "unknown") {
  if (!values || values.length === 0) return { ok: true };
  if (maxCount && values.length > maxCount) return { ok: false, reason: `INVALID: ${values.length} values exceed the maximum of ${maxCount}.` };
  const { doc } = deps;

  if (fieldDisplaysExactSet(doc, config, values)) return { ok: true }; // idempotent: already exactly correct

  const opened = await openDialogPicker(root, config, deps, stepName);
  if (!opened.ok) return opened;

  // Follow-up correction (Material still NOT_FOUND despite being visibly
  // present) — content container resolved ONCE here and threaded through
  // every helper below, so every discovery/reconciliation/confirmation
  // step is explicitly scoped to the verified OPEN dropdown, never
  // document-wide.
  const contentEl = doc.querySelector(`[data-testid="${config.contentTestId}"]`);
  if (!contentEl) return { ok: false, reason: `NOT_FOUND: ${idPrefix} dropdown content container not found after opening.` };

  // Structure-agnostic — see findOptionRows/findSelectionIndicator's own
  // top comments. Never derives a checkbox by guessing a sibling id from
  // an option's own id; reads each row's OWN checked-state indicator
  // directly, which is what makes this resilient to an id-naming change
  // that would otherwise silently break reconciliation the same way it
  // broke discovery.
  // Follow-up correction (colour duplicate-representation collapsing) —
  // deduplicated by TEXT (never by DOM node), since Vinted can render the
  // same logical option twice (a Suggested chip mirroring its own
  // full-list row — see resolveDuplicateOptionMatches's own top comment)
  // and both representations reflect the SAME underlying checked state.
  // Without this, a checked duplicate would appear twice in this list,
  // and the deselect loop below would process — and click — the same
  // logical option twice for one reconciliation pass, which
  // resolveDuplicateOptionMatches's own collapsing would then have
  // nothing left to legitimately resolve against on the second pass
  // (having already been unchecked by the first). A plain Set is safe
  // here precisely because exact text matching is otherwise unchanged —
  // two DIFFERENT colours never share exactly the same normalised text.
  const currentlyCheckedTexts = () => [...new Set(
    findOptionRows(doc, contentEl, idPrefix)
      .filter(el => isIndicatorChecked(findSelectionIndicator(doc, el, idPrefix)))
      .map(el => normaliseText(optionRowVisibleText(el))),
  )];

  const targetNormalised = values.map(normaliseText);

  // Deselect anything checked that ISN'T wanted — safe to snapshot once:
  // this loop only ever un-checks entries already in the snapshot.
  for (const checkedText of currentlyCheckedTexts()) {
    if (targetNormalised.includes(checkedText)) continue;
    const toRemove = await findMultiSelectOptionRow(doc, contentEl, idPrefix, checkedText);
    if (!toRemove.ok) return toRemove;
    safeClick(toRemove.element, stepName);
    await pause(STABILITY_PAUSE_MS);
  }

  // Select anything wanted that isn't already checked — re-checked fresh
  // each iteration so a value selected earlier this same loop is never
  // clicked again. findMultiSelectOptionRow inspects what's currently
  // rendered first, then falls back to scrolling the picker's own options
  // container when the option isn't among it (the confirmed root cause of
  // the reported "NOT_FOUND: material option exactly matching
  // 'Suede'/'Mesh'" failures — both genuinely exist, just not discoverable
  // via the old fixed selector shape).
  for (const value of values) {
    const target = normaliseText(value);
    if (currentlyCheckedTexts().includes(target)) continue;
    const resolved = await findMultiSelectOptionRow(doc, contentEl, idPrefix, value);
    if (!resolved.ok) return resolved;
    safeClick(resolved.element, stepName);

    // Never trusts the (possibly now-stale, post-rerender) `resolved.element`
    // reference — re-resolves fresh on every poll, exactly like discovery
    // itself, and accepts either a genuine checkbox/radio's `.checked` or
    // a role="checkbox" row's own `aria-checked`.
    const confirmed = await waitFor(() => findOptionRows(doc, contentEl, idPrefix)
      .filter(el => normaliseText(optionRowVisibleText(el)) === target)
      .some(el => isIndicatorChecked(findSelectionIndicator(doc, el, idPrefix))));
    if (!confirmed) return { ok: false, reason: `UNVERIFIED: ${idPrefix} option "${value}" did not confirm as selected after clicking.` };
    await pause(STABILITY_PAUSE_MS);
  }

  dismissOpenDropdown(doc);

  return confirmDialogPicker(config, deps, () => fieldDisplaysExactSet(doc, config, values), { step: stepName, field: idPrefix, expected: values.join(", ") });
}

export function stepSelectColours(root, item, deps) {
  return stepSelectMultiOptions(root, VINTED_FIELD_STRATEGIES.colour, item.colours, { idPrefix: "color", maxCount: 2 }, deps, "SET_COLOURS");
}
export function stepSelectMaterials(root, item, deps) {
  return stepSelectMultiOptions(root, VINTED_FIELD_STRATEGIES.material, item.materials, { idPrefix: "material", maxCount: null }, deps, "SET_MATERIALS");
}

/**
 * Extracts the real, observed Vinted success marker: the new draft's own
 * "Finish editing" link, whose href is exactly /items/<draftId>/edit —
 * verified directly against a live, signed-in session (see
 * stepSaveDraft's own comment for the full finding). Never a document-
 * wide text scan — scoped to actual anchors only. Exported: the service
 * worker's durable confirmation flow (WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION)
 * calls this directly against whatever page the content script currently
 * finds itself on — see findConfirmedDraftId below for the full picture,
 * including the direct-URL /items/<id>/edit case.
 */
export function findConfirmedDraftLink(doc) {
  const links = Array.from(doc.querySelectorAll('a[href*="/items/"]'));
  const match = links.find(a => /\/items\/\d+\/edit(?:[/?#]|$)/.test(a.getAttribute("href") || ""));
  if (!match) return null;
  const idMatch = /\/items\/(\d+)\/edit/.exec(match.getAttribute("href"));
  return idMatch ? { element: match, draftId: idMatch[1] } : null;
}

/**
 * Follow-up correction (durable Save Draft confirmation) — the single
 * source of truth for "has Save Draft been confirmed on THIS page",
 * called fresh every time by whichever content-script instance happens
 * to be running (very possibly not the one that clicked — see this
 * file's own top comment on why a single in-page poll can never survive
 * the click's own navigation). Supports BOTH real observed destinations:
 *
 *   - https://www.vinted.co.uk/member/<sellerId> — the actual, verified
 *     live destination. Its Drafts tab shows a "Finish editing" link
 *     (findConfirmedDraftLink above) — the draft id is extracted from
 *     THAT link's href, never guessed from the page's own URL (which
 *     carries no id at all on this destination).
 *   - https://www.vinted.co.uk/items/<draftId>/edit — reachable by
 *     directly following that same link, or (per this segment's own
 *     requirement) treated as an equally valid confirmation destination
 *     in its own right. Here the numeric id is read directly from the
 *     URL itself, after validating its exact shape — no DOM search
 *     needed at all, and no need for a Finish-editing link to exist on
 *     this particular page.
 *
 * Returns null (never guesses, never throws) if neither shape matches —
 * the caller (service-worker.js) treats that as "not confirmed YET",
 * never as a hard failure by itself; only its own deadline decides that.
 */
export function findConfirmedDraftId(doc, location) {
  const directMatch = /^\/items\/(\d+)\/edit(?:[/?#]|$)/.exec(location?.pathname || "");
  if (directMatch) return directMatch[1];
  const link = findConfirmedDraftLink(doc);
  return link ? link.draftId : null;
}

// ---- Clean-create-form inspection (confirmed root cause of BUG: a failed
// item's leftover photos/fields contaminate the NEXT item) ----------------
//
// Confirmed root cause: a failed item (e.g. failing at SET_MATERIALS after
// its photos already uploaded) left its own unsaved Create Listing form
// exactly as-is. Nothing ever reset it before the queue moved on — neither
// to the next queued item nor to a manual Retry of the same one — so the
// next runItem() call started stepUploadPhotos against a page that ALREADY
// had a different item's photo count on it, tripping
// PHOTO_COUNT_MISMATCH (a correct, deliberately-preserved safeguard —
// see stepUploadPhotos's own comment — reacting correctly to a genuinely
// contaminated precondition it was never responsible for creating).
//
// inspectPageState is the one pure, narrowly-scoped boundary the service
// worker uses (see service-worker.js's ensureCleanCreateForm) to decide,
// BEFORE ever dispatching PROCESS_ITEM, whether the current page is safe
// to start a fresh item on. It never mutates anything — purely read-only
// DOM inspection — and never itself removes a photo or clears a field;
// the actual reset (a navigation) is the service worker's job once this
// reports the page isn't already clean.
export const PAGE_STATE = Object.freeze({
  // A confirmed, empty /items/new form — no uploaded photos, no open
  // picker, the photo input is resolvable. Safe to dispatch PROCESS_ITEM
  // immediately, no reset needed.
  CLEAN: "clean",
  // A Create Listing form IS present, but it isn't the fresh state above —
  // leftover photos and/or fields from a previous item, and/or a picker
  // dialog left open. Must be reset before the next item starts.
  DIRTY: "dirty",
  // The current page is a CONFIRMED saved draft (the same durable marker
  // stepSaveDraft's own confirmation flow already uses — see
  // findConfirmedDraftId above). This is NEVER treated as an unsaved form
  // to clear — its photos are a real, already-saved Vinted draft, not
  // debris — but it also isn't a form a new item can be started on, so the
  // caller still navigates AWAY from it (to a fresh /items/new), never
  // interacting with anything on this page itself.
  SAVED_DRAFT: "saved_draft",
  // Not recognisably either of the above — not on the Create Listing page
  // at all (per CREATE_LISTING_FORM_SELECTORS), or not at the required
  // fresh /items/new URL specifically (e.g. still sitting on
  // /items/<id>/edit, or mid-navigation). Treated the same as DIRTY by the
  // caller (needs a reset), kept distinct here purely for diagnostics.
  UNAVAILABLE: "unavailable",
});

const FRESH_CREATE_FORM_PATH_PATTERN = /^\/items\/new(?:[/?#]|$)/;

/** True if ANY of the six dialog pickers (category/brand/size/condition/colour/material) currently has its content container open — a stale open picker left over from a failed attempt is exactly as contaminating as a leftover photo, and must trigger a reset the same way. */
function isAnyDialogPickerOpen(doc) {
  return Object.values(VINTED_FIELD_STRATEGIES).some(config => {
    if (!config.contentTestId) return false;
    const content = doc.querySelector(`[data-testid="${config.contentTestId}"]`);
    return Boolean(content) && isVisible(content);
  });
}

/**
 * Read-only inspection of the CURRENT page — never navigates, never clicks,
 * never removes anything. Returns `{ state, ...diagnostics }`:
 *  - SAVED_DRAFT is checked FIRST, unconditionally — a confirmed saved
 *    draft is never reclassified as dirty regardless of what else is on
 *    the page (see PAGE_STATE.SAVED_DRAFT's own comment).
 *  - CLEAN requires ALL of: the page is genuinely at /items/new (never
 *    /items/<id>/edit — retrying/advancing always targets a truly fresh
 *    form, never an existing draft's own edit page); zero uploaded photo
 *    cards (countUploadedPhotoCards — the exact same verified marker
 *    stepUploadPhotos itself already trusts); the hidden photo input
 *    resolves (resolvePhotoInput — proves the page has actually finished
 *    rendering the upload area, not just the URL having changed); and no
 *    dialog picker is left open.
 *  - Zero photos is deliberately the sole field-contamination signal
 *    checked (rather than separately re-verifying title/description/etc.
 *    are blank) — runItem's own VERIFIED step order always uploads photos
 *    FIRST, before touching any other field (see runItem's own top
 *    comment), so no field is ever set on a page that still shows zero
 *    photos; a photo count of zero is therefore already conclusive proof
 *    nothing else has been touched either.
 */
export function inspectPageState(doc, location) {
  const confirmedDraftId = findConfirmedDraftId(doc, location);
  if (confirmedDraftId) return { state: PAGE_STATE.SAVED_DRAFT, vintedDraftId: confirmedDraftId };

  const onCreateListingPage = CREATE_LISTING_FORM_SELECTORS.some(selector => doc.querySelector(selector));
  const isFreshFormUrl = FRESH_CREATE_FORM_PATH_PATTERN.test(location?.pathname || "");
  if (!onCreateListingPage || !isFreshFormUrl) return { state: PAGE_STATE.UNAVAILABLE, onCreateListingPage, isFreshFormUrl };

  const photoCount = countUploadedPhotoCards(doc);
  const photoInputResolvable = resolvePhotoInput(doc).ok;
  const dialogOpen = isAnyDialogPickerOpen(doc);

  if (photoCount === 0 && photoInputResolvable && !dialogOpen) return { state: PAGE_STATE.CLEAN };
  return { state: PAGE_STATE.DIRTY, photoCount, photoInputResolvable, dialogOpen };
}

/**
 * Follow-up correction (live Save Draft investigation) — best-effort,
 * NOT live-verified: the one authorised live click on this investigation
 * succeeded outright on a fully-completed form, so a genuine validation-
 * blocked Save Draft was never directly observed. Scoped narrowly to the
 * standard accessible pattern for a shown field/form error (a visible
 * [role="alert"]) rather than any document-wide text scan (see this
 * file's own top comment on why that's always avoided) — if Vinted's
 * real wording/shape differs, this degrades safely (the click is never
 * even attempted; the caller reports a clear, retryable failure instead
 * of mis-reporting a field that isn't actually the problem).
 */
function findBlockingValidationError(doc) {
  const alerts = Array.from(doc.querySelectorAll('[role="alert"]')).filter(isVisible);
  const messages = alerts.map(el => (el.textContent || "").trim()).filter(Boolean);
  return messages.length ? messages.join("; ") : null;
}

/**
 * Follow-up correction (durable Save Draft confirmation) — root cause of
 * the reported live "TIMEOUT: field did not confirm the entered value" /
 * "the draft is not saved" symptom: verified directly against a live,
 * signed-in session (one authorised click on a fully-completed form).
 * Clicking Save Draft performs a genuine top-level navigation to the
 * seller's own profile page (confirmed via
 * performance.getEntriesByType("navigation")[0].type === "navigate" for
 * that exact destination — never an in-page SPA route change). A hard
 * navigation like that can — and, per this segment's own investigation,
 * sometimes does — destroy THIS SCRIPT's own execution context before
 * anything it does after the click ever runs. No in-page poll, however
 * clever, can be relied on to survive that: the fix is architectural, not
 * a longer or smarter wait.
 *
 * This function's job now ends at the click. Confirmation is handled
 * durably, OUTSIDE this script's own lifetime, by the service worker:
 * chrome.tabs.onUpdated watches the selected tab for the real observed
 * post-save destinations and asks WHICHEVER content-script instance is
 * running there (fresh-injected if needed) to check for the confirmed
 * draft link (findConfirmedDraftId above) — see service-worker.js's own
 * comments for the full durable flow, including recovery across service-
 * worker restarts, browser restarts, and delayed rendering.
 *
 * Sequence, every call:
 *   1. Idempotent short-circuit — `deps.getKnownVintedDraftId()`, if
 *      supplied, is checked FIRST; an already-confirmed draft is never
 *      re-submitted, full stop.
 *   2. Resolve the exact verified Save Draft button; never falls back to
 *      anything else (see resolveSaveDraftButton's own guarantees).
 *   3. A pre-click validation-error check (best-effort — see
 *      findBlockingValidationError's own comment).
 *   4. `deps.beginSaveDraft()`, if supplied, is AWAITED and must resolve
 *      `{ ok: true }` before the click is EVER allowed to happen — this
 *      is what persists the durable pending-save record before the
 *      click, satisfying "the record is persisted before the click is
 *      allowed" even though this very function has no access to
 *      chrome.storage.local itself (see content-script.js for how this
 *      hook is wired to the real BEGIN_SAVE_DRAFT round trip).
 *   5. Exactly one click on the resolved button — the same guarded
 *      resolveSaveDraftButton() call from step 2 already ran
 *      assertNotForbiddenTestId and assertNotForbiddenAction; nothing
 *      else in this function ever clicks anything else, especially never
 *      Upload/Publish/List/Post.
 *   6. Returns `{ ok: true, pending: true }` IMMEDIATELY — no waiting,
 *      no polling. Whether or not this very call survives past this
 *      point is now irrelevant to the outcome.
 */
export async function stepSaveDraft(root, deps) {
  const { doc } = deps;

  if (deps.getKnownVintedDraftId) {
    const known = await deps.getKnownVintedDraftId();
    if (known) return { ok: true, pending: false, vintedDraftId: known };
  }

  const resolved = resolveSaveDraftButton(root);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const blockingError = findBlockingValidationError(doc);
  if (blockingError) return { ok: false, reason: `VALIDATION_ERROR: step=SAVE_DRAFT — Vinted blocked Save draft: ${blockingError}` };

  if (deps.beginSaveDraft) {
    const begun = await deps.beginSaveDraft();
    if (!begun?.ok) {
      return { ok: false, reason: `SAVE_DRAFT_NOT_STARTED: step=SAVE_DRAFT — the pending-save record could not be persisted before clicking, so the click was refused: ${begun?.reason ?? "unknown reason"}.` };
    }
  }

  resolved.element.click(); // resolveSaveDraftButton already ran assertNotForbiddenTestId and assertNotForbiddenAction

  return { ok: true, pending: true, vintedDraftId: null };
}

// Failure handling: "Stop the individual item when: Vinted requires
// login; CAPTCHA or verification appears... Do not bypass a CAPTCHA or
// verification screen." Checked once at the very start of runItem, before
// ANY interaction is attempted — never a bypass attempt, purely detect-
// and-stop. Patterns are intentionally broad (better to stop on a false
// positive than to plough through a real challenge).
const LOGIN_REQUIRED_PATTERNS = [/log\s*in to continue/i, /sign\s*in to continue/i, /please log in/i, /session has expired/i];
const CAPTCHA_OR_VERIFICATION_PATTERNS = [/captcha/i, /verify you.?re (a )?human/i, /unusual traffic/i, /confirm you.?re not a robot/i, /two-factor|2fa\b|verification code/i];

// Follow-up correction (login-detection bug): detectLoginRequired() used
// to test LOGIN_REQUIRED_PATTERNS against doc.body.textContent — the
// ENTIRE page's text, hidden content included. Real pages (Vinted's own
// SPA very much among them) commonly keep a login modal/template
// permanently in the DOM, just hidden, ready to be shown the moment it's
// actually needed — that hidden markup matched just as readily as a
// genuinely visible prompt, so an authenticated session with that hidden
// markup present was indistinguishable from an actual login requirement.
// Fixed by scoping to a small, deliberate set of container types that
// could ever legitimately BE a login prompt/session-expired message
// (never a document-wide text search — see vinted-fields.js's own top
// comment on why that's always avoided here), and requiring isVisible()
// on each one before its text is ever examined. A container matching one
// of these selectors while hidden (closed dialog, not-yet-shown modal,
// `[hidden]` template) is exactly the previously-mismatched case — now
// correctly skipped.
const LOGIN_CONTAINER_SELECTOR = [
  '[role="dialog"]', '[aria-modal="true"]', 'form',
  '[role="alert"]', '[role="status"]',
  '[class*="modal" i]', '[class*="login" i]', '[class*="signin" i]', '[class*="session" i]',
  '[id*="login" i]', '[id*="session" i]',
].join(", ");

export function detectLoginRequired(doc) {
  const candidates = doc.querySelectorAll ? Array.from(doc.querySelectorAll(LOGIN_CONTAINER_SELECTOR)) : [];
  for (const el of candidates) {
    if (!isVisible(el)) continue; // e.g. a hidden pre-rendered login modal/template — never a real signal
    const text = el.textContent || "";
    for (const pattern of LOGIN_REQUIRED_PATTERNS) if (pattern.test(text)) return pattern.source;
  }
  return null;
}

// Follow-up correction (false-CAPTCHA bug): detectCaptchaOrVerification()
// used to test CAPTCHA_OR_VERIFICATION_PATTERNS against doc.body.textContent
// (plus an unscoped iframe/class/id querySelector) — on a live, signed-in
// page this matched the word "captcha" sitting inside a hidden anti-bot
// loader script (`script#data-dome-script`), reporting a false CAPTCHA on
// a completely normal page with zero visible challenge elements. Verified
// on that same live page: document.body.textContent contains "captcha"
// (true) while document.body.innerText — which, unlike textContent,
// reflects only rendered/visible text — does NOT (false), and there were
// zero visible CAPTCHA elements or challenge text. Fixed exactly like
// detectLoginRequired above: never inspect a <script>/<style>/<template>/
// <noscript> element's content at all (isVisible() rejects those tags
// outright — see vinted-fields.js), never inspect hidden/zero-sized
// content, and require POSITIVE visible evidence — a matching iframe, or
// visible text inside a container that could plausibly BE a challenge —
// rather than a whole-document scan.
const CAPTCHA_IFRAME_SELECTOR = 'iframe[src*="captcha" i], iframe[title*="captcha" i]';
const CAPTCHA_CONTAINER_SELECTOR = [
  '[role="dialog"]', '[aria-modal="true"]',
  '[role="alert"]', '[role="status"]',
  '[class*="captcha" i]', '[id*="captcha" i]',
  '[class*="challenge" i]', '[id*="challenge" i]',
].join(", ");

export function detectCaptchaOrVerification(doc) {
  if (!doc.querySelectorAll) return null;

  // Positive evidence #1: a visible CAPTCHA iframe whose src/title identifies it.
  for (const iframe of Array.from(doc.querySelectorAll(CAPTCHA_IFRAME_SELECTOR))) {
    if (isVisible(iframe)) return "captcha iframe present";
  }

  // Positive evidence #2: visible text, inside a container that could
  // plausibly BE a challenge/verification screen — never the whole
  // document, never a hidden/inactive script or template.
  for (const el of Array.from(doc.querySelectorAll(CAPTCHA_CONTAINER_SELECTOR))) {
    if (!isVisible(el)) continue;
    const text = el.textContent || "";
    for (const pattern of CAPTCHA_OR_VERIFICATION_PATTERNS) if (pattern.test(text)) return pattern.source;
  }
  return null;
}

// Follow-up correction (account-detection bug): the previous
// detectAccountUsername() grabbed textContent off a broad, generic header
// container ('header [class*="user"]' and similar) with no requirement
// that the text actually identify an account. On the real page this
// picked up Vinted's notification-badge count ("99+") instead of a
// username, since the badge happened to be the visible text of whatever
// element the selector matched. This replacement never treats a bare
// number/badge as an identity, and anchors identity to something
// structural and stable — a header link to the account's own profile.
// Verified on the live page: the account menu's Profile link is exactly
// `<a href="/member/<digits>">Profile</a>` — its PATHNAME (not merely a
// substring of the href) matches `^/member/(\d+)$`, distinguishing it
// from any other link that might merely contain "/member/" somewhere in
// a longer path. The digits are the account's Vinted member id — the
// live `99+` value seen in the header is the conversations/notification
// badge, never the account id, and is never accepted as one.
const MEMBER_PATHNAME_PATTERN = /^\/member\/(\d+)$/;
const BADGE_LIKE_TEXT_PATTERN = /^\d+\+?$/; // "99+", "5", "12" — a notification/message count, never a username
const GENERIC_CONTROL_LABEL_PATTERN = /^(profile|account|my account|view profile|user menu|menu|notifications?)$/i;
const BADGE_DESCENDANT_SELECTOR = '[class*="badge" i], [class*="notification" i], [data-testid*="badge" i], [data-testid*="notification" i]';

function isBadgeLikeText(text) {
  return !text || BADGE_LIKE_TEXT_PATTERN.test(text.trim()) || GENERIC_CONTROL_LABEL_PATTERN.test(text.trim());
}

/** The profile link's own visible text, with any nested notification-badge elements (e.g. an unread-count overlay on the avatar) removed first — never trusts textContent that might include a badge's digits. */
function visibleTextExcludingBadges(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll(BADGE_DESCENDANT_SELECTOR).forEach(el => el.remove());
  return clone.textContent?.trim() ?? "";
}

/** A link's pathname, resolved the same way a real browser resolves `href` — works for both an absolute `/member/123` href and a fully-qualified `https://www.vinted.co.uk/member/123` one. Falls back to a plain regex match on the raw attribute if URL parsing isn't available (never throws). */
function linkPathname(link, doc) {
  const href = link.getAttribute("href") || "";
  try {
    const base = doc?.defaultView?.location?.href ?? doc?.location?.href ?? "https://www.vinted.co.uk/";
    return new URL(href, base).pathname;
  } catch {
    return href.split(/[?#]/)[0];
  }
}

/**
 * Detects the logged-in Vinted account structurally, never from freeform
 * text, from whatever is CURRENTLY in the DOM (closed header, or an
 * already-open account menu — either way, the profile link is found the
 * same way). Returns `{ memberId, displayName }` (displayName may be
 * `null` if only a verified member ID could be found — never invents a
 * username), or `null` if no reliable identity can be established at all
 * (no member-profile link found, or more than one DISTINCT member id
 * found, which is treated as ambiguous rather than guessed at).
 */
function detectAccountIdentityFromDom(doc) {
  const header = doc.querySelector("header") ?? doc;
  // Only a VISIBLE profile link counts as "exposed" — one sitting inside
  // a closed account menu (display:none/[hidden] until opened) is not
  // something a real user (or this detector) can currently read, which is
  // exactly the case detectAccountIdentity()'s menu-opening fallback
  // below exists to handle. The pathname (not a loose href substring
  // check) must match /member/<digits> EXACTLY — see this file's own
  // comment above on why this is the verified boundary.
  const links = Array.from(header.querySelectorAll('a[href*="/member/"]'))
    .filter(link => isVisible(link) && MEMBER_PATHNAME_PATTERN.test(linkPathname(link, doc)));

  const byMemberId = new Map();
  for (const link of links) {
    const memberId = MEMBER_PATHNAME_PATTERN.exec(linkPathname(link, doc))[1];

    const ariaLabel = link.getAttribute("aria-label")?.trim();
    const title = link.getAttribute("title")?.trim();
    const visibleText = visibleTextExcludingBadges(link);
    const displayName = [ariaLabel, title, visibleText].find(candidate => candidate && !isBadgeLikeText(candidate)) ?? null;

    // First link for a given memberId always sets the initial entry; a
    // LATER link for the SAME memberId only overwrites it if we don't
    // already have a real name (e.g. an avatar link with no usable name,
    // followed by a separate name link for the same account).
    if (!byMemberId.has(memberId) || (!byMemberId.get(memberId) && displayName)) byMemberId.set(memberId, displayName);
  }

  if (byMemberId.size !== 1) return null; // no profile link found, or more than one distinct account referenced — never guess
  const [[memberId, displayName]] = byMemberId;
  return { memberId, displayName };
}

// Verified on the live page: the header's account-menu toggle button's
// OWN accessible name toggles between "Menu opened" (its state before
// being clicked — i.e. "click me to open the menu") and "Menu closed"
// (after being clicked — i.e. "click me to close the now-open menu"), the
// standard toggle-button convention of labelling the action the next
// click performs, not the current state's own name. This is read here by
// EXACT accessible name, not a generic aria-haspopup/aria-expanded guess.
const ACCOUNT_MENU_TOGGLE_NAME_PATTERN = /^menu (opened|closed)$/i;
const MENU_OPEN_TIMEOUT_MS = 2000;
const MENU_OPEN_POLL_MS = 50;

function findAccountMenuToggle(doc) {
  const header = doc.querySelector("header") ?? doc;
  const candidates = findByRole(header, "button").filter(el => isVisible(el) && ACCOUNT_MENU_TOGGLE_NAME_PATTERN.test(getAccessibleName(el).trim()));
  return requireUnique(candidates, 'account/avatar menu toggle (accessible name "Menu opened"/"Menu closed")');
}

/**
 * Detects the logged-in Vinted account. Tries the closed header first —
 * no interaction at all — and only if that finds no reliable member link
 * does it fall back to opening the account/avatar menu: click the ONE
 * unique, visible toggle control that OPENS it, wait for it to actually
 * open, read the profile link, then close the SAME toggle again. This
 * never clicks anything else — never "Profile", "Log out", or any other
 * menu item — and never leaves the menu open behind it (closes it again
 * only if this call is the one that opened it; a menu the user already
 * had open is left exactly as found).
 */
export async function detectAccountIdentity(doc) {
  const direct = detectAccountIdentityFromDom(doc);
  if (direct) return direct;

  const found = findAccountMenuToggle(doc);
  if (!found.ok) return null;
  const toggle = found.element;

  // "Menu closed" is the label shown WHILE the menu is open (see this
  // file's own comment above) — i.e. that is the already-open state.
  const alreadyOpen = getAccessibleName(toggle).trim().toLowerCase() === "menu closed";
  if (!alreadyOpen) {
    // A menu toggle is never itself a forbidden publishing action, but
    // every click in this codebase goes through this same guard — no
    // exceptions, see safeClick()'s own comment.
    assertNotForbiddenAction(getAccessibleName(toggle));
    toggle.click();
    await waitFor(() => getAccessibleName(toggle).trim().toLowerCase() === "menu closed" || detectAccountIdentityFromDom(doc), { timeoutMs: MENU_OPEN_TIMEOUT_MS, intervalMs: MENU_OPEN_POLL_MS });
  }

  const identity = detectAccountIdentityFromDom(doc);

  if (!alreadyOpen) {
    assertNotForbiddenAction(getAccessibleName(toggle)); // same guard, immediately before EVERY click — no exceptions, even the closing one
    toggle.click(); // close it again — the ONLY two clicks this ever performs are on this same toggle, never a menu item like Profile/Log out
  }

  return identity;
}

async function runWithRetries(fn, maxRetries) {
  let last = { ok: false, reason: "unknown" };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await fn();
    if (last.ok) return last;
  }
  return last;
}

/**
 * Runs the FULL ordered state machine for one item, in the VERIFIED
 * required order: OPEN_FORM -> UPLOAD_PHOTOS -> SET_TITLE ->
 * SET_DESCRIPTION -> SET_CATEGORY (which itself waits for the
 * category-dependent fields to exist before returning) -> SET_BRAND ->
 * SET_SIZE -> SET_CONDITION -> SET_COLOURS -> SET_MATERIALS -> SET_PRICE
 * -> SAVE_DRAFT -> (result extraction). Brand/Size/Condition/Colours/
 * Material genuinely do not exist in Vinted's DOM until the category
 * dialog has been saved and the form has rerendered — running any of
 * them before SET_CATEGORY completes would simply fail to find the
 * field, which is exactly why this order is load-bearing, not cosmetic.
 * `report(status, extra)` is called at each meaningful transition
 * ("filling", "saving", "completed"/"failed" with a structured reason) —
 * content-script.js supplies a report() that forwards these to the
 * service worker; tests can supply one that just records calls.
 *
 * Follow-up correction (photo-download CORS bug): no longer takes a
 * bearer token — photos are downloaded by the service worker (see
 * stepUploadPhotos/deps.requestPhoto), which already holds the batch's
 * own token in its own persisted state and never needs it passed through
 * here at all.
 */
export async function runItem(item, report, deps) {
  const validationErrors = validateBatchItem(item);
  if (validationErrors.length) return report("failed", { errorCode: "INVALID_ITEM", errorMessage: validationErrors.join("; ") });

  // Checked FIRST, before any interaction at all — see this file's own
  // comment above detectLoginRequired/detectCaptchaOrVerification.
  const loginRequired = detectLoginRequired(deps.doc);
  if (loginRequired) return report("failed", { errorCode: "LOGIN_REQUIRED", errorMessage: `Vinted is asking to log in (matched: ${loginRequired}).` });
  const blocked = detectCaptchaOrVerification(deps.doc);
  if (blocked) return report("failed", { errorCode: "CAPTCHA_OR_VERIFICATION", errorMessage: `Stopped: a CAPTCHA or verification screen was detected (matched: ${blocked}). This is never bypassed automatically.` });

  const opened = await stepOpenForm(deps);
  if (!opened.ok) return report("failed", { errorCode: "OPEN_FORM", errorMessage: opened.reason });
  const root = opened.root;

  // Follow-up correction (live investigation — diagnostics gap) — the
  // field loop below used to run with NO progress reporting at all between
  // "filling" (this call) and either "saving" or a terminal failure, so a
  // real failure gave no way to tell how far it actually got without
  // extension logs (which, for every field EXCEPT photos, never existed
  // either). `currentStep` now tracks the step actively being attempted,
  // and `lastCompletedStep` the most recent one that genuinely succeeded —
  // both persisted on the item (see queue-state.js's QUEUE_CONTROLLED_FIELDS)
  // and shown by the side panel, so "how far did it get" is always visible
  // from persisted state alone, live or after the fact.
  let lastCompletedStep = null;
  report("filling", { currentStep: "UPLOAD_PHOTOS", lastCompletedStep });

  const uploaded = await stepUploadPhotos(root, item, deps, report);
  if (!uploaded.ok) return report("failed", { errorCode: "UPLOAD_PHOTOS", errorMessage: uploaded.reason, lastCompletedStep });
  lastCompletedStep = "UPLOAD_PHOTOS";
  await pause(STABILITY_PAUSE_MS);

  const fieldSteps = [
    ["SET_TITLE", () => stepSetTitle(item, deps)],
    ["SET_DESCRIPTION", () => stepSetText(root, VINTED_FIELD_STRATEGIES.description, item.description, deps, { step: "SET_DESCRIPTION" })],
    ["SET_CATEGORY", () => stepSelectCategory(root, item, deps)],
    ["SET_BRAND", () => stepSelectBrand(root, item, deps)],
    ["SET_SIZE", () => stepSelectSize(root, item, deps)],
    ["SET_CONDITION", () => stepSelectCondition(root, item, deps)],
    ["SET_COLOURS", () => stepSelectColours(root, item, deps)],
    ["SET_MATERIALS", () => stepSelectMaterials(root, item, deps)],
    // Follow-up correction (live investigation — SET_PRICE currency-format
    // mismatch bug): Vinted's own Price input immediately reformats a typed
    // number into a "£X.XX" display value (verified live), which the old
    // raw string comparison could never match — see priceValueMatch's own
    // comment. This is the ONLY field step that passes a non-default
    // isMatch comparator; every other stepSetText field keeps strict
    // string equality.
    ["SET_PRICE", () => stepSetText(root, VINTED_FIELD_STRATEGIES.price, String(item.pricePence / 100), deps, { step: "SET_PRICE", isMatch: priceValueMatch })],
    // Deliberately no parcel/package-size step here, and none should ever
    // be added. Vinted auto-selects a recommended parcel size itself, and
    // that default is always acceptable — this extension never selects,
    // changes, waits for, or validates it (never Small/Medium/Large, never
    // a "confirm size" control), and never lets its presence, absence, or
    // shape block Save Draft. See the "Parcel/package size" test describe
    // block in tests/vinted-extension-form-steps.test.ts for the full
    // regression coverage proving this.
  ];

  for (const [stepName, run] of fieldSteps) {
    report("filling", { currentStep: stepName, lastCompletedStep });
    const result = await runWithRetries(run, MAX_STEP_RETRIES);
    if (!result.ok) return report("failed", { errorCode: stepName, errorMessage: result.reason, lastCompletedStep });
    lastCompletedStep = stepName;
    await pause(STABILITY_PAUSE_MS);
  }

  report("saving", { currentStep: "SAVE_DRAFT", lastCompletedStep }); // proceeds directly from the final listing field (price) to Save Draft — no parcel-size step in between
  const saved = await stepSaveDraft(root, deps);
  if (!saved.ok) return report("failed", { errorCode: "SAVE_DRAFT", errorMessage: saved.reason, lastCompletedStep });

  // Follow-up correction (durable Save Draft confirmation) — a PENDING
  // result means the click succeeded but confirmation is now the service
  // worker's durable, navigation-safe job (see stepSaveDraft's own
  // comment) — never this function's. Completion is reported later, by
  // the service worker itself, once it actually confirms — never here,
  // and never merely because the click happened. This function's own job
  // for this item ends here either way, whether or not this very script
  // survives past this point.
  if (saved.pending) return { status: "saving", pending: true };

  // Only reached via the idempotent short-circuit above (an
  // already-confirmed draft) — a genuine, immediate completion.
  return report("completed", { vintedDraftId: saved.vintedDraftId });
}
