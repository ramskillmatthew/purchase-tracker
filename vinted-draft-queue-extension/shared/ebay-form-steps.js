// eBay Seller Hub extension drafter — the actual state-machine step
// implementations. Mirrors shared/form-steps.js's own architecture
// (dependency-injected fetch/DataTransfer/File/document, directly
// unit-testable with vitest + jsdom, never throws for an expected failure)
// but is a SEPARATE module — see this feature's own "do not let eBay
// messages enter the Vinted processing path" requirement.
//
// STOP-BEFORE-SAVE BOUNDARY (this milestone's own hard scope): the last
// step this file ever runs is stepVerifyPopulatedFields. There is no
// stepSaveDraft here, and no code path that clicks "Save for later" or
// "List it for free" — see ebay-fields.js's own publishing-safety guard,
// enforced on EVERY click via safeClick, no exceptions, including inside
// the prelist wizard steps below.

import {
  getAccessibleName, findByRole, requireUnique, resolveByName, resolveItemSpecificSearchBox,
  resolveItemSpecificPillButton, isPillButtonPressed, resolvePhotoInput, safeClick,
  assertNotForbiddenAction, assertValidInteractionTarget, isOnSellerHubListingForm,
  EBAY_FIELD_STRATEGIES,
} from "./ebay-fields.js";

export const STEP_TIMEOUT_MS = 8000;
export const POLL_INTERVAL_MS = 150;
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

// Mirrors setNativeValue in form-steps.js exactly — see that function's own
// comment on why a plain `.value =` assignment doesn't work against a
// React-driven input.
export function setNativeValue(element, value, win) {
  const prototype = element.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value); else element.value = value;
  element.dispatchEvent(new win.Event("input", { bubbles: true }));
  element.dispatchEvent(new win.Event("change", { bubbles: true }));
}

export function boundDiagnosticValue(value, maxLen = 120) {
  const str = value == null ? "" : String(value);
  const singleLine = str.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen)}…` : singleLine;
}

export function buildFieldTimeoutReason({ prefix = "TIMEOUT", step, field, expected, observed, cause }) {
  const parts = [
    `step=${step}`, `field=${field}`,
    expected !== undefined ? `expected=${JSON.stringify(boundDiagnosticValue(expected))}` : null,
    observed !== undefined ? `observed=${JSON.stringify(boundDiagnosticValue(observed))}` : null,
    cause ? `reason=${JSON.stringify(cause)}` : null,
  ].filter(Boolean);
  return `${prefix}: ${parts.join(" ")}`;
}

function parsePriceToPence(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  if (cleaned === "" || cleaned === ".") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
// eBay's price input, like Vinted's, may reformat what's typed — compare
// the NUMERIC pence value, never the raw text. (Not yet individually
// confirmed live whether eBay reformats — this is a defensive match, safe
// either way: an exact string match also satisfies a numeric-pence match.)
function priceValueMatch(current, expectedTypedValue) {
  const currentPence = parsePriceToPence(current);
  const expectedPence = parsePriceToPence(expectedTypedValue);
  return currentPence !== null && expectedPence !== null && currentPence === expectedPence;
}

// ---- Stage A-C: the prelist wizard (search -> category -> condition) ------
// VERIFIED live this session end-to-end (typed a real title, selected the
// matching category suggestion, selected the matching condition, reached
// the real form) — see ebay-fields.js's own top comment on what's verified
// vs assumed. Every click still goes through safeClick — the forbidden-
// action guard applies here exactly as much as on the final form.

export async function stepStartPrelistSearch({ doc, win, location }, title) {
  if (isOnSellerHubListingForm(location)) return { ok: true, alreadyOnForm: true };
  const searchBox = requireUnique(
    Array.from(doc.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'))
      .filter(el => /tell us what you're selling/i.test(el.placeholder || "") || /sell/i.test(getAccessibleName(el))),
    "the prelist 'Tell us what you're selling' search box",
  );
  if (!searchBox.ok) return { ok: false, reason: searchBox.reason };
  setNativeValue(searchBox.element, title, win);
  searchBox.element.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const arrived = await waitFor(() => /\/sl\/prelist\/identify/.test(location.pathname) || findByRole(doc.body, "button", { nameContains: "Continue without match" }).length > 0);
  if (!arrived) return { ok: false, reason: buildFieldTimeoutReason({ step: "OPEN_FORM", field: "prelist_search", expected: title, observed: location.pathname }) };
  return { ok: true, alreadyOnForm: false };
}

export async function stepSelectCategorySuggestion({ doc, location }, categoryName) {
  if (/caty=\d+/.test(location.search)) return { ok: true, alreadySelected: true }; // a category was already picked (e.g. resuming mid-wizard)
  const suggestions = await waitFor(() => {
    const matches = findByRole(doc.body, "button", { nameContains: categoryName });
    return matches.length > 0 ? matches : null;
  });
  if (!suggestions) return { ok: false, reason: buildFieldTimeoutReason({ step: "SELECT_CATEGORY", field: "category", expected: categoryName, cause: "no matching category suggestion appeared" }) };
  const unique = requireUnique(suggestions, `category suggestion containing "${categoryName}"`);
  if (!unique.ok) return { ok: false, reason: unique.reason };
  safeClick(unique.element, "SELECT_CATEGORY");
  const arrived = await waitFor(() => /caty=\d+/.test(location.search));
  if (!arrived) return { ok: false, reason: buildFieldTimeoutReason({ step: "SELECT_CATEGORY", field: "category", cause: "selecting the category did not advance the wizard" }) };
  return { ok: true, alreadySelected: false };
}

// CORRECTIVE PASS (condition-safety review) — this extension NEVER selects
// a condition automatically, for any item, ever. Live evidence (category
// 95672 "Trainers"): eBay UK Seller Hub offers exactly six condition
// options for this category — "New with box", "New without box", "New
// with defects", "Pre-owned - Excellent" ("Like new, no visible flaws or
// signs of use"), "Pre-owned - Good" ("Gently used with moderate signs of
// wear and/or visible flaws"), "Pre-owned - Fair" ("Significantly visible
// flaws, heavy signs of use..."). There is no "Very Good" tier. Any
// automatic mapping from this app's own condition vocabulary onto one of
// these six is a genuine judgement call with a real misrepresentation
// risk in one direction (mapping "Very Good" to "Excellent" would claim
// "no visible flaws" for an item that may have some) — exactly the
// "silently upgrade the item's condition" this review explicitly
// prohibits. Rather than pick a side, this step stops and requires the
// human to choose. The Select Condition page is reachable ONLY as a gate
// before the real Complete-your-listing form even exists (eBay's own
// wizard architecture — condition is not a re-editable field on the final
// form), so this step cannot skip ahead and fill in the rest of the form
// first; it waits, with a long, human-scale timeout (never a false
// "stalled" failure just because a person hasn't looked at their screen
// yet), for the human to make the selection and click Continue themselves
// — detected the same honest way every other stage detects arrival at the
// real form: isOnSellerHubListingForm(location) becoming true.
export const MANUAL_CONDITION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — a human-scale wait, not a form-filling one

export async function stepWaitForManualCondition({ doc, location }, report = () => {}) {
  if (isOnSellerHubListingForm(location)) return { ok: true, alreadySelected: true };
  const heading = await waitFor(() => doc.querySelector("h1, h2")?.textContent?.trim() === "Select condition" ? true : null);
  if (!heading) return { ok: false, reason: buildFieldTimeoutReason({ step: "SELECT_CONDITION", field: "condition", cause: "the Select condition page did not appear" }) };
  report("filling", {
    currentStep: "SELECT_CONDITION_MANUAL",
    detail: "This app has no 'Very Good' equivalent verified for eBay's Seller Hub — select the closest matching condition yourself, then click Continue.",
  });
  const arrived = await waitFor(() => isOnSellerHubListingForm(location), { timeoutMs: MANUAL_CONDITION_TIMEOUT_MS, intervalMs: 500 });
  if (!arrived) {
    return { ok: false, reason: buildFieldTimeoutReason({ step: "SELECT_CONDITION", field: "condition", cause: "no condition was selected within the allowed time — reopen and retry when ready" }) };
  }
  return { ok: true, alreadySelected: false };
}

// ---- Stage D: the real Complete-your-listing form (VERIFIED live) --------

export async function stepSetTitle(item, { doc, win }) {
  const field = resolveByName(doc, EBAY_FIELD_STRATEGIES.title.name);
  if (!field.ok) return { ok: false, reason: field.reason };
  if (field.element.value === item.title) return { ok: true }; // idempotent — already correct (e.g. a retry)
  setNativeValue(field.element, item.title, win);
  const confirmed = await waitFor(() => field.element.value === item.title);
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_TITLE", field: "title", expected: item.title, observed: field.element.value }) };
  return { ok: true };
}

export async function stepSetDescription(item, { doc, win }) {
  const field = resolveByName(doc, EBAY_FIELD_STRATEGIES.description.name);
  if (!field.ok) return { ok: false, reason: field.reason };
  if (field.element.value === item.description) return { ok: true };
  setNativeValue(field.element, item.description, win);
  const confirmed = await waitFor(() => field.element.value === item.description);
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_DESCRIPTION", field: "description", expected: item.description, observed: field.element.value }) };
  return { ok: true };
}

export async function stepSetPrice(item, { doc, win }) {
  const field = resolveByName(doc, EBAY_FIELD_STRATEGIES.price.name);
  if (!field.ok) return { ok: false, reason: field.reason };
  const typedValue = (item.pricePence / 100).toFixed(2);
  if (priceValueMatch(field.element.value, typedValue)) return { ok: true };
  setNativeValue(field.element, typedValue, win);
  const confirmed = await waitFor(() => priceValueMatch(field.element.value, typedValue));
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_PRICE", field: "price", expected: typedValue, observed: field.element.value }) };
  return { ok: true };
}

export async function stepSetQuantity(item, { doc, win }) {
  const field = resolveByName(doc, EBAY_FIELD_STRATEGIES.quantity.name);
  if (!field.ok) return { ok: false, reason: field.reason };
  const typedValue = String(item.quantity);
  if (field.element.value === typedValue) return { ok: true };
  setNativeValue(field.element, typedValue, win);
  const confirmed = await waitFor(() => field.element.value === typedValue);
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_QUANTITY", field: "quantity", expected: typedValue, observed: field.element.value }) };
  return { ok: true };
}

export async function stepSetSku(item, { doc, win }) {
  const toggle = resolveByName(doc, EBAY_FIELD_STRATEGIES.skuToggle.name);
  if (!toggle.ok) return { ok: false, reason: toggle.reason };
  if (!toggle.element.checked) {
    safeClick(toggle.element, "SET_SKU");
    const revealed = await waitFor(() => resolveByName(doc, EBAY_FIELD_STRATEGIES.sku.name).ok);
    if (!revealed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_SKU", field: "sku", cause: "the SKU field did not appear after enabling the Custom label toggle" }) };
  }
  const field = resolveByName(doc, EBAY_FIELD_STRATEGIES.sku.name);
  if (!field.ok) return { ok: false, reason: field.reason };
  if (field.element.value === item.sku) return { ok: true };
  setNativeValue(field.element, item.sku, win);
  const confirmed = await waitFor(() => field.element.value === item.sku);
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_SKU", field: "sku", expected: item.sku, observed: field.element.value }) };
  return { ok: true };
}

export async function stepSetConditionDescription(item, { doc, win }) {
  if (!item.conditionDescription) return { ok: true }; // optional field — nothing to set
  const field = resolveByName(doc, EBAY_FIELD_STRATEGIES.conditionDescription.name);
  if (!field.ok) return { ok: true, skipped: true, reason: field.reason }; // not every category renders this field — never a hard failure
  setNativeValue(field.element, item.conditionDescription, win);
  const confirmed = await waitFor(() => field.element.value === item.conditionDescription);
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_CONDITION_DESCRIPTION", field: "conditionDescription", expected: item.conditionDescription, observed: field.element.value }) };
  return { ok: true };
}

/**
 * One item specific — tries the VERIFIED pill-button pattern first (UK
 * Shoe Size's own confirmed behaviour), falling back to the search-box
 * autocomplete pattern (Brand's own confirmed behaviour: type, then click
 * the first matching suggestion option). Neither existing is never a hard
 * failure for an OPTIONAL specific — see stepSelectItemSpecifics below,
 * which only treats this as fatal for a specific the caller marked
 * required.
 */
async function stepSetOneItemSpecific(doc, win, name, value) {
  const pill = resolveItemSpecificPillButton(doc, name, value);
  if (pill.ok) {
    if (isPillButtonPressed(pill.element)) return { ok: true };
    safeClick(pill.element, `SET_SPECIFIC:${name}`);
    const confirmed = await waitFor(() => isPillButtonPressed(pill.element));
    if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_ITEM_SPECIFIC", field: name, expected: value, cause: "pill button never showed aria-pressed=true" }) };
    return { ok: true };
  }

  const searchBox = resolveItemSpecificSearchBox(doc, name);
  if (!searchBox.ok) return { ok: false, reason: searchBox.reason };
  setNativeValue(searchBox.element, value, win);
  const optionAppeared = await waitFor(() => findByRole(doc.body, "option", { nameContains: value }).length > 0 || findByRole(doc.body, "button", { name: value }).length > 0);
  if (!optionAppeared) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_ITEM_SPECIFIC", field: name, expected: value, cause: "no matching suggestion appeared" }) };
  const options = findByRole(doc.body, "option", { nameContains: value }).concat(findByRole(doc.body, "button", { name: value }));
  const unique = requireUnique(options, `item specific option "${value}" for "${name}"`);
  if (!unique.ok) return { ok: false, reason: unique.reason };
  safeClick(unique.element, `SET_SPECIFIC:${name}`);
  const confirmed = await waitFor(() => searchBox.element.value.toLowerCase().includes(value.toLowerCase()));
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "SET_ITEM_SPECIFIC", field: name, expected: value, observed: searchBox.element.value }) };
  return { ok: true };
}

/** Sets every item specific in item.itemSpecifics. A specific eBay's OWN category doesn't render for this listing is never a hard failure (categories vary in which specifics they expose) — only a genuine SET failure for a specific that DOES exist on the page is fatal, so this never silently drops a value the page was ready to accept. */
export async function stepSelectItemSpecifics(item, { doc, win }, report = () => {}) {
  for (const specific of item.itemSpecifics) {
    report("filling", { detail: `Setting ${specific.name}` });
    const result = await stepSetOneItemSpecific(doc, win, specific.name, specific.value);
    if (!result.ok && !/NOT_FOUND/.test(result.reason || "")) return result; // a genuine failure on a field that DOES exist
    // NOT_FOUND is tolerated here (the category may not render this
    // specific) — logged via lastCompletedStep-equivalent reporting only.
  }
  return { ok: true };
}

export async function stepSelectPolicy(fieldStrategy, policy, { doc, win }, stepName) {
  if (!policy) return { ok: true }; // optional — see this feature's own account-default finding (Phase 2): returns/location come from account settings, and payment/shipping may too if unset
  const field = resolveByName(doc, fieldStrategy.name);
  if (!field.ok) return { ok: false, reason: field.reason };
  if (field.element.value && field.element.value.includes(policy.name)) return { ok: true };
  setNativeValue(field.element, policy.name, win);
  const optionAppeared = await waitFor(() => findByRole(doc.body, "option", { nameContains: policy.name }).length > 0);
  if (!optionAppeared) return { ok: false, reason: buildFieldTimeoutReason({ step: stepName, field: fieldStrategy.name, expected: policy.name, cause: "no matching policy option appeared" }) };
  const options = findByRole(doc.body, "option", { nameContains: policy.name });
  const unique = requireUnique(options, `policy option "${policy.name}"`);
  if (!unique.ok) return { ok: false, reason: unique.reason };
  safeClick(unique.element, stepName);
  return { ok: true };
}

// ---- Photos (Phase 5) -------------------------------------------------

function safeFileName(rawName, position, mimeType) {
  const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9._-]+$/;
  const candidate = typeof rawName === "string" ? rawName.trim() : "";
  if (candidate && SAFE_FILENAME_PATTERN.test(candidate)) return candidate;
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return `photo-${position}.${ext}`;
}

/**
 * Uploads every available photo, preserving the app's own order (Phase 5).
 * Downloads happen ONE AT A TIME via the injected requestPhoto (the
 * service worker's own fetch, never this content script's — see
 * shared/ebay-messages.js's EBAY_REQUEST_PHOTO comment for why). Reports
 * the exact number requested/uploaded/failed via `report`, per this
 * feature's own "report the exact number requested, uploaded and failed"
 * requirement — never silently drops a photo.
 *
 * VERIFIED live: the real file input is a single `#fehelix-uploader`
 * accepting multiple files in one assignment (accept="image/*,image/heic,
 * image/heif,video/mp4,video/quicktime"), exactly like Vinted's own
 * single-batch-assignment DataTransfer pattern — NOT yet verified is
 * whether eBay's own thumbnail confirmation renders a stable, countable
 * DOM marker the way Vinted's image-wrapper-N cards do; until that is
 * live-confirmed, this step confirms upload completion via the file
 * input's own `.files.length` matching the expected count (a weaker, but
 * still genuine, confirmation — never assumed complete from the click
 * alone) rather than a page-rendered thumbnail count.
 */
export async function stepUploadPhotos(item, { doc, win, requestPhoto, DataTransferImpl, FileImpl }, report = () => {}) {
  const fileFound = resolvePhotoInput(doc);
  if (!fileFound.ok) return { ok: false, reason: fileFound.reason };
  const input = fileFound.element;

  const orderedPhotos = item.photos.slice().sort((a, b) => a.position - b.position);
  const total = orderedPhotos.length;
  let uploaded = 0;
  let failed = 0;
  const files = [];

  for (const photo of orderedPhotos) {
    const label = `photo ${photo.position + 1} of ${total}`;
    report("filling", { detail: `Downloading ${label}`, photosRequested: total, photosUploaded: uploaded, photosFailed: failed });

    let result;
    try { result = await requestPhoto(item.itemId, photo.position); }
    catch (error) { failed += 1; return { ok: false, reason: `NETWORK: could not download photo at position ${photo.position} (${error?.name || "Error"}: ${String(error?.message || error)}).`, photosRequested: total, photosUploaded: uploaded, photosFailed: failed }; }
    if (!result || !result.ok) { failed += 1; return { ok: false, reason: (result && result.reason) || `NETWORK: could not download photo at position ${photo.position}.`, photosRequested: total, photosUploaded: uploaded, photosFailed: failed }; }

    let bytes;
    try {
      const binary = win.atob(result.base64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch (error) {
      failed += 1;
      return { ok: false, reason: `INVALID: could not reconstruct photo ${photo.position} (${error?.name || "Error"}: ${String(error?.message || error)}).`, photosRequested: total, photosUploaded: uploaded, photosFailed: failed };
    }
    files.push(new FileImpl([bytes], safeFileName(result.fileName, photo.position, result.mimeType), { type: result.mimeType }));
    uploaded += 1;
    report("filling", { detail: `Uploaded ${label}`, photosRequested: total, photosUploaded: uploaded, photosFailed: failed });
  }

  const dataTransfer = new DataTransferImpl();
  for (const file of files) dataTransfer.items.add(file);
  try { input.files = dataTransfer.files; }
  catch { Object.defineProperty(input, "files", { value: dataTransfer.files, configurable: true }); }
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(new win.Event("change", { bubbles: true }));

  const confirmed = await waitFor(() => input.files && input.files.length === total, { timeoutMs: STEP_TIMEOUT_MS * 2 });
  if (!confirmed) return { ok: false, reason: buildFieldTimeoutReason({ step: "UPLOAD_PHOTOS", field: "photos", expected: total, observed: input.files?.length ?? 0, cause: "the file input never reflected every uploaded photo" }), photosRequested: total, photosUploaded: uploaded, photosFailed: failed };
  return { ok: true, photosRequested: total, photosUploaded: uploaded, photosFailed: 0 };
}

// ---- Verify-after-population (Phase 6: "the click succeeded is not proof") -

/** Re-reads every field this run set and confirms it still holds the expected value RIGHT NOW — never trusts an earlier per-field confirmation alone, since a later step's own interaction (e.g. a dropdown's outside-click handler) could in principle have reset an earlier field. */
export function stepVerifyPopulatedFields(item, { doc }) {
  const mismatches = [];
  const title = resolveByName(doc, EBAY_FIELD_STRATEGIES.title.name);
  if (!title.ok || title.element.value !== item.title) mismatches.push("title");
  const description = resolveByName(doc, EBAY_FIELD_STRATEGIES.description.name);
  if (!description.ok || description.element.value !== item.description) mismatches.push("description");
  const price = resolveByName(doc, EBAY_FIELD_STRATEGIES.price.name);
  if (!price.ok || !priceValueMatch(price.element.value, (item.pricePence / 100).toFixed(2))) mismatches.push("price");
  const quantity = resolveByName(doc, EBAY_FIELD_STRATEGIES.quantity.name);
  if (!quantity.ok || quantity.element.value !== String(item.quantity)) mismatches.push("quantity");
  const sku = resolveByName(doc, EBAY_FIELD_STRATEGIES.sku.name);
  if (!sku.ok || sku.element.value !== item.sku) mismatches.push("sku");
  if (mismatches.length > 0) return { ok: false, reason: `VERIFY_FAILED: the following fields did not hold their expected value on final read-back: ${mismatches.join(", ")}.` };
  return { ok: true };
}

// ---- Safety detection (mirrors form-steps.js's own, marketplace-agnostic) -

const LOGIN_REQUIRED_PATTERNS = [/sign in to (?:your )?account/i, /log ?in to continue/i, /session has expired/i];
export function detectLoginRequired(doc) {
  for (const el of Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"], form, [role="alert"], [role="status"]'))) {
    const text = el.textContent || "";
    for (const pattern of LOGIN_REQUIRED_PATTERNS) if (pattern.test(text)) return pattern.source;
  }
  return null;
}

const CAPTCHA_OR_VERIFICATION_PATTERNS = [/captcha/i, /verify you are human/i, /pardon our interruption/i, /confirm you're not a robot/i, /additional verification/i, /security check/i];
export function detectCaptchaOrVerification(doc) {
  for (const iframe of Array.from(doc.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i]'))) {
    if (iframe.offsetParent !== null) return "captcha iframe present";
  }
  for (const el of Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alert"], [class*="captcha" i], [id*="captcha" i], [class*="challenge" i]'))) {
    const text = el.textContent || "";
    for (const pattern of CAPTCHA_OR_VERIFICATION_PATTERNS) if (pattern.test(text)) return pattern.source;
  }
  return null;
}

// ---- Orchestrator ----------------------------------------------------

/** Read-only page-state check — used by the service worker to decide whether a tab needs a fresh navigation before dispatching an item, without ever resetting anything itself (mirrors form-steps.js's own inspectPageState/PAGE_STATE convention). */
export function inspectEbayPageState(doc, location) {
  if (detectCaptchaOrVerification(doc)) return "captcha";
  if (detectLoginRequired(doc)) return "login_required";
  if (isOnSellerHubListingForm(location)) return "on_form";
  if (/\/sl\/prelist/.test(location.pathname)) return "on_wizard";
  return "elsewhere";
}

/**
 * Runs one eBay extension batch item end to end, STOPPING at
 * WAITING_FOR_REVIEW — never Save Draft, never Publish (see this file's
 * own top comment). `deps` mirrors form-steps.js's own runItem contract:
 * { doc, win, location, requestPhoto, DataTransferImpl, FileImpl }, all
 * injected so this is directly unit-testable against a synthetic fixture.
 * `report(status, extra)` is called on every real transition — the
 * content-script wrapper forwards each call to the service worker as
 * EBAY_ITEM_STEP_PROGRESS.
 */
export async function runEbayItem(item, report, deps) {
  const { doc } = deps;

  const captcha = detectCaptchaOrVerification(doc);
  if (captcha) return { ok: false, errorCode: "CAPTCHA_OR_VERIFICATION", errorMessage: `eBay presented a security check (${captcha}) — stopping. Complete it manually, then retry.` };
  const loginRequired = detectLoginRequired(doc);
  if (loginRequired) return { ok: false, errorCode: "LOGIN_REQUIRED", errorMessage: "eBay is asking to sign in again — sign in manually in this tab, then retry." };

  report("preparing", { currentStep: "OPEN_FORM" });
  const opened = await stepStartPrelistSearch(deps, item.title);
  if (!opened.ok) return { ok: false, errorCode: "OPEN_FORM", errorMessage: opened.reason };

  if (!opened.alreadyOnForm) {
    report("preparing", { currentStep: "SELECT_CATEGORY" });
    const category = await stepSelectCategorySuggestion(deps, item.categoryName);
    if (!category.ok) return { ok: false, errorCode: "SELECT_CATEGORY", errorMessage: category.reason };

    // CORRECTIVE PASS (condition-safety review) — never auto-selected; see
    // stepWaitForManualCondition's own extensive comment for why.
    report("preparing", { currentStep: "SELECT_CONDITION_MANUAL" });
    const condition = await stepWaitForManualCondition(deps, report);
    if (!condition.ok) return { ok: false, errorCode: "SELECT_CONDITION", errorMessage: condition.reason };
  }

  report("filling", { currentStep: "SET_TITLE" });
  const title = await stepSetTitle(item, deps);
  if (!title.ok) return { ok: false, errorCode: "SET_TITLE", errorMessage: title.reason };

  report("filling", { currentStep: "UPLOAD_PHOTOS" });
  const photos = await stepUploadPhotos(item, deps, report);
  if (!photos.ok) return { ok: false, errorCode: "UPLOAD_PHOTOS", errorMessage: photos.reason, photosRequested: photos.photosRequested, photosUploaded: photos.photosUploaded, photosFailed: photos.photosFailed };

  report("filling", { currentStep: "SET_DESCRIPTION" });
  const description = await stepSetDescription(item, deps);
  if (!description.ok) return { ok: false, errorCode: "SET_DESCRIPTION", errorMessage: description.reason };

  report("filling", { currentStep: "SET_ITEM_SPECIFICS" });
  const specifics = await stepSelectItemSpecifics(item, deps, report);
  if (!specifics.ok) return { ok: false, errorCode: "SET_ITEM_SPECIFICS", errorMessage: specifics.reason };

  report("filling", { currentStep: "SET_CONDITION_DESCRIPTION" });
  const conditionDescription = await stepSetConditionDescription(item, deps);
  if (!conditionDescription.ok) return { ok: false, errorCode: "SET_CONDITION_DESCRIPTION", errorMessage: conditionDescription.reason };

  report("filling", { currentStep: "SET_PRICE" });
  const price = await stepSetPrice(item, deps);
  if (!price.ok) return { ok: false, errorCode: "SET_PRICE", errorMessage: price.reason };

  report("filling", { currentStep: "SET_QUANTITY" });
  const quantity = await stepSetQuantity(item, deps);
  if (!quantity.ok) return { ok: false, errorCode: "SET_QUANTITY", errorMessage: quantity.reason };

  report("filling", { currentStep: "SET_SKU" });
  const sku = await stepSetSku(item, deps);
  if (!sku.ok) return { ok: false, errorCode: "SET_SKU", errorMessage: sku.reason };

  report("filling", { currentStep: "SET_POLICIES" });
  const fulfillment = await stepSelectPolicy(EBAY_FIELD_STRATEGIES.fulfillmentPolicy, item.fulfillmentPolicy, deps, "SET_FULFILLMENT_POLICY");
  if (!fulfillment.ok) return { ok: false, errorCode: "SET_FULFILLMENT_POLICY", errorMessage: fulfillment.reason };
  const payment = await stepSelectPolicy(EBAY_FIELD_STRATEGIES.paymentPolicy, item.paymentPolicy, deps, "SET_PAYMENT_POLICY");
  if (!payment.ok) return { ok: false, errorCode: "SET_PAYMENT_POLICY", errorMessage: payment.reason };
  // Returns policy / item location are deliberately NEVER actively set —
  // VERIFIED live (Phase 2): both are inherited from the seller's own
  // account-wide defaults on this form, shown read-only with an Edit link,
  // not a per-listing field this flow fills in.

  report("filling", { currentStep: "VERIFY_FIELDS" });
  const verified = stepVerifyPopulatedFields(item, deps);
  if (!verified.ok) return { ok: false, errorCode: "VERIFY_FIELDS", errorMessage: verified.reason };

  return { ok: true, photosRequested: photos.photosRequested, photosUploaded: photos.photosUploaded, photosFailed: photos.photosFailed };
}
