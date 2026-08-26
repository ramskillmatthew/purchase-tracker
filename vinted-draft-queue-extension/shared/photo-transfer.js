// Vinted Draft Queue extension — bounded, timeout-safe messaging between
// the content script and the service worker for one photo's transfer.
// Pulled out of content-script.js into its own plain ES module (mirroring
// shared/form-steps.js's own reasoning for existing as a separate file) so
// the message lifecycle itself — timeouts, chrome.runtime.lastError,
// malformed responses, chunked reassembly — is directly unit-testable
// against a fake `chrome.runtime`-shaped object, no real browser required.
//
// Follow-up correction (message-lifecycle hang bug): a live batch hung
// indefinitely — with NO download error at all, only the unrelated
// 3-minute item watchdog eventually firing — because NEITHER side of the
// REQUEST_PHOTO exchange ever bounded anything: the service worker's own
// fetch() could stall forever on a dead connection (see
// service-worker.js's FETCH_TIMEOUT_MS), and even set that aside, this
// content-script-side wait for chrome.runtime.sendMessage's callback had
// no timeout of its own at all — a hung service worker, or a response
// Chrome silently failed to deliver, left the returned Promise pending
// forever. Every request made through this module now has its own bounded
// timeout (REQUEST_TIMEOUT_MS, comfortably under the 3-minute watchdog) and
// every outcome — timeout, chrome.runtime.lastError, a malformed response
// shape — rejects with a specific, safe error instead of hanging or
// resolving with something stepUploadPhotos can't trust.
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * SAFE, TEMPORARY diagnostics for the message-lifecycle hang bug — only
 * ever a photo position, a chunk index/count, or a short fixed label is
 * logged; never a URL, a token, or any byte of the actual photo data.
 */
function logStage(stage, position, extra = "") {
  console.log(`Vinted Draft Queue [photo ${position}]: ${stage}`, extra);
}

function sendRuntimeMessage(runtime, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`TIMEOUT: photo ${message.position} — stage: waiting for service-worker response (no reply within ${Math.round(timeoutMs / 1000)}s).`));
    }, timeoutMs);

    try {
      runtime.sendMessage(message, response => {
        if (settled) return; // a timeout already rejected this — a late reply is simply ignored
        settled = true;
        clearTimeout(timeoutId);
        if (runtime.lastError) {
          logStage("stage 8: chrome.runtime.lastError", message.position, runtime.lastError.message);
          reject(new Error(`NETWORK: the extension service worker did not respond (${runtime.lastError.message}).`));
          return;
        }
        if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
          logStage("stage 8/9: malformed response shape", message.position);
          reject(new Error("MALFORMED_RESPONSE: the service worker returned an unexpected response shape."));
          return;
        }
        logStage("stage 9: content script received response", message.position, response.ok ? "ok" : "failed");
        resolve(response);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error(`NETWORK: could not send a message to the extension service worker (${error?.message || error}).`));
    }
  });
}

/**
 * Builds the content script's requestPhoto(itemId, position). Every real
 * network request happens in the service worker (see
 * service-worker.js's downloadPhotoForContentScript) — this only ever
 * sends REQUEST_PHOTO / REQUEST_PHOTO_CHUNK messages and reassembles a
 * chunked transfer if the service worker chose one (see its own comment on
 * when a photo is too large for one reliable sendResponse). One photo —
 * and, within it, one chunk — requested at a time, never concurrently.
 */
export function makeRequestPhoto(runtime, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return async function requestPhoto(itemId, position) {
    logStage("stage 1: content script starting download", position);
    logStage("stage 2: sending REQUEST_PHOTO", position);
    const metadata = await sendRuntimeMessage(runtime, { type: "REQUEST_PHOTO", itemId, position }, timeoutMs);
    if (!metadata.ok || !metadata.chunked) return metadata; // either a failure, or the ordinary single-message success shape

    let base64 = "";
    for (let chunkIndex = 0; chunkIndex < metadata.totalChunks; chunkIndex++) {
      const chunk = await sendRuntimeMessage(runtime, { type: "REQUEST_PHOTO_CHUNK", transferId: metadata.transferId, chunkIndex, position }, timeoutMs);
      if (!chunk.ok || typeof chunk.data !== "string") {
        return { ok: false, reason: (chunk && chunk.reason) || `NETWORK: could not download photo ${position} chunk ${chunkIndex}.` };
      }
      base64 += chunk.data;
    }
    return { ok: true, position: metadata.position, fileName: metadata.fileName, mimeType: metadata.mimeType, base64 };
  };
}
