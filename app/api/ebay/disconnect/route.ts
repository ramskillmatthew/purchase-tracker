import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { getEbayConnection, disconnectEbayConnection } from "@/lib/ebay-account/client";

export const runtime = "nodejs";

/**
 * Disconnects the current eBay account: destroys the locally stored
 * tokens and marks the connection disconnected. Never touches
 * ebay_policies (policy history/snapshots survive so any existing
 * draft's saved policy label remains resolvable), never deletes anything
 * from Listing Studio, never calls an eBay listing/policy-delete
 * endpoint. Confirmation is a UI-level responsibility (see the Settings
 * page's own window.confirm, matching disconnectGmail's existing
 * pattern) — this route performs the action once called.
 */
export async function POST() {
  try {
    const user = await requireOwner();
    const connection = await getEbayConnection(user.id);
    if (!connection) return NextResponse.json({ error: "No eBay account is connected." }, { status: 409 });
    await disconnectEbayConnection(user.id, connection.id);
    return NextResponse.json({ disconnected: true });
  } catch (error) { return safeApiError(error, "The eBay account could not be disconnected."); }
}
