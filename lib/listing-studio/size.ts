import type { ListingFieldData } from "./types";
import { isFieldConfirmedOrConfident } from "./field-value";

/**
 * Categories requiring a confirmed size before a draft can be marked Ready
 * (Stage 1 spec §10: "Shoes require size... some accessories may not").
 * The exact category taxonomy isn't finalised until the AI pipeline
 * (Milestone 3) settles what values Pass 3 actually produces, so this is
 * deliberately a small, easy-to-extend allowlist rather than a fixed enum —
 * an unrecognised category defaults to NOT requiring size (a missing/unknown
 * category is already separately flagged by validateDraftReadiness, so this
 * helper doesn't need to double-guess it). Review/expand this list once
 * Milestone 3's category values are known — see the Milestone 1 report.
 */
const SIZE_REQUIRED_CATEGORIES = new Set([
  "shoes", "footwear", "trainers", "boots", "sandals", "heels",
  "clothing", "tops", "t-shirts", "shirts", "jumpers", "hoodies", "jackets", "coats", "outerwear",
  "bottoms", "trousers", "jeans", "shorts", "skirts", "dresses",
]);

export function categoryRequiresSize(category: string | null | undefined): boolean {
  if (!category) return false;
  return SIZE_REQUIRED_CATEGORIES.has(category.trim().toLowerCase());
}

/**
 * True once a category-appropriate size is settled — either a manually
 * typed sizeLabel, or any of the three label-extracted size-system fields
 * confirmed/confident. Deliberately does not require all three (uk/eu/us) —
 * a single readable, trustworthy size system is enough.
 */
export function hasUsableSize(fields: Pick<ListingFieldData, "sizeUk" | "sizeEu" | "sizeUs">, sizeLabel: string | null | undefined): boolean {
  if (sizeLabel?.trim()) return true;
  return isFieldConfirmedOrConfident(fields.sizeUk) || isFieldConfirmedOrConfident(fields.sizeEu) || isFieldConfirmedOrConfident(fields.sizeUs);
}
