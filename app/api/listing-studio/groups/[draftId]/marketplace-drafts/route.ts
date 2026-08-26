import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { listMarketplaceDraftsForProduct } from "@/lib/listing-studio/marketplace-drafts";

export const runtime = "nodejs";

/**
 * Stage 2/3 — every non-Vinted marketplace draft that exists for one
 * product group (a Vinted draft is still read from the listing_drafts row
 * itself — see supabase-listing-studio-marketplace.sql's own header
 * comment). Read-only; drafts are created via the generate route and
 * edited via this same path's [marketplace] sibling route.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const drafts = await listMarketplaceDraftsForProduct(user.id, draftId);
    return NextResponse.json({ drafts });
  } catch (error) { return safeApiError(error, "Could not load this product's marketplace drafts."); }
}
