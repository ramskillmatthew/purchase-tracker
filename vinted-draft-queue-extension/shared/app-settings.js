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
 * CORRECTIVE PASS (controlled pairing test review) — the exact root cause
 * of a real, reproduced 404: the claim request never reached the app
 * server AT ALL (confirmed by the server's own request log showing zero
 * matches for "claim" across the whole session) while the app's own
 * pairing-code panel and the extension's pairing-code entry agreed
 * perfectly — meaning the mismatch was never the code, only the
 * destination URL a real request was built against. The OLD save handler
 * (sidepanel.js) stripped at most one trailing slash and never validated
 * anything else, so a pasted page URL (e.g. ".../listings-review") or a
 * double slash saved silently and broke every subsequent request without
 * ever explaining why.
 *
 * This is now the ONE function every fetch in this extension MUST derive
 * its origin from — health check, claim, batch fetch, heartbeat, photo
 * download, item results, imports. Never call `new URL(rawUrl)` or
 * string-concatenate settings.appBaseUrl anywhere else.
 *
 * Lenient by design: always returns SOME usable origin (falling back to
 * DEFAULT_APP_BASE_URL) so a previously-saved bad value can never
 * permanently break every request going forward — see
 * validateAppBaseUrlInput below for the STRICT counterpart used at
 * settings-save time, which rejects a bad value instead of silently
 * fixing it, so the user learns about the mistake instead of it quietly
 * recurring.
 */
export function canonicalizeAppBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return DEFAULT_APP_BASE_URL;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return DEFAULT_APP_BASE_URL;
    // parsed.origin is already scheme://host[:port] with no trailing
    // slash, no path, no query, no hash — exactly what every fetch site
    // template-interpolates a path onto.
    return parsed.origin;
  } catch {
    return DEFAULT_APP_BASE_URL;
  }
}

/**
 * STRICT settings-form validator (sidepanel.js's own App URL Save
 * handler) — unlike canonicalizeAppBaseUrl above, this REJECTS anything
 * that isn't a bare origin rather than silently stripping it, and
 * explains exactly what to remove. Returns { ok: true, url } (the
 * canonical origin, ready to store) or { ok: false, error } (a clear,
 * specific message — never saved).
 */
export function validateAppBaseUrlInput(rawUrl) {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) return { ok: true, url: "" }; // explicitly clearing the App URL is allowed — resolveAppBaseUrl falls back to the default
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid URL. Use just the origin, e.g. http://localhost:3000` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "App URL must start with http:// or https://." };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return {
      ok: false,
      error: `App URL must be just the origin, not a page — remove "${parsed.pathname}" from the end. Use ${parsed.origin} instead.`,
    };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "App URL must not include a query string or #fragment — use just the origin." };
  }
  return { ok: true, url: parsed.origin };
}

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
 *
 * Always passes the result through canonicalizeAppBaseUrl — a value saved
 * before this pass's stricter validator existed (or written directly to
 * chrome.storage.local some other way) is normalized here too, so a
 * legacy bad value can never keep silently 404ing every request.
 */
export function resolveAppBaseUrl(settings) {
  const raw = settings?.appBaseUrl;
  // Preserves the exact original `?? DEFAULT_APP_BASE_URL` semantic for
  // the two edge cases (key genuinely absent -> default; explicitly
  // cleared to "" -> stays "", never silently replaced) — canonicalizing
  // only applies to an actual non-empty configured value.
  if (raw === undefined || raw === null) return DEFAULT_APP_BASE_URL;
  if (raw === "") return "";
  return canonicalizeAppBaseUrl(raw);
}
