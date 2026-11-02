import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { getMarketplaceDraft } from "@/lib/listing-studio/marketplace-drafts";
import { getEbayItemConditionPolicies } from "@/lib/listing-studio/ebay-taxonomy-client";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });

    const draft = await getMarketplaceDraft(user.id, draftId, "EBAY_UK");
    if (!draft) return NextResponse.json({ error: "eBay draft not found." }, { status: 404 });
    if (!draft.categoryId) return NextResponse.json({ error: "Choose an eBay category before setting its condition." }, { status: 409 });

    const result = await getEbayItemConditionPolicies(draft.categoryId);
    if (!result.ok) return NextResponse.json({ error: "Could not load eBay's condition choices for this category." }, { status: 502 });
    return NextResponse.json({ categoryId: draft.categoryId, conditions: result.data });
  } catch (error) {
    return safeApiError(error, "Could not load eBay condition choices.");
  }
}
