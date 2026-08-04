import type { ListingGenerationFields } from "./listing-generation-schemas";

/**
 * Milestone 5 (Listings Review workspace). Every derived value here is
 * computed from data the AI listing-generation pipeline (Milestone 4)
 * already stores — no AI confidence value is ever read or surfaced;
 * "actionable problems" (missing fields) replace it entirely, per the
 * milestone's own explicit instruction.
 *
 * "Edited" detection deliberately needs no new tracking column: every
 * generated draft's `ai_result_json` is a frozen snapshot of exactly what
 * the AI returned at generation time (see listing-generation-schemas.ts —
 * the AI never returns a title/description, only these structured
 * fields), and is never touched again by Edit Fields. So a draft's LIVE
 * brand/model/productType/colours/material/sku differing from that frozen
 * snapshot is a completely reliable signal that the user has since edited
 * something — and for UK size specifically, `uk_size_source === "manual"`
 * already records the same fact directly (the AI never returns a ukSize
 * field at all, only sourceSize, so there's nothing to compare there).
 */

export type ReviewRequiredField = "brand" | "model" | "colours" | "ukSize" | "sku";

// The 5 fields the Milestone 5 spec's Warnings list names ("Missing SKU,
// Missing Size, Missing Brand, Missing Colour, Missing Model") — deliberately
// excludes productType and material, neither of which the spec ever lists
// as a warning/quick filter.
export const REVIEW_REQUIRED_FIELDS: ReviewRequiredField[] = ["brand", "model", "colours", "ukSize", "sku"];

const REVIEW_FIELD_WARNING_LABELS: Record<ReviewRequiredField, string> = {
  sku: "Missing SKU",
  ukSize: "Missing Size",
  brand: "Missing Brand",
  colours: "Missing Colour",
  model: "Missing Model",
};

// Exact order given in the spec's own Warnings example list.
const WARNING_FIELD_ORDER: ReviewRequiredField[] = ["sku", "ukSize", "brand", "colours", "model"];

export type ReviewableListingFields = {
  brand: string | null;
  model: string | null;
  productType: string | null;
  // Milestone 6 (Vinted-aware colours/materials): up to 2 exact Vinted
  // colour-list values — never null, an empty array is "none set".
  colours: string[];
  // Milestone 6: a single exact Vinted material-list value, or null.
  material: string | null;
  ukSize: string | null;
  sku: string | null;
};

export type ReviewableListing = ReviewableListingFields & {
  ukSizeSource: string | null;
  // The raw last-generation-pipeline-output audit blob, unchanged since
  // Milestone 4 — reused here read-only, purely for edited-detection.
  aiResultJson: ListingGenerationFields | null;
  reviewMarkedReadyAt: string | null;
  updatedAt: string;
  // Milestone 7 (Vinted category catalogue sync). vintedCategoryValid is
  // computed by the caller (a fresh lookup against the live
  // vinted_categories table — never trusted from stale client state): true
  // only when vintedCategoryId is non-null AND that category is currently
  // active, selectable, and a leaf. A category that's since gone inactive
  // still displays (vintedCategoryId/Path are kept for a readable audit
  // trail) but counts as missing for review purposes.
  vintedCategoryId: number | null;
  vintedCategoryValid: boolean;
  vintedCategorySource: "ai" | "manual" | null;
  // Follow-up correction (2026-08-04) — the persisted reason the last
  // automatic category-assignment attempt landed where it did (or
  // didn't); see lib/listing-studio/vinted-category-assignment.ts's
  // VintedCategoryAssignmentReason. Lets the "Missing category" warning
  // become the specific, actionable "Audience required" whenever that's
  // genuinely why — never a raw internal code shown to the user.
  vintedCategoryStatus: string | null;
  vintedAudienceSource: "ai" | "manual" | null;
};

/** True whenever this listing has no currently-publishable Vinted category — null, unknown, inactive, non-selectable, or non-leaf all count. */
export function isMissingVintedCategory(listing: { vintedCategoryId: number | null; vintedCategoryValid: boolean }): boolean {
  return listing.vintedCategoryId === null || !listing.vintedCategoryValid;
}

/** The specific reason label shown in warnings/details when a category is missing — "Audience required" is the one case worth calling out distinctly (see this milestone's own "do not leave only a vague Missing category warning" requirement); everything else falls back to the generic label. */
export function describeMissingVintedCategoryWarning(vintedCategoryStatus: string | null): string {
  return vintedCategoryStatus === "audience_missing" ? "Audience required" : "Missing category";
}

export type ListingReviewStatus = "ready" | "needs_review" | "edited";
export const listingReviewStatuses: ListingReviewStatus[] = ["ready", "needs_review", "edited"];
export type ListingReviewStatusFilter = "all" | ListingReviewStatus;

// Milestone 7: "missing_category" added alongside the original 4 —
// handled separately below since it isn't one of REVIEW_REQUIRED_FIELDS.
export type ListingQuickFilter = "missing_sku" | "missing_size" | "missing_brand" | "missing_colour" | "missing_category";

// Only 4 of the 5 warning fields get a quick-filter chip — "Missing Model"
// is a valid warning but deliberately has no quick filter, matching the
// spec's own (shorter) Quick Filters list exactly.
const QUICK_FILTER_FIELD: Partial<Record<ListingQuickFilter, ReviewRequiredField>> = {
  missing_sku: "sku",
  missing_size: "ukSize",
  missing_brand: "brand",
  missing_colour: "colours",
};

function isBlank(value: string | null): boolean {
  return !value || !value.trim();
}

// `colours` is the one required field that isn't a plain nullable string —
// "missing" means an empty array, not blank/whitespace.
function isFieldMissing(listing: ReviewableListingFields, field: ReviewRequiredField): boolean {
  if (field === "colours") return listing.colours.length === 0;
  return isBlank(listing[field]);
}

export function getMissingRequiredFields(listing: ReviewableListingFields): ReviewRequiredField[] {
  return REVIEW_REQUIRED_FIELDS.filter(field => isFieldMissing(listing, field));
}

/** Human-readable warnings, in the exact order the spec's own example lists them, plus a category warning (Milestone 7 — "Audience required" or "Missing category", whichever is actually true) appended last. */
export function buildListingWarnings(listing: ReviewableListingFields & { vintedCategoryId: number | null; vintedCategoryValid: boolean; vintedCategoryStatus?: string | null }): string[] {
  const missing = new Set(getMissingRequiredFields(listing));
  const warnings = WARNING_FIELD_ORDER.filter(field => missing.has(field)).map(field => REVIEW_FIELD_WARNING_LABELS[field]);
  if (isMissingVintedCategory(listing)) warnings.push(describeMissingVintedCategoryWarning(listing.vintedCategoryStatus ?? null));
  return warnings;
}

export function matchesQuickFilter(listing: ReviewableListingFields & { vintedCategoryId: number | null; vintedCategoryValid: boolean }, filter: ListingQuickFilter): boolean {
  if (filter === "missing_category") return isMissingVintedCategory(listing);
  return isFieldMissing(listing, QUICK_FILTER_FIELD[filter]!);
}

// Order-insensitive — re-selecting the same up-to-2 colours in a different
// dropdown order is not a meaningful edit.
function sameColours(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * True whenever the user has manually changed something via Edit Fields
 * since this draft was last (re)generated — see this file's own top
 * comment for why no new column is needed to know this.
 */
export function isListingEdited(listing: ReviewableListing): boolean {
  if (listing.ukSizeSource === "manual") return true;
  // Milestone 7: a manually-chosen category is itself a user edit, exactly
  // like a manually-entered UK size above — there's no AI-side snapshot to
  // diff a category against (ai_result_json never included one), so the
  // dedicated vintedCategorySource field is the only signal, same reasoning
  // as ukSizeSource.
  if (listing.vintedCategorySource === "manual") return true;
  // Follow-up correction (2026-08-04): a manually-corrected audience is
  // itself a user edit too, same reasoning as vintedCategorySource above.
  if (listing.vintedAudienceSource === "manual") return true;
  const original = listing.aiResultJson;
  if (!original) return false;
  return (
    (listing.brand ?? null) !== (original.brand.value ?? null)
    || (listing.model ?? null) !== (original.model.value ?? null)
    || (listing.productType ?? null) !== (original.productType.value ?? null)
    || !sameColours(listing.colours, original.colours.value)
    || (listing.material ?? null) !== (original.material.value ?? null)
    || (listing.sku ?? null) !== (original.sku.value ?? null)
  );
}

/**
 * Priority, matching the spec's own wording exactly: missing required
 * fields is "automatic" (§ Rules) and always wins, with no override —
 * "Mark Ready" (reviewMarkedReadyAt) only ever resolves the Edited case,
 * never a genuinely incomplete one. A listing edited AGAIN after being
 * marked ready (updatedAt moves past reviewMarkedReadyAt) correctly shows
 * Edited again with no extra bookkeeping — see supabase-listing-studio.sql's
 * own comment on this column.
 */
export function computeListingReviewStatus(listing: ReviewableListing): ListingReviewStatus {
  if (getMissingRequiredFields(listing).length > 0) return "needs_review";
  // Milestone 7: a missing/invalid category is automatic and wins just
  // like a missing required field above — never overridden by Mark Ready.
  if (isMissingVintedCategory(listing)) return "needs_review";
  if (!isListingEdited(listing)) return "ready";
  const markedReadyAt = listing.reviewMarkedReadyAt;
  if (markedReadyAt && new Date(markedReadyAt).getTime() >= new Date(listing.updatedAt).getTime()) return "ready";
  return "edited";
}

export type ListingSearchFields = {
  generatedTitle: string | null;
  sku: string | null;
  brand: string | null;
  model: string | null;
  colours: string[];
};

/** Instant substring search across title/SKU/brand/model/colours, case-insensitive. An empty query matches everything. */
export function matchesListingSearch(listing: ListingSearchFields, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [listing.generatedTitle, listing.sku, listing.brand, listing.model, listing.colours.join(" ")]
    .some(value => (value ?? "").toLowerCase().includes(q));
}
