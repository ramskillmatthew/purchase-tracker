import "server-only";
import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/auth/api";

/**
 * Milestone 7 (Chrome extension draft queue) — CORS for the small set of
 * routes the extension itself calls cross-origin (chrome-extension://...).
 * Every other route in this app is same-origin (called from the app's own
 * pages) and needs no CORS headers at all — this is deliberately scoped to
 * ONLY the /api/extension/* routes.
 *
 * EXTENSION_ORIGIN must be set to the installed extension's own origin —
 * "chrome-extension://<extension id>". Because vinted-draft-queue-extension/manifest.json
 * pins a fixed "key" (public key), the extension's id is deterministic
 * regardless of which machine loads it unpacked — see that manifest's own
 * comment and this feature's README for the exact id/setup step. No
 * wildcard origin is ever allowed; a request whose Origin header doesn't
 * exactly match EXTENSION_ORIGIN gets no CORS headers at all (the browser
 * itself then blocks the extension from reading the response), never a
 * permissive fallback.
 */
function allowedOrigin(): string | null {
  return process.env.EXTENSION_ORIGIN?.trim() || null;
}

export function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const allowed = allowedOrigin();
  if (!allowed || requestOrigin !== allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** Every extension-facing route's response — success or error — must go through this, so CORS headers are never accidentally missing on a failure path. */
export function extensionCorsJson(request: Request, body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders(request.headers.get("origin")) });
}

/** The one shared OPTIONS preflight handler every extension-facing route exports. */
export function extensionCorsPreflight(request: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

/**
 * safeApiError's own response never carries CORS headers (it doesn't know
 * about this cross-origin caller) — every extension-facing route's catch
 * block must go through THIS instead, or the browser blocks the extension
 * from ever reading the error body, regardless of the actual HTTP status.
 */
export function extensionSafeApiError(request: Request, error: unknown, fallback?: string): NextResponse {
  const response = safeApiError(error, fallback);
  const headers = corsHeaders(request.headers.get("origin"));
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/** A coarse, best-effort caller identifier for rate-limiting an UNAUTHENTICATED route (the pairing-code claim) — never used for anything security-critical beyond throttling, since it's trivially spoofable. Vercel sets x-forwarded-for on every request. */
export function requestIpForRateLimit(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}
