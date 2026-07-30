import { z } from "zod";
import { isAcceptedImageMimeType, MAX_AUTO_GROUP_BATCH_SIZE, MAX_AUTO_GROUP_SESSION_SIZE, MAX_FILES_PER_SELECTION } from "@/lib/listing-studio/upload-limits";
import { autoGroupToolInputSchema } from "@/lib/listing-studio/auto-group-schemas";

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

// Applies one already-reviewed medium-confidence auto-grouping proposal
// (see app/api/listing-studio/groups/auto-group/apply/route.ts) — just the
// photo ids the user confirmed; the destination group is always a fresh,
// automatically-named one, and the source is always whichever Unsorted
// group currently exists, so neither is ever client-supplied.
export const applyAutoGroupProposalRequestSchema = z.object({
  imageIds: z.array(uuidSchema).min(1).max(100),
}).strict();

// One chunk of a (possibly much larger) "Auto-group products" run — see
// MAX_AUTO_GROUP_BATCH_SIZE. components/listing-studio/GroupingWorkspace.tsx
// slices the whole eligible Unsorted set into chunks of at most this many
// ids and calls the analyze route once per chunk, automatically, in
// sequence; the server independently re-verifies every id still belongs to
// this owner's current Unsorted group regardless of what the client sends.
// `overlapImageIds` (read-only context from the tail of the previous
// chunk) and `chunkStartSequenceIndex` (this chunk's own global sequence
// position, for prompt labelling only) are both optional — chunk 1 has
// neither.
export const autoGroupAnalyzeRequestSchema = z.object({
  imageIds: z.array(uuidSchema).min(1).max(MAX_AUTO_GROUP_BATCH_SIZE),
  overlapImageIds: z.array(uuidSchema).max(20).optional(),
  chunkStartSequenceIndex: z.number().int().positive(),
}).strict();

// Applies a WHOLE "Auto-group products" session in one all-or-nothing call
// — see app/api/listing-studio/groups/auto-group/apply-session/route.ts.
// `imageIds` is the full session's eligible photo ids, in the exact order
// used throughout analysis (1-based position = sequence index);
// `chunkResults` is every chunk's own validated analyze response, in the
// order the chunks were analysed. Both are re-derived from data the server
// itself already returned to the client — this is reconciliation input,
// not a source of authority: ownership and Unsorted-membership are still
// independently enforced by rpc/listing_studio_apply_boundary_session
// itself before anything is ever moved.
export const applyAutoGroupSessionRequestSchema = z.object({
  imageIds: z.array(uuidSchema).min(1).max(MAX_AUTO_GROUP_SESSION_SIZE),
  chunkResults: z.array(autoGroupToolInputSchema).min(1).max(Math.ceil(MAX_AUTO_GROUP_SESSION_SIZE / MAX_AUTO_GROUP_BATCH_SIZE)),
}).strict();
