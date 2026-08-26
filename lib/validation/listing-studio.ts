import { z } from "zod";
import { confidenceLevels, fieldSources, imageRoles, listingDraftStatuses, listingFieldNames } from "@/lib/listing-studio/types";

export const confidenceLevelSchema = z.enum(confidenceLevels);
export const fieldSourceSchema = z.enum(fieldSources);
export const imageRoleSchema = z.enum(imageRoles);
export const listingDraftStatusSchema = z.enum(listingDraftStatuses);
export const listingFieldNameSchema = z.enum(listingFieldNames);

const uuidSchema = z.string().uuid();

/**
 * Generic FieldValue<T> validator (lib/listing-studio/types.ts). `.strict()`
 * so an AI response carrying an unexpected extra property on a field is
 * rejected rather than silently accepted — every important field's shape is
 * identical regardless of which pipeline stage produced it.
 */
export function fieldValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema.nullable(),
    confidence: confidenceLevelSchema,
    source: fieldSourceSchema,
    sourceImageId: uuidSchema.nullable(),
    aiGenerated: z.boolean(),
    userConfirmed: z.boolean(),
    conflict: z.boolean(),
  }).strict();
}

const shortTextSchema = z.string().trim().min(1).max(120);
const colourMaterialArraySchema = z.array(z.string().trim().min(1).max(60)).max(6);

// Mirrors ListingFieldValueTypeMap exactly — one fieldValueSchema per
// tracked field, each with the value type that field actually holds.
export const listingFieldDataSchema = z.object({
  brand: fieldValueSchema(shortTextSchema).optional(),
  model: fieldValueSchema(shortTextSchema).optional(),
  silhouette: fieldValueSchema(shortTextSchema).optional(),
  sku: fieldValueSchema(shortTextSchema).optional(),
  styleCode: fieldValueSchema(shortTextSchema).optional(),
  sizeUk: fieldValueSchema(shortTextSchema).optional(),
  sizeEu: fieldValueSchema(shortTextSchema).optional(),
  sizeUs: fieldValueSchema(shortTextSchema).optional(),
  category: fieldValueSchema(shortTextSchema).optional(),
  condition: fieldValueSchema(shortTextSchema).optional(),
  colours: fieldValueSchema(colourMaterialArraySchema).optional(),
  materials: fieldValueSchema(colourMaterialArraySchema).optional(),
}).strict();

export const listingWarningSchema = z.object({
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(300),
  field: listingFieldNameSchema.nullable(),
}).strict();

export const listingConflictSchema = z.object({
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(300),
  field: listingFieldNameSchema.nullable(),
  values: z.array(z.string().trim().min(1).max(120)).max(10),
}).strict();
