const STORAGE_KEY = "sourcingMonitorStateV1";
const ROLES = new Set(["monitor1", "monitor2", "inbox"]);
let detectionQueue = Promise.resolve();

function emptyState() {
  return { mode: "test", enabled: false, clickTargets: [], inboxTestEnabled: false, assignments: {}, detections: [], inboxOutcomes: [], reservationImports: [] };
}

function compareSizes(monitorSize, vintedSize) {
  const monitorNumbers = String(monitorSize || "").match(/\d+(?:[.,]\d+)?/g)?.map(Number) || [];
  const vintedNumber = Number(String(vintedSize || "").match(/\d+(?:[.,]\d+)?/)?.[0]);
  if (!monitorNumbers.length || !Number.isFinite(vintedNumber)) return { status: "unavailable", monitorSystem: "unknown", vintedSystem: "UK" };
  const hasEuropean = monitorNumbers.some(value => value >= 30);
  const hasUk = monitorNumbers.some(value => value < 20);
  if (hasEuropean && hasUk) return { status: "not-comparable", monitorSystem: "mixed", vintedSystem: "UK" };
  if (hasEuropean) return { status: "different-systems", monitorSystem: "EU", vintedSystem: "UK" };
  const monitorNumber = monitorNumbers[0];
  return { status: monitorNumber === vintedNumber ? "match" : "different", monitorSystem: "UK", vintedSystem: "UK" };
}

async function readState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = { ...emptyState(), ...(stored[STORAGE_KEY] ?? {}) };
  state.reservationImports = state.reservationImports.map(item => {
    if (!item.listingData?.size) return item;
    const sizeComparison = compareSizes(item.size, item.listingData.size);
    return { ...item, sizeComparison, sizeMismatch: sizeComparison.status === "different" };
  });
  return state;
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function roleForTab(state, tabId) {
  return Object.entries(state.assignments).find(([, value]) => value.tabId === tabId)?.[0] ?? "unassigned";
}

async function notifyAssignments(state) {
  for (const [role, assignment] of Object.entries(state.assignments)) {
    try { await chrome.tabs.sendMessage(assignment.tabId, { type: "SOURCING_ASSIGNMENT_CHANGED", role, enabled: state.enabled, clickTargets: state.clickTargets, inboxTestEnabled: state.inboxTestEnabled }); }
    catch { /* A reloading or closed tab will reconnect and request its assignment. */ }
  }
}

function isVintedListingUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "vinted.co.uk" || url.hostname.endsWith(".vinted.co.uk")) && /\/items\/\d+/.test(url.pathname); }
  catch { return false; }
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Vinted listing timed out.")); }, timeoutMs);
    const listener = (updatedId, changeInfo) => {
      if (updatedId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve();
    };
    chrome.tabs.get(tabId).then(tab => { if (tab.status === "complete") { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve(); } }).catch(() => {});
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function extractFromVinted(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try { const result = await chrome.tabs.sendMessage(tab.id, { type: "SOURCING_EXTRACT_VINTED_LISTING" }); if (result?.ok && result.ready) return result.listing; }
      catch { /* The content script may still be starting. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("The Vinted listing loaded, but its title or structured size was not readable after 6 seconds.");
  } finally { try { await chrome.tabs.remove(tab.id); } catch { /* Tab may already be closed. */ } }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readState();
  state.enabled = false;
  state.clickTargets = [];
  state.inboxTestEnabled = false;
  await writeState(state);
  await notifyAssignments(state);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await readState();
  let changed = false;
  for (const [role, assignment] of Object.entries(state.assignments)) {
    if (assignment.tabId === tabId) { delete state.assignments[role]; changed = true; }
  }
  if (changed) await writeState(state);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const state = await readState();
    if (message?.type === "SOURCING_GET_STATE") return sendResponse({ ok: true, state });
    if (message?.type === "SOURCING_GET_TAB_ASSIGNMENT") {
      const role = sender.tab?.id ? roleForTab(state, sender.tab.id) : "unassigned";
      return sendResponse({ ok: true, role, enabled: state.enabled, clickTargets: state.clickTargets, inboxTestEnabled: state.inboxTestEnabled });
    }
    if (message?.type === "SOURCING_ASSIGN_ROLE") {
      if (!ROLES.has(message.role) || !Number.isInteger(message.tabId)) return sendResponse({ ok: false, error: "Invalid role or tab." });
      for (const [role, assignment] of Object.entries(state.assignments)) {
        if (assignment.tabId === message.tabId || role === message.role) delete state.assignments[role];
      }
      state.assignments[message.role] = { tabId: message.tabId, title: message.title ?? "Discord", url: message.url ?? "" };
      await writeState(state); await notifyAssignments(state);
      return sendResponse({ ok: true, state });
    }
    if (message?.type === "SOURCING_SET_ENABLED") {
      state.enabled = message.enabled === true;
      await writeState(state); await notifyAssignments(state);
      return sendResponse({ ok: true, state });
    }
    if (message?.type === "SOURCING_SET_CLICK_TARGETS") {
      state.clickTargets = [...new Set((message.roles ?? []).filter(role => ["monitor1", "monitor2"].includes(role)))];
      state.enabled = state.clickTargets.length > 0;
      await writeState(state); await notifyAssignments(state);
      return sendResponse({ ok: true, state });
    }
    if (message?.type === "SOURCING_SET_INBOX_TEST") {
      state.inboxTestEnabled = message.enabled === true;
      await writeState(state); await notifyAssignments(state);
      return sendResponse({ ok: true, state });
    }
    if (message?.type === "SOURCING_CLEAR_DETECTIONS") {
      state.detections = []; state.inboxOutcomes = []; await writeState(state); return sendResponse({ ok: true, state });
    }
    if (message?.type === "SOURCING_TEST_VISIBLE_BUTTONS") {
      const results = {};
      for (const role of ["monitor1", "monitor2"]) {
        const assignment = state.assignments[role];
        if (!assignment) { results[role] = { ok: false, error: "Not assigned" }; continue; }
        try { results[role] = await chrome.tabs.sendMessage(assignment.tabId, { type: "SOURCING_TEST_VISIBLE_BUTTONS" }); }
        catch { results[role] = { ok: false, error: "Detector not connected - reload Discord tab" }; }
      }
      return sendResponse({ ok: true, results });
    }
    if (message?.type === "SOURCING_IMPORT_VISIBLE_RESERVATIONS") {
      const inbox = state.assignments.inbox;
      if (!inbox) return sendResponse({ ok: false, error: "Assign the inbox tab first." });
      state.enabled = false; state.clickTargets = []; state.inboxTestEnabled = false;
      await writeState(state); await notifyAssignments(state);
      let scanned;
      try { scanned = await chrome.tabs.sendMessage(inbox.tabId, { type: "SOURCING_IMPORT_VISIBLE_RESERVATIONS" }); }
      catch { return sendResponse({ ok: false, error: "Inbox detector is not connected. Reload the inbox tab." }); }
      if (!scanned?.ok) return sendResponse(scanned || { ok: false, error: "Inbox scan failed." });
      const fresh = await readState(); let imported = 0, skipped = 0;
      for (const item of scanned.items || []) {
        const uniqueKey = item.itemUrl || item.messageKey;
        if (fresh.reservationImports.some(existing => (existing.itemUrl || existing.messageKey) === uniqueKey)) { skipped += 1; continue; }
        fresh.reservationImports.unshift({ id: crypto.randomUUID(), ...item }); imported += 1;
      }
      fresh.reservationImports = fresh.reservationImports.slice(0, 500); await writeState(fresh);
      return sendResponse({ ok: true, state: fresh, imported, skipped, scanned: scanned.items?.length || 0 });
    }
    if (message?.type === "SOURCING_CLEAR_IMPORTS") {
      state.reservationImports = []; await writeState(state); return sendResponse({ ok: true, state });
    }
    if (message?.type === "SOURCING_ENRICH_NEXT_RESERVATION") {
      state.enabled = false; state.clickTargets = []; state.inboxTestEnabled = false;
      await writeState(state); await notifyAssignments(state);
      const target = state.reservationImports.find(item => (!item.listingData || !item.listingData.size) && item.itemUrl && item.enrichmentStatus !== "processing");
      if (!target) return sendResponse({ ok: false, error: "No queued reservation with an unread View Item URL." });
      if (!isVintedListingUrl(target.itemUrl)) return sendResponse({ ok: false, error: "The next View Item URL is not a supported Vinted UK listing." });
      target.enrichmentStatus = "processing"; await writeState(state);
      try {
        const listingData = await extractFromVinted(target.itemUrl);
        const fresh = await readState(), item = fresh.reservationImports.find(entry => entry.id === target.id);
        if (!item) return sendResponse({ ok: false, error: "Reservation was removed during inspection." });
        item.listingData = listingData; item.enrichmentStatus = "complete"; item.enrichmentError = null;
        item.sizeComparison = compareSizes(item.size, listingData.size); item.sizeMismatch = item.sizeComparison.status === "different";
        await writeState(fresh); return sendResponse({ ok: true, state: fresh, item });
      } catch (error) {
        const fresh = await readState(), item = fresh.reservationImports.find(entry => entry.id === target.id);
        if (item) { item.enrichmentStatus = "failed"; item.enrichmentError = error instanceof Error ? error.message : "Listing inspection failed."; await writeState(fresh); }
        return sendResponse({ ok: false, state: fresh, error: item?.enrichmentError || "Listing inspection failed." });
      }
    }
    if (message?.type === "SOURCING_BUY_NOW_DETECTED") {
      const task = async () => {
        const fresh = await readState();
        if (!sender.tab?.id || roleForTab(fresh, sender.tab.id) !== message.role) return false;
        fresh.detections.unshift({ id: crypto.randomUUID(), tabId: sender.tab.id, role: message.role, messageKey: message.messageKey, detectedAt: message.detectedAt, clickedAt: message.clickedAt, clickCompletedAt: message.clickCompletedAt, clickLatencyMs: message.clickLatencyMs, clickDurationMs: message.clickDurationMs, clickError: message.clickError, reportedAt: message.reportedAt, reactionMs: message.reactionMs, recordedAt: Date.now() });
        fresh.detections = fresh.detections.slice(0, 100); await writeState(fresh); return true;
      };
      detectionQueue = detectionQueue.then(task, task);
      if (!(await detectionQueue)) return sendResponse({ ok: false });
      return sendResponse({ ok: true });
    }
    if (message?.type === "SOURCING_INBOX_OUTCOME") {
      const task = async () => {
        const fresh = await readState();
        if (!sender.tab?.id || roleForTab(fresh, sender.tab.id) !== "inbox" || !fresh.inboxTestEnabled) return false;
        const fingerprint = `${message.outcome}:${String(message.text || "").replace(/\s+/g, " ").trim()}:${(message.links || []).join("|")}`;
        if (fresh.inboxOutcomes.some(item => item.messageKey === message.messageKey || (item.fingerprint === fingerprint && Date.now() - item.recordedAt < 5000))) return true;
        fresh.inboxOutcomes.unshift({ id: crypto.randomUUID(), messageKey: message.messageKey, fingerprint, outcome: message.outcome, text: message.text, links: message.links, detectedAt: message.detectedAt, recordedAt: Date.now() });
        fresh.inboxOutcomes = fresh.inboxOutcomes.slice(0, 100); await writeState(fresh); return true;
      };
      detectionQueue = detectionQueue.then(task, task);
      if (!(await detectionQueue)) return sendResponse({ ok: false });
      return sendResponse({ ok: true });
    }
    sendResponse({ ok: false, error: "Unknown message." });
  })().catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unexpected error." }));
  return true;
});
