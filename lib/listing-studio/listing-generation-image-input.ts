import "server-only";
import sharp from "sharp";
import convertHeic from "heic-convert";
import type Anthropic from "@anthropic-ai/sdk";
import { createSignedDownloadUrl } from "./storage-rest";
import { isHeicMimeType } from "./upload-limits";
import { LISTING_GENERATION_IMAGE_JPEG_QUALITY, LISTING_GENERATION_IMAGE_MAX_DIMENSION_PX } from "./upload-limits";

/**
 * Builds one Claude-ready image content block per eligible photo of ONE
 * product group, for Milestone 4 listing generation. A deliberately
 * separate file from lib/listing-studio/auto-group-image-input.ts, not a
 * shared/refactored one, even though the underlying resize/HEIC pipeline is
 * almost identical — that file backs Milestone 3's grouping feature, which
 * is tested and committed and must not be touched by this milestone. The
 * one real difference: this pass resizes to LISTING_GENERATION_IMAGE_MAX_DIMENSION_PX
 * (near Anthropic's own ~1568px internal limit), not
 * AUTO_GROUP_IMAGE_MAX_DIMENSION_PX — grouping only needs to tell products
 * apart, this pass needs to read fine label/sticker text (the SKU
 * inventory sticker, a UK size tag).
 *
 * HEIC/HEIF handling and the "skip this one photo, never abort the whole
 * group" failure behaviour are identical to the grouping pipeline's own —
 * see that file's doc comment for the full rationale (verified live during
 * Milestone 2 that sharp's bundled libheif cannot decode real HEVC pixel
 * data, hence the separate heic-convert WASM decode step).
 *
 * Unlike grouping, callers here do NOT need to preserve input order — a
 * listing-generation call has no ordered-sequence concept, it just needs
 * every one of this group's own photos in one request — so `blocks` can be
 * used directly in whatever order the concurrent workers below finish in.
 */

export type ListingImageInput = { id: string; storagePath: string; mimeType: string };
export type PreparedListingImageBlock = { imageId: string; content: Anthropic.ImageBlockParam };
export type SkippedListingImage = { imageId: string; reason: string };

const SIGNED_URL_LIFETIME_SECONDS = 120; // just long enough to fetch it ourselves within this same request
const CONCURRENCY = 8;

async function prepareOne(image: ListingImageInput, bucket: string): Promise<{ block?: PreparedListingImageBlock; skipped?: SkippedListingImage }> {
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
      .resize({ width: LISTING_GENERATION_IMAGE_MAX_DIMENSION_PX, height: LISTING_GENERATION_IMAGE_MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: LISTING_GENERATION_IMAGE_JPEG_QUALITY })
      .toBuffer();
    return { block: { imageId: image.id, content: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") } } } };
  } catch {
    // Never surface the raw decode/network error — just treat this one
    // photo as unavailable for this run.
    return { skipped: { imageId: image.id, reason: "Could not prepare this photo for analysis." } };
  }
}

export async function prepareListingGenerationImageInputs(images: ListingImageInput[], bucket: string): Promise<{ blocks: PreparedListingImageBlock[]; skipped: SkippedListingImage[] }> {
  const queue = [...images];
  const blocks: PreparedListingImageBlock[] = [];
  const skipped: SkippedListingImage[] = [];
  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, queue.length)) }, async () => {
    let next: ListingImageInput | undefined;
    while ((next = queue.shift())) {
      const result = await prepareOne(next, bucket);
      if (result.block) blocks.push(result.block);
      if (result.skipped) skipped.push(result.skipped);
    }
  });
  await Promise.all(workers);
  return { blocks, skipped };
}
