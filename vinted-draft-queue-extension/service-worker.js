// Vinted Draft Queue extension — background service worker (MV3, ES
// module — "type": "module" in manifest.json). The ONLY place chrome.storage.local
// is read or written (single-writer, avoids races between the side panel
// and the content script both trying to persist queue state). Owns:
// claiming a batch, fetching its payload, opening/managing the Vinted tab,
// dispatching one item at a time to the content script, persisting every
// status transition, and reporting results back to the app.
//
// "Chrome may suspend the service worker, so never rely on global
// in-memory state" — this file holds NO state in module-level variables
// beyond pure constants; every real fact is read fresh from
// chrome.storage.local at the start of every handler and written back
// before the handler returns. See shared/queue-state.js's own top comment
// for how resumeAfterRestart() recovers a mid-flight item after a restart.

import { PANEL_TO_WORKER, CONTENT_TO_WORKER, WORKER_TO_CONTENT } from "./shared/messages.js";
import * as QueueState from "./shared/queue-state.js";
import { validateBatchPayload, isValidPairingCodeShape } from "./shared/validation.js";

const DEFAULT_APP_BASE_URL = "http://localhost:3000";
const VINTED_URL_PATTERN = "https://www.vinted.co.uk/*";
const CREATE_LISTING_TAB_PATTERN = /^https:\/\/www\.vinted\.co\.uk\/items\/new(?:[/?#]|$)/;
// Also allowed (beyond the bare Create Listing form): every page Vinted
// itself can navigate the tab to once a draft is saved.
//
// Follow-up correction (live Save Draft investigation) — this pattern
// used to allow only /items/<id>/edit, on the assumption Save Draft
// navigates straight there. Verified directly against a live, signed-in
// session (see shared/form-steps.js's own comment on stepSaveDraft for
// the full finding): Save Draft actually performs a genuine top-level
// navigation to the SELLER'S OWN PROFILE page
// (https://www.vinted.co.uk/member/<sellerId>), never straight to the
// edit page — the edit page is only reachable from there via its
// "Finish editing" link, which nothing in this flow ever clicks. Without
// /member/* also being allowed here, isSelectedTabStillValid() wrongly
// treated a JUST-SUCCEEDED save as "the tab navigated away and was
// lost", pausing the batch immediately after a real success — a second,
// independent consequence of the same root cause as the reported
// timeout. The very next item's own stepOpenForm() already knows how to
// get back to a fresh /items/new from either destination (see
// shared/form-steps.js), so both are a normal, expected mid-batch URL
// for the selected tab, never a sign it was lost.
const ALLOWED_VINTED_TAB_PATTERN = /^https:\/\/www\.vinted\.co\.uk\/(items\/(new|\d+\/edit)|member\/\d+)(?:[/?#]|$)/;
// Follow-up correction (durable Save Draft confirmation) — the subset of
// ALLOWED_VINTED_TAB_PATTERN that a confirmation check is ever worth
// attempting against: specifically NOT /items/new itself (the tab sits
// there both before AND, briefly, right after the click — attempting a
// check there would just waste a round trip finding nothing) — only the
// two real, observed post-save destinations (see
// shared/form-steps.js's findConfirmedDraftId for the full finding).
const POST_SAVE_CONFIRMATION_TAB_PATTERN = /^https:\/\/www\.vinted\.co\.uk\/(member\/\d+|items\/\d+\/edit)(?:[/?#]|$)/;
const ALARM_NAME = "vinted-draft-queue-tick";
// How long a single PING is given to get a response before treating the
// content script as absent — generous for a same-process message round
// trip, short enough that a genuinely dead tab is detected quickly rather
// than stalling the whole "start next item" flow.
const PING_TIMEOUT_MS = 1500;
// Watchdog: an in-flight item (preparing/filling/saving) with no reported
// progress for this long is presumed stuck and moved to a retryable failed
// state — see triggerTick()'s own comment. Generous relative to the
// ~1-minute-per-listing target so a genuinely slow (not stuck) save is
// never killed mid-flight, but still bounded so a truly stuck item is
// never left indefinitely in "preparing".
const WATCHDOG_TIMEOUT_MS = 3 * 60 * 1000;
// Follow-up correction (durable Save Draft confirmation) — how long a
// pending-save record is given to be confirmed before it becomes a clear
// SAVE_DRAFT_UNCONFIRMED failure (see shared/queue-state.js's
// applyPendingSaveExpired). Deliberately well UNDER WATCHDOG_TIMEOUT_MS —
// this is the specific, more informative signal that should always fire
// first for a pending save; the generic watchdog message would otherwise
// occasionally win the race and give a far less useful error. Generous
// enough for Vinted's real redirect + full page render, including at
// least one periodic recovery tick's worth of margin.
const SAVE_DRAFT_CONFIRMATION_TIMEOUT_MS = 90 * 1000;

// Follow-up correction (photo-download CORS bug) — the extension-facing
// photo route always serves already-converted output (see
// app/api/extension/batch/route.ts's own extensionForMime — never the
// original HEIC/HEIF), so only these three are ever legitimate here.
const ALLOWED_PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
// Mirrors lib/listing-studio/upload-limits.ts's MAX_INDIVIDUAL_FILE_SIZE_BYTES
// — kept as an independent local constant since this extension is a
// separate, dependency-free codebase that never imports app source files
// directly (see this repo's own top-level conventions).
const MAX_PHOTO_BYTES = 35 * 1024 * 1024;

// Follow-up correction (message-lifecycle hang bug) — bounds the app API
// photo fetch itself. A stalled connection (one that never errors AND
// never completes) used to hang this function — and therefore the whole
// REQUEST_PHOTO round trip — indefinitely, with no error surfacing at all
// until the unrelated 3-minute item watchdog eventually gave up on the
// ENTIRE item. Aborting well under that watchdog turns a stalled fetch
// into a specific, immediate, retryable failure instead.
const FETCH_TIMEOUT_MS = 30_000;
// A conservative bound comfortably under any known chrome.runtime
// messaging size ceiling. A single sendResponse carrying the WHOLE base64
// photo is fine below this; above it, reliability is not something to
// gamble on (see downloadPhotoForContentScript's own comment) — MAX_PHOTO_BYTES
// (35 MB) base64-encodes to ~46.6 MB, comfortably over this bound, so the
// largest allowed photos always use the chunked path below.
const SAFE_SINGLE_MESSAGE_BASE64_CHARS = 20_000_000; // ~15 MB binary
// Small enough that any individual REQUEST_PHOTO_CHUNK response is
// reliably small, however large the whole photo is.
const PHOTO_CHUNK_BASE64_CHARS = 4_000_000; // ~3 MB binary per chunk
// How long an in-progress chunked transfer is kept in memory if the
// content script never finishes requesting every chunk (e.g. the tab
// closed mid-transfer) — never chrome.storage.local (see this file's own
// "never store photo bytes permanently" requirement); this is purely an
// in-memory cleanup bound so an abandoned transfer doesn't linger for the
// service worker's whole lifetime.
const PHOTO_TRANSFER_TTL_MS = 60_000;

function nowIso() { return new Date().toISOString(); }

/**
 * SAFE, TEMPORARY diagnostics for the message-lifecycle hang bug — see
 * this file's safeUrlParts/describe*Failure helpers for the same "never a
 * full URL/token/byte" restriction; only ever a photo position and a
 * short fixed label are logged here.
 */
function logStage(stage, position, extra = "") {
  console.log(`Vinted Draft Queue [photo ${position}]: ${stage}`, extra);
}

// In-memory ONLY, and only ever for a photo CURRENTLY mid-transfer — never
// chrome.storage.local. Losing this on a service-worker suspend/restart
// mid-transfer is acceptable: the content script's own bounded
// REQUEST_PHOTO_CHUNK timeout (see shared/photo-transfer.js) turns that
// into a clear, retryable failure rather than a hang.
const photoTransfers = new Map();

function chunkBase64(base64) {
  const chunks = [];
  for (let i = 0; i < base64.length; i += PHOTO_CHUNK_BASE64_CHARS) chunks.push(base64.slice(i, i + PHOTO_CHUNK_BASE64_CHARS));
  return chunks;
}

function storePhotoTransfer(chunks) {
  const transferId = crypto.randomUUID();
  photoTransfers.set(transferId, chunks);
  setTimeout(() => photoTransfers.delete(transferId), PHOTO_TRANSFER_TTL_MS);
  return transferId;
}

/** Serves ONE bounded chunk of a previously-downloaded photo. Deletes the transfer as soon as its LAST chunk is served — never waits out the TTL once fully consumed. */
function getPhotoChunk(transferId, chunkIndex) {
  const chunks = photoTransfers.get(transferId);
  if (!chunks) return { ok: false, reason: "NOT_FOUND: photo transfer expired or is unknown — request the photo again." };
  if (typeof chunkIndex !== "number" || chunkIndex < 0 || chunkIndex >= chunks.length) {
    return { ok: false, reason: `NOT_FOUND: chunk ${chunkIndex} is out of range for this photo transfer.` };
  }
  const isLast = chunkIndex === chunks.length - 1;
  if (isLast) photoTransfers.delete(transferId);
  return { ok: true, chunkIndex, data: chunks[chunkIndex] };
}

/** Base64-encodes an ArrayBuffer in bounded chunks — String.fromCharCode(...bytes) on the WHOLE array risks a call-stack overflow for a large photo. */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  return btoa(binary);
}

/**
 * SAFE diagnostics only — never a full URL (query strings/tokens), never
 * request headers. Only protocol/hostname/pathname, HTTP status/statusText,
 * exception name/message, and the photo position are ever included in a
 * returned reason or logged — see this project's own explicit requirement
 * that credentials/signed-URL details never appear in an error message.
 */
function safeUrlParts(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return { protocol: url.protocol.replace(/:$/, ""), hostname: url.hostname, pathname: url.pathname };
  } catch {
    return { protocol: "unknown", hostname: "unknown", pathname: "unknown" };
  }
}
function safeUrlString(rawUrl) {
  const { protocol, hostname, pathname } = safeUrlParts(rawUrl);
  return `${protocol}://${hostname}${pathname}`;
}

// Follow-up correction (live production PHOTO_HOST_NOT_PERMITTED follow-up
// bug — "TypeError: Failed to fetch") — every stage a photo download can
// fail at, named explicitly. The live investigation needed to distinguish
// "the service worker never even got the message" (see photo-transfer.js's
// own TIMEOUT/NETWORK-no-response messages — those happen on the CONTENT
// SCRIPT side, before/without ever reaching here) from "the service worker
// DID receive REQUEST_PHOTO and attempted the download, but the download
// itself failed" (every stage below) — every reason this function ever
// returns implies the LATTER, since reaching any of these lines is itself
// proof the message was received and is being answered.
const PHOTO_FETCH_STAGE = Object.freeze({
  URL_RESOLUTION: "URL_RESOLUTION",
  HOST_PERMISSION: "HOST_PERMISSION",
  FETCH: "FETCH",
  REDIRECT: "REDIRECT",
  HTTP_STATUS: "HTTP_STATUS",
  READ_BODY: "READ_BODY",
  MIME_VALIDATION: "MIME_VALIDATION",
  SIZE_VALIDATION: "SIZE_VALIDATION",
});

/**
 * Reads a BOUNDED, safe excerpt of a failed response's own JSON error body
 * (e.g. `{"error":"Missing batch token."}`) — never the raw body verbatim,
 * never anything beyond a short, single-line string, and never attempted at
 * all for a successful (2xx) response, so real image bytes are never routed
 * through text/JSON parsing. A response whose body can't be read or isn't
 * `{"error": string}`-shaped safely degrades to null rather than throwing.
 */
async function safeResponseErrorMessage(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    const bounded = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    try {
      const parsed = JSON.parse(bounded);
      if (parsed && typeof parsed.error === "string") return parsed.error.slice(0, 300);
    } catch { /* not JSON — fall through to the bounded raw text below */ }
    return bounded.replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

/**
 * Builds the ONE structured diagnostic reason string every photo-download
 * failure below returns — request stage, HTTP status (when a response
 * exists), whether a redirect occurred, the final response URL (sanitised
 * — see safeUrlString), and a safe server-provided error message, all in
 * one place so a real failure is self-diagnosing from the persisted
 * errorMessage alone. Mirrors shared/form-steps.js's own
 * buildFieldTimeoutReason key=value convention (a deliberately separate,
 * local implementation — this file has never imported shared/form-steps.js
 * and does not start now, per this project's own "no cross-file coupling
 * beyond what's needed" convention). NEVER includes a bearer token, a
 * signed URL, a query string, or any byte of image content — only ever the
 * sanitised protocol/hostname/pathname (see safeUrlParts) and short,
 * bounded text.
 */
function buildPhotoFailureReason({ prefix, stage, position, requestUrl, status, redirected, finalUrl, serverError, cause }) {
  const parts = [
    `stage=${stage}`,
    `position=${position}`,
    `url=${JSON.stringify(safeUrlString(requestUrl))}`,
    `status=${status ?? "none"}`,
    `redirected=${redirected ?? false}`,
    `final_url=${JSON.stringify(finalUrl ? safeUrlString(finalUrl) : "none")}`,
    serverError ? `server_error=${JSON.stringify(serverError)}` : null,
    cause ? `reason=${JSON.stringify(cause)}` : null,
  ].filter(Boolean);
  return `${prefix}: ${parts.join(" ")}`;
}

function describeNetworkFailure(rawUrl, position, error) {
  return buildPhotoFailureReason({
    prefix: "NETWORK", stage: PHOTO_FETCH_STAGE.FETCH, position, requestUrl: rawUrl,
    status: null, redirected: false, finalUrl: null,
    cause: `${error?.name || "Error"}: ${String(error?.message || error)}`,
  });
}
async function describeHttpFailure(rawUrl, position, response) {
  const serverError = await safeResponseErrorMessage(response);
  return buildPhotoFailureReason({
    prefix: `HTTP_${response.status}`, stage: PHOTO_FETCH_STAGE.HTTP_STATUS, position, requestUrl: rawUrl,
    status: response.status, redirected: response.redirected, finalUrl: response.url || null,
    serverError, cause: response.statusText || null,
  });
}
function describeRedirectRejected(rawUrl, position, response) {
  return buildPhotoFailureReason({
    prefix: "REDIRECT_REJECTED", stage: PHOTO_FETCH_STAGE.REDIRECT, position, requestUrl: rawUrl,
    status: response.status, redirected: response.redirected, finalUrl: response.url || null,
    cause: "the response was redirected away from the requested photo route — a redirected response is never treated as valid photo data, regardless of its final status",
  });
}

// Follow-up correction (photo origin-mismatch bug) — the ONLY shape a
// batch photo's `path` may ever take. Anchored end to end, so a match can
// contain no protocol, host, credentials, query string, fragment, or
// (literal/encoded) ".." traversal — only the exact
// /api/extension/batch/photos/<item-uuid>/<position> route. Mirrors
// lib/listing-studio/extension-batch-schema.ts's own
// EXTENSION_PHOTO_PATH_PATTERN (hand-written here, dependency-free, since
// this extension never imports app source directly — see this file's own
// MAX_PHOTO_BYTES precedent for the same mirroring convention).
const PHOTO_PATH_PATTERN = /^\/api\/extension\/batch\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(0|[1-9][0-9]*)$/i;

/**
 * Follow-up correction (photo origin-mismatch bug) — root cause: the
 * batch payload used to carry an ABSOLUTE photo url built server-side from
 * NEXT_PUBLIC_APP_URL, which could (and did) silently point at a
 * different origin than the extension's OWN configured App URL — the
 * request then went to a port nothing was listening on, and hung until
 * the fetch timeout/watchdog eventually gave up. A relative `path` removes
 * the whole class of drift: it is resolved ONLY against this extension's
 * own configured `appBaseUrl` (chrome.storage.local's settings — the same
 * origin its claim/batch requests already use and that its
 * host_permissions already cover), never trusted as (or converted from) an
 * absolute URL from the payload. Every check below fails CLOSED — this
 * function never lets the payload redirect the extension to an arbitrary
 * host.
 */
export function resolvePhotoUrl(appBaseUrl, path) {
  if (typeof path !== "string" || !PHOTO_PATH_PATTERN.test(path)) {
    return { ok: false, reason: "PHOTO_URL_INVALID: the photo path returned by the app did not match the expected route shape." };
  }

  let configured;
  try { configured = new URL(appBaseUrl); }
  catch { return { ok: false, reason: "PHOTO_URL_INVALID: the extension's configured App URL is not a valid URL." }; }

  let resolved;
  try { resolved = new URL(path, `${appBaseUrl}/`); }
  catch { return { ok: false, reason: "PHOTO_URL_INVALID: could not resolve the photo path against the configured App URL." }; }

  if (resolved.origin !== configured.origin) {
    return { ok: false, reason: `PHOTO_ORIGIN_MISMATCH: the resolved photo URL (${resolved.protocol}//${resolved.host}) does not match the configured App URL's origin (${configured.protocol}//${configured.host}).` };
  }
  if (!PHOTO_PATH_PATTERN.test(resolved.pathname)) {
    return { ok: false, reason: "PHOTO_URL_INVALID: the resolved photo URL's path does not match the expected route shape." };
  }
  return { ok: true, url: resolved };
}

/**
 * Whether this extension currently holds host permission for `origin` —
 * checked BEFORE ever attempting a fetch, so a missing permission (e.g.
 * the configured App URL points at a dev port never added to
 * manifest.json's host_permissions) is reported immediately, rather than
 * surfacing later as a slow, opaque CORS-style network failure.
 */
function checkHostPermitted(origin) {
  return new Promise(resolve => {
    try {
      chrome.permissions.contains({ origins: [`${origin}/*`] }, granted => resolve(Boolean(granted)));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Downloads ONE photo — using the batch's own bearer token, never any
 * longer-lived credential — and returns it as base64 (never a raw
 * ArrayBuffer over chrome.runtime messaging, per this project's own
 * "if in doubt, use a bounded base64 representation for one photo at a
 * time" guidance) plus its verified MIME type and filename. Called ONE
 * photo at a time (see form-steps.js's stepUploadPhotos, which awaits
 * each REQUEST_PHOTO in position order before requesting the next) —
 * bytes are never held here beyond the single request/response, and are
 * never written to chrome.storage.local.
 *
 * This function is the ONLY place in the whole extension that fetches a
 * photo's bytes — a Vinted-page content script must never do this itself
 * (see CONTENT_TO_WORKER.REQUEST_PHOTO's own comment for why).
 */
async function downloadPhotoForContentScript(itemId, position) {
  logStage("stage 3: service worker received REQUEST_PHOTO", position);
  const state = await getState();
  if (!state.pairing?.batchToken) return { ok: false, reason: "NOT_FOUND: no active batch — pairing has expired or was cleared." };
  if (QueueState.isBatchExpired(state, nowIso())) return { ok: false, reason: "EXPIRED: this batch has expired." };

  const item = state.batch?.items?.find(i => i.itemId === itemId);
  if (!item) return { ok: false, reason: `NOT_FOUND: item ${itemId} is not part of the active batch.` };
  const photo = (item.photos || []).find(p => p.position === position);
  if (!photo) return { ok: false, reason: `NOT_FOUND: no photo at position ${position} for this item.` };

  // Follow-up correction (photo origin-mismatch bug): resolved against
  // THIS extension's own configured App URL — never an absolute URL from
  // the payload — and validated before ever attempting a fetch, so a bad
  // path/origin/permission responds immediately rather than waiting out
  // the fetch timeout.
  const { appBaseUrl } = await getSettings();
  const resolved = resolvePhotoUrl(appBaseUrl, photo.path);
  if (!resolved.ok) {
    console.warn("Vinted Draft Queue: photo URL resolution failed —", resolved.reason);
    return { ok: false, reason: resolved.reason };
  }
  const permitted = await checkHostPermitted(resolved.url.origin);
  if (!permitted) {
    const reason = `PHOTO_HOST_NOT_PERMITTED: this extension has no host permission for ${resolved.url.protocol}//${resolved.url.host} — add it to manifest.json's host_permissions.`;
    console.warn("Vinted Draft Queue: photo host not permitted —", reason);
    return { ok: false, reason };
  }
  const photoUrl = resolved.url.toString();

  logStage("stage 4: service worker starting app API fetch", position);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(photoUrl, { headers: { Authorization: `Bearer ${state.pairing.batchToken}` }, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.name === "AbortError") {
      const reason = buildPhotoFailureReason({
        prefix: "PHOTO_FETCH_TIMEOUT", stage: PHOTO_FETCH_STAGE.FETCH, position, requestUrl: photoUrl,
        status: null, redirected: false, finalUrl: null,
        cause: `did not respond within ${FETCH_TIMEOUT_MS / 1000}s — the app may be unreachable or the connection stalled`,
      });
      console.warn("Vinted Draft Queue: photo download fetch timed out —", reason);
      return { ok: false, reason };
    }
    console.warn("Vinted Draft Queue: photo download network error —", error?.name, error?.message);
    return { ok: false, reason: describeNetworkFailure(photoUrl, position, error) };
  }
  clearTimeout(timeoutId);
  logStage("stage 5: fetch returned headers/status", position, response.status);

  // Required behaviour (live production follow-up bug) — a redirected
  // response is NEVER treated as valid photo data, regardless of its final
  // status. Checked BEFORE the ok/status check below: a redirect that
  // happens to land on a 200 page (e.g. a login page serving HTML with a
  // 200 status) must still be rejected, never silently accepted as if it
  // were the requested photo's bytes.
  if (response.redirected) {
    console.warn("Vinted Draft Queue: photo download was redirected —", safeUrlString(response.url || photoUrl));
    return { ok: false, reason: describeRedirectRejected(photoUrl, position, response) };
  }
  if (!response.ok) {
    console.warn("Vinted Draft Queue: photo download HTTP failure —", response.status, response.statusText);
    return { ok: false, reason: await describeHttpFailure(photoUrl, position, response) };
  }

  let buffer;
  try { buffer = await response.arrayBuffer(); }
  catch (error) { return { ok: false, reason: describeNetworkFailure(photoUrl, position, error) }; }
  logStage("stage 6: response body finished reading", position, `${buffer.byteLength} bytes`);
  if (!buffer.byteLength) return { ok: false, reason: `EMPTY: photo ${position} response body was empty.` };
  if (buffer.byteLength > MAX_PHOTO_BYTES) {
    return { ok: false, reason: `TOO_LARGE: photo ${position} (${buffer.byteLength} bytes) exceeds the ${MAX_PHOTO_BYTES}-byte limit.` };
  }

  const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (!ALLOWED_PHOTO_MIME_TYPES.has(mimeType)) {
    return { ok: false, reason: `INVALID_MIME: photo ${position} had content type "${mimeType || "unknown"}", which is not an allowed image type.` };
  }

  const base64 = arrayBufferToBase64(buffer);
  if (base64.length <= SAFE_SINGLE_MESSAGE_BASE64_CHARS) {
    logStage("stage 7: service worker sending its response", position, "single message");
    return { ok: true, position, fileName: photo.fileName, mimeType, base64 };
  }

  // Follow-up correction (message-lifecycle hang bug): rather than gamble
  // on one very large sendResponse "just working" (or silently
  // failing/hanging Chrome's own messaging layer), anything above the
  // safe bound above is handed back in small, bounded chunks instead — see
  // getPhotoChunk/CONTENT_TO_WORKER.REQUEST_PHOTO_CHUNK. Still only one
  // photo in flight at a time, just delivered across several small
  // messages rather than one huge one.
  const chunks = chunkBase64(base64);
  const transferId = storePhotoTransfer(chunks);
  logStage("stage 7: service worker sending its response", position, `chunked, ${chunks.length} chunks`);
  return { ok: true, position, fileName: photo.fileName, mimeType, chunked: true, transferId, totalChunks: chunks.length };
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { appBaseUrl: DEFAULT_APP_BASE_URL, ...settings };
}
export async function setSettings(patch) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...patch } });
}

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return state ?? QueueState.createInitialState();
}
async function setState(state) {
  await chrome.storage.local.set({ state });
  return state;
}
async function updateState(updater) {
  const current = await getState();
  const next = await updater(current);
  await setState(next);
  return next;
}

// ---- Vinted tab management --------------------------------------------------
//
// Follow-up correction (arbitrary-tab-selection bug): ensureVintedTab()
// used to just take chrome.tabs.query(...)[0] — literally the first
// vinted.co.uk tab Chrome happened to return, which could be the
// homepage, an unrelated browsing tab, anything — not necessarily a
// Create Listing tab at all. Fixed with a deterministic one-time
// selection (selectVintedTab, below), PERSISTED as state.batch.vintedTabId
// so every later call for this batch — account detection, content-script
// readiness, and every item's form-filling — always operates on that
// exact same tab. It is never silently re-picked: if it's closed or
// navigated away, the batch pauses with a clear recovery message instead.

function isCreateListingTab(tab) { return Boolean(tab?.url) && CREATE_LISTING_TAB_PATTERN.test(tab.url); }
function isAllowedVintedTab(tab) { return Boolean(tab?.url) && ALLOWED_VINTED_TAB_PATTERN.test(tab.url); }

async function createFreshCreateListingTab() {
  const tab = await chrome.tabs.create({ url: "https://www.vinted.co.uk/items/new", active: true });
  await new Promise(resolve => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab.id;
}

/**
 * Deterministic, one-time tab selection — only ever run when no tab has
 * been selected yet for the active batch (see ensureVintedTab below), in
 * this exact priority order:
 *   1. The active tab of the current window, if it's ALREADY a Create
 *      Listing tab (never just "the active Vinted tab" — a homepage tab
 *      that merely happens to be active and on vinted.co.uk is skipped).
 *   2. Any OTHER Create Listing tab in the current window.
 *   3. A Create Listing tab in a different window.
 *   4. None exists anywhere — open a fresh one.
 */
async function selectVintedTab() {
  const [activeTabs, allVintedTabs] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.tabs.query({ url: VINTED_URL_PATTERN }),
  ]);
  const activeTab = activeTabs[0];
  const currentWindowId = activeTab?.windowId;

  if (activeTab && isCreateListingTab(activeTab)) return activeTab.id;

  const inCurrentWindow = currentWindowId != null ? allVintedTabs.filter(t => t.windowId === currentWindowId) : [];
  const createListingInCurrent = inCurrentWindow.find(isCreateListingTab);
  if (createListingInCurrent) return createListingInCurrent.id;

  const createListingInOther = allVintedTabs.find(t => t.windowId !== currentWindowId && isCreateListingTab(t));
  if (createListingInOther) return createListingInOther.id;

  return createFreshCreateListingTab();
}

/** false for a closed tab (chrome.tabs.get rejects) or one that navigated away from an allowed Create Listing URL — never throws. */
async function isSelectedTabStillValid(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { return false; }
  return isAllowedVintedTab(tab);
}

/**
 * Resolves the ONE tab this batch uses for everything. Runs
 * selectVintedTab() exactly ONCE per batch — the result is persisted in
 * state.batch.vintedTabId — and every later call just re-validates that
 * SAME tab still exists and is still on an allowed URL. On browser
 * restart, state.batch.vintedTabId is cleared by resumeAfterRestart()
 * (old Chrome tab ids don't survive a restart), so this transparently
 * reselects fresh rather than trying to validate a stale id.
 *
 * If the persisted tab is gone or has navigated away, this NEVER falls
 * back to silently picking a different arbitrary tab — it pauses the
 * batch (with a clear recovery message) and clears the stale id, then
 * returns null so the caller stops (does not proceed to content-script
 * readiness or item dispatch). The next attempt, after the side panel's
 * own explicit Resume, reselects fresh via the normal empty-id path.
 */
async function ensureVintedTab() {
  const state = await getState();
  const persistedTabId = state.batch?.vintedTabId;

  if (persistedTabId != null) {
    if (await isSelectedTabStillValid(persistedTabId)) return persistedTabId;
    await updateState(s => QueueState.applyVintedTabLost(s));
    return null;
  }

  const tabId = await selectVintedTab();
  await updateState(s => QueueState.applySelectedVintedTab(s, tabId));
  return tabId;
}

function requestAccountDetection(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: WORKER_TO_CONTENT.DETECT_ACCOUNT }, response => {
      if (chrome.runtime.lastError) {
        // Never silently swallowed — logged for diagnosis. Not fatal here:
        // by the time this is called, ensureContentScriptReady() has
        // already confirmed a live content script, so this specific
        // failure is unexpected rather than the common case; degrading to
        // "account unknown" rather than aborting the whole item is the
        // existing, deliberate behaviour for this one signal.
        console.warn("Vinted Draft Queue: account detection got no response —", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response?.identity ?? null);
    });
  });
}

/**
 * Follow-up correction (queue-stalling bug) — pings the content script and
 * waits (bounded by PING_TIMEOUT_MS) for its synchronous { ready: true }
 * response. Resolves false — never throws, never hangs — for every
 * failure mode: no receiver at all (chrome.runtime.lastError, the exact
 * case for a Vinted tab that was already open before this extension was
 * installed), a timeout, or an unexpected exception. Every failure path is
 * logged, never silently discarded.
 */
function pingContentScript(tabId) {
  return new Promise(resolve => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn("Vinted Draft Queue: content script ping timed out after", PING_TIMEOUT_MS, "ms");
      resolve(false);
    }, PING_TIMEOUT_MS);

    try {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, response => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          console.warn("Vinted Draft Queue: content script ping got no receiver —", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        resolve(Boolean(response?.ready));
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      console.warn("Vinted Draft Queue: content script ping threw —", error?.message || error);
      resolve(false);
    }
  });
}

/** Explicit fallback injection via the `scripting` permission — needed for a tab that was already open before this extension was installed/reloaded, since Chrome's declarative content_scripts only auto-injects on a fresh navigation after that point. content-script.js's own top-level guard (`window.__vintedDraftQueueContentScriptLoaded`) makes this safe to call even if a declarative injection is also present or races with this one. */
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    return true;
  } catch (error) {
    console.warn("Vinted Draft Queue: content script injection failed —", error?.message || error);
    return false;
  }
}

/**
 * The one gate startItem() must pass through before it may EVER mark an
 * item "preparing": ping first (covers the common case — a tab that
 * already has the content script, whether from declarative injection or a
 * previous ensureContentScriptReady() call); if that fails, inject and
 * ping again. Returns false (never throws) if the content script still
 * can't be confirmed ready after an injection attempt — the caller is
 * responsible for reporting a clear, user-facing error in that case (see
 * startItem()), never for retrying silently or guessing.
 */
async function ensureContentScriptReady(tabId) {
  if (await pingContentScript(tabId)) return true;
  const injected = await injectContentScript(tabId);
  if (!injected) return false;
  return pingContentScript(tabId);
}

// ---- Durable Save Draft confirmation (live Save Draft investigation, follow-up) --------
//
// The live investigation confirmed clicking Vinted's real Save Draft
// button performs a genuine top-level navigation that can destroy the
// content script that clicked it before it ever records success. Every
// actual STATE decision (what counts as expired/confirmed/a safe retry)
// lives in shared/queue-state.js as a pure function, per this file's own
// top comment — everything here is the thin chrome.* orchestration that
// calls those functions at the right moments: before the click
// (beginSaveDraft), on tab navigation (the onUpdated listener below), and
// on every periodic recovery pass (triggerTick, bootResume).

/**
 * The BEGIN_SAVE_DRAFT handler — see shared/messages.js's own comment.
 * Persists the pending-save record BEFORE the content script is ever
 * permitted to click Save Draft; the click only happens once this
 * resolves `{ ok: true }` (see shared/form-steps.js's stepSaveDraft).
 *
 * `tabId` is always the message's own sender.tab.id — NEVER taken from
 * the message payload itself, so a content script can never claim to be
 * a tab it isn't. Refuses (never persists anything) if: there's no
 * active batch, the sender isn't the batch's own selected tab, or a
 * pending save is already in flight for this batch (the single-in-flight-
 * item invariant the rest of this file already relies on — see
 * computeProgressSummary's own currentItem).
 */
async function beginSaveDraft(tabId, { itemId, draftId, expectedTitle, expectedSku }) {
  if (!tabId) return { ok: false, reason: "NO_SENDER_TAB: could not determine which tab this Save Draft click is coming from." };
  const state = await getState();
  if (!state.batch) return { ok: false, reason: "NO_ACTIVE_BATCH: no batch is currently active." };
  if (state.batch.vintedTabId !== tabId) return { ok: false, reason: "TAB_MISMATCH: this is not the batch's own selected Vinted tab." };
  if (state.batch.pendingSave) return { ok: false, reason: "ALREADY_PENDING: a Save Draft confirmation is already pending for this batch." };

  const clickedAt = nowIso();
  const deadline = new Date(Date.now() + SAVE_DRAFT_CONFIRMATION_TIMEOUT_MS).toISOString();
  await updateState(s => QueueState.applyPendingSaveStarted(s, {
    batchId: state.batch.batchId, itemId, draftId: draftId ?? null, vintedTabId: tabId,
    expectedTitle: expectedTitle ?? null, expectedSku: expectedSku ?? null,
    clickedAt, deadline,
  }, clickedAt));
  return { ok: true, deadline };
}

/** Asks whichever content-script instance is CURRENTLY running on `tabId` (fresh-injecting it first if needed) to check its own current page for the confirmed draft link — see shared/form-steps.js's findConfirmedDraftId. Never throws; a content script that can't be reached at all is indistinguishable here from "not confirmed yet" — the caller's own deadline is what eventually turns that into a real failure, never this function guessing. */
async function requestDraftConfirmationCheck(tabId) {
  const ready = await ensureContentScriptReady(tabId);
  if (!ready) return null;
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION }, response => {
      if (chrome.runtime.lastError) {
        console.warn("Vinted Draft Queue: draft confirmation check got no response —", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response?.vintedDraftId ?? null);
    });
  });
}

/** Navigates the given tab back to a fresh Create Listing form and waits for it to finish loading — mirrors createFreshCreateListingTab()'s own wait pattern. Used once a save is confirmed, so the tab is left in a clean, predictable state for the next queued item (whose own stepOpenForm() would eventually get there anyway if this were ever skipped — this is a proactive, immediate version of that same recovery, not a replacement for it). */
async function returnTabToCreateListing(tabId) {
  try {
    await chrome.tabs.update(tabId, { url: "https://www.vinted.co.uk/items/new" });
  } catch (error) {
    console.warn("Vinted Draft Queue: could not navigate the selected tab back to a fresh Create Listing form —", error?.message || error);
    return;
  }
  await new Promise(resolve => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * The core recovery/confirmation attempt — called from THREE places, all
 * converging on the same pure logic: the tab-navigation listener below
 * (the fast path, right after Vinted's own redirect completes), every
 * triggerTick() (the periodic alarm-driven recovery path, covering a
 * missed/delayed navigation event or a service-worker restart mid-
 * confirmation), and checkSavedDraftAgain (the explicit, click-free user
 * recovery action for an already-expired pending save — see that
 * function's own comment). Never clicks Save Draft, Upload, or anything
 * else — only ever reads the current page via CHECK_DRAFT_CONFIRMATION.
 */
async function attemptPendingSaveConfirmation() {
  const state = await getState();
  const pending = state.batch?.pendingSave;
  if (!pending) return;

  let tabId = pending.vintedTabId;
  if (tabId == null) {
    // Follow-up correction (restart-recovery gap) — resumeAfterRestart()
    // clears a pending save's own tab id across a service-worker
    // suspension/restart or a browser restart (it can never be trusted —
    // see that function's own comment), rather than immediately failing
    // it. Reacquire one the SAME way every other flow in this file
    // already does — ensureVintedTab() reuses an already-open, allowed
    // Vinted tab if one exists, or safely opens/selects one, never
    // guessing or falling back to an arbitrary tab. This is
    // confirmation-ONLY: it never sends PROCESS_ITEM and never clicks
    // anything — the reacquired tab is only ever asked to check its own
    // current page via CHECK_DRAFT_CONFIRMATION below. If a tab genuinely
    // can't be reacquired (ensureVintedTab pauses instead), this attempt
    // is simply skipped for now — the pending save is neither confirmed
    // nor failed by that alone; if recovery remains impossible, the SAME
    // deadline this record already carries is what eventually resolves
    // it into a clear SAVE_DRAFT_UNCONFIRMED failure on a later tick,
    // never a special-cased "restart made this impossible" failure.
    tabId = await ensureVintedTab();
    if (!tabId) return;
    await updateState(s => QueueState.applyPendingSaveTabReacquired(s, tabId, nowIso()));
  }

  const vintedDraftId = await requestDraftConfirmationCheck(tabId);
  if (vintedDraftId) {
    await updateState(s => QueueState.applyPendingSaveConfirmed(s, vintedDraftId, nowIso()));
    // Follow-up correction (durable Save Draft confirmation) — this path
    // updates state via QueueState.applyPendingSaveConfirmed directly
    // (never reportItemResult — see postResultToApp's own comment), so
    // it must report to the app itself; without this the "completed
    // Vinted draft IDs are reported back to the app" guarantee silently
    // never fired for a save confirmed via tab navigation.
    await postResultToApp(pending.itemId, "completed", { vintedDraftId });
    await returnTabToCreateListing(tabId);
  } else {
    await updateState(s => QueueState.applyPendingSaveCheckAttempted(s, nowIso()));
  }
}

// Follow-up correction (durable Save Draft confirmation) — registered
// ONCE, at module load, for the lifetime of the service worker (unlike
// createFreshCreateListingTab()'s own dynamic, self-removing listener
// further up this file) — this is how a navigation is noticed even
// though the content script that triggered it may not survive to report
// anything itself. Deliberately narrow: only ever acts when (a) a
// pending save actually exists, (b) the navigating tab is EXACTLY the one
// that pending save is for (never a different tab, even a different
// Vinted tab), and (c) the destination matches one of the two real
// observed post-save shapes (never /items/new itself, which the tab also
// legitimately sits on before and immediately after the click).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = changeInfo.url ?? tab?.url;
  if (!url || !POST_SAVE_CONFIRMATION_TAB_PATTERN.test(url)) return;
  getState().then(async state => {
    if (state.batch?.pendingSave?.vintedTabId !== tabId) return;
    await attemptPendingSaveConfirmation();
    // Follow-up correction (durable Save Draft confirmation) — a
    // confirmation reached via this listener (rather than a periodic
    // triggerTick() recovery pass, which already continues the queue as
    // part of its own normal flow) would otherwise leave the batch
    // sitting idle even after a successful confirmation clears the way
    // for the next queued item — this is what actually starts it.
    await triggerTick();
  }).catch(error => {
    console.warn("Vinted Draft Queue: tab-navigation Save Draft confirmation attempt failed —", error?.message || error);
  });
});

/**
 * PANEL_TO_WORKER.CHECK_SAVED_DRAFT — the ONLY sanctioned recovery for an
 * item that failed with SAVE_DRAFT_UNCONFIRMED (see
 * shared/queue-state.js's applyRetryItem, which structurally refuses to
 * requeue that specific failure). Deliberately separate from, and never
 * routed through, anything that could click Save Draft again: this
 * re-derives everything it needs (the batch's own persisted
 * vintedTabId — the SAME tab used throughout the batch, per
 * ensureVintedTab's own single-selection guarantee) without needing a
 * live pendingSave record at all, since applyPendingSaveExpired already
 * cleared it. A confirmed draft found this way is reported exactly like
 * any other confirmation — completed, exactly once, with the real
 * vintedDraftId — and the batch continues from there.
 */
async function checkSavedDraftAgain(itemId) {
  const state = await getState();
  const item = state.batch?.items?.find(i => i.itemId === itemId);
  if (!item) return { error: "This item is not part of the active batch." };
  const tabId = state.batch.vintedTabId;
  if (!tabId) return { error: "No Vinted tab is selected for this batch — reopen it, then try again." };

  const vintedDraftId = await requestDraftConfirmationCheck(tabId);
  if (!vintedDraftId) return { state: await getState(), found: false };

  await reportItemResult(itemId, "completed", { vintedDraftId });
  await returnTabToCreateListing(tabId);
  await triggerTick();
  return { state: await getState(), found: true, vintedDraftId };
}

// ---- App API calls -----------------------------------------------------------

async function claimBatch(pairingCode) {
  if (!isValidPairingCodeShape(pairingCode)) return { error: "Enter the pairing code shown in the app." };
  const { appBaseUrl } = await getSettings();
  const manifest = chrome.runtime.getManifest();
  let response;
  try {
    response = await fetch(`${appBaseUrl}/api/extension/claim`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode, extensionId: chrome.runtime.id, extensionVersion: manifest.version }),
    });
  } catch {
    return { error: "Could not reach the app. Check the app URL in settings and that it is running." };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { error: body.error || "Could not claim this batch." };

  await updateState(s => QueueState.applyClaim(s, { batchId: body.batchId, batchToken: body.batchToken, expiresAt: body.expiresAt, claimedAt: nowIso() }));
  const payloadResult = await fetchBatchPayload();
  if (payloadResult.error) return payloadResult;

  // Mandatory initial account confirmation gate: detect the Vinted
  // account right after pairing, well before "Start batch" can ever be
  // clicked — applyStart() refuses to start until the side panel's
  // explicit "Confirm this account" click promotes this detection into a
  // confirmed account (see queue-state.js's own account-awareness comment).
  await detectAndRecordAccount();
  return { state: await getState() };
}

async function fetchBatchPayload() {
  const state = await getState();
  if (!state.pairing) return { error: "No claimed batch." };
  const { appBaseUrl } = await getSettings();
  let response;
  try {
    response = await fetch(`${appBaseUrl}/api/extension/batch`, { headers: { Authorization: `Bearer ${state.pairing.batchToken}` } });
  } catch {
    return { error: "Could not reach the app to load the batch." };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { error: body.error || "Could not load batch payload." };

  const validation = validateBatchPayload(body);
  if (!validation.valid) return { error: `Malformed batch payload — refusing to process it: ${validation.errors.join("; ")}` };

  const next = await updateState(s => QueueState.applyBatchPayload(s, body, nowIso()));
  return { state: next };
}

/** Opens/reuses the Vinted tab, ensures the content script is ready, and records whatever identity (or lack of one) it detects — used both right after pairing (the initial confirmation gate) and again via RETRY_ACCOUNT_DETECTION if that first attempt couldn't reliably identify anyone (e.g. the tab was still loading). */
async function detectAndRecordAccount() {
  const tabId = await ensureVintedTab();
  if (!tabId) return; // paused — see ensureVintedTab's own comment
  const ready = await ensureContentScriptReady(tabId);
  const identity = ready ? await requestAccountDetection(tabId) : null;
  return updateState(s => QueueState.applyAccountDetected(s, identity, nowIso()));
}

/**
 * Follow-up correction (durable Save Draft confirmation) — extracted out
 * of reportItemResult() so the tab-navigation-driven confirmation path
 * (attemptPendingSaveConfirmation, which updates state via
 * QueueState.applyPendingSaveConfirmed/Expired directly — never through
 * reportItemResult, since those need to clear pendingSave atomically with
 * the item transition, which reportItemResult's own status-name switch
 * doesn't know how to do) can report the SAME "completed Vinted draft IDs
 * are reported back to the app" guarantee every other terminal status
 * already had. Best-effort, exactly as before: local state is already
 * the source of truth for the side panel's own UI regardless of whether
 * this network call succeeds.
 */
async function postResultToApp(itemId, status, extra = {}) {
  const state = await getState();
  if (!state.pairing?.batchToken) return;
  const { appBaseUrl } = await getSettings();
  fetch(`${appBaseUrl}/api/extension/batch/items/${itemId}/result`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.pairing.batchToken}` },
    body: JSON.stringify({ status, errorCode: extra.errorCode ?? null, errorMessage: extra.errorMessage ?? null, vintedDraftId: extra.vintedDraftId ?? null }),
  }).catch(() => {});
}

async function reportItemResult(itemId, status, extra = {}) {
  let next;
  if (status === "preparing") next = await updateState(s => QueueState.applyItemAttemptStarting(s, itemId, nowIso()));
  else if (status === "completed") next = await updateState(s => QueueState.applyItemCompleted(s, itemId, extra.vintedDraftId ?? null, nowIso()));
  else if (status === "failed") next = await updateState(s => QueueState.applyItemFailed(s, itemId, extra.errorCode ?? null, extra.errorMessage ?? null, nowIso(), extra.lastCompletedStep));
  // "filling"/"saving" step-progress reports — these still reset the
  // watchdog's clock (lastProgressAt) even though they aren't one of the
  // named terminal/attempt-start transitions above, since they ARE
  // genuine, fresh proof the content script is actively working the item.
  // Follow-up correction (live-investigation diagnostics gap) — also
  // carries through currentStep/lastCompletedStep when the report included
  // them (every field-loop progress report does — see runItem's own
  // comment), so the side panel can show exactly how far a still-running
  // item has gotten, not just its coarse "filling" status.
  else next = await updateState(s => QueueState.applyItemStatus(s, itemId, {
    status,
    ...(extra.currentStep !== undefined ? { currentStep: extra.currentStep } : {}),
    ...(extra.lastCompletedStep !== undefined ? { lastCompletedStep: extra.lastCompletedStep } : {}),
  }, nowIso()));

  await postResultToApp(itemId, status, extra);
  if (status === "completed" || status === "failed") await triggerTick();
  return next;
}

// ---- Queue driving -------------------------------------------------------------

/**
 * Follow-up correction (queue-stalling bug) — every tick now also checks
 * for a stalled in-flight item BEFORE (and independent of) the normal
 * "start the next queued item" logic, so a stuck item is recovered into a
 * retryable failed state even if the batch is currently paused, and the
 * very next tick after that can immediately pick up whatever's next.
 */
async function triggerTick() {
  const now = nowIso();
  let state = await getState();
  if (!state.batch) return;

  // Follow-up correction (durable Save Draft confirmation) — recovery,
  // every tick: covers a missed/delayed chrome.tabs.onUpdated event (e.g.
  // Vinted's own destination page renders slowly), AND a service-worker
  // restart that happened while a confirmation was still pending (see
  // bootResume/resumeAfterRestart for the browser-restart case
  // specifically — that one is handled once, up front, before this ever
  // runs; this covers every subsequent periodic tick regardless of cause).
  // Runs BEFORE the generic watchdog below so this record's own, more
  // specific deadline and error message always win the race.
  if (state.batch.pendingSave) {
    if (QueueState.isPendingSaveExpired(state, now)) {
      const expiredItemId = state.batch.pendingSave.itemId;
      await updateState(s => QueueState.applyPendingSaveExpired(s, now));
      await postResultToApp(expiredItemId, "failed", { errorCode: QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE, errorMessage: QueueState.SAVE_DRAFT_UNCONFIRMED_MESSAGE });
    } else {
      await attemptPendingSaveConfirmation();
    }
    state = await getState();
  }

  const stalled = QueueState.findStalledItem(state, now, WATCHDOG_TIMEOUT_MS);
  if (stalled) {
    console.warn("Vinted Draft Queue: watchdog timeout — no progress reported for item", stalled.itemId, "in", WATCHDOG_TIMEOUT_MS, "ms");
    await reportItemResult(stalled.itemId, "failed", {
      errorCode: "WATCHDOG_TIMEOUT",
      errorMessage: "No response from the Vinted page for this item — it may be stuck. Marked as failed; you can retry it.",
    });
    state = await getState();
  }

  if (!state.batch || !state.batch.running || state.batch.paused) return;
  const summary = QueueState.computeProgressSummary(state);
  if (summary.currentItem) return; // something already in flight — the content script will report when it's done, or the watchdog above will recover it
  const item = QueueState.nextQueuedItem(state);
  if (!item) return; // nothing left to process
  await startItem(item);
}

/**
 * Follow-up correction (queue-stalling bug) — root cause: this function
 * used to mark the item "preparing" and fire-and-forget a
 * chrome.tabs.sendMessage() PROCESS_ITEM, silently discarding
 * chrome.runtime.lastError. A Vinted tab already open before this
 * extension was installed has no content script listening at all (Chrome
 * only auto-injects declarative content_scripts on a fresh navigation
 * after install), so that message was simply dropped — the item stayed
 * "preparing" forever, and triggerTick() treats any in-flight item as
 * "already being handled", so it never retried on its own.
 *
 * Fixed order: confirm the content script is genuinely ready to receive
 * PROCESS_ITEM FIRST (ping, inject-and-ping-again if needed) — the item is
 * only ever marked "preparing" AFTER that succeeds. If readiness can never
 * be confirmed, this reports a clear, immediately-retryable failure
 * instead of leaving the item queued forever or silently stuck.
 */
async function startItem(item) {
  const tabId = await ensureVintedTab();
  if (!tabId) return; // paused — see ensureVintedTab's own comment; never silently switches to a different tab

  const ready = await ensureContentScriptReady(tabId);
  if (!ready) {
    await reportItemResult(item.itemId, "failed", {
      errorCode: "CONTENT_SCRIPT_UNAVAILABLE",
      errorMessage: "The Vinted page connection could not be established. Refresh the Vinted tab and retry.",
    });
    return;
  }

  const identity = await requestAccountDetection(tabId);
  if (identity) await updateState(s => QueueState.applyAccountDetected(s, identity, nowIso()));

  const stateAfterDetection = await getState();
  if (stateAfterDetection.batch.paused) return; // account change (or a manual pause) — wait for the side panel's own explicit resume

  const state = await reportItemResult(item.itemId, "preparing").then(getState);
  const payloadItem = state.batch.items.find(i => i.itemId === item.itemId);
  const fullItem = { ...item, ...payloadItem };
  // Follow-up correction (photo-download CORS bug): no bearer token is
  // sent here anymore — the content script never downloads a photo
  // itself (see downloadPhotoForContentScript, which reads the token from
  // this worker's OWN persisted state), so the batch's live credential is
  // never exposed to the least-trusted context (a Vinted-page content
  // script) at all, not merely "unused there".
  chrome.tabs.sendMessage(tabId, { type: WORKER_TO_CONTENT.PROCESS_ITEM, item: fullItem }, () => {
    if (chrome.runtime.lastError) {
      // Readiness was JUST confirmed above, so this is unexpected (e.g.
      // the tab navigated away or closed in the interim) rather than the
      // ordinary "no receiver yet" case ensureContentScriptReady() already
      // handles. Logged, never silently discarded — the watchdog in
      // triggerTick() will recover this item into a retryable failed
      // state if no further progress is ever reported for it.
      console.warn("Vinted Draft Queue: PROCESS_ITEM dispatch failed after readiness was confirmed —", chrome.runtime.lastError.message);
    }
  });
}

// ---- Message handling -----------------------------------------------------------

async function handleMessage(message, sender) {
  switch (message?.type) {
    case PANEL_TO_WORKER.GET_STATE: return { state: await getState(), settings: await getSettings() };
    case PANEL_TO_WORKER.CLAIM_BATCH: return claimBatch(message.pairingCode);
    case PANEL_TO_WORKER.START_BATCH: {
      const current = await getState();
      if (!current.batch?.account) return { error: "Confirm the Vinted account before starting the batch." };
      const tabId = await ensureVintedTab();
      if (!tabId) return { state: await getState() }; // ensureVintedTab already paused with a recovery message — never overridden by applyStart below
      const next = await updateState(s => QueueState.applyStart(s));
      await triggerTick();
      return { state: next };
    }
    case PANEL_TO_WORKER.PAUSE_BATCH: return { state: await updateState(s => QueueState.applyPause(s, "user")) };
    case PANEL_TO_WORKER.RESUME_BATCH: {
      const current = await getState();
      const next = current.batch?.pendingAccountChange
        ? await updateState(s => QueueState.applyAccountChangeConfirmed(s, nowIso()))
        : await updateState(s => QueueState.applyResume(s));
      await triggerTick();
      return { state: next };
    }
    case PANEL_TO_WORKER.RETRY_ITEM: {
      const before = await getState();
      const next = await updateState(s => QueueState.applyRetryItem(s, message.itemId));
      // Follow-up correction (durable Save Draft confirmation) — a true
      // no-op reference back means applyRetryItem structurally refused
      // (SAVE_DRAFT_UNCONFIRMED — see its own comment): reported here as
      // a clear error rather than silently doing nothing, so the caller
      // knows to use CHECK_SAVED_DRAFT instead.
      if (next === before) {
        const item = next.batch?.items?.find(i => i.itemId === message.itemId);
        if (item?.errorCode === QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE) {
          return { error: "Save draft may already have succeeded for this item — use \"Check saved draft again\" instead of Retry, to avoid creating a duplicate draft.", state: next };
        }
      }
      await triggerTick();
      return { state: next };
    }
    case PANEL_TO_WORKER.CHECK_SAVED_DRAFT: return checkSavedDraftAgain(message.itemId);
    case PANEL_TO_WORKER.CANCEL_REMAINING: return { state: await updateState(s => QueueState.applyCancelRemaining(s)) };
    case PANEL_TO_WORKER.CLEAR_BATCH: {
      const current = await getState();
      if (current.batch && !QueueState.allItemsTerminal(current.batch.items)) return { error: "Cannot clear a batch that is still in progress." };
      return { state: await setState(QueueState.createInitialState()) };
    }
    case PANEL_TO_WORKER.CONFIRM_ACCOUNT: return { state: await updateState(s => QueueState.applyAccountConfirmed(s, nowIso())) };
    case PANEL_TO_WORKER.RETRY_ACCOUNT_DETECTION: { await detectAndRecordAccount(); return { state: await getState() }; }
    case PANEL_TO_WORKER.CONFIRM_ACCOUNT_CHANGE: {
      const next = await updateState(s => QueueState.applyAccountChangeConfirmed(s, nowIso()));
      await triggerTick();
      return { state: next };
    }
    case CONTENT_TO_WORKER.ACCOUNT_DETECTED: return { state: await updateState(s => QueueState.applyAccountDetected(s, message.identity, nowIso())) };
    case CONTENT_TO_WORKER.BEGIN_SAVE_DRAFT: return beginSaveDraft(sender?.tab?.id, message);
    // Follow-up correction (live-investigation diagnostics gap) — now
    // forwards the full message (mirroring ITEM_RESULT's own handler just
    // below) so extra.currentStep/lastCompletedStep/detail actually reach
    // reportItemResult instead of being silently dropped — see runItem's
    // own comment on why step-level progress needed to be visible at all.
    case CONTENT_TO_WORKER.ITEM_STEP_PROGRESS: return { state: await reportItemResult(message.itemId, message.status, message) };
    case CONTENT_TO_WORKER.ITEM_RESULT: return { state: await reportItemResult(message.itemId, message.status, message) };
    case CONTENT_TO_WORKER.REQUEST_PHOTO: return downloadPhotoForContentScript(message.itemId, message.position);
    case CONTENT_TO_WORKER.REQUEST_PHOTO_CHUNK: return getPhotoChunk(message.transferId, message.chunkIndex);
    default: return { error: "Unknown message type." };
  }
}

/**
 * Follow-up correction (message-lifecycle hang bug) — the message-listener
 * bug found while tracing this: `handleMessage(message).then(sendResponse)
 * .catch(...)` could call sendResponse TWICE for the same message if
 * sendResponse itself threw (e.g. the receiving tab/panel had already
 * disconnected) — the thrown error from inside `.then()` was caught by the
 * chained `.catch()`, which then called sendResponse again. Chrome's real
 * behaviour when sendResponse is called more than once, or after the
 * channel closed, is undefined and never relied upon. The `responded`
 * guard below makes every path call the real sendResponse at most once,
 * matching the required pattern of checking the message type and always
 * returning `true` synchronously (done below) so the async response above
 * is never dropped.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let responded = false;
  const respond = payload => {
    if (responded) return;
    responded = true;
    try { sendResponse(payload); }
    catch (error) {
      console.warn("Vinted Draft Queue: sendResponse failed —", error?.message || error);
    }
  };
  handleMessage(message, sender).then(respond).catch(error => respond({ error: String(error?.message || error) }));
  return true; // keep the message channel open for the async response above
});

// ---- Lifecycle: resume after suspension/restart, and periodic self-healing ----

async function bootResume() {
  // Follow-up correction (restart-recovery gap) — resumeAfterRestart() no
  // longer treats restart-while-pending as an automatic hard failure: a
  // pending save still within its OWN deadline is PRESERVED (its tab id
  // cleared, to be reacquired by attemptPendingSaveConfirmation on the
  // triggerTick() below), not failed — only one already past its deadline
  // is expired. This only reports to the app when resumeAfterRestart
  // ACTUALLY expired it (compare before/after: still pending before, no
  // longer pending after) — never for the common case where it survives
  // the restart and recovery simply continues normally. See
  // shared/queue-state.js's own comment on resumeAfterRestart for the
  // full reasoning.
  const before = await getState();
  const pendingItemId = before.batch?.pendingSave?.itemId ?? null;
  const next = await updateState(s => QueueState.resumeAfterRestart(s, nowIso()));
  if (pendingItemId && !next.batch?.pendingSave) {
    const item = next.batch?.items?.find(i => i.itemId === pendingItemId);
    if (item?.errorCode === QueueState.SAVE_DRAFT_UNCONFIRMED_ERROR_CODE) {
      await postResultToApp(pendingItemId, "failed", { errorCode: item.errorCode, errorMessage: item.errorMessage });
    }
  }
  await triggerTick();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  bootResume();
});
chrome.runtime.onStartup.addListener(() => { bootResume(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM_NAME) triggerTick(); });
