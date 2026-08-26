import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { confirmUploadRequestSchema, uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { getStorageObjectMetadata, StorageBucketMissingError } from "@/lib/listing-studio/storage-rest";
import { buildStatusHistoryEntry, isValidStatusTransition } from "@/lib/listing-studio/status";

export const runtime = "nodejs";
export const maxDuration = 20;

type ImageRow = { id: string; draft_id: string; storage_path: string };

/**
 * Never marks an upload complete just because the browser's PUT returned
 * 200 (Milestone 2 spec §6/§16) — independently re-checks Storage for the
 * real object and its real size/mime type before flipping upload_state to
 * "uploaded". A missing object marks the image "failed" (recoverable via
 * retry), never silently "uploaded".
 */
export async function POST(request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const user = await requireOwner();
    const { imageId } = await params;
    if (!uuidSchema.safeParse(imageId).success) return NextResponse.json({ error: "Invalid image id." }, { status: 400 });

    const rawBody = await request.json().catch(() => ({}));
    const body = confirmUploadRequestSchema.parse({ ...rawBody, imageId });

    const rows = await supabaseRequestAll<ImageRow>(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}&select=id,draft_id,storage_path`);
    const image = rows[0];
    if (!image) return NextResponse.json({ error: "Image not found." }, { status: 404 });

    const metadata = await getStorageObjectMetadata(LISTING_STUDIO_BUCKET, image.storage_path);
    if (!metadata) {
      await supabaseRequest(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ upload_state: "failed" }),
      });
      return NextResponse.json({ error: "The upload did not complete — the file was not found in storage. Please retry." }, { status: 409 });
    }

    await supabaseRequest(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        upload_state: "uploaded",
        // Server-verified values win — never the client's original claim.
        file_size: metadata.size,
        mime_type: metadata.mimeType,
        // Browser-derived only; not security/trust relevant, so no
        // independent re-verification (see lib/listing-studio
        // /client-image-processing.ts).
        width: body.width ?? null,
        height: body.height ?? null,
        preview_available: body.previewAvailable ?? true,
      }),
    });

    await maybeAdvanceDraftToGrouping(image.draft_id, user.id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof StorageBucketMissingError) return NextResponse.json({ error: error.message }, { status: 503 });
    return safeApiError(error, "Could not confirm the upload.");
  }
}

// Once every image in a batch has resolved (uploaded or failed — none
// still pending/uploading), the group leaves "uploading" for "grouping" so
// the user can start organising. A still-failed image never blocks this —
// it stays visible in the group for retry/removal (Milestone 2 spec §10).
async function maybeAdvanceDraftToGrouping(draftId: string, ownerId: string): Promise<void> {
  const draftRows = await supabaseRequestAll<{ id: string; status: string }>(`listing_drafts?id=eq.${draftId}&owner_id=eq.${ownerId}&select=id,status`);
  const draft = draftRows[0];
  if (!draft || draft.status !== "uploading" || !isValidStatusTransition("uploading", "grouping")) return;

  const stillResolving = await supabaseRequestAll<{ id: string }>(`listing_draft_images?draft_id=eq.${draftId}&owner_id=eq.${ownerId}&upload_state=in.(pending,uploading)&select=id`);
  if (stillResolving.length > 0) return;

  await supabaseRequest(`listing_drafts?id=eq.${draftId}&owner_id=eq.${ownerId}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "grouping", updated_at: new Date().toISOString() }),
  });
  const entry = buildStatusHistoryEntry("uploading", "grouping", "all photos in this batch finished uploading");
  await supabaseRequest("listing_status_history", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ draft_id: draftId, owner_id: ownerId, previous_status: entry.previousStatus, new_status: entry.newStatus, reason: entry.reason }),
  }).catch(() => {});
}
