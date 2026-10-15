import { NextResponse } from "next/server";
import { supabaseRequestAll } from "@/lib/supabase";
import { createSignedDownloadUrl } from "@/lib/listing-studio/storage-rest";
import { verifyEbayPhotoProxySignature } from "@/lib/listing-studio/ebay-photo-urls";
import { LISTING_STUDIO_BUCKET } from "@/lib/listing-studio/storage-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ imageId: string }> }) {
  const { imageId } = await context.params;
  const url = new URL(request.url);
  const expiresAt = Number(url.searchParams.get("exp"));
  const suppliedSignature = url.searchParams.get("sig") ?? "";
  if (!verifyEbayPhotoProxySignature(imageId, expiresAt, suppliedSignature)) {
    return NextResponse.json({ error: "This photo link is invalid or has expired." }, { status: 403 });
  }

  const rows = await supabaseRequestAll<{ storage_path: string }>(
    `listing_draft_images?id=eq.${encodeURIComponent(imageId)}&upload_state=eq.uploaded&select=storage_path`,
  );
  if (!rows[0]) return NextResponse.json({ error: "Photo not found." }, { status: 404 });

  const signedUrl = await createSignedDownloadUrl(LISTING_STUDIO_BUCKET, rows[0].storage_path, 60);
  const upstream = await fetch(signedUrl, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!upstream.ok || !upstream.body) return NextResponse.json({ error: "Photo could not be loaded." }, { status: 502 });
  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
    "Cache-Control": "private, max-age=60",
  };
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers["Content-Length"] = contentLength;
  return new NextResponse(upstream.body, { status: 200, headers });
}
