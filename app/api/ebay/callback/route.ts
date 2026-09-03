import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { consumeEbayOAuthState, exchangeEbayCode, fetchEbayIdentity, trustedAppOrigin } from "@/lib/ebay-account/oauth";
import { saveEbayConnectionAfterOAuth, syncEbayIdentityAndPolicies } from "@/lib/ebay-account/client";

export const runtime = "nodejs";

/**
 * eBay OAuth callback — mirrors app/api/gmail/callback's exact shape and
 * safety properties (state verified server-side, code exchanged server-
 * side, redirect never carries a token). Every failure mode redirects to
 * a distinct, safe `?ebay=error&reason=...` code (never the raw eBay
 * error body) rather than a single generic failure, per the product
 * spec's own "distinguish these" requirement — the Settings page reads
 * `reason` to show one of its known safe messages.
 *
 * Refreshing this URL (a browser reload after landing here) re-submits
 * the SAME `code`/`state` query — consumeEbayOAuthState's atomic
 * conditional UPDATE means the second attempt always fails with
 * `state_invalid` (already consumed) rather than creating a duplicate
 * connection or re-importing policies twice.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // PROVEN ROOT CAUSE FIX — the redirect origin comes ONLY from the
  // trusted, server-configured NEXT_PUBLIC_APP_URL (see
  // lib/ebay-account/oauth.ts's own trustedAppOrigin comment), never from
  // `url.origin`/`request.url` itself, which through a reverse proxy or
  // tunnel does not reflect the address a real browser can reach and —
  // more importantly — is exactly the kind of request-derived value that
  // must never drive a redirect target, or this would be an open
  // redirect. A misconfigured/insecure NEXT_PUBLIC_APP_URL outside
  // development fails the whole request rather than silently redirecting
  // somewhere unintended.
  let redirectOrigin: string;
  try { redirectOrigin = trustedAppOrigin(); } catch { return NextResponse.json({ error: "The application's base URL is not configured correctly." }, { status: 500 }); }
  const redirectTo = (reason?: string, ok = false) => NextResponse.redirect(new URL(`/settings?ebay=${ok ? "connected" : "error"}${reason ? `&reason=${reason}` : ""}`, redirectOrigin));

  let user: Awaited<ReturnType<typeof requireOwner>>;
  try { user = await requireOwner(); } catch { return redirectTo("auth_required"); }

  if (url.searchParams.get("error")) return redirectTo("access_denied");

  const state = url.searchParams.get("state");
  if (!state) return redirectTo("state_invalid");
  let intent: "connect" | "change_account";
  try {
    ({ intent } = await consumeEbayOAuthState(state, user.id));
  } catch {
    return redirectTo("state_invalid");
  }

  const code = url.searchParams.get("code");
  if (!code) return redirectTo("missing_code");

  try {
    const tokens = await exchangeEbayCode(code);
    const identity = await fetchEbayIdentity(tokens.access_token);
    await saveEbayConnectionAfterOAuth(user.id, tokens, identity, intent);
    // Best-effort immediate policy import — a failure here does not undo
    // the connection itself (it's already saved and usable); "Sync
    // account" remains available to retry from Settings.
    try { await syncEbayIdentityAndPolicies(user.id); } catch { /* surfaced via last_sync_error_* on next load, not fatal here */ }
    return redirectTo(undefined, true);
  } catch (error) {
    const status = error instanceof Error && "status" in error ? (error as Error & { status?: number }).status : undefined;
    if (status === 400 || status === 401) return redirectTo("token_exchange_failed");
    return redirectTo("connection_failed");
  }
}
