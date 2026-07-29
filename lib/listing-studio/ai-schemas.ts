import { z } from "zod";
import { confidenceLevelSchema, imageRoleSchema, listingFieldNameSchema } from "@/lib/validation/listing-studio";

/**
 * Strict JSON schemas for every AI pipeline stage (Stage 1 spec §7/§17).
 * These are NOT called yet — Milestone 3 wires the actual Claude tool-use
 * calls that validate against them, following this codebase's existing
 * convention (lib/purchase-import/ai-schema.ts): force a tool call, then
 * re-validate `tool_use.input` against these schemas anyway, never trusting
 * the tool-call shape on its own. All `.strict()`; every nullable value is
 * explicit; enums are validated; text/array lengths are bounded so a
 * malformed or adversarial response can't produce an unbounded payload.
 */

const uuidSchema = z.string().uuid();
const shortText = z.string().trim().min(1).max(200);
const longText = z.string().trim().min(1).max(4000);
const warningText = z.string().trim().min(1).max(300);

// A value read directly off a label photo — no confidence-independent
// "source" field needed here since the parent `imageId` on each labels[]
// entry already is the source image (Stage 1 spec §7 Pass 2: "include the
// source image ID for every extracted value").
const labelFieldSchema = z.object({ value: shortText, confidence: confidenceLevelSchema }).strict().nullable();

// A value read from the full photo set (not label-specific) — same
// value/confidence shape as labelFieldSchema, kept as a distinct name for
// readability since Pass 3 is visual, not label, analysis.
function visualField<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({ value: valueSchema, confidence: confidenceLevelSchema }).strict();
}

// PASS 1 — image quality and grouping validation
export const imageQualityResultSchema = z.object({
  sameProductConfidence: confidenceLevelSchema,
  imageRoles: z.array(z.object({
    imageId: uuidSchema,
    role: imageRoleSchema,
    confidence: confidenceLevelSchema,
  }).strict()).max(100),
  missingPhotoWarnings: z.array(warningText).max(20),
  unusableImageWarnings: z.array(z.object({ imageId: uuidSchema, reason: warningText }).strict()).max(100),
  groupingWarnings: z.array(warningText).max(20),
  hasReadableLabel: z.boolean(),
}).strict();
export type ImageQualityResult = z.infer<typeof imageQualityResultSchema>;

// PASS 2 — label extraction. Rules from Stage 1 spec §7: preserve exact
// characters (no inference of missing ones — enforced by prompt, not
// schema), null for anything unreadable, raw text kept separate from the
// parsed fields.
export const labelExtractionResultSchema = z.object({
  labels: z.array(z.object({
    imageId: uuidSchema,
    rawText: z.string().trim().max(2000).nullable(),
    brand: labelFieldSchema,
    sizeSystemsShown: z.array(shortText).max(6),
    sizeUk: labelFieldSchema,
    sizeEu: labelFieldSchema,
    sizeUs: labelFieldSchema,
    styleCode: labelFieldSchema,
    sku: labelFieldSchema,
    productCode: labelFieldSchema,
    colourCode: labelFieldSchema,
    materialText: labelFieldSchema,
    countryOfManufacture: labelFieldSchema,
    otherText: z.array(shortText).max(20),
  }).strict()).max(50),
}).strict();
export type LabelExtractionResult = z.infer<typeof labelExtractionResultSchema>;

// PASS 3 — visual product identification. Deliberately independent of Pass 2
// — the model must not treat label text as ground truth for what it sees.
export const visualIdentificationResultSchema = z.object({
  productType: visualField(shortText),
  brand: visualField(shortText.nullable()),
  model: visualField(shortText.nullable()),
  silhouette: visualField(shortText.nullable()),
  colourway: visualField(shortText.nullable()),
  mainColour: visualField(shortText.nullable()),
  secondaryColours: visualField(z.array(shortText).max(6)),
  department: visualField(shortText.nullable()),
  category: visualField(shortText),
  subcategory: visualField(shortText.nullable()),
  material: visualField(z.array(shortText).max(6)),
  approximateCondition: visualField(shortText),
  visibleDefects: z.array(warningText).max(20),
  distinguishingDetails: z.array(warningText).max(20),
}).strict();
export type VisualIdentificationResult = z.infer<typeof visualIdentificationResultSchema>;

// PASS 4 — consistency check between Pass 2 (label) and Pass 3 (visual).
export const consistencyCheckResultSchema = z.object({
  confirmedFacts: z.array(z.object({ field: listingFieldNameSchema, value: shortText }).strict()).max(20),
  conflicts: z.array(z.object({
    code: z.string().trim().min(1).max(80),
    message: warningText,
    field: listingFieldNameSchema.nullable(),
    values: z.array(shortText).max(10),
  }).strict()).max(20),
  missingRequiredInformation: z.array(warningText).max(20),
  fieldsRequiringReview: z.array(listingFieldNameSchema).max(20),
  overallConfidence: confidenceLevelSchema,
  readyForGeneration: z.boolean(),
}).strict();
export type ConsistencyCheckResult = z.infer<typeof consistencyCheckResultSchema>;

// PASS 5 — listing generation. Only ever invoked after Pass 4 reports
// readyForGeneration === true (enforced by the caller, not this schema).
// suggestedPricePence caps at £100,000 as a sanity ceiling, not a real
// business limit — matches this app's existing pattern of a generous but
// bounded numeric ceiling (see purchaseInputSchema's price_purchased).
export const listingGenerationResultSchema = z.object({
  title: z.string().trim().min(1).max(150),
  description: longText,
  brand: shortText.nullable(),
  model: shortText.nullable(),
  silhouette: shortText.nullable(),
  category: shortText,
  subcategory: shortText.nullable(),
  size: shortText.nullable(),
  condition: shortText,
  colour: shortText.nullable(),
  material: shortText.nullable(),
  suggestedPricePence: z.number().int().nonnegative().max(100_000_00),
  searchKeywords: z.array(shortText).max(20),
  warnings: z.array(warningText).max(20),
}).strict();
export type ListingGenerationResult = z.infer<typeof listingGenerationResultSchema>;
