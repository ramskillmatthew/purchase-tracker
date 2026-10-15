import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { getValidEbayAccessToken, syncEbayIdentityAndPolicies } from "@/lib/ebay-account/client";
import { createEbayInventoryLocation } from "@/lib/ebay-account/inventory-client";

export const runtime = "nodejs";
const schema = z.object({ name: z.string().trim().min(1).max(100), postalCode: z.string().trim().min(2).max(12) }).strict();

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = schema.parse(await request.json());
    const { accessToken } = await getValidEbayAccessToken(user.id);
    const key = `purchase-tracker-${Date.now().toString(36)}`.slice(0, 36);
    await createEbayInventoryLocation(accessToken, key, input);
    await syncEbayIdentityAndPolicies(user.id);
    return NextResponse.json({ merchantLocationKey: key });
  } catch (error) { return safeApiError(error, "Could not create the eBay inventory location."); }
}
