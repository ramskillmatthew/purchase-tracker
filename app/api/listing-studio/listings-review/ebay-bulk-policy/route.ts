import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getEbayConnection, listEbayPolicies } from "@/lib/ebay-account/client";
import { listMarketplaceDraftsForProducts, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";

export const runtime = "nodejs";

const POLICY_COLUMN: Record<"FULFILLMENT" | "RETURN" | "PAYMENT", string> = {
  FULFILLMENT: "ebay_fulfillment_policy_id", RETURN: "ebay_return_policy_id", PAYMENT: "ebay_payment_policy_id",
};

const requestSchema = z.object({
  draftIds: z.array(uuidSchema).min(1).max(200),
  policyType: z.enum(["FULFILLMENT", "RETURN", "PAYMENT"]),
  ebayPolicyId: z.string().min(1).max(200),
}).strict();

/**
 * Stage 6 (eBay draft batches) — the "Set eBay shipping policy" bulk
 * action (also reused, via `policyType`, for a future bulk return/payment
 * control without a second route). Applies ONE eBay policy id to every
 * selected listing that genuinely HAS an eBay preparation and doesn't
 * already have a completed eBay draft — a Vinted-only selection, or an
 * already-drafted listing, is silently SKIPPED (never altered, never
 * errored on individually) and reported back by exact count/reason so the
 * caller can show "Applied to N eligible listings — M skipped: …". Never
 * touches listing_drafts (Vinted data) at all, and never creates a draft
 * itself — this only ever sets the stored policy id for later use.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { draftIds, policyType, ebayPolicyId } = requestSchema.parse(await request.json());
    const uniqueDraftIds = [...new Set(draftIds)];

    const connection = await getEbayConnection(user.id);
    if (!connection || connection.connectionStatus !== "connected") {
      return NextResponse.json({ error: "Connect an eBay account in Settings before assigning policies." }, { status: 409 });
    }
    const policies = await listEbayPolicies(connection.id);
    const policyIsAvailable = policies.some(p => p.policyType === policyType && p.ebayPolicyId === ebayPolicyId && p.available);
    if (!policyIsAvailable) return NextResponse.json({ error: `The selected ${policyType.toLowerCase()} policy is not available on this connection.` }, { status: 400 });

    const draftsByProduct = await listMarketplaceDraftsForProducts(user.id, uniqueDraftIds);
    const column = POLICY_COLUMN[policyType];

    let appliedCount = 0;
    const skipped: Array<{ draftId: string; reason: string }> = [];
    for (const draftId of uniqueDraftIds) {
      const ebayDraft = (draftsByProduct.get(draftId) ?? []).find(d => d.marketplace === "EBAY_UK");
      if (!ebayDraft) { skipped.push({ draftId, reason: "No eBay preparation for this listing" }); continue; }
      // CORRECTIVE PASS (legacy-offer/blocker audit) — this MUST check the
      // genuine, confirmed Seller Hub Feed draft flag, never the retired
      // Inventory API pipeline's own ebayOfferId. A legacy, unpublished
      // Inventory API offer (ebayOfferId set, ebayFeedDraftCreatedAt still
      // null) is historical information only — eBay's own docs say it
      // can't be edited through Seller Hub, and it must never block a
      // harmless metadata write like a shipping policy assignment.
      if (ebayDraft.ebayFeedDraftCreatedAt !== null) { skipped.push({ draftId, reason: "A Seller Hub draft already exists for this listing" }); continue; }
      await patchMarketplaceDraft(user.id, ebayDraft.id, { [column]: ebayPolicyId });
      appliedCount += 1;
    }

    return NextResponse.json({ appliedCount, skippedCount: skipped.length, skipped });
  } catch (error) { return safeApiError(error, "Could not apply this policy to the selected listings."); }
}
