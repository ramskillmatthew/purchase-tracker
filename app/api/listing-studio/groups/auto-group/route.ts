import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { autoGroupAnalyzeRequestSchema } from "@/lib/validation/listing-studio-uploads";
import { prepareAutoGroupImageInputs, type PreparedImageBlock } from "@/lib/listing-studio/auto-group-image-input";
import { runAutoGroupAnalysis } from "@/lib/listing-studio/auto-group-ai";
import { describeAutoGroupFailure } from "@/lib/listing-studio/auto-group-schemas";
import { LISTING_PROMPT_VERSIONS } from "@/lib/listing-studio/prompt-versions";
import { LISTING_SCHEMA_VERSIONS } from "@/lib/listing-studio/schema-versions";

export const runtime = "nodejs";
export const maxDuration = 60;

// Same lookup as app/api/listing-studio/uploads/route.ts's find-or-create —
// this route only ever reads from whichever Unsorted group currently
// exists, never creates one (nothing to analyse if there isn't one yet).
const UNSORTED_TITLE = "Unsorted";

type DraftRow = { id: string; title: string | null };
type ImageRow = { id: string; storage_path: string; mime_type: string };

/**
 * Analyses ONE chunk of Unsorted photos (at most MAX_AUTO_GROUP_BATCH_SIZE)
 * for ORDERED PRODUCT-BOUNDARY DETECTION and returns the raw, schema-valid
 * (but not yet session-reconciled) result — this route never creates or
 * moves anything. A full "Auto-group products" click calls this once per
 * chunk in sequence, accumulates every chunk's result client-side, then
 * calls .../auto-group/apply-session ONCE with everything, so a physical
 * product can never be split across a chunk boundary and left half-applied
 * (see that route's own doc comment). Every id (both this chunk's own
 * photos and any read-only overlap context from the previous chunk) is
 * independently re-verified against this owner's current Unsorted group
 * regardless of what the client sends — never touching a manually created
 * group.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const { imageIds, overlapImageIds, chunkStartSequenceIndex } = autoGroupAnalyzeRequestSchema.parse(await request.json());

    const unsorted = await (await supabaseRequest(
      `listing_drafts?owner_id=eq.${user.id}&title=eq.${encodeURIComponent(UNSORTED_TITLE)}&status=in.(uploading,grouping)&select=id&order=created_at.desc&limit=1`,
    )).json() as DraftRow[];
    if (!unsorted.length) return NextResponse.json({ data: { groups: [], ungroupedImageIds: [] } });
    const unsortedDraftId = unsorted[0].id;

    const allRequestedIds = [...imageIds, ...(overlapImageIds ?? [])];
    const validImages = await (await supabaseRequest(
      `listing_draft_images?id=in.(${allRequestedIds.join(",")})&owner_id=eq.${user.id}&draft_id=eq.${unsortedDraftId}&upload_state=eq.uploaded&select=id,storage_path,mime_type`,
    )).json() as ImageRow[];
    const validById = new Map(validImages.map(image => [image.id, image]));

    // Only ids that are STILL genuinely eligible right now are ever sent
    // for analysis — a stale/moved id is silently excluded here rather
    // than breaking the whole chunk (its photo simply won't appear in any
    // group this chunk proposes, and falls back to "left in Unsorted"
    // during session reconciliation).
    const chunkImages = imageIds.map(id => validById.get(id)).filter((image): image is ImageRow => Boolean(image));
    const overlapImages = (overlapImageIds ?? []).map(id => validById.get(id)).filter((image): image is ImageRow => Boolean(image));
    if (!chunkImages.length) return NextResponse.json({ data: { groups: [], ungroupedImageIds: [] } });

    const { blocks } = await prepareAutoGroupImageInputs(
      [...chunkImages, ...overlapImages].map(image => ({ id: image.id, storagePath: image.storage_path, mimeType: image.mime_type })),
      LISTING_STUDIO_BUCKET,
    );
    // Re-establish exact sequence order — prepareAutoGroupImageInputs does
    // not preserve input order (see its own doc comment).
    const blockById = new Map(blocks.map(block => [block.imageId, block]));
    const orderedChunkBlocks: PreparedImageBlock[] = chunkImages.map(image => blockById.get(image.id)).filter((block): block is PreparedImageBlock => Boolean(block));
    const orderedOverlapBlocks: PreparedImageBlock[] = overlapImages.map(image => blockById.get(image.id)).filter((block): block is PreparedImageBlock => Boolean(block));
    if (!orderedChunkBlocks.length) return NextResponse.json({ data: { groups: [], ungroupedImageIds: [] } });

    const startedAt = new Date().toISOString();
    const outcome = await runAutoGroupAnalysis(orderedChunkBlocks, chunkStartSequenceIndex, orderedOverlapBlocks);
    const completedAt = new Date().toISOString();
    const model = process.env.ANTHROPIC_MODEL ?? null;

    if (outcome.status !== "success") {
      await supabaseRequest("listing_analysis_runs", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          draft_id: unsortedDraftId, owner_id: user.id, stage: "product_grouping", status: "failed",
          model, prompt_version: LISTING_PROMPT_VERSIONS.product_grouping, schema_version: LISTING_SCHEMA_VERSIONS.product_grouping,
          error_message: describeAutoGroupFailure(outcome.status), started_at: startedAt, completed_at: completedAt,
        }),
      }).catch(() => {});
      // 503 (not configured) signals the client's chunk loop to stop
      // entirely — every remaining chunk would fail identically. 502 (any
      // other AI failure) signals "this one chunk failed, but it may be
      // transient" — the client continues with the next chunk rather than
      // aborting the whole run over one bad batch.
      const status = outcome.status === "not_configured" ? 503 : 502;
      return NextResponse.json({ error: describeAutoGroupFailure(outcome.status) }, { status });
    }

    await supabaseRequest("listing_analysis_runs", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        draft_id: unsortedDraftId, owner_id: user.id, stage: "product_grouping", status: "success",
        model, prompt_version: LISTING_PROMPT_VERSIONS.product_grouping, schema_version: LISTING_SCHEMA_VERSIONS.product_grouping,
        response_json: outcome.data, started_at: startedAt, completed_at: completedAt,
      }),
    }).catch(() => {});

    return NextResponse.json({ data: outcome.data });
  } catch (error) { return safeApiError(error, "Could not analyse these photos."); }
}
