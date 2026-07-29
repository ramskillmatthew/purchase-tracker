import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { splitGroupRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { classifyListingStudioRpcError } from "@/lib/listing-studio/rpc-errors";
import { getNextAutomaticGroupName } from "@/lib/listing-studio/group-naming";

export const runtime = "nodejs";

/**
 * Splits selected photos out of a group into a brand-new group via the
 * transactional rpc/listing_studio_split_group, which returns the new
 * group's id. An explicit `newTitle` is honoured as-is; omitting it
 * auto-names the new group via getNextAutomaticGroupName rather than
 * relying on the SQL function's own generic "Untitled group" fallback, so
 * a split always lands in the same Product-N sequence as any other
 * automatic group creation.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { sourceDraftId, imageIds, newTitle } = splitGroupRequestSchema.parse(await request.json());

    const resolvedTitle = newTitle ?? getNextAutomaticGroupName(
      await supabaseRequestAll<{ id: string; title: string | null }>(`listing_drafts?owner_id=eq.${user.id}&status=neq.archived&select=id,title`),
    );

    const response = await supabaseRequest("rpc/listing_studio_split_group", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: user.id, p_source_draft_id: sourceDraftId, p_image_ids: imageIds, p_new_title: resolvedTitle }),
    });
    const newDraftId = (await response.json()) as string;

    return NextResponse.json({ draftId: newDraftId, title: resolvedTitle }, { status: 201 });
  } catch (error) {
    const known = classifyListingStudioRpcError(error);
    if (known) return NextResponse.json({ error: known }, { status: 409 });
    return safeApiError(error, "Could not split the group.");
  }
}
