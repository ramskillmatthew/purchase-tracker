import { NextResponse } from "next/server";
import { supabaseRequest, supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { deleteStorageObject } from "@/lib/listing-studio/storage-rest";

export const runtime = "nodejs";

type ImageRow = { id: string; storage_path: string };

/**
 * Removes a photo entirely — never auto-deletes its (possibly now-empty)
 * group; that's a distinct, explicit "Delete an empty group" action
 * (Milestone 2 spec §7). A Storage cleanup failure is logged but never
 * blocks removing the record itself — an orphaned Storage object is a
 * minor cleanup debt, not a reason to leave a photo the user asked to
 * remove still showing in their workspace.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const user = await requireOwner();
    const { imageId } = await params;
    if (!uuidSchema.safeParse(imageId).success) return NextResponse.json({ error: "Invalid image id." }, { status: 400 });

    const rows = await supabaseRequestAll<ImageRow>(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}&select=id,storage_path`);
    const image = rows[0];
    if (!image) return NextResponse.json({ error: "Image not found." }, { status: 404 });

    await deleteStorageObject(LISTING_STUDIO_BUCKET, image.storage_path).catch(error => {
      console.error("Could not delete listing-studio Storage object during image removal", image.storage_path, error instanceof Error ? error.message : error);
    });
    await supabaseRequest(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}`, { method: "DELETE" });

    return NextResponse.json({ ok: true });
  } catch (error) { return safeApiError(error, "Could not remove the photo."); }
}
