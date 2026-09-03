import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { parseSellingPricePounds } from "@/lib/listing-studio/selling-price";
import { getMarketplaceDraft, patchMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { getEbayConnection, listEbayPolicies } from "@/lib/ebay-account/client";

export const runtime = "nodejs";

/**
 * Stage 6 (eBay draft batches) — Listings Review's own eBay tab save
 * action: selling price, and/or the three eBay business-policy selections,
 * and/or the inventory location override, for ONE listing's eBay
 * preparation. Deliberately separate from the Vinted selling-price route
 * (app/api/listing-studio/groups/[draftId]/selling-price/route.ts), which
 * only ever touches listing_drafts.confirmed_price_pence — this route only
 * ever touches the EBAY_UK row in listing_marketplace_drafts, never
 * listing_drafts itself, so saving one marketplace's price/policies can
 * never overwrite the other's.
 *
 * Every field is optional (a partial patch) — the client sends only what
 * changed. A policy id, when provided, is validated against this owner's
 * OWN connection's currently-available policies of the matching type
 * before being saved (mirrors lib/ebay-account/client.ts's own
 * saveEbayDefaults validation) — never trusted from the client alone, and
 * a stale/foreign id is rejected with a clear error rather than silently
 * saved.
 */
const patchSchema = z.object({
  sellingPrice: z.string().optional(),
  fulfillmentPolicyId: z.string().max(200).nullable().optional(),
  returnPolicyId: z.string().max(200).nullable().optional(),
  paymentPolicyId: z.string().max(200).nullable().optional(),
  merchantLocationKey: z.string().max(200).nullable().optional(),
}).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const body = patchSchema.parse(await request.json());

    const existing = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!existing) return NextResponse.json({ error: "No eBay preparation exists for this listing yet — generate one in Listing Studio first." }, { status: 404 });

    const patch: Record<string, unknown> = {};

    if (body.sellingPrice !== undefined) {
      const parsed = parseSellingPricePounds(body.sellingPrice);
      if (!parsed.valid) return NextResponse.json({ error: parsed.error }, { status: 400 });
      patch.price_pence = parsed.pence;
    }

    const policyFields: Array<["FULFILLMENT" | "RETURN" | "PAYMENT", "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId", string]> = [
      ["FULFILLMENT", "fulfillmentPolicyId", "ebay_fulfillment_policy_id"],
      ["RETURN", "returnPolicyId", "ebay_return_policy_id"],
      ["PAYMENT", "paymentPolicyId", "ebay_payment_policy_id"],
    ];
    const anyPolicyProvided = policyFields.some(([, key]) => body[key] !== undefined);
    if (anyPolicyProvided) {
      const connection = await getEbayConnection(user.id);
      if (!connection || connection.connectionStatus !== "connected") return NextResponse.json({ error: "Connect an eBay account in Settings before choosing policies." }, { status: 409 });
      const policies = await listEbayPolicies(connection.id);
      for (const [type, key, column] of policyFields) {
        const value = body[key];
        if (value === undefined) continue;
        if (value === null) { patch[column] = null; continue; }
        const isAvailable = policies.some(p => p.policyType === type && p.ebayPolicyId === value && p.available);
        if (!isAvailable) return NextResponse.json({ error: `The selected ${type.toLowerCase()} policy is not available on this connection.` }, { status: 400 });
        patch[column] = value;
      }
    }

    if (body.merchantLocationKey !== undefined) patch.ebay_merchant_location_key = body.merchantLocationKey;

    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to save." }, { status: 400 });

    await patchMarketplaceDraft(user.id, existing.id, patch);
    const updated = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    return NextResponse.json({
      draftId,
      sellingPricePence: updated?.pricePence ?? null,
      fulfillmentPolicyId: updated?.ebayFulfillmentPolicyId ?? null,
      returnPolicyId: updated?.ebayReturnPolicyId ?? null,
      paymentPolicyId: updated?.ebayPaymentPolicyId ?? null,
      merchantLocationKey: updated?.ebayMerchantLocationKey ?? null,
    });
  } catch (error) { return safeApiError(error, "Could not save this listing's eBay settings."); }
}
