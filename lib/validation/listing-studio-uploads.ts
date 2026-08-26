import { z } from "zod";
import { isAcceptedImageMimeType, MAX_AUTO_GROUP_BATCH_SIZE, MAX_AUTO_GROUP_SESSION_SIZE, MAX_FILES_PER_SELECTION } from "@/lib/listing-studio/upload-limits";
import { autoGroupToolInputSchema } from "@/lib/listing-studio/auto-group-schemas";
import { VINTED_COLOURS, VINTED_MATERIALS, VINTED_AUDIENCE_VALUES } from "@/lib/listing-studio/listing-generation-schemas";

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

// Milestone 4 (AI listing generation) — the "Edit fields" modal's own save
// request (see app/api/listing-studio/groups/[draftId]/fields/route.ts).
// Every field is optional/nullable: a blank field is a legitimate value
// (the AI leaves brand/model/ukSize/sku null rather than guess, and the
// user can leave it blank too) — this is never itself a validation
// failure, only a missing-data state the UI already expects. An empty
// string is normalized to null by the route, not this schema.
const listingFieldTextSchema = z.string().trim().max(150).nullable();
// Milestone 6 (Vinted-aware colours/materials): colours/material are no
// longer free text — a manual Edit Fields save is validated against the
// exact same Vinted enum lists the AI is constrained to (VINTED_COLOURS/
// VINTED_MATERIALS), so a value outside either list is rejected here
// exactly like an out-of-enum AI tool call would be. Vinted allows at
// most two colours per listing.
const vintedColoursFieldSchema = z.array(z.enum(VINTED_COLOURS)).max(2);
const vintedMaterialFieldSchema = z.enum(VINTED_MATERIALS).nullable();
// Milestone 7 (Vinted category catalogue sync): the manual category picker
// only ever sends back a real Vinted numeric id (or null to clear it) —
// never free text. The route itself re-validates this id against the live
// vinted_categories table (active/selectable/leaf) before it's ever
// persisted; this schema only guards the shape.
const vintedCategoryIdFieldSchema = z.number().int().positive().nullable();
// Follow-up correction (2026-08-04): a real, dedicated audience field —
// see listing-generation-schemas.ts's own comment for why this is now
// independent of sourceSize.gender. Always required (never omitted) so
// the fields route can reliably detect "did the user just change this".
const vintedAudienceFieldSchema = z.enum(VINTED_AUDIENCE_VALUES);
export const updateListingFieldsRequestSchema = z.object({
  brand: listingFieldTextSchema,
  model: listingFieldTextSchema,
  productType: listingFieldTextSchema,
  colours: vintedColoursFieldSchema,
  material: vintedMaterialFieldSchema,
  ukSize: z.string().trim().max(20).nullable(),
  sku: z.string().trim().max(50).nullable(),
  vintedAudience: vintedAudienceFieldSchema,
  vintedCategoryId: vintedCategoryIdFieldSchema,
}).strict();

// Milestone 6 (purchase-price lookup and manual Vinted selling price) — the
// details panel's dedicated selling-price save. Deliberately just the raw
// pounds string exactly as typed (never a client-computed pence value) —
// lib/listing-studio/selling-price.ts's parseSellingPricePounds is the
// SOLE authoritative parser/validator, called server-side by the route
// itself; this schema only guards the shape/length of what's allowed to
// reach that function at all.
export const updateSellingPriceRequestSchema = z.object({
  sellingPrice: z.string().trim().min(1).max(20),
}).strict();
