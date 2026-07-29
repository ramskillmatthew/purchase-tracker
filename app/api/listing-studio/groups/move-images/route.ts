import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { moveImagesRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { classifyListingStudioRpcError } from "@/lib/listing-studio/rpc-errors";

export const runtime = "nodejs";

/** Moves one or more photos into another group via the transactional rpc/listing_studio_move_images. */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { imageIds, targetDraftId } = moveImagesRequestSchema.parse(await request.json());

    await supabaseRequest("rpc/listing_studio_move_images", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: user.id, p_image_ids: imageIds, p_target_draft_id: targetDraftId }),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const known = classifyListingStudioRpcError(error);
    if (known) return NextResponse.json({ error: known }, { status: 409 });
    return safeApiError(error, "Could not move the selected photo(s).");
  }
}
