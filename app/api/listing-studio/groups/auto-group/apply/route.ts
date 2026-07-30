import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { applyAutoGroupProposalRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { applyAutoGroupProposal } from "@/lib/listing-studio/auto-group-apply";
import { getNextAutomaticGroupName } from "@/lib/listing-studio/group-naming";

export const runtime = "nodejs";

const UNSORTED_TITLE = "Unsorted";

/**
 * Applies one medium-confidence auto-grouping proposal the user has chosen
 * to confirm after reviewing it (see components/listing-studio/GroupingWorkspace.tsx —
 * the analyze call at .../auto-group never applies these itself). Only the
 * photo ids are taken from the client; the Unsorted group is looked up
 * fresh here rather than trusted from an earlier response, and the
 * transactional RPC underneath (via applyAutoGroupProposal) independently
 * re-verifies every photo still belongs to it at the moment this runs — so
 * a proposal reviewed a while ago, where the underlying photos have since
 * moved, fails safely with a clear message rather than silently moving the
 * wrong thing.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { imageIds } = applyAutoGroupProposalRequestSchema.parse(await request.json());

    const unsorted = await (await supabaseRequest(
      `listing_drafts?owner_id=eq.${user.id}&title=eq.${encodeURIComponent(UNSORTED_TITLE)}&status=in.(uploading,grouping)&select=id&order=created_at.desc&limit=1`,
    )).json() as { id: string }[];
    if (!unsorted.length) return NextResponse.json({ error: "These photos are no longer in Unsorted." }, { status: 409 });

    const existingDrafts = await supabaseRequestAll<{ id: string; title: string | null }>(
      `listing_drafts?owner_id=eq.${user.id}&status=neq.archived&select=id,title`,
    );
    const title = getNextAutomaticGroupName(existingDrafts);

    const result = await applyAutoGroupProposal(user, unsorted[0].id, imageIds, title);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

    return NextResponse.json({ draftId: result.draftId, title, photoCount: imageIds.length }, { status: 201 });
  } catch (error) { return safeApiError(error, "Could not create this group."); }
}
