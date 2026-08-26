import { z } from "zod";
import {
  marketplaces, generationTargets, marketplaceDraftSourceTypes, contentModes, marketplaceDraftStatuses,
  categorySources, aspectConfidenceLevels, listingFormats, packageSizes, automationModes, sharedFactSources,
} from "@/lib/listing-studio/marketplace-types";

export const marketplaceSchema = z.enum(marketplaces);
export const generationTargetSchema = z.enum(generationTargets);
export const marketplaceDraftSourceTypeSchema = z.enum(marketplaceDraftSourceTypes);
export const contentModeSchema = z.enum(contentModes);
export const marketplaceDraftStatusSchema = z.enum(marketplaceDraftStatuses);
export const categorySourceSchema = z.enum(categorySources);
export const aspectConfidenceLevelSchema = z.enum(aspectConfidenceLevels);
export const listingFormatSchema = z.enum(listingFormats);
export const packageSizeSchema = z.enum(packageSizes);
export const automationModeSchema = z.enum(automationModes);
export const sharedFactSourceSchema = z.enum(sharedFactSources);

export const marketplaceReadinessSchema = z.object({
  ready: z.boolean(),
  completionPercent: z.number().min(0).max(100),
  requiredComplete: z.number().int().min(0),
  requiredTotal: z.number().int().min(0),
  recommendedComplete: z.number().int().min(0),
  recommendedTotal: z.number().int().min(0),
}).strict();

export const marketplaceValidationMessageSchema = z.object({
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(300),
  field: z.string().trim().min(1).max(80).nullable(),
  severity: z.enum(["blocking", "warning", "suggestion"]),
}).strict();

// Free text, but bounded to a sane size — the actual set of valid values
// per category comes from eBay's own aspect metadata (Stage 5), not from a
// fixed application-side enum, so this schema only guards shape/size, not
// content.
const aspectValueSchema = z.union([z.string().trim().min(1).max(500), z.array(z.string().trim().min(1).max(500)).max(20)]).nullable();

export const marketplaceAspectValueSchema = z.object({
  value: aspectValueSchema,
  confidence: aspectConfidenceLevelSchema,
  source: z.string().trim().min(1).max(80),
  appliedAutomatically: z.boolean(),
  needsReview: z.boolean(),
  userConfirmed: z.boolean(),
  updatedAt: z.string(),
}).strict();

export const marketplaceDynamicDataSchema = z.record(z.string().trim().min(1).max(120), marketplaceAspectValueSchema);

export const marketplaceDraftSettingsSchema = z.object({
  contentMode: contentModeSchema.optional(),
  listingFormat: listingFormatSchema.optional(),
  quantity: z.number().int().positive().max(1000).optional(),
  allowOffers: z.boolean().optional(),
  postageProfileLabel: z.string().trim().max(120).nullable().optional(),
  returnProfileLabel: z.string().trim().max(120).nullable().optional(),
  paymentProfileLabel: z.string().trim().max(120).nullable().optional(),
  packageSize: packageSizeSchema.nullable().optional(),
  automationMode: automationModeSchema.optional(),
}).strict();

export const sharedFactSchema = z.object({
  value: z.string().trim().min(1).max(300).nullable(),
  source: sharedFactSourceSchema,
  confidence: aspectConfidenceLevelSchema,
  confirmed: z.boolean(),
}).strict();

export const sharedFactsSchema = z.record(z.string().trim().min(1).max(60), sharedFactSchema);
