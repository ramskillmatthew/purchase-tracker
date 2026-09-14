// CORRECTIVE PASS (environment provenance audit) — the ONE place the
// default App URL is defined. Previously private to service-worker.js
// (DEFAULT_APP_BASE_URL), which meant sidepanel.js's own settings display
// ("Not set") could silently disagree with what the service worker would
// actually default to for a real request — exactly the class of quiet
// mismatch this review exists to eliminate. Both files now import this
// SAME constant, so the diagnostics panel's own resolved App URL can never
// drift from what real requests actually use.
export const DEFAULT_APP_BASE_URL = "http://localhost:3000";

/**
 * Resolves the effective App URL EXACTLY the way service-worker.js's own
 * getSettings() does — `{ appBaseUrl: DEFAULT_APP_BASE_URL, ...settings }`
 * — which only falls back to the default when the key is genuinely
 * ABSENT, never when it's been explicitly saved as an empty string.
 * Deliberately `??`, not `||`: `"" || DEFAULT` would silently override an
 * explicitly-cleared App URL with the default, which is NOT what the real
 * request path does — this diagnostics resolution must never disagree
 * with it, or the panel could show "reachable" against a DIFFERENT URL
 * than what a real request would actually hit.
 */
export function resolveAppBaseUrl(settings) {
  return settings?.appBaseUrl ?? DEFAULT_APP_BASE_URL;
}
