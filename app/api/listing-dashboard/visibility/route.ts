import { NextResponse } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/auth/api";
import { requireOwner, serverAuthClient } from "@/lib/auth/server";
import { LISTING_DASHBOARD_HIDDEN_IDS_KEY, savedHiddenListingIds } from "@/lib/listing-dashboard/hidden-listings";

export const runtime = "nodejs";

const inputSchema = z.object({
  listingId: z.string().uuid(),
  hidden: z.boolean(),
});

export async function PATCH(request: Request) {
  try {
    const user = await requireOwner();
    const input = inputSchema.parse(await request.json());
    const ids = new Set(savedHiddenListingIds(user.user_metadata));
    if (input.hidden) ids.add(input.listingId);
    else ids.delete(input.listingId);
    const client = await serverAuthClient();
    const { error } = await client.auth.updateUser({
      data: { ...user.user_metadata, [LISTING_DASHBOARD_HIDDEN_IDS_KEY]: [...ids].slice(-2000) },
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, hidden: input.hidden });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "This listing could not be identified." }, { status: 400 });
    return safeApiError(error, "The dashboard visibility could not be changed.");
  }
}

