import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { getEbayConnection, getValidEbayAccessToken, listEbayInventoryLocations, syncEbayIdentityAndPolicies } from "@/lib/ebay-account/client";
import { createEbayInventoryLocation, updateEbayInventoryLocation } from "@/lib/ebay-account/inventory-client";

export const runtime = "nodejs";
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const locationFields = { name: z.string().trim().min(1).max(100), postalCode: z.string().trim().toUpperCase().regex(UK_POSTCODE, "Enter a full UK postcode, for example HG5 8XX.") };
const createSchema = z.object(locationFields).strict();
const updateSchema = z.object({ ...locationFields, merchantLocationKey: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/) }).strict();

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const input = createSchema.parse(await request.json());
    const { accessToken } = await getValidEbayAccessToken(user.id);
    const key = `purchase-tracker-${Date.now().toString(36)}`.slice(0, 36);
    await createEbayInventoryLocation(accessToken, key, input);
    await syncEbayIdentityAndPolicies(user.id);
    return NextResponse.json({ merchantLocationKey: key });
  } catch (error) { return safeApiError(error, "Could not create the eBay inventory location."); }
}


export async function PATCH(request: Request) {
  try {
    const user = await requireOwner();
    const input = updateSchema.parse(await request.json());
    const connection = await getEbayConnection(user.id);
    if (!connection || connection.connectionStatus !== "connected") return NextResponse.json({ error: "No eBay account is connected." }, { status: 409 });
    const locations = await listEbayInventoryLocations(connection.id);
    const existing = locations.find(location => location.merchantLocationKey === input.merchantLocationKey && location.available);
    if (!existing) return NextResponse.json({ error: "That inventory location is not available on this eBay account." }, { status: 422 });
    const { accessToken } = await getValidEbayAccessToken(user.id);
    await updateEbayInventoryLocation(accessToken, input.merchantLocationKey, { name: input.name, postalCode: input.postalCode });
    await syncEbayIdentityAndPolicies(user.id);
    return NextResponse.json({ merchantLocationKey: input.merchantLocationKey });
  } catch (error) { return safeApiError(error, "Could not update the eBay inventory location."); }
}
