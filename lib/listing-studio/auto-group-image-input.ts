import "server-only";
import sharp from "sharp";
import convertHeic from "heic-convert";
import type Anthropic from "@anthropic-ai/sdk";
import { createSignedDownloadUrl } from "./storage-rest";
import { isHeicMimeType } from "./upload-limits";
import { AUTO_GROUP_IMAGE_JPEG_QUALITY, AUTO_GROUP_IMAGE_MAX_DIMENSION_PX } from "./upload-limits";

/**
 * Builds one Claude-ready image content block per eligible photo — resized,
 * re-encoded as JPEG, and base64-embedded directly in the request rather
 * than passed as a URL for Claude's own servers to fetch. This is a
 * deliberate choice, not the simpler alternative: minting a signed URL and
 * handing it to Claude as `source: {type: "url"}` would still work, but it
 * would send the *original, full-resolution* file to the model provider —
 * this milestone's spec explicitly asks for resized/optimised input to
 * control latency and cost, which requires resizing here, server-side,
 * before the request leaves this app. The original Storage object is never
 * touched, overwritten, or re-uploaded by any of this — only an in-memory
 * copy built for this one API call and discarded afterward.
 *
 * HEIC/HEIF handling: sharp's own bundled libheif cannot decode real HEVC
 * pixel data (verified live during Milestone 2 — it reads the container but
 * has no HEVC codec plugin built in), so HEIC/HEIF originals are decoded
 * first via `heic-convert`, a separate, WASM-based libheif build that does
 * not depend on the system codec plugin sharp's libvips build was missing —
 * the same class of fix as this app's existing browser-side fallback
 * (heic2any, used for the upload-queue preview thumbnail), just for Node
 * instead of the browser. `heic-convert`'s output (a decoded JPEG buffer)
 * is then run through the exact same sharp resize/re-encode step as every
 * other format, so the final size/quality is consistent regardless of the
 * original's format. NOTE: unlike the sharp finding above, this specific
 * decoder's real-world reliability against a genuine HEVC-encoded iPhone
 * photo has not been verified live in this environment (no sample HEIC file
 * was available to test against here) — flagged for manual verification.
 *
 * Either way, a per-image failure (network error, corrupt file, a decode
 * genuinely failing) is skipped rather than aborting the whole batch — one
 * bad photo must never prevent every other photo in the same run from being
 * grouped, and HEIC support degrading to "skipped, left in Unsorted" on
 * failure is exactly the same safe fallback this app already uses
 * everywhere else HEIC decoding is attempted.
 */

export type AutoGroupImageInput = { id: string; storagePath: string; mimeType: string };
export type PreparedImageBlock = { imageId: string; content: Anthropic.ImageBlockParam };
export type SkippedImage = { imageId: string; reason: string };

const SIGNED_URL_LIFETIME_SECONDS = 120; // just long enough to fetch it ourselves within this same request
const CONCURRENCY = 8;

async function prepareOne(image: AutoGroupImageInput, bucket: string): Promise<{ block?: PreparedImageBlock; skipped?: SkippedImage }> {
  try {
    const signedUrl = await createSignedDownloadUrl(bucket, image.storagePath, SIGNED_URL_LIFETIME_SECONDS);
    const response = await fetch(signedUrl);
    if (!response.ok) return { skipped: { imageId: image.id, reason: "Could not download this photo for analysis." } };
    let decodable = Buffer.from(await response.arrayBuffer());

    if (isHeicMimeType(image.mimeType)) {
      try {
        decodable = Buffer.from(await convertHeic({ buffer: decodable, format: "JPEG", quality: 0.9 }));
      } catch {
        return { skipped: { imageId: image.id, reason: "Could not decode this HEIC/HEIF photo for analysis." } };
      }
    }

    const resized = await sharp(decodable)
      .rotate() // apply the file's own EXIF orientation before resizing, since we're discarding EXIF in the output
      .resize({ width: AUTO_GROUP_IMAGE_MAX_DIMENSION_PX, height: AUTO_GROUP_IMAGE_MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: AUTO_GROUP_IMAGE_JPEG_QUALITY })
      .toBuffer();
    return { block: { imageId: image.id, content: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") } } } };
  } catch {
    // Never surface the raw decode/network error — just treat this one
    // photo as unavailable for this run.
    return { skipped: { imageId: image.id, reason: "Could not prepare this photo for analysis." } };
  }
}

/**
 * NOTE for callers: `blocks` is returned in whatever order the concurrent
 * workers below happen to finish in, NOT the order `images` was given in —
 * fine for v2's free clustering (order didn't matter), but v3's ordered
 * boundary detection depends on exact sequence order for its "Photo #N"
 * labelling. Callers that care about order (lib/listing-studio/auto-group-ai.ts)
 * must build a lookup keyed by `imageId` and re-walk their own known-order
 * id list, rather than relying on this array's own order.
 */
export async function prepareAutoGroupImageInputs(images: AutoGroupImageInput[], bucket: string): Promise<{ blocks: PreparedImageBlock[]; skipped: SkippedImage[] }> {
  const queue = [...images];
  const blocks: PreparedImageBlock[] = [];
  const skipped: SkippedImage[] = [];
  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, queue.length)) }, async () => {
    let next: AutoGroupImageInput | undefined;
    while ((next = queue.shift())) {
      const result = await prepareOne(next, bucket);
      if (result.block) blocks.push(result.block);
      if (result.skipped) skipped.push(result.skipped);
    }
  });
  await Promise.all(workers);
  return { blocks, skipped };
}
