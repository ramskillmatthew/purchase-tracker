(() => {
  const handled = new Set(), inboxHandled = new Set(), inboxPending = new Map();
  let role = "unassigned", enabled = false, clickTargets = [], inboxTestEnabled = false, observer, scanQueued = false, mutationCount = 0, scanCount = 0, lastMutationAt = 0;
  const now = () => performance.timeOrigin + performance.now();
  const label = el => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-label") || ""} ${el.textContent || ""}`.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  const buttonsInside = root => {
    const all = [];
    if (root.matches?.('button,a,[role="button"]')) all.push(root);
    all.push(...(root.querySelectorAll?.('button,a,[role="button"]') || []));
    return all.filter(el => /(^| )buy now($| )/.test(label(el)));
  };
  const messageFor = button => button.closest('[id^="chat-messages-"],li[class*="messageListItem"],[data-list-item-id*="chat-messages"]') || button.parentElement;
  const keyFor = (message, button) => message?.id || message?.getAttribute?.("data-list-item-id") || `${location.pathname}:${label(button)}:${message?.textContent?.slice(0,160)}`;
  const mark = (button, colour) => { button.style.outline = `3px solid ${colour}`; button.style.outlineOffset = "3px"; };
  const baseline = () => buttonsInside(document.documentElement).forEach(button => handled.add(keyFor(messageFor(button), button)));
  const messageSelector = '[id^="chat-messages-"]';
  const canonicalInboxMessage = element => {
    const matches = [];
    let current = element;
    while (current) { if (current.matches?.(messageSelector)) matches.push(current); current = current.parentElement; }
    return matches.at(-1) || null;
  };
  const inboxMessagesInside = root => {
    const messages = new Set();
    const closest = canonicalInboxMessage(root); if (closest) messages.add(closest);
    root.querySelectorAll?.(messageSelector).forEach(message => messages.add(canonicalInboxMessage(message) || message));
    return [...messages];
  };
  const inboxKey = message => message.id || message.getAttribute("data-list-item-id") || `${location.pathname}:${message.textContent?.slice(0,240)}`;
  const baselineInbox = () => inboxMessagesInside(document.documentElement).forEach(message => inboxHandled.add(inboxKey(message)));
  function scheduleInbox(node) {
    if (role !== "inbox" || !inboxTestEnabled) return;
    const root = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!root) return;
    for (const message of inboxMessagesInside(root)) {
      if (inboxHandled.has(inboxKey(message))) continue;
      clearTimeout(inboxPending.get(message));
      inboxPending.set(message, setTimeout(() => {
        inboxPending.delete(message);
        if (role !== "inbox" || !inboxTestEnabled) return;
        const messageKey = inboxKey(message); if (inboxHandled.has(messageKey)) return;
        inboxHandled.add(messageKey);
        const text = message.textContent || "", outcome = globalThis.SourcingInboxRules.classify(text);
        const links = [...message.querySelectorAll("a[href]")].map(link => link.href);
        message.style.outline = `3px solid ${outcome === "success" ? "#39e6c5" : "#ff5263"}`;
        message.style.outlineOffset = "3px";
        chrome.runtime.sendMessage({ type: "SOURCING_INBOX_OUTCOME", messageKey, outcome, text: text.slice(0, 2000), links, detectedAt: now(), pageUrl: location.href });
      }, 350));
    }
  }
  function inspect(node = document.documentElement) {
    if (!enabled || !["monitor1", "monitor2"].includes(role)) return;
    const root = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!root) return;
    const detectedAt = now(); scanCount += 1;
    for (const button of buttonsInside(root)) {
      const message = messageFor(button), messageKey = keyFor(message, button);
      if (handled.has(messageKey)) continue;
      handled.add(messageKey); mark(button, "#39e6c5");
      let clickedAt = null, clickCompletedAt = null, clickError = null;
      if (clickTargets.includes(role)) {
        clickedAt = now();
        try { button.click(); clickCompletedAt = now(); mark(button, "#ff4fd8"); }
        catch (error) { clickError = error instanceof Error ? error.message : "Click failed"; }
      }
      const reportedAt = now();
      chrome.runtime.sendMessage({ type: "SOURCING_BUY_NOW_DETECTED", role, messageKey, detectedAt, clickedAt, clickCompletedAt, clickLatencyMs: clickedAt === null ? null : clickedAt - detectedAt, clickDurationMs: clickCompletedAt === null ? null : clickCompletedAt - clickedAt, clickError, reportedAt, reactionMs: reportedAt - detectedAt, pageUrl: location.href });
    }
  }
  function queueFullScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => { scanQueued = false; inspect(document.documentElement); });
  }
  function start() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(records => {
      mutationCount += records.length; lastMutationAt = Date.now();
      for (const record of records) {
        if (record.type === "childList") record.addedNodes.forEach(node => { inspect(node); scheduleInbox(node); });
        else { inspect(record.target); scheduleInbox(record.target); }
      }
      queueFullScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "data-label", "role"] });
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "SOURCING_ASSIGNMENT_CHANGED") {
      const nextRole = message.role || "unassigned", nextEnabled = message.enabled === true;
      const nextInboxTest = message.inboxTestEnabled === true;
      if (nextRole !== role || (!enabled && nextEnabled)) baseline();
      if (nextRole !== role || (!inboxTestEnabled && nextInboxTest)) baselineInbox();
      role = nextRole; enabled = nextEnabled; clickTargets = Array.isArray(message.clickTargets) ? message.clickTargets : []; inboxTestEnabled = nextInboxTest;
    }
    if (message?.type === "SOURCING_TEST_VISIBLE_BUTTONS") { const found = buttonsInside(document.documentElement); found.forEach(button => mark(button, "#ffb020")); respond({ ok: true, count: found.length }); }
    if (message?.type === "SOURCING_IMPORT_VISIBLE_RESERVATIONS") {
      if (role !== "inbox") return respond({ ok: false, error: "This tab is not assigned as Inbox." });
      const items = inboxMessagesInside(document.documentElement).flatMap(message => {
        const text = message.innerText || message.textContent || "";
        if (globalThis.SourcingInboxRules.classify(text) !== "success") return [];
        const links = [...message.querySelectorAll("a[href]")].map(link => ({ label: link.innerText || link.textContent || "", url: link.href }));
        const extracted = globalThis.SourcingInboxRules.extract(text, links);
        const images = [...message.querySelectorAll("img[src]")].map(image => image.currentSrc || image.src).filter(Boolean);
        return [{ ...extracted, messageKey: inboxKey(message), rawText: text.slice(0, 4000), images: [...new Set(images)], importedAt: Date.now() }];
      });
      respond({ ok: true, items });
    }
    if (message?.type === "SOURCING_DIAGNOSTIC_PING") respond({ ok: true, role, enabled, clickArmed: clickTargets.includes(role), inboxWatching: role === "inbox" && inboxTestEnabled, visibleButtons: buttonsInside(document.documentElement).length, mutationCount, scanCount, lastMutationAt, pageUrl: location.href });
  });
  start();
  chrome.runtime.sendMessage({ type: "SOURCING_GET_TAB_ASSIGNMENT" }).then(response => { role = response?.role || "unassigned"; enabled = response?.enabled === true; clickTargets = response?.clickTargets || []; inboxTestEnabled = response?.inboxTestEnabled === true; baseline(); baselineInbox(); });
})();
