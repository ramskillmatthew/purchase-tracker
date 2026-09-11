import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";

export const runtime = "nodejs";

/**
 * eBay Seller Hub extension drafter — the owner-authenticated user Cancel
 * action (review requirement 7). Atomically cancels the parent batch AND
 * every still-live child — INCLUDING a 'waiting_for_review' one, since
 * this is a deliberate human action, not a passive timeout (review
 * requirement 6: a populated form stays duplicate-protected until the user
 * explicitly cancels it) — releasing
 * ebay_extension_batch_items_live_draft_idx immediately so a fresh send
 * can be created.
 *
 * The whole operation is ONE service-role-only transactional RPC
 * (listing_studio_cancel_ebay_extension_batch), never independent PATCHes.
 * Owner is derived from the authenticated session and passed to the RPC,
 * which re-checks it — a batch belonging to a different owner is a hard
 * no-op. Touches ONLY the two extension tables' own status columns —
 * never listing_drafts, listing_marketplace_drafts, the legacy Inventory
 * API offer, or ebay_feed_batches (review requirement 8).
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const user = await requireOwner();
    const { batchId } = await params;
    if (!uuidSchema.safeParse(batchId).success) return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });

    await supabaseRequest("rpc/listing_studio_cancel_ebay_extension_batch", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ p_owner_id: user.id, p_batch_id: batchId }),
    });

    return NextResponse.json({ ok: true });
  } catch (error) { return safeApiError(error, "Could not cancel this eBay extension batch."); }
}
