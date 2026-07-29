import { z } from "zod";
import { isAcceptedImageMimeType, MAX_FILES_PER_SELECTION } from "@/lib/listing-studio/upload-limits";

// Milestone 2 request-body schemas: photo upload, confirmation, and manual
// grouping (create/rename/move/reorder/split/merge). Every field is
// strictly validated server-side regardless of what the client already
// checked — the client's own limits/mime checks are a UX convenience only.

export const uuidSchema = z.string().uuid();

const filenameSchema = z.string().trim().min(1).max(255);

export const uploadSessionFileSchema = z.object({
  filename: filenameSchema,
  mimeType: z.string().refine(isAcceptedImageMimeType, { message: "Unsupported file type." }),
  fileSize: z.number().int().positive(),
}).strict();

// draftId is optional — omitted, the server finds-or-creates the owner's
// current "Unsorted" inbox group (Milestone 2 spec §8); provided, the files
// are appended to that specific existing group instead.
export const uploadSessionRequestSchema = z.object({
  draftId: uuidSchema.nullable().optional(),
  files: z.array(uploadSessionFileSchema).min(1).max(MAX_FILES_PER_SELECTION),
}).strict();

export const confirmUploadRequestSchema = z.object({
  imageId: uuidSchema,
  // Browser-derived only (never trusted for mime/size — those are
  // independently re-verified against the real Storage object). Reasonable
  // ceiling guards against a nonsensical/adversarial value.
  width: z.number().int().positive().max(20_000).nullable().optional(),
  height: z.number().int().positive().max(20_000).nullable().optional(),
  previewAvailable: z.boolean().optional(),
}).strict();

export const retryUploadRequestSchema = z.object({ imageId: uuidSchema }).strict();

export const removeImageRequestSchema = z.object({ imageId: uuidSchema }).strict();

export const createGroupRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
}).strict();

export const updateGroupRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
}).strict();

// Only required when the group being deleted still has photos — an empty
// group can be deleted with no body/mode at all.
export const deleteGroupRequestSchema = z.object({
  mode: z.enum(["move_to_unsorted", "delete_photos"]).optional(),
}).strict();

export const reorderImagesRequestSchema = z.object({
  draftId: uuidSchema,
  orderedImageIds: z.array(uuidSchema).min(1).max(500),
}).strict();

export const moveImagesRequestSchema = z.object({
  imageIds: z.array(uuidSchema).min(1).max(100),
  targetDraftId: uuidSchema,
}).strict();

export const splitGroupRequestSchema = z.object({
  sourceDraftId: uuidSchema,
  imageIds: z.array(uuidSchema).min(1).max(100),
  newTitle: z.string().trim().min(1).max(200).optional(),
}).strict();

export const mergeGroupsRequestSchema = z.object({
  sourceDraftId: uuidSchema,
  targetDraftId: uuidSchema,
}).strict();
