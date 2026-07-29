import { NextResponse } from "next/server";
import { supabaseRequestAll } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { uuidSchema } from "@/lib/validation/listing-studio-uploads";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";
import { createSignedDownloadUrl, StorageBucketMissingError } from "@/lib/listing-studio/storage-rest";
import { SIGNED_VIEW_URL_LIFETIME_SECONDS } from "@/lib/listing-studio/upload-limits";

export const runtime = "nodejs";

type ImageRow = { id: string; storage_path: string };

/**
 * Redirects to a short-lived signed Storage URL rather than proxying the
 * image bytes itself — the actual photo bytes flow straight from Storage
 * to the browser, never through this Vercel function (mirrors the upload
 * side's "never route full-resolution bytes through a Vercel API route").
 * <img src="/api/listing-studio/images/{id}/view"> works directly; no
 * separate JSON round-trip needed on the client.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const user = await requireOwner();
    const { imageId } = await params;
    if (!uuidSchema.safeParse(imageId).success) return NextResponse.json({ error: "Invalid image id." }, { status: 400 });

    const rows = await supabaseRequestAll<ImageRow>(`listing_draft_images?id=eq.${imageId}&owner_id=eq.${user.id}&select=id,storage_path`);
    const image = rows[0];
    if (!image) return NextResponse.json({ error: "Image not found." }, { status: 404 });

    const signedUrl = await createSignedDownloadUrl(LISTING_STUDIO_BUCKET, image.storage_path, SIGNED_VIEW_URL_LIFETIME_SECONDS);
    return NextResponse.redirect(signedUrl, { status: 302 });
  } catch (error) {
    if (error instanceof StorageBucketMissingError) return NextResponse.json({ error: error.message }, { status: 503 });
    return safeApiError(error, "Could not load this photo.");
  }
}
