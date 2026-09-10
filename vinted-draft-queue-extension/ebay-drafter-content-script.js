// eBay Seller Hub extension drafter — content script. Runs on
// www.ebay.co.uk, scoped by manifest.json to only /lstng* and
// /sl/prelist/* (never the whole domain — the pre-existing
// ebay-content-script.js, a completely separate read-only LISTING IMPORTER
// feature, already owns the rest of that domain and is untouched by this
// file). Classic (non-module) script per Chrome's content_scripts loading
// model — shared modules are loaded via dynamic import() (chrome.runtime.
// getURL + web_accessible_resources, see manifest.json), mirroring
// content-script.js's own established pattern exactly, never a static
// top-level `import` (which a declaratively-injected content script can't
// use).
//
// This file is deliberately a THIN WRAPPER: every real step lives in
// shared/ebay-form-steps.js (dependency-injected, directly unit-tested
// with jsdom — see tests/ebay-extension-form-steps.test.ts). This file only
// supplies the real browser globals as that module's dependencies, and
// wires chrome.runtime messaging.
//
// STOP-BEFORE-SAVE. This milestone never sends a save/publish command of
// any kind — see shared/ebay-form-steps.js's own top comment and
// shared/ebay-fields.js's publishing-safety guard, enforced on every click.

if (!window.__ebayDrafterContentScriptLoaded) {
  window.__ebayDrafterContentScriptLoaded = true;

  const base = chrome.runtime.getURL("shared/");
  const modulesPromise = Promise.all([
    import(base + "ebay-messages.js"),
    import(base + "ebay-form-steps.js"),
  ]);
  modulesPromise.catch(() => {});

  function requestPhotoFromServiceWorker(EBAY_CONTENT_TO_WORKER, makeEbayMessage, itemId, position) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(makeEbayMessage(EBAY_CONTENT_TO_WORKER.EBAY_REQUEST_PHOTO, { itemId, position }), response => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(response);
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ready: true });
      return false;
    }

    modulesPromise.then(([{ EBAY_WORKER_TO_CONTENT, EBAY_CONTENT_TO_WORKER, makeEbayMessage }, formSteps]) => {
      if (message?.type === EBAY_WORKER_TO_CONTENT.EBAY_FILL_LISTING) {
        const { item } = message;
        const deps = {
          doc: document, win: window, location: window.location,
          requestPhoto: (itemId, position) => requestPhotoFromServiceWorker(EBAY_CONTENT_TO_WORKER, makeEbayMessage, itemId, position),
          DataTransferImpl: window.DataTransfer, FileImpl: window.File,
        };
        function report(status, extra = {}) {
          chrome.runtime.sendMessage(makeEbayMessage(EBAY_CONTENT_TO_WORKER.EBAY_ITEM_STEP_PROGRESS, { itemId: item.itemId, status, ...extra }));
        }
        formSteps.runEbayItem(item, report, deps)
          .then(result => {
            chrome.runtime.sendMessage(makeEbayMessage(EBAY_CONTENT_TO_WORKER.EBAY_ITEM_RESULT, { itemId: item.itemId, ...result }));
            sendResponse({ ok: true });
          })
          .catch(error => {
            chrome.runtime.sendMessage(makeEbayMessage(EBAY_CONTENT_TO_WORKER.EBAY_ITEM_RESULT, {
              itemId: item.itemId, ok: false, errorCode: "UNEXPECTED", errorMessage: String(error?.message || error),
            }));
            sendResponse({ ok: false });
          });
        return;
      }
      if (message?.type === EBAY_WORKER_TO_CONTENT.EBAY_INSPECT_PAGE_STATE) {
        sendResponse({ state: formSteps.inspectEbayPageState(document, window.location) });
        return;
      }
    }).catch(error => sendResponse({ error: `eBay drafter modules failed to load: ${String(error?.message || error)}` }));

    return true; // keep the message channel open for the async response above
  });
}
