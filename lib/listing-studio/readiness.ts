import type { ListingFieldData } from "./types";
import { isFieldConfirmedOrConfident } from "./field-value";
import { categoryRequiresSize, hasUsableSize } from "./size";

export type ReadinessInput = {
  imageCount: number;
  fields: ListingFieldData;
  title: string | null;
  description: string | null;
  category: string | null;
  sizeLabel: string | null;
  suggestedPricePence: number | null;
  confirmedPricePence: number | null;
  hasUnresolvedCriticalConflict: boolean;
};

export type MissingRequirement = "photo" | "sku" | "title" | "description" | "brand" | "category" | "condition" | "size" | "price" | "unresolved_conflict";

export type ReadinessResult = { ready: boolean; missing: MissingRequirement[] };

/**
 * Stage 1 spec §10's required-fields gate. Deliberately does NOT check
 * optional/unconfident fields like material — "Do not make 'Ready' dependent
 * on optional fields... if they cannot be confidently identified." Brand,
 * SKU, and condition go through isFieldConfirmedOrConfident so a low-
 * confidence AI guess can never quietly count as "done" — only a user-
 * confirmed or high-confidence value satisfies the requirement.
 */
export function validateDraftReadiness(input: ReadinessInput): ReadinessResult {
  const missing: MissingRequirement[] = [];

  if (input.imageCount < 1) missing.push("photo");
  if (!isFieldConfirmedOrConfident(input.fields.sku)) missing.push("sku");
  if (!input.title?.trim()) missing.push("title");
  if (!input.description?.trim()) missing.push("description");
  if (!isFieldConfirmedOrConfident(input.fields.brand)) missing.push("brand");
  if (!input.category?.trim()) missing.push("category");
  if (!isFieldConfirmedOrConfident(input.fields.condition)) missing.push("condition");
  if (categoryRequiresSize(input.category) && !hasUsableSize(input.fields, input.sizeLabel)) missing.push("size");
  if (input.confirmedPricePence == null && input.suggestedPricePence == null) missing.push("price");
  if (input.hasUnresolvedCriticalConflict) missing.push("unresolved_conflict");

  return { ready: missing.length === 0, missing };
}
