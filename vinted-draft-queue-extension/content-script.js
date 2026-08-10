// Vinted Draft Queue extension — content script. Runs on vinted.co.uk
// pages. Classic (non-module) script per Chrome's content_scripts loading
// model, so shared modules are loaded via a single dynamic import() at the
// top (chrome.runtime.getURL + web_accessible_resources — see manifest.json)
// rather than a static top-level `import`, which content scripts can't use.
//
// This file is deliberately a THIN WRAPPER: every real state-machine step
// lives in shared/form-steps.js (dependency-injected, directly unit-
// tested with jsdom against a synthetic fixture — see
// tests/vinted-extension-form-steps.test.ts). This file only supplies the
// real browser globals (document, window, fetch, location, DataTransfer,
// File) as that module's dependencies, and wires chrome.runtime messaging.
//
// DRAFTS ONLY — NEVER PUBLISHES. The only click ever allowed against a
// final-save action is resolved by resolveSaveDraftButton() in
// shared/vinted-fields.js, which requires the button's name to match an
// allowlist AND fail the forbidden-action check. See
// tests/vinted-extension-publishing-safety.test.ts for the structural
// tests proving this.
//
// Follow-up correction (queue-stalling bug): a Vinted tab already open
// BEFORE this extension was installed never receives Chrome's declarative
// content_scripts injection — that only fires on a fresh navigation after
// the extension is enabled. service-worker.js's ensureContentScriptReady()
// detects this (a PING gets no response) and explicitly injects this exact
// file via chrome.scripting.executeScript as a fallback. Both the
// declarative injection and that fallback injection run in the SAME
// per-frame "isolated world" Chrome maintains for this extension, so they
// share one `window` — the guard below makes a second execution (whichever
// order the two injections happen to race in) a safe no-op rather than
// registering a duplicate chrome.runtime.onMessage listener, which would
// otherwise double-process every message this content script receives.
if (!window.__vintedDraftQueueContentScriptLoaded) {
  window.__vintedDraftQueueContentScriptLoaded = true;

  const base = chrome.runtime.getURL("shared/");
  // Kicked off immediately but not awaited here — the PING handler below
  // must respond the instant this script is executing, without waiting on
  // this (it's how the service worker distinguishes "no content script at
  // all" from "content script loaded, modules still resolving").
  const modulesPromise = Promise.all([
    import(base + "messages.js"),
    import(base + "form-steps.js"),
    import(base + "photo-transfer.js"),
  ]);
  // A fire-and-forget branch purely so this is never reported as an
  // unhandled promise rejection if these imports fail before any message
  // ever arrives to consume modulesPromise. The REAL handling — surfacing
  // a clear error for whichever message triggered it — is the separate
  // .then().catch() chain inside the onMessage listener below; this branch
  // changes nothing about that.
  modulesPromise.catch(() => {});

  const deps = {
    doc: document, win: window, location: window.location,
    DataTransferImpl: window.DataTransfer, FileImpl: window.File,
    // Follow-up correction (photo-download CORS bug): this content script
    // NEVER fetches a photo's bytes itself — a request made from here
    // carries this PAGE's own origin (https://www.vinted.co.uk), which the
    // app's CORS config never allows (see shared/messages.js's own comment
    // on CONTENT_TO_WORKER.REQUEST_PHOTO). Every photo is requested one at
    // a time from the service worker instead, which downloads it (using
    // the batch's own bearer token — never exposed here) and returns it as
    // base64 for this script to reconstruct into a real File — see
    // shared/form-steps.js's stepUploadPhotos.
    //
    // Follow-up correction (message-lifecycle hang bug): the actual
    // request/timeout/reassembly logic lives in shared/photo-transfer.js
    // (bounded timeouts, chrome.runtime.lastError handling, malformed-
    // response rejection, chunked-transfer reassembly — see its own top
    // comment) so it's directly unit-testable; deps.requestPhoto is filled
    // in below once modulesPromise resolves, since it isn't available yet
    // at this point (mirroring the PING handler's own reasoning above).
    requestPhoto: undefined,
  };

  /**
   * Follow-up correction (durable Save Draft confirmation) — the content-
   * script side of the BEGIN_SAVE_DRAFT round trip: shared/form-steps.js's
   * stepSaveDraft awaits this and refuses to click Save Draft at all
   * unless it resolves `{ ok: true }` — see that function's own comment.
   * Bound fresh per item (never reused across items) so the service
   * worker always learns exactly which item this click is for; the tab id
   * itself is deliberately NEVER sent here at all — the service worker
   * always uses the message's own sender.tab.id instead (see
   * shared/messages.js's own comment on this message type), so a content
   * script can never claim to be a tab it isn't.
   */
  function beginSaveDraft(item, CONTENT_TO_WORKER, makeMessage) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(makeMessage(CONTENT_TO_WORKER.BEGIN_SAVE_DRAFT, {
        itemId: item.itemId, draftId: item.draftId ?? null,
        expectedTitle: item.title ?? null, expectedSku: item.sku ?? null,
      }), response => {
        if (chrome.runtime.lastError) { resolve({ ok: false, reason: chrome.runtime.lastError.message }); return; }
        resolve(response ?? { ok: false, reason: "No response from the service worker." });
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // The literal string, not a shared/messages.js constant — this must
    // work even before modulesPromise resolves (or if it never does), so
    // the service worker's readiness check can't itself depend on the
    // thing it's trying to verify.
    if (message?.type === "PING") {
      sendResponse({ ready: true });
      return false; // answered synchronously — no need to keep the channel open
    }

    modulesPromise.then(([{ WORKER_TO_CONTENT, CONTENT_TO_WORKER, makeMessage }, formSteps, photoTransfer]) => {
      if (!deps.requestPhoto) deps.requestPhoto = photoTransfer.makeRequestPhoto(chrome.runtime);

      if (message?.type === WORKER_TO_CONTENT.DETECT_ACCOUNT) {
        formSteps.detectAccountIdentity(document)
          .then(identity => sendResponse({ identity }))
          .catch(error => sendResponse({ error: `Account detection failed: ${String(error?.message || error)}` }));
        return;
      }
      // Follow-up correction (durable Save Draft confirmation) — asked of
      // WHICHEVER content-script instance is currently running on the
      // selected tab, quite possibly a freshly (re-)injected one on an
      // entirely different page than whatever clicked Save Draft
      // originally — this handler only ever reads the CURRENT page, never
      // anything held over from before, so that's always fine. See
      // shared/form-steps.js's findConfirmedDraftId for the full picture
      // (both real observed destination shapes).
      if (message?.type === WORKER_TO_CONTENT.CHECK_DRAFT_CONFIRMATION) {
        const vintedDraftId = formSteps.findConfirmedDraftId(document, window.location);
        sendResponse({ vintedDraftId });
        return;
      }
      if (message?.type === WORKER_TO_CONTENT.PROCESS_ITEM) {
        const { item } = message;
        // A per-item deps object (a shallow copy — never mutates the
        // shared `deps` above) so beginSaveDraft's closure always refers
        // to exactly the item currently being processed, never a stale
        // one left over from a previous PROCESS_ITEM call.
        const itemDeps = { ...deps, beginSaveDraft: () => beginSaveDraft(item, CONTENT_TO_WORKER, makeMessage) };
        formSteps.runItem(item, (status, extra = {}) => {
          // Follow-up correction (message-lifecycle hang bug; extended by
          // the live-investigation diagnostics follow-up): forwards the
          // WHOLE extra object — e.g. extra.detail ("Downloading photo 1 of
          // 8"), extra.currentStep/lastCompletedStep (the field-step
          // progress tracking — see runItem's own comment) — so the side
          // panel can show live progress; never a substitute for the
          // timeout logic actually detecting a stuck request.
          const progressPayload = { itemId: item.itemId, status, ...extra };
          chrome.runtime.sendMessage(makeMessage(CONTENT_TO_WORKER.ITEM_STEP_PROGRESS, progressPayload));
          if (status === "completed" || status === "failed") {
            chrome.runtime.sendMessage(makeMessage(CONTENT_TO_WORKER.ITEM_RESULT, { itemId: item.itemId, status, ...extra }));
          }
          return { status, ...extra };
        }, itemDeps).catch(error => {
          chrome.runtime.sendMessage(makeMessage(CONTENT_TO_WORKER.ITEM_RESULT, { itemId: item.itemId, status: "failed", errorCode: "UNEXPECTED", errorMessage: String(error?.message || error) }));
        });
        sendResponse({ started: true });
        return;
      }
      sendResponse({ error: "Unknown message type." });
    }).catch(error => {
      sendResponse({ error: `Content script module load failed: ${String(error?.message || error)}` });
    });

    return true; // the branches above respond asynchronously via modulesPromise
  });
}
