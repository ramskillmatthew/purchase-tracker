import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { ebayAuthorizationUrl, type EbayOAuthIntent } from "@/lib/ebay-account/oauth";

export const runtime = "nodejs";

/**
 * Starts the eBay OAuth connection flow — mirrors app/api/gmail/connect's
 * exact shape (authenticate, build the authorization URL, redirect).
 * `?intent=change_account` is the ONLY way "Change account" differs from
 * an ordinary first connection: the state row records that intent, and
 * the callback (see ../callback/route.ts) reads it back to know whether
 * to clear the previous account's policy defaults. Never asks the user to
 * paste a token or enter eBay credentials in this app.
 */
export async function GET(request: Request) {
  try {
    const user = await requireOwner();
    const intent: EbayOAuthIntent = new URL(request.url).searchParams.get("intent") === "change_account" ? "change_account" : "connect";
    const url = await ebayAuthorizationUrl(user.id, intent);
    return NextResponse.redirect(url);
  } catch (error) { return safeApiError(error, "The eBay connection could not be started."); }
}
