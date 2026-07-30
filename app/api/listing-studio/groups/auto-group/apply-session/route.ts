import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { applyAutoGroupSessionRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { reconcileAutoGroupSession } from "@/lib/listing-studio/auto-group-schemas";
import { classifyListingStudioRpcError } from "@/lib/listing-studio/rpc-errors";
import { getNextAutomaticGroupName } from "@/lib/listing-studio/group-naming";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";

export const runtime = "nodejs";
export const maxDuration = 30;

const UNSORTED_TITLE = "Unsorted";

/**
 * Reconciles EVERY chunk of one "Auto-group products" run together and, ONLY
 * once that whole-session result is known, applies every accepted
 * (high-confidence) contiguous group in ONE all-or-nothing transactional
 * RPC call (rpc/listing_studio_apply_boundary_session — see
 * supabase-listing-studio.sql). This is deliberately a separate step from
 * analysis (app/api/listing-studio/groups/auto-group/route.ts, called once
 * per chunk): applying each chunk immediately, before the rest of the
 * session is known, would risk creating two groups for one physical
 * product that happens to straddle a chunk boundary — reconcileAutoGroupSession
 * is exactly what stitches such a split back together (continuesFromPreviousChunk)
 * before anything is ever written.
 *
 * Medium-confidence ranges are never auto-applied here — they're returned
 * as proposedGroups for the user to accept/reject individually via
 * .../auto-group/apply/route.ts, exactly as before.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { imageIds, chunkResults } = applyAutoGroupSessionRequestSchema.parse(await request.json());

    const unsorted = await (await supabaseRequest(
      `listing_drafts?owner_id=eq.${user.id}&title=eq.${encodeURIComponent(UNSORTED_TITLE)}&status=in.(uploading,grouping)&select=id&order=created_at.desc&limit=1`,
    )).json() as { id: string }[];
    if (!unsorted.length) {
      return NextResponse.json({ runId: null, groupsCreated: [], proposedGroups: [], photosGroupedCount: 0, photosPendingReviewCount: 0, photosLeftInUnsortedCount: 0 });
    }
    const unsortedDraftId = unsorted[0].id;

    const reconciled = reconcileAutoGroupSession(chunkResults, imageIds.map(id => ({ id })));

    const model = process.env.ANTHROPIC_MODEL ?? null;
    const startedAt = new Date().toISOString();
    let groupsCreated: { draftId: string; title: string; photoCount: number }[] = [];

    if (reconciled.applyAutomatically.length > 0) {
      const existingTitles = (await supabaseRequestAll<{ id: string; title: string | null }>(
        `listing_drafts?owner_id=eq.${user.id}&status=neq.archived&select=id,title`,
      )).map(draft => ({ title: draft.title }));

      const plannedGroups = reconciled.applyAutomatically.map(proposal => {
        const title = getNextAutomaticGroupName(existingTitles);
        existingTitles.push({ title });
        return { title, image_ids: proposal.imageIds, photoCount: proposal.imageIds.length };
      });

      try {
        const response = await supabaseRequest("rpc/listing_studio_apply_boundary_session", {
          method: "POST",
          body: JSON.stringify({
            p_owner_id: user.id, p_source_draft_id: unsortedDraftId,
            p_groups: plannedGroups.map(g => ({ title: g.title, image_ids: g.image_ids })),
          }),
        });
        const created = (await response.json()) as { draft_id: string; title: string }[];
        groupsCreated = created.map((row, index) => ({ draftId: row.draft_id, title: row.title, photoCount: plannedGroups[index]?.photoCount ?? 0 }));
      } catch (error) {
        const known = classifyListingStudioRpcError(error);
        const completedAt = new Date().toISOString();
        await supabaseRequest("listing_analysis_runs", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            draft_id: unsortedDraftId, owner_id: user.id, stage: "product_grouping", status: "failed",
            model, prompt_version: LISTING_PROMPT_VERSIONS.product_grouping, schema_version: LISTING_SCHEMA_VERSIONS.product_grouping,
            error_message: known ?? "Could not apply this session's groups.", started_at: startedAt, completed_at: completedAt,
          }),
        }).catch(() => {});
        return NextResponse.json({ error: known ?? "Could not apply this session's groups." }, { status: 409 });
      }
    }

    const proposedGroups = reconciled.needsReview.map(proposal => ({
      proposedGroupId: proposal.proposedGroupId, imageIds: proposal.imageIds, photoCount: proposal.imageIds.length,
      boundaryReason: proposal.boundaryReason, warnings: proposal.warnings,
    }));
    const photosGroupedCount = groupsCreated.reduce((sum, group) => sum + group.photoCount, 0);
    const photosPendingReviewCount = proposedGroups.reduce((sum, group) => sum + group.photoCount, 0);
    const photosLeftInUnsortedCount = reconciled.leftInUnsortedImageIds.length;
    const completedAt = new Date().toISOString();

    const runResponse = await (await supabaseRequest("listing_analysis_runs", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        draft_id: unsortedDraftId, owner_id: user.id, stage: "product_grouping", status: "success",
        model, prompt_version: LISTING_PROMPT_VERSIONS.product_grouping, schema_version: LISTING_SCHEMA_VERSIONS.product_grouping,
        response_json: { groupsCreated, proposedGroups, leftInUnsortedImageIds: reconciled.leftInUnsortedImageIds, validationWarnings: reconciled.validationWarnings },
        started_at: startedAt, completed_at: completedAt,
      }),
    }).catch(() => null))?.json().catch(() => null) as { id: string }[] | null;

    return NextResponse.json({
      runId: runResponse?.[0]?.id ?? null,
      groupsCreated, proposedGroups,
      photosGroupedCount, photosPendingReviewCount, photosLeftInUnsortedCount,
    });
  } catch (error) { return safeApiError(error, "Could not apply this session's groups."); }
}
