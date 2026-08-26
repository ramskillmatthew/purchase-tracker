import type { ListingGenerationFields, VintedAudienceValue } from "./listing-generation-schemas";
import { deriveDraftItemFamily, normaliseFootwearListingText } from "./vinted-category-selection";

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

export type ReviewRequiredField = "brand" | "model" | "productType" | "colours" | "ukSize" | "sku";

// The original 5 fields the Milestone 5 spec's Warnings list names
// ("Missing SKU, Missing Size, Missing Brand, Missing Colour, Missing
// Model") plus "productType" (follow-up correction, closing the Mark
// Ready readiness gap — a listing genuinely needs a product type to be
// Vinted-ready, even though the original spec's shorter list didn't name
// it). "material" deliberately stays excluded — Vinted only requires
// material for SOME categories, and this app has no per-category "is
// material required" data to check that safely, so treating it as
// universally optional (never blocking Ready) is the only safe choice —
// see this file's own isUkSizeRequired for the one field that DOES get a
// real conditional-by-category rule, because a reliable signal
// (deriveDraftItemFamily) already exists for it.
export const REVIEW_REQUIRED_FIELDS: ReviewRequiredField[] = ["brand", "model", "productType", "colours", "ukSize", "sku"];

const REVIEW_FIELD_WARNING_LABELS: Record<ReviewRequiredField, string> = {
  sku: "Missing SKU",
  ukSize: "Missing Size",
  brand: "Missing Brand",
  productType: "Missing Product Type",
  colours: "Missing Colour",
  model: "Missing Model",
};

// Exact order given in the spec's own Warnings example list, with the new
// "productType" inserted right after "brand" (the two fields most
// directly define "what is this item").
const WARNING_FIELD_ORDER: ReviewRequiredField[] = ["sku", "ukSize", "brand", "productType", "colours", "model"];

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
  // Milestone 6 (purchase-price lookup and manual Vinted selling price) —
  // listing_drafts.confirmed_price_pence, reused as-is (see
  // lib/listing-studio/selling-price.ts's own comment on why no new
  // column was added). A valid price is >= 1 penny — 0/negative are
  // never written by the save route, but treated as "missing" here too
  // defensively, same spirit as every other required-field check in this
  // file never trusting a value's mere presence alone.
  sellingPricePence: number | null;
  // Follow-up correction (closing the Mark Ready readiness gap) — the
  // remaining ReadinessCheckFields not already covered above.
  vintedAudience: VintedAudienceValue | null;
  generatedTitle: string;
  generatedDescription: string;
  condition: string | null;
  hasPhoto: boolean;
};

/** True whenever this listing has no valid saved Vinted selling price — null/undefined, zero, or negative all count as missing. */
export function isMissingSellingPrice(listing: { sellingPricePence: number | null }): boolean {
  return listing.sellingPricePence == null || listing.sellingPricePence <= 0;
}

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

// Milestone 7 added "missing_category"; Milestone 6 (selling price) adds
// "missing_price" — both handled separately below since neither is one of
// REVIEW_REQUIRED_FIELDS.
export type ListingQuickFilter = "missing_sku" | "missing_size" | "missing_brand" | "missing_colour" | "missing_category" | "missing_price";

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

/**
 * Follow-up correction (closing the Mark Ready readiness gap) — UK size is
 * only genuinely required for the two item families Vinted actually needs
 * a size for: footwear and clothing (the same deterministic classification
 * already trusted for automatic category selection — see
 * vinted-category-selection.ts's own comment on why it's a fixed keyword
 * list, never a guess). An "uncertain" item family (an accessory, a bag, or
 * simply no product type set yet) never requires a size — a missing
 * product type is its own separate warning instead, never doubled up with
 * a spurious "Missing Size" for something that may not need one at all.
 */
function isUkSizeRequired(productType: string | null): boolean {
  const itemFamily = deriveDraftItemFamily(productType);
  return itemFamily === "footwear" || itemFamily === "clothing";
}

// `colours` is the one required field that isn't a plain nullable string —
// "missing" means an empty array, not blank/whitespace. `ukSize` is the
// one field whose requiredness is itself conditional — see
// isUkSizeRequired above.
function isFieldMissing(listing: ReviewableListingFields, field: ReviewRequiredField): boolean {
  if (field === "colours") return listing.colours.length === 0;
  if (field === "ukSize") return isUkSizeRequired(listing.productType) && isBlank(listing.ukSize);
  return isBlank(listing[field]);
}

export function getMissingRequiredFields(listing: ReviewableListingFields): ReviewRequiredField[] {
  return REVIEW_REQUIRED_FIELDS.filter(field => isFieldMissing(listing, field));
}

/** True whenever the derived title (generated_title) is blank — defensive: generateListingTitle always produces text once the required structured fields exist, so this should be unreachable in practice, but Mark Ready must never trust that without checking. */
export function isMissingGeneratedTitle(listing: { generatedTitle: string }): boolean {
  return isBlank(listing.generatedTitle);
}

/** Same reasoning as isMissingGeneratedTitle, for the derived description. */
export function isMissingGeneratedDescription(listing: { generatedDescription: string }): boolean {
  return isBlank(listing.generatedDescription);
}

/** condition is a fixed constant set once at generation time (see lib/listing-studio/listing-template.ts's LISTING_CONDITION_TEXT) — never user-edited, so this should also be unreachable in practice, but is checked for the same "never trust presence without verifying" reason as every other field here. */
export function isMissingCondition(listing: { condition: string | null }): boolean {
  return isBlank(listing.condition);
}

/** True whenever the Vinted audience field itself is unset or still "unknown" — "unisex"/"mens"/"womens"/"boys"/"girls" are all genuinely resolved, non-missing values. Distinct from isMissingVintedCategory: a listing can have a resolved audience but still lack a category (or vice versa via a manual category pick), so both are checked independently. */
export function isMissingAudience(listing: { vintedAudience: VintedAudienceValue | null }): boolean {
  return listing.vintedAudience === null || listing.vintedAudience === "unknown";
}

/** True whenever this listing has no successfully uploaded photo at all — a Vinted listing can never be published without at least one. */
export function hasNoUploadedPhoto(listing: { hasPhoto: boolean }): boolean {
  return !listing.hasPhoto;
}

// The single shared shape both the UI (ListingsReviewWorkspace) and the
// server (mark-ready route) build before calling buildListingWarnings —
// see that function's own comment for why this is the ONE place "is this
// listing genuinely ready" is decided, used identically by both, so they
// can never drift apart.
export type ReadinessCheckFields = ReviewableListingFields & {
  vintedCategoryId: number | null;
  vintedCategoryValid: boolean;
  vintedCategoryStatus?: string | null;
  vintedAudience: VintedAudienceValue | null;
  sellingPricePence: number | null;
  generatedTitle: string;
  generatedDescription: string;
  condition: string | null;
  hasPhoto: boolean;
};

/**
 * Human-readable warnings — the SINGLE shared definition of "what's
 * blocking this listing from being complete/Ready", called by both
 * computeListingReviewStatus (UI) and the mark-ready route (server) so
 * neither can ever compute a different answer than the other. Order:
 * the original required-fields group (SKU, Size, Brand, Product Type,
 * Colour, Model), then title/description/condition/audience (follow-up
 * correction — closing the Mark Ready readiness gap), then category
 * (Milestone 7 — "Audience required" or "Missing category"), then photo
 * (follow-up correction), then selling price (Milestone 6) last.
 */
export function buildListingWarnings(listing: ReadinessCheckFields): string[] {
  const missing = new Set(getMissingRequiredFields(listing));
  const warnings = WARNING_FIELD_ORDER.filter(field => missing.has(field)).map(field => REVIEW_FIELD_WARNING_LABELS[field]);
  if (isMissingGeneratedTitle(listing)) warnings.push("Missing title");
  if (isMissingGeneratedDescription(listing)) warnings.push("Missing description");
  if (isMissingCondition(listing)) warnings.push("Missing condition");
  if (isMissingAudience(listing)) warnings.push("Missing audience");
  if (isMissingVintedCategory(listing)) warnings.push(describeMissingVintedCategoryWarning(listing.vintedCategoryStatus ?? null));
  if (hasNoUploadedPhoto(listing)) warnings.push("No uploaded photos");
  if (isMissingSellingPrice(listing)) warnings.push("Missing selling price");
  return warnings;
}

export function matchesQuickFilter(listing: ReviewableListingFields & { vintedCategoryId: number | null; vintedCategoryValid: boolean; sellingPricePence: number | null }, filter: ListingQuickFilter): boolean {
  if (filter === "missing_category") return isMissingVintedCategory(listing);
  if (filter === "missing_price") return isMissingSellingPrice(listing);
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
  // Business-rule follow-up correction (children's wording in
  // customer-facing text): ai_result_json is a frozen, untouched snapshot
  // of exactly what the AI returned (see this file's own top comment) — it
  // is deliberately never cleaned. So a footwear Women's listing whose
  // model/productType were automatically stripped of children's wording
  // (e.g. "Clifton 9 Youth" -> "Clifton 9") would otherwise look
  // "edited" purely from that automatic cleanup, even though the user
  // changed nothing. Both sides are normalised through the same rule
  // before comparing so only a REAL user edit ever shows as Edited.
  const itemFamily = deriveDraftItemFamily(listing.productType);
  const normalisedModel = normaliseFootwearListingText(listing.model, itemFamily, listing.vintedAudience);
  const normalisedOriginalModel = normaliseFootwearListingText(original.model.value, itemFamily, listing.vintedAudience);
  const normalisedProductType = normaliseFootwearListingText(listing.productType, itemFamily, listing.vintedAudience);
  const normalisedOriginalProductType = normaliseFootwearListingText(original.productType.value, itemFamily, listing.vintedAudience);
  return (
    (listing.brand ?? null) !== (original.brand.value ?? null)
    || (normalisedModel ?? null) !== (normalisedOriginalModel ?? null)
    || (normalisedProductType ?? null) !== (normalisedOriginalProductType ?? null)
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
 *
 * Follow-up correction (closing the Mark Ready readiness gap): the
 * "anything missing" check below is now literally `buildListingWarnings(
 * listing).length > 0` — the exact same function, and therefore the exact
 * same answer, the mark-ready route calls server-side and the details
 * panel calls to render the Warnings list. There is no second,
 * independently-maintained copy of "what counts as ready" anywhere in this
 * codebase; this is deliberate so the UI and the server can never drift
 * apart on the definition.
 */
export function computeListingReviewStatus(listing: ReviewableListing): ListingReviewStatus {
  if (buildListingWarnings(listing).length > 0) return "needs_review";
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
