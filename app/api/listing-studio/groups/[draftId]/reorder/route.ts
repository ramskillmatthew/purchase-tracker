import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { reorderImagesRequestSchema, uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { classifyListingStudioRpcError } from "@/lib/listing-studio/rpc-errors";

export const runtime = "nodejs";

/**
 * Sets photo order via the transactional rpc/listing_studio_reorder_images
 * (see supabase-listing-studio.sql) — one call per drag-and-drop "drop"
 * (Milestone 2 spec §9: "Avoid one API call per tiny drag movement"), never
 * per-pixel-movement, and atomic so a partial reorder can never happen.
 */
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  try {
    const user = await requireOwner();
    const { draftId } = await params;
    if (!uuidSchema.safeParse(draftId).success) return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    const body = reorderImagesRequestSchema.parse({ ...(await request.json()), draftId });

    await supabaseRequest("rpc/listing_studio_reorder_images", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: user.id, p_draft_id: body.draftId, p_ordered_image_ids: body.orderedImageIds }),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const known = classifyListingStudioRpcError(error);
    if (known) return NextResponse.json({ error: known }, { status: 409 });
    return safeApiError(error, "Could not save the new photo order.");
  }
}
