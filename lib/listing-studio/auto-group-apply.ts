import "server-only";
import { supabaseRequest } from "@/lib/supabase";
import { classifyListingStudioRpcError } from "./rpc-errors";

/**
 * Creates one automatically-named group and moves the given photos into it
 * from the Unsorted group — the exact same transactional operation as a
 * manual "Split into new group" (rpc/listing_studio_split_group, see
 * supabase-listing-studio.sql), reused as-is rather than a new RPC: an
 * auto-grouping proposal IS a split of Unsorted into a new group, so no new
 * transactional logic is needed. The RPC itself re-validates ownership and
 * that every image still belongs to `unsortedDraftId` at the moment it
 * runs — so this is safe to call even a while after analysis, if the
 * caller is applying a medium-confidence proposal the user only confirmed
 * after reviewing it. One call is one atomic transaction: either the group
 * and every one of its photos move together, or nothing happens at all.
 *
 * Used by app/api/listing-studio/groups/auto-group/apply/route.ts to apply
 * one user-confirmed medium-confidence proposal after review. High-confidence
 * groups are applied differently (in bulk, transactionally, via
 * rpc/listing_studio_apply_boundary_session — see
 * app/api/listing-studio/groups/auto-group/apply-session/route.ts) since a
 * whole session's worth of chunks must be reconciled together first; this
 * function's single-group RPC call is only for the one-at-a-time review path.
 */
export async function applyAutoGroupProposal(
  owner: { id: string },
  unsortedDraftId: string,
  imageIds: string[],
  title: string,
): Promise<{ ok: true; draftId: string } | { ok: false; error: string }> {
  try {
    const response = await supabaseRequest("rpc/listing_studio_split_group", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: owner.id, p_source_draft_id: unsortedDraftId, p_image_ids: imageIds, p_new_title: title }),
    });
    const draftId = (await response.json()) as string;
    return { ok: true, draftId };
  } catch (error) {
    const known = classifyListingStudioRpcError(error);
    return { ok: false, error: known ?? "Could not create this group." };
  }
}
