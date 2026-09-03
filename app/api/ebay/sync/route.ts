import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { syncEbayIdentityAndPolicies } from "@/lib/ebay-account/client";

export const runtime = "nodejs";

/**
 * "Sync account" — re-fetches identity and all three EBAY_GB policy
 * types. Never disconnects the account on a sync failure (a temporary
 * eBay outage leaves the last-known-good policy snapshot in place, with
 * a safe warning) — see lib/ebay-account/client.ts's own
 * syncEbayIdentityAndPolicies for the partial-failure handling this
 * route simply reports.
 */
export async function POST() {
  try {
    const user = await requireOwner();
    const result = await syncEbayIdentityAndPolicies(user.id);
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as Error & { code?: string }).code : undefined;
    if (code === "not_connected") return NextResponse.json({ error: "No eBay account is connected." }, { status: 409 });
    if (code === "needs_reconnect") return NextResponse.json({ error: (error as Error).message, code }, { status: 409 });
    return safeApiError(error, "eBay could not be synced right now. Your account remains connected.");
  }
}
