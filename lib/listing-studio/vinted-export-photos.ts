import "server-only";
import convertHeic from "heic-convert";
import { createSignedDownloadUrl } from "./storage-rest";
import { isHeicMimeType } from "./upload-limits";
import { extensionForExportedPhoto, buildPhotoFileName } from "./vinted-export-schema";

/**
 * Downloads and (if needed) converts ONE listing photo for the ZIP export,
 * server-side only. Mirrors lib/listing-studio/listing-generation-image-input.ts's
 * own signed-URL-then-fetch-then-HEIC-convert pipeline exactly (the same
 * already-verified server-side HEIC decode approach — heic-convert, not
 * sharp, which cannot decode real HEVC pixel data; see that file's own
 * comment) — but deliberately never resizes or re-encodes a non-HEIC
 * photo: this package is for an actual Vinted listing, not AI analysis, so
 * every photo's original quality is preserved untouched except for the
 * HEIC container itself, which Vinted cannot accept at all.
 */

export type ExportPhotoInput = { imageId: string; storagePath: string; mimeType: string; fileSize: number };
export type PreparedExportPhoto = { imageId: string; fileName: string; bytes: Buffer };
export type PreparedSinglePhoto = { imageId: string; fileName: string; bytes: Buffer; contentType: string };

const SIGNED_URL_LIFETIME_SECONDS = 120; // just long enough to fetch it ourselves within this same request
const CONCURRENCY = 8;

export class ExportPhotoError extends Error {
  imageId: string;
  constructor(imageId: string, message: string) {
    super(message);
    this.name = "ExportPhotoError";
    this.imageId = imageId;
  }
}

async function prepareOne(image: ExportPhotoInput, positionInListing: number, bucket: string): Promise<PreparedExportPhoto> {
  let signedUrl: string;
  try {
    signedUrl = await createSignedDownloadUrl(bucket, image.storagePath, SIGNED_URL_LIFETIME_SECONDS);
  } catch {
    throw new ExportPhotoError(image.imageId, "Could not create a download link for this photo.");
  }

  let response: Response;
  try {
    response = await fetch(signedUrl);
  } catch {
    throw new ExportPhotoError(image.imageId, "Could not download this photo.");
  }
  if (!response.ok) throw new ExportPhotoError(image.imageId, "Could not download this photo.");

  let bytes = Buffer.from(await response.arrayBuffer());
  let wasConverted = false;
  if (isHeicMimeType(image.mimeType)) {
    try {
      // quality near 1 — unlike the AI-analysis pipeline, export must
      // preserve real listing-photo quality, not just enough detail for a
      // vision model.
      bytes = Buffer.from(await convertHeic({ buffer: bytes, format: "JPEG", quality: 0.95 }));
      wasConverted = true;
    } catch {
      throw new ExportPhotoError(image.imageId, "Could not convert this HEIC/HEIF photo to a Vinted-supported format.");
    }
  }

  const extension = extensionForExportedPhoto(image.mimeType, wasConverted);
  return { imageId: image.imageId, fileName: buildPhotoFileName(positionInListing, extension), bytes };
}

// Milestone 7 (Chrome extension draft queue) — the same single-photo
// prepare step the ZIP export already uses (download + HEIC-convert),
// exposed directly rather than duplicated: the extension's photo-serving
// route (app/api/extension/batch/photos/[itemId]/[position]/route.ts)
// calls this for exactly one photo at a time, on demand, rather than
// preparing a whole listing's photos up front — "reuses the app's
// existing safe conversion approach" literally, not a second
// implementation of it.
export async function prepareSinglePhoto(image: ExportPhotoInput, positionInListing: number, bucket: string): Promise<PreparedSinglePhoto> {
  const prepared = await prepareOne(image, positionInListing, bucket);
  const contentType = prepared.fileName.endsWith(".png") ? "image/png" : prepared.fileName.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { ...prepared, contentType };
}

/**
 * Downloads every one of ONE listing's ordered photos, bounded concurrency.
 * `images` MUST already be sorted by sort_order (cover photo first) — this
 * function preserves that order in its return value regardless of which
 * download finishes first, by writing into a pre-sized array by index
 * rather than pushing in completion order.
 *
 * All-or-nothing per listing: the first photo that fails to download or
 * convert throws immediately (via ExportPhotoError) rather than silently
 * omitting it — a Vinted listing transfer package can never be missing a
 * photo the app itself recorded as uploaded.
 */
export async function prepareExportPhotos(images: ExportPhotoInput[], bucket: string): Promise<PreparedExportPhoto[]> {
  const results = new Array<PreparedExportPhoto>(images.length);
  const queue = images.map((image, index) => ({ image, index }));
  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, queue.length)) }, async () => {
    let next: { image: ExportPhotoInput; index: number } | undefined;
    while ((next = queue.shift())) {
      results[next.index] = await prepareOne(next.image, next.index, bucket);
    }
  });
  await Promise.all(workers);
  return results;
}
