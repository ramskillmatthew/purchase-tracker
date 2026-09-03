import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { getEbayConnection, saveEbayDefaults } from "@/lib/ebay-account/client";

export const runtime = "nodejs";

const bodySchema = z.object({
  fulfillmentPolicyId: z.string().min(1).nullable().optional(),
  returnPolicyId: z.string().min(1).nullable().optional(),
  paymentPolicyId: z.string().min(1).nullable().optional(),
  inventoryLocationKey: z.string().min(1).nullable().optional(),
});

/**
 * "Save defaults" — validates every provided policy id genuinely belongs
 * to this owner's active connection, the right type, EBAY_GB, and remains
 * available (see saveEbayDefaults) BEFORE writing anything, so a failed
 * validation leaves the previous defaults completely untouched. Never
 * calls any eBay policy-write endpoint — this only ever updates
 * ebay_connections' own default_*_policy_id columns.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = bodySchema.parse(await request.json());
    const connection = await getEbayConnection(user.id);
    if (!connection || connection.connectionStatus !== "connected") return NextResponse.json({ error: "No eBay account is connected." }, { status: 409 });
    const result = await saveEbayDefaults(user.id, connection.id, input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
    return NextResponse.json({ connection: result.connection });
  } catch (error) { return safeApiError(error, "eBay listing defaults could not be saved."); }
}
