import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { createSignedUploadUrl, StorageBucketMissingError } from "@/lib/listing-studio/storage-rest";

export const runtime = "nodejs";
export const maxDuration = 20;

type ImageRow = { id: string; storage_path: string };

/**
 * Mints a fresh signed upload URL for the SAME image/path (never a new
 * image record — the retry is the same logical photo) so the browser can
 * re-attempt the PUT after a network failure or an expired signed URL.
 * Passes upsert:true since a legitimate retry may re-write the same path a
 * previous attempt partially or fully wrote to.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const user = await requireOwner();
    const { imageId } = await params;
    if (!uuidSchema.safeParse(imageId).success) return NextResponse.json({ error: "Invalid image id." }, { status: 400 });

    const rows = await supabaseRequestAll<ImageRow>(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}&select=id,storage_path`);
    const image = rows[0];
    if (!image) return NextResponse.json({ error: "Image not found." }, { status: 404 });

    const { uploadUrl } = await createSignedUploadUrl(LISTING_STUDIO_BUCKET, image.storage_path, { upsert: true });
    await supabaseRequest(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ upload_state: "pending" }),
    });

    return NextResponse.json({ imageId, uploadUrl, storagePath: image.storage_path });
  } catch (error) {
    if (error instanceof StorageBucketMissingError) return NextResponse.json({ error: error.message }, { status: 503 });
    return safeApiError(error, "Could not retry the upload.");
  }
}
