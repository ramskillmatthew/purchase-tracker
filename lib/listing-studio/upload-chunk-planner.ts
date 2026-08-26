import { MAX_BATCH_SIZE_BYTES, MAX_FILES_PER_SELECTION, MAX_INDIVIDUAL_FILE_SIZE_BYTES } from "./upload-limits";

/**
 * Pure, DOM-free chunk planning for a large Listing Studio photo selection.
 * Confirmed root cause of the "126 photos -> 0 uploaded, 126 failed"
 * failure: GroupingWorkspace.runUploadBatch sent the ENTIRE selection as one
 * `files` array to POST /api/listing-studio/uploads, whose
 * uploadSessionRequestSchema caps that array at MAX_FILES_PER_SELECTION
 * (60) — Zod rejected the whole request before a single signed URL was
 * minted, and the client applied that one generic error to every file.
 *
 * The fix is NOT raising the 60-file server ceiling (see MAX_FILES_PER_SELECTION's
 * own doc comment for why it exists — bounded request size, signed-URL
 * minting, DB inserts, and API duration all scale with it). Instead, a large
 * selection is planned into several requests here, each independently
 * guaranteed to satisfy every server-side limit.
 *
 * Chosen target chunk size: exactly MAX_FILES_PER_SELECTION. That constant
 * was already a deliberately chosen, documented ceiling for one
 * registration request's blast radius — there's no evidence (and the
 * confirmed failure gives none) that ordinary product photos need a lower
 * target for reliability. The observed failing selection's photos were
 * ~600-900KB JPEGs; 60 of those (~54MB) sits comfortably under
 * MAX_BATCH_SIZE_BYTES (500MB), so the byte ceiling only ever binds for an
 * unusually large-file selection (e.g. many files near the 35MB individual
 * cap), which is exactly the scenario the byte-aware chunking below exists
 * to still handle safely rather than assuming uniform file sizes.
 */

export type PlannableFile = { name: string; size: number };

export type ChunkRejectReason = "file_too_large" | "workspace_capacity_exceeded";

export type RejectedPlannableFile<T extends PlannableFile> = {
  file: T;
  reason: ChunkRejectReason;
  message: string;
};

export type UploadChunkPlan<T extends PlannableFile> = {
  chunks: T[][];
  rejected: RejectedPlannableFile<T>[];
};

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function fileTooLargeMessage(file: PlannableFile): string {
  return `"${file.name}" exceeds the ${formatMb(MAX_INDIVIDUAL_FILE_SIZE_BYTES)} file limit.`;
}

function capacityExceededMessage(file: PlannableFile): string {
  return `"${file.name}" was not added — this workspace has reached its active-photo limit.`;
}

/**
 * Plans a large, already-deduplicated file selection into upload-registration
 * chunks. Every chunk is guaranteed to satisfy BOTH the file-count ceiling
 * (MAX_FILES_PER_SELECTION) and the combined-byte ceiling (MAX_BATCH_SIZE_BYTES)
 * — files are never assumed to be the same size, so a run of unusually
 * large files can close a chunk well before it reaches 60 files.
 *
 * Order is sacred: the returned chunks, concatenated, reproduce exactly the
 * input order (minus anything rejected) — this is what lets
 * `listing_draft_images.sort_order` preserve the user's original photography
 * order across chunk boundaries. Nothing is ever reordered, dropped
 * silently, or duplicated between chunks.
 *
 * `remainingCapacity`, when provided (the workspace's current
 * MAX_TOTAL_ACTIVE_UPLOAD_FILES headroom), truncates the *tail* of the
 * selection — the first files in original order are kept, since a user
 * who selected files in a specific order most likely cares most about the
 * earliest ones landing. This is only ever a client-side courtesy: the
 * server independently re-checks capacity on every chunk registration and
 * remains the authoritative source (see app/api/listing-studio/uploads/route.ts)
 * — this local truncation can never let something server-invalid through,
 * it can only pre-empt an avoidable failed request.
 */
export function planUploadChunks<T extends PlannableFile>(files: T[], remainingCapacity?: number | null): UploadChunkPlan<T> {
  const rejected: RejectedPlannableFile<T>[] = [];
  const accepted: T[] = [];

  for (const file of files) {
    if (file.size > MAX_INDIVIDUAL_FILE_SIZE_BYTES) {
      rejected.push({ file, reason: "file_too_large", message: fileTooLargeMessage(file) });
      continue;
    }
    accepted.push(file);
  }

  let toChunk = accepted;
  if (typeof remainingCapacity === "number" && accepted.length > Math.max(0, remainingCapacity)) {
    const keep = Math.max(0, remainingCapacity);
    toChunk = accepted.slice(0, keep);
    for (const file of accepted.slice(keep)) {
      rejected.push({ file, reason: "workspace_capacity_exceeded", message: capacityExceededMessage(file) });
    }
  }

  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const file of toChunk) {
    const wouldExceedCount = current.length >= MAX_FILES_PER_SELECTION;
    const wouldExceedBytes = current.length > 0 && currentBytes + file.size > MAX_BATCH_SIZE_BYTES;
    if (wouldExceedCount || wouldExceedBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) chunks.push(current);

  return { chunks, rejected };
}

export function totalPlannedFiles<T extends PlannableFile>(plan: UploadChunkPlan<T>): number {
  return plan.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}
