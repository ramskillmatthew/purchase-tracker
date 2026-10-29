export const BUY_NOW_LABEL = "buy now";

export function normaliseLabel(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function normaliseActionWords(value) {
  return normaliseLabel(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function accessibleLabel(element) {
  return normaliseLabel(element?.getAttribute?.("aria-label") || element?.textContent || "");
}

export function isExactBuyNowButton(element) {
  if (!element || typeof element.matches !== "function") return false;
  if (!element.matches("button, a[role='button'], [role='button']")) return false;
  return normaliseActionWords(accessibleLabel(element)) === BUY_NOW_LABEL;
}

export function buyNowButtonsInside(root) {
  const matches = [];
  if (isExactBuyNowButton(root)) matches.push(root);
  if (typeof root?.querySelectorAll !== "function") return matches;
  for (const element of root.querySelectorAll("button, a[role='button'], [role='button']")) {
    if (isExactBuyNowButton(element)) matches.push(element);
  }
  return [...new Set(matches)];
}

export function closestDiscordMessage(element) {
  return element?.closest?.("[data-list-item-id^='chat-messages'], li[id^='chat-messages'], [id^='chat-messages']") ?? null;
}

export function discordMessageKey(message, button) {
  const stable = message?.getAttribute?.("data-list-item-id") || message?.id;
  if (stable) return stable;
  const text = normaliseLabel(message?.textContent || button?.parentElement?.textContent || "").slice(0, 300);
  return `fallback:${text}`;
}
