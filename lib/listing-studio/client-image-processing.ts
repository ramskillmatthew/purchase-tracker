"use client";

import { isHeicMimeType } from "./upload-limits";

/**
 * Client-only. Never import this from an API route or server component —
 * heic2any depends on browser globals and is loaded via a dynamic import
 * specifically so it's never pulled into a server bundle.
 *
 * HEIC/HEIF investigation (Milestone 2, timeboxed):
 *  - Server-side conversion (sharp) was tested live against a real,
 *    HEVC-encoded iPhone-shaped HEIC file: sharp's bundled libheif reads
 *    the container/metadata (width/height/compression fine) but the actual
 *    pixel decode fails with "heif: Error while loading plugin: Support
 *    for this compression format has not been built in" — the HEVC codec
 *    plugin isn't included in sharp's distributed binaries (a licensing
 *    constraint of the codec itself, not an environment quirk), so this
 *    would fail identically on Vercel. Ruled out.
 *  - Chosen fallback: browser-side conversion via heic2any (a WASM port of
 *    libheif that does include HEVC decode) attempted before upload, purely
 *    to produce a local preview thumbnail. If it fails for any reason, the
 *    ORIGINAL file is still queued for upload unchanged — a failed preview
 *    is never a failed upload, and the file is never discarded, rejected,
 *    or altered.
 */

export type PreparedImagePreview = {
  previewUrl: string | null;
  previewAvailable: boolean;
  conversionAttempted: boolean;
};

/**
 * Produces a preview object URL for the upload queue thumbnail. Non-HEIC
 * images get an instant object URL from the original bytes. HEIC/HEIF files
 * get a best-effort browser-side conversion to JPEG first — this function
 * never throws; any failure resolves to `previewAvailable: false` so the
 * caller can render a clear "preview unavailable" state instead of crashing
 * the upload flow.
 */
export async function prepareImagePreview(file: File): Promise<PreparedImagePreview> {
  if (!isHeicMimeType(file.type)) {
    try {
      return { previewUrl: URL.createObjectURL(file), previewAvailable: true, conversionAttempted: false };
    } catch {
      return { previewUrl: null, previewAvailable: false, conversionAttempted: false };
    }
  }

  try {
    const heic2any = (await import("heic2any")).default;
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.8 });
    // heic2any returns a single Blob, or an array of Blobs for multi-image
    // HEIC containers (e.g. Live Photos) — the first frame is the cover.
    const blob = Array.isArray(converted) ? converted[0] : converted;
    return { previewUrl: URL.createObjectURL(blob), previewAvailable: true, conversionAttempted: true };
  } catch {
    // Preserve original upload and provide a clear unsupported-preview
    // state (Milestone 2 spec §5, fallback option 3) — never discard,
    // reject, or corrupt the file itself.
    return { previewUrl: null, previewAvailable: false, conversionAttempted: true };
  }
}

/**
 * Revokes a preview object URL created above — call on unmount/removal to
 * avoid leaking blob URLs across a large batch of photos.
 */
export function releaseImagePreview(previewUrl: string | null): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
}
