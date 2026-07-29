import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { mergeGroupsRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { classifyListingStudioRpcError } from "@/lib/listing-studio/rpc-errors";

export const runtime = "nodejs";

/** Merges the source group's photos into the target group and deletes the now-empty source group, via the transactional rpc/listing_studio_merge_groups. */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { sourceDraftId, targetDraftId } = mergeGroupsRequestSchema.parse(await request.json());

    await supabaseRequest("rpc/listing_studio_merge_groups", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: user.id, p_source_draft_id: sourceDraftId, p_target_draft_id: targetDraftId }),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const known = classifyListingStudioRpcError(error);
    if (known) return NextResponse.json({ error: known }, { status: 409 });
    return safeApiError(error, "Could not merge the groups.");
  }
}
